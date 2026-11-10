import { randomUUID } from 'node:crypto'
import type { BrowserCommand, BrowserResult, DaemonClient, TaskApp } from '@ted/protocol'
import { isLoopbackUrl } from '@ted/protocol/app'
import { type BrowserWindow, type Session, session, WebContentsView } from 'electron'

interface Page {
  view: WebContentsView
  app: TaskApp
  ready: boolean
  revision: string
  error?: string | undefined
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export function createTaskBrowsers(
  getWindow: () => BrowserWindow | undefined,
  client: DaemonClient,
  onSelect: (taskId: string, app: TaskApp) => void,
) {
  const pages = new Map<string, Page>()
  const sessions = new Map<string, Session>()
  let activeTask: string | undefined
  let shown: string | undefined
  let presentation = 0
  let stopped = false
  const owner = randomUUID()
  const attached = new Set<WebContentsView>()
  const hide = (temporary = false) => {
    if (!temporary) activeTask = undefined
    presentation++
    for (const view of attached) {
      getWindow()?.contentView.removeChildView(view)
    }
    attached.clear()
    shown = undefined
  }
  const close = (id: string, forget = true) => {
    const page = pages.get(id)
    if (page) {
      pages.delete(id)
      if (shown === id) {
        for (const view of attached) getWindow()?.contentView.removeChildView(view)
        attached.clear()
        shown = undefined
      }
      if (!page.view.webContents.isDestroyed())
        page.view.webContents.close({ waitForBeforeUnload: false })
    }
    if (forget) {
      const ses = sessions.get(id)
      sessions.delete(id)
      void ses?.clearStorageData().catch(() => undefined)
      void ses?.closeAllConnections().catch(() => undefined)
    }
  }
  const valid = async (taskId: string, expected: TaskApp) => {
    const current = await client.browserApp(taskId, expected)
    if (
      current?.state !== 'running' ||
      current.removed ||
      current.kind !== 'web' ||
      current.url !== expected.url ||
      current.startedAt !== expected.startedAt ||
      !current.url ||
      !isLoopbackUrl(current.url)
    ) {
      throw new Error('That web App isn’t running; use ▶ in Apps')
    }
    return current
  }
  const ensure = async (taskId: string, app: TaskApp) => {
    await valid(taskId, app)
    const old = pages.get(taskId)
    if (
      old &&
      old.app.repo === app.repo &&
      old.app.name === app.name &&
      old.app.url === app.url &&
      old.app.startedAt === app.startedAt &&
      !old.view.webContents.isDestroyed()
    )
      return old
    close(taskId, false)
    const ses = sessions.get(taskId) ?? session.fromPartition(`ted-browser-${randomUUID()}`)
    sessions.set(taskId, ses)
    const origin = new URL(app.url as string).origin
    const allowed = (address: string) => {
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
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.removeAllListeners('will-download')
    ses.on('will-download', (event) => event.preventDefault())
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !allowed(details.url) }),
    )
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
    view.setBounds({ x: 0, y: 0, width: 1024, height: 720 })
    const page: Page = { view, app, ready: false, revision: randomUUID() }
    pages.set(taskId, page)
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
    contents.on('did-navigate', () => {
      page.revision = randomUUID()
    })
    contents.on('did-navigate-in-page', () => {
      page.revision = randomUUID()
    })
    contents.on('render-process-gone', () => {
      if (pages.get(taskId) === page) close(taskId)
    })
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
      // An unstarted renderer cannot answer Page.enable, so begin navigation first.
      const loading = contents.loadURL(app.url as string).catch(() => {
        page.error = 'The page couldn’t load. Reload to try again.'
      })
      contents.debugger.attach('1.3')
      contents.debugger.on('detach', () => {
        if (pages.get(taskId) === page) close(taskId)
      })
      contents.debugger.on('message', (_event, method) => {
        if (method === 'Page.javascriptDialogOpening') {
          void contents.debugger
            .sendCommand('Page.handleJavaScriptDialog', { accept: false })
            .catch(() => undefined)
        }
      })
      await contents.debugger.sendCommand('Page.enable')
      await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      await loading
      page.ready = true
      return page
    } catch (error) {
      if (pages.get(taskId) === page) close(taskId)
      throw error
    }
  }
  const execute = async (
    command: BrowserCommand,
  ): Promise<BrowserResult & { capture?: Uint8Array<ArrayBuffer> }> => {
    if (Date.now() >= command.expiresAt) throw new Error('Browser command expired')
    if (command.runId && (await client.getRun(command.runId)).run.state === 'finished')
      throw new Error('This Run has ended')
    const page = await ensure(command.taskId, command.app)
    if (Date.now() >= command.expiresAt) throw new Error('Browser command expired')
    const contents = page.view.webContents
    const { action, value, ref } = command.request
    const script = async <T>(code: string): Promise<T> =>
      contents.executeJavaScriptInIsolatedWorld(999, [{ code }]) as Promise<T>
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
      if (!ref?.startsWith(`${page.revision}:`))
        throw new Error('Stale element reference; run snapshot again')
      const lookup = `const e = globalThis.__tedElements?.get(${JSON.stringify(ref)}); if (!e || !e.isConnected) throw Error('Stale element reference; run snapshot again'); if (e instanceof HTMLInputElement && e.type === 'file') throw Error('File inputs aren’t supported');`
      if (action === 'click') {
        const point = await script<{ x: number; y: number }>(
          `(() => { ${lookup} e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); if (!r.width || !r.height || e.disabled) throw Error('Element is not clickable'); const x=r.x+r.width/2,y=r.y+r.height/2; if (!e.contains(document.elementFromPoint(x,y))) throw Error('Element is covered'); return {x,y}; })()`,
        )
        contents.sendInputEvent({
          type: 'mouseDown',
          button: 'left',
          clickCount: 1,
          x: Math.round(point.x),
          y: Math.round(point.y),
        })
        contents.sendInputEvent({
          type: 'mouseUp',
          button: 'left',
          clickCount: 1,
          x: Math.round(point.x),
          y: Math.round(point.y),
        })
      } else {
        await script(
          `(() => { ${lookup} if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) || e.disabled || e.readOnly) throw Error('Choose an editable text field'); if(e instanceof HTMLInputElement && !['text','search','email','url','tel','password','number'].includes(e.type)) throw Error('Choose a text field'); e.focus(); const proto=e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value ?? '')}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`,
        )
      }
      page.revision = randomUUID()
    } else if (action === 'press') {
      const keys: Record<string, string> = {
        Enter: 'Return',
        Tab: 'Tab',
        Escape: 'Escape',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Backspace: 'Backspace',
        Space: 'Space',
      }
      const keyCode = keys[value ?? '']
      if (!keyCode) throw new Error('Use Enter, Tab, Escape, Backspace, Space or an arrow key')
      contents.sendInputEvent({ type: 'keyDown', keyCode })
      contents.sendInputEvent({ type: 'keyUp', keyCode })
      page.revision = randomUUID()
    } else if (action === 'navigate') {
      const url = new URL(value ?? '/', command.app.url)
      if (url.origin !== new URL(command.app.url as string).origin || url.username || url.password)
        throw new Error('Navigate within this App’s origin')
      await contents.loadURL(url.href)
    } else if (action === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    } else if (action === 'forward') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    } else if (action === 'reload') {
      page.error = undefined
      contents.reload()
    } else if (action === 'screenshot') {
      const capture = (
        await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
      if (capture.length > 25 * 1024 * 1024) throw new Error('Screenshot exceeds 25 MB')
      return { url: contents.getURL(), capture: new Uint8Array(capture) }
    }
    return { url: contents.getURL(), ...(page.error && { text: page.error }) }
  }
  const loop = async () => {
    while (!stopped) {
      try {
        const command = await client.pollBrowser(owner)
        if (stopped) break
        if (!command) continue
        try {
          const { capture, ...result } = await execute(command)
          if (capture) await client.uploadBrowserCapture(owner, command.id, capture)
          else await client.replyBrowser(owner, command.id, { result })
          if (activeTask === command.taskId && command.request.action === 'open')
            onSelect(command.taskId, command.app)
        } catch (error) {
          await client
            .replyBrowser(owner, command.id, {
              error:
                error instanceof Error ? error.message.slice(0, 1000) : 'Browser command failed',
            })
            .catch(() => undefined)
        }
      } catch {
        hide()
        for (const id of sessions.keys()) close(id)
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
  }
  void loop()
  return {
    async present(taskId: string, bounds: BrowserBounds) {
      const version = ++presentation
      const page = pages.get(taskId)
      if (!page?.ready) return
      await valid(taskId, page.app)
      if (version !== presentation) return
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      const size = win.getContentBounds()
      const x = Math.max(0, Math.min(size.width, Math.round(bounds.x)))
      const y = Math.max(0, Math.min(size.height, Math.round(bounds.y)))
      page.view.setBounds({
        x,
        y,
        width: Math.max(0, Math.min(size.width - x, Math.round(bounds.width))),
        height: Math.max(0, Math.min(size.height - y, Math.round(bounds.height))),
      })
      if (shown !== taskId) {
        for (const view of attached) win.contentView.removeChildView(view)
        attached.clear()
        win.contentView.addChildView(page.view)
        attached.add(page.view)
      }
      shown = taskId
      activeTask = taskId
    },
    hide,
    async state(taskId: string) {
      const page = pages.get(taskId)
      if (!page) return { url: '', text: 'Open a running web App' }
      await valid(taskId, page.app)
      return {
        url: page.view.webContents.getURL(),
        text: page.ready ? (page.error ?? 'Ready') : 'Opening…',
      }
    },
    async external(taskId: string) {
      const page = pages.get(taskId)
      if (!page) throw new Error('Open a running web App')
      await valid(taskId, page.app)
      const url = page.view.webContents.getURL()
      if (!isLoopbackUrl(url) || new URL(url).origin !== new URL(page.app.url as string).origin)
        throw new Error('That isn’t an App page')
      return url
    },
    changed(taskId: string) {
      const page = pages.get(taskId)
      if (page)
        void valid(taskId, page.app).catch(() => {
          if (pages.get(taskId) === page) close(taskId)
        })
    },
    close() {
      stopped = true
      hide()
      for (const id of sessions.keys()) close(id)
    },
  }
}
