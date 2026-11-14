import { randomUUID } from 'node:crypto'
import { type BrowserRequest, type BrowserResult, browserViewport } from '@ted/protocol'
import { type Session, WebContentsView } from 'electron'

export interface GuestPage {
  view: WebContentsView
  url: string
  ready: boolean
  revision: string
  error?: string | undefined
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
    created?(page: GuestPage): void
    gone(page: GuestPage): void
    size?: { width: number; height: number }
  },
): Promise<GuestPage> {
  const { check } = options
  const origin = new URL(appUrl).origin
  const allowed = originGuard(appUrl)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.removeAllListeners('will-download')
  ses.on('will-download', (event) => event.preventDefault())
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      backgroundThrottling: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  })
  view.setBounds({ x: 0, y: 0, width: 1024, height: 720, ...options.size })
  const page: GuestPage = { view, url: appUrl, ready: false, revision: randomUUID() }
  options.created?.(page)
  const contents = view.webContents
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
    if (event.isMainFrame) page.revision = randomUUID()
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
    await ses.setProxy({
      proxyRules: 'socks5://127.0.0.1:9',
      proxyBypassRules: `<-loopback>,${origin},${origin.replace(/^http/, 'ws')}`,
    })
    check()
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !allowed(details.url) }),
    )
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
    await contents.loadURL(appUrl).catch(() => {
      page.error = 'The page couldn’t load. Reload to try again.'
    })
    check()
    page.ready = true
    return page
  } catch (error) {
    closeGuest(page)
    throw error
  }
}

export function closeGuest(page: GuestPage) {
  if (!page.view.webContents.isDestroyed())
    page.view.webContents.close({ waitForBeforeUnload: false })
}

export async function runOnPage(
  page: GuestPage,
  command: PageCommand,
  options: {
    check(): void
    current(): boolean
    closeAfterPartialInput(): void
  },
): Promise<PageResult> {
  const { check } = options
  const contents = page.view.webContents
  const revision = page.revision
  let inputStarted = false
  const checkPage = () => {
    check()
    if (!options.current() || contents.isDestroyed() || page.revision !== revision) {
      if (inputStarted && options.current()) options.closeAfterPartialInput()
      throw new Error('The page changed; run snapshot again before retrying')
    }
  }
  const { action, value, ref } = command.request
  const script = async <T>(code: string): Promise<T> => {
    check()
    const result = (await contents.executeJavaScriptInIsolatedWorld(999, [
      {
        code: `(() => { const check = () => { if (Date.now() >= ${command.expiresAt}) throw Error('Browser command expired'); }; check(); return (${code}); })()`,
      },
    ])) as T
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
          const ref = ${JSON.stringify(prefix)} + ':' + (++index);
          globalThis.__tedElements.set(ref,e);
          const name = (e.getAttribute('aria-label') || (e.labels && Array.from(e.labels).map(l => l.innerText).join(' ')) || e.innerText || e.getAttribute('placeholder') || '').replace(/\\s+/g,' ').slice(0,200);
          out.push(ref + ' ' + (e.getAttribute('role') || e.tagName.toLowerCase()) + ' ' + name);
        }
        return (document.title.slice(0,200) + '\\n' + (document.body?.innerText || '').slice(0,20000) + '\\n\\nElements:\\n' + out.join('\\n')).slice(0,60000);
      })()`)
    return { url: contents.getURL(), text }
  }
  if (action === 'click' || action === 'fill') {
    checkPage()
    if (!ref?.startsWith(`${page.revision}:`))
      throw new Error('Stale element reference; run snapshot again')
    const lookup = `const e = globalThis.__tedElements?.get(${JSON.stringify(ref)}); if (!e || !e.isConnected) throw Error('Stale element reference; run snapshot again'); if (e instanceof HTMLInputElement && e.type === 'file') throw Error('File inputs aren’t supported');`
    if (action === 'click') {
      const point = await script<{ x: number; y: number }>(
        `(() => { ${lookup} e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); if (!r.width || !r.height || e.disabled) throw Error('Element is not clickable'); const x=r.x+r.width/2,y=r.y+r.height/2; if (!e.contains(document.elementFromPoint(x,y))) throw Error('Element is covered'); return {x,y}; })()`,
      )
      checkPage()
      inputStarted = true
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        x: point.x,
        y: point.y,
      })
      checkPage()
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        x: point.x,
        y: point.y,
      })
    } else {
      await script(
        `(() => { ${lookup} if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) || e.disabled || e.readOnly) throw Error('Choose an editable text field'); if(e instanceof HTMLInputElement && !['text','search','email','url','tel','password','number'].includes(e.type)) throw Error('Choose a text field'); check(); e.focus(); check(); const proto=e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value ?? '')}); check(); e.dispatchEvent(new Event('input',{bubbles:true})); check(); e.dispatchEvent(new Event('change',{bubbles:true})); })()`,
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
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      windowsVirtualKeyCode: keyCode,
      ...(value === 'Enter' ? { text: '\r' } : value === 'Space' ? { text: ' ' } : {}),
    })
    checkPage()
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      windowsVirtualKeyCode: keyCode,
    })
    page.revision = randomUUID()
  } else if (action === 'navigate') {
    const url = new URL(value ?? '/', command.url)
    if (url.origin !== new URL(command.url).origin || url.username || url.password)
      throw new Error('Navigate within this App’s origin')
    await contents.loadURL(url.href)
  } else if (action === 'back') {
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  } else if (action === 'forward') {
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  } else if (action === 'reload') {
    page.error = undefined
    contents.reload()
  } else if (action === 'resize') {
    const viewport = browserViewport(value ?? '')
    if (typeof viewport === 'string') throw new Error(viewport)
    const { width, height } = viewport
    check()
    page.view.setBounds({ x: 0, y: 0, width, height })
    await script(
      `new Promise((resolve) => { const done = () => innerWidth === ${width} ? resolve(true) : Date.now() < ${command.expiresAt} - 1000 ? setTimeout(done, 16) : resolve(false); done(); })`,
    )
    page.revision = randomUUID()
  } else if (action === 'color-scheme') {
    if (value !== 'light' && value !== 'dark') throw new Error('Use light or dark')
    check()
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    })
    page.revision = randomUUID()
  } else if (action === 'screenshot') {
    const capture = (
      await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    ).toPNG()
    if (capture.length > 25 * 1024 * 1024) throw new Error('Screenshot exceeds 25 MB')
    return { url: contents.getURL(), capture: new Uint8Array(capture) }
  }
  return { url: contents.getURL(), ...(page.error && { text: page.error }) }
}
