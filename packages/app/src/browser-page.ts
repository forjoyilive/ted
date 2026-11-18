import { randomUUID } from 'node:crypto'
import {
  type BrowserRequest,
  type BrowserResult,
  browserViewport,
  scriptLiteral,
} from '@ted/protocol'
import type { Session, WebContents, WebPreferences } from 'electron'
import { isOutsideMedia } from './browser-proxy.ts'

export interface GuestHost {
  contents: WebContents
  resize(width: number, height: number): unknown
  close?(): void
}

export interface PageDriver {
  url(): string
  gone(): boolean
  script(code: string): Promise<unknown>
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  load(url: string): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  capture(): Promise<Uint8Array<ArrayBuffer>>
}

export interface DrivenPage {
  driver: PageDriver
  revision: string
  error?: string | undefined
  navigate: boolean
  inputScale?: number
  touch?: boolean
  resize(width: number, height: number): unknown
}

export interface GuestPage extends GuestHost, DrivenPage {
  url: string
  ready: boolean
  blocked: number
}

export function webContentsDriver(contents: WebContents): PageDriver {
  return {
    url: () => contents.getURL(),
    gone: () => contents.isDestroyed(),
    script: (code) => contents.executeJavaScriptInIsolatedWorld(999, [{ code }]),
    send: (method, params) => contents.debugger.sendCommand(method, params),
    load: (url) => contents.loadURL(url),
    back: async () => {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    },
    forward: async () => {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    },
    reload: async () => contents.reload(),
    capture: async () =>
      new Uint8Array(
        (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      ),
  }
}

export interface PageCommand {
  request: BrowserRequest
  expiresAt: number
  url: string
}

export type PageResult = BrowserResult & { capture?: Uint8Array<ArrayBuffer> }

export function originGuard(appUrl: string): (address: string) => boolean {
  const origin = new URL(appUrl).origin
  return (address) => {
    try {
      const url = new URL(address)
      const protocol =
        url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol
      return (
        !url.username &&
        !url.password &&
        (protocol === 'http:' || protocol === 'https:') &&
        new URL(`${protocol}//${url.host}`).origin === origin
      )
    } catch {
      return false
    }
  }
}

export async function openGuest(
  ses: Session,
  appUrl: string,
  options: {
    check(): void
    proxy?(): Promise<string>
    host(webPreferences: WebPreferences): GuestHost
    created?(page: GuestPage): void
    beforeLoad?(page: GuestPage): Promise<void>
    gone(page: GuestPage): void
  },
): Promise<GuestPage> {
  const { check } = options
  const origin = new URL(appUrl).origin
  const allowed = originGuard(appUrl)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.removeAllListeners('will-download')
  ses.on('will-download', (event) => event.preventDefault())
  const host = options.host({
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    backgroundThrottling: false,
    safeDialogs: true,
    navigateOnDragDrop: false,
  })
  const page: GuestPage = {
    ...host,
    url: appUrl,
    ready: false,
    blocked: 0,
    revision: randomUUID(),
    navigate: true,
    driver: webContentsDriver(host.contents),
  }
  options.created?.(page)
  const contents = page.contents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('select-client-certificate', (event, _url, _certificates, callback) => {
    event.preventDefault()
    // Electron’s WebContents typings omit the supported no-certificate callback.
    ;(callback as () => void)()
  })
  contents.on('will-navigate', (event, url) => {
    if (!allowed(url)) event.preventDefault()
  })
  contents.on('will-frame-navigate', (event) => {
    if (!allowed(event.url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!allowed(url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame) return
    page.revision = randomUUID()
    if (!event.isSameDocument) page.blocked = 0
  })
  contents.on('did-navigate', () => {
    page.revision = randomUUID()
  })
  contents.on('did-navigate-in-page', () => {
    page.revision = randomUUID()
  })
  contents.on('render-process-gone', () => options.gone(page))
  contents.on('did-fail-load', (_event, code, _description, _url, main) => {
    if (main && code !== -3) page.error = 'The page couldn’t load. Check that the App is running.'
  })
  contents.on('dom-ready', () => {
    void contents
      .executeJavaScriptInIsolatedWorld(999, [
        {
          code: `
        const blockFiles = () => document.querySelectorAll('input[type="file"]').forEach(e => e.disabled = true);
        blockFiles(); new MutationObserver(blockFiles).observe(document, {childList:true,subtree:true,attributes:true,attributeFilter:['type']});
        document.addEventListener('click', e => { if (e.target instanceof HTMLInputElement && e.target.type === 'file') { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
      `,
        },
      ])
      .catch(() => undefined)
  })
  try {
    // Bootstrap without repo scripts before installing guards in every guest frame.
    await contents.loadURL('about:blank')
    check()
    contents.debugger.attach('1.3')
    contents.debugger.on('detach', () => options.gone(page))
    contents.debugger.on('message', (_event, method) => {
      if (method === 'Page.javascriptDialogOpening') {
        void contents.debugger
          .sendCommand('Page.handleJavaScriptDialog', { accept: false })
          .catch(() => undefined)
      }
    })
    check()
    // WebTransport bypasses webRequest but refuses proxied connections.
    const proxyRules = options.proxy ? await options.proxy() : 'socks5://127.0.0.1:9'
    check()
    await ses.setProxy({
      proxyRules,
      proxyBypassRules: `<-loopback>,${origin},${origin.replace(/^http/, 'ws')}`,
    })
    check()
    ses.webRequest.onBeforeRequest((details, callback) => {
      const pass = allowed(details.url) || isOutsideMedia(details.url, details.resourceType)
      if (!pass && /^(https?|wss?):/.test(details.url)) page.blocked++
      callback({ cancel: !pass })
    })
    await contents.debugger.sendCommand('Page.enable')
    check()
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
          Object.defineProperty(globalThis, name, {value: undefined, writable: false, configurable: false});
        }`,
    })
    check()
    await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    check()
    await options.beforeLoad?.(page)
    check()
    await contents.loadURL(appUrl).catch(() => {
      page.error = 'The page couldn’t load. Reload to try again.'
    })
    check()
    contents.navigationHistory.clear()
    page.ready = true
    return page
  } catch (error) {
    closeGuest(page)
    throw error
  }
}

export function closeGuest(page: GuestPage) {
  if (!page.contents.isDestroyed()) page.contents.close({ waitForBeforeUnload: false })
  page.close?.()
}

export async function runOnPage(
  page: DrivenPage,
  command: PageCommand,
  options: {
    check(): void
    current(): boolean
    closeAfterPartialInput(): void
  },
): Promise<PageResult> {
  const { check } = options
  const contents = page.driver
  const revision = page.revision
  let inputStarted = false
  const checkPage = () => {
    check()
    if (!options.current() || contents.gone() || page.revision !== revision) {
      if (inputStarted && options.current()) options.closeAfterPartialInput()
      throw new Error('The page changed; run snapshot again before retrying')
    }
  }
  const { action, value, ref } = command.request
  const script = async <T>(code: string): Promise<T> => {
    check()
    const result = (await contents.script(
      `(() => { const check = () => { if (Date.now() >= ${scriptLiteral(command.expiresAt)}) throw Error('Browser command expired'); }; check(); return (${code}); })()`,
    )) as T
    check()
    return result
  }
  if (action === 'snapshot') {
    const prefix = randomUUID()
    page.revision = prefix
    const text = await script<string>(`(() => {
        globalThis.__tedElements = new Map();
        const out = []; let index = 0;
        for (const e of document.querySelectorAll('a,button,input,textarea,select,h1,h2,h3,[role]')) {
          if (index >= 200) break;
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') continue;
          const ref = ${scriptLiteral(prefix)} + ':' + (++index);
          globalThis.__tedElements.set(ref,e);
          const name = (e.getAttribute('aria-label') || (e.labels && Array.from(e.labels).map(l => l.innerText).join(' ')) || e.innerText || e.getAttribute('placeholder') || '').replace(/\\s+/g,' ').slice(0,200);
          out.push(ref + ' ' + (e.getAttribute('role') || e.tagName.toLowerCase()) + ' ' + name);
        }
        return (document.title.slice(0,200) + '\\n' + (document.body?.innerText || '').slice(0,20000) + '\\n\\nElements:\\n' + out.join('\\n')).slice(0,60000);
      })()`)
    return { url: contents.url(), text }
  }
  if (action === 'click' || action === 'fill') {
    checkPage()
    if (!ref?.startsWith(`${page.revision}:`))
      throw new Error('Stale element reference; run snapshot again')
    const lookup = `const e = globalThis.__tedElements?.get(${scriptLiteral(ref)}); if (!e || !e.isConnected) throw Error('Stale element reference; run snapshot again'); if (e instanceof HTMLInputElement && e.type === 'file') throw Error('File inputs aren’t supported');`
    if (action === 'click') {
      const point = await script<{ x: number; y: number }>(
        `(() => { ${lookup} e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); if (!r.width || !r.height || e.disabled) throw Error('Element is not clickable'); const x=r.x+r.width/2,y=r.y+r.height/2; if (!e.contains(document.elementFromPoint(x,y))) throw Error('Element is covered'); return {x,y}; })()`,
      )
      checkPage()
      inputStarted = true
      const x = point.x * (page.inputScale ?? 1)
      const y = point.y * (page.inputScale ?? 1)
      if (page.touch) {
        await contents.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y }],
        })
        checkPage()
        await contents.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else {
        await contents.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          x,
          y,
        })
        checkPage()
        await contents.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          x,
          y,
        })
      }
    } else {
      await script(
        `(() => { ${lookup} if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) || e.disabled || e.readOnly) throw Error('Choose an editable text field'); if(e instanceof HTMLInputElement && !['text','search','email','url','tel','password','number'].includes(e.type)) throw Error('Choose a text field'); check(); e.focus(); check(); const proto=e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${scriptLiteral(value ?? '')}); check(); e.dispatchEvent(new Event('input',{bubbles:true})); check(); e.dispatchEvent(new Event('change',{bubbles:true})); })()`,
      )
    }
    page.revision = randomUUID()
  } else if (action === 'press') {
    const keys: Record<string, number> = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      Backspace: 8,
      Space: 32,
    }
    const keyCode = keys[value ?? '']
    if (!keyCode) throw new Error('Use Enter, Tab, Escape, Backspace, Space or an arrow key')
    checkPage()
    inputStarted = true
    const key = value === 'Space' ? ' ' : value
    await contents.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      windowsVirtualKeyCode: keyCode,
      ...(value === 'Enter' ? { text: '\r' } : value === 'Space' ? { text: ' ' } : {}),
    })
    checkPage()
    await contents.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      windowsVirtualKeyCode: keyCode,
    })
    page.revision = randomUUID()
  } else if (action === 'navigate') {
    if (!page.navigate) throw new Error('A desktop App has no addresses to navigate to')
    const url = new URL(value ?? '/', command.url)
    if (url.origin !== new URL(command.url).origin || url.username || url.password)
      throw new Error('Navigate within this App’s origin')
    await contents.load(url.href)
  } else if (action === 'back') {
    await contents.back()
  } else if (action === 'forward') {
    await contents.forward()
  } else if (action === 'reload') {
    page.error = undefined
    await contents.reload()
  } else if (action === 'resize') {
    const viewport = browserViewport(value ?? '')
    if (typeof viewport === 'string') throw new Error(viewport)
    const { width, height } = viewport
    check()
    await page.resize(width, height)
    await script(
      `new Promise((resolve) => { const done = () => innerWidth === ${width} ? resolve(true) : Date.now() < ${command.expiresAt} - 1000 ? setTimeout(done, 16) : resolve(false); done(); })`,
    )
    page.revision = randomUUID()
  } else if (action === 'color-scheme') {
    if (value !== 'light' && value !== 'dark') throw new Error('Use light or dark')
    check()
    await contents.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    })
    page.revision = randomUUID()
  } else if (action === 'screenshot') {
    const capture = await contents.capture()
    if (capture.length > 25 * 1024 * 1024) throw new Error('Screenshot exceeds 25 MB')
    return { url: contents.url(), capture }
  }
  return { url: contents.url(), ...(page.error && { text: page.error }) }
}
