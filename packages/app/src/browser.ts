import { randomUUID } from 'node:crypto'
import {
  type BrowserCommand,
  type BrowserResult,
  type DaemonClient,
  DaemonRequestError,
  type TaskApp,
} from '@ted/protocol'
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
  getClient: () => DaemonClient,
  onSelect: (taskId: string, app: TaskApp) => void,
) {
  const pages = new Map<string, Page>()
  const sessions = new Map<string, { session: Session; apps: Map<string, TaskApp> }>()
  const appKey = (app: TaskApp) => JSON.stringify([app.repo, app.name])
  let activeTask: string | undefined
  let shown: string | undefined
  let presentation = 0
  let stopped = false
  let generation = 0
  const running = new Map<string, AbortController>()
  const runTasks = new Map<string, string>()
  const rechecks = new Map<string, ReturnType<typeof setTimeout>>()
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
    clearTimeout(rechecks.get(id))
    rechecks.delete(id)
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
      void ses?.session.clearStorageData().catch(() => undefined)
      void ses?.session.closeAllConnections().catch(() => undefined)
    }
  }
  const valid = async (taskId: string, expected: TaskApp, client = getClient()) => {
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
  const reconcile = (taskId: string) => {
    clearTimeout(rechecks.get(taskId))
    rechecks.delete(taskId)
    const retained = sessions.get(taskId)
    if (!retained) return
    const version = generation
    const client = getClient()
    for (const expected of retained.apps.values())
      void valid(taskId, expected, client).catch((error: unknown) => {
        if (
          stopped ||
          version !== generation ||
          client !== getClient() ||
          sessions.get(taskId) !== retained
        )
          return
        if (
          error instanceof Error &&
          (error.message === 'That web App isn’t running; use ▶ in Apps' ||
            (error instanceof DaemonRequestError && [403, 404, 409].includes(error.status)))
        )
          close(taskId)
        else {
          clearTimeout(rechecks.get(taskId))
          rechecks.set(
            taskId,
            setTimeout(() => reconcile(taskId), 1_000),
          )
        }
      })
  }
  const ensure = async (taskId: string, app: TaskApp, check: () => void) => {
    await valid(taskId, app)
    check()
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
    const retained = sessions.get(taskId)?.apps.get(appKey(app))
    const restarted =
      retained !== undefined && (retained.url !== app.url || retained.startedAt !== app.startedAt)
    close(taskId, restarted)
    const ses =
      sessions.get(taskId)?.session ?? session.fromPartition(`ted-browser-${randomUUID()}`)
    const retainedSession = sessions.get(taskId) ?? {
      session: ses,
      apps: new Map<string, TaskApp>(),
    }
    retainedSession.apps.set(appKey(app), app)
    sessions.set(taskId, retainedSession)
    const origin = new URL(app.url as string).origin
    // WebTransport bypasses webRequest but refuses proxied connections.
    await ses.setProxy({
      proxyRules: 'socks5://127.0.0.1:9',
      proxyBypassRules: `<-loopback>,${origin},${origin.replace(/^http/, 'ws')}`,
    })
    check()
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
      // Bootstrap without repo scripts before installing guards in every guest frame.
      await contents.loadURL('about:blank')
      check()
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
      check()
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
      await contents.loadURL(app.url as string).catch(() => {
        page.error = 'The page couldn’t load. Reload to try again.'
      })
      check()
      page.ready = true
      return page
    } catch (error) {
      if (pages.get(taskId) === page) close(taskId, false)
      throw error
    }
  }
  const execute = async (
    command: BrowserCommand,
    check: () => void,
  ): Promise<BrowserResult & { capture?: Uint8Array<ArrayBuffer> }> => {
    check()
    if (command.runId && (await getClient().getRun(command.runId)).run.state === 'finished')
      throw new Error('This Run has ended')
    const page = await ensure(command.taskId, command.app, check)
    check()
    const contents = page.view.webContents
    const revision = page.revision
    let inputStarted = false
    const checkPage = () => {
      check()
      if (
        pages.get(command.taskId) !== page ||
        contents.isDestroyed() ||
        page.revision !== revision
      ) {
        if (inputStarted && pages.get(command.taskId) === page) close(command.taskId, false)
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
  const invalidate = () => {
    generation++
    for (const timer of rechecks.values()) clearTimeout(timer)
    rechecks.clear()
    for (const controller of running.values()) controller.abort()
  }
  const run = async (command: BrowserCommand, client: DaemonClient, version: number) => {
    if (running.has(command.taskId)) {
      await client
        .replyBrowser(owner, command.id, { error: 'A browser command is still finishing' })
        .catch(() => undefined)
      return
    }
    const controller = new AbortController()
    running.set(command.taskId, controller)
    if (command.runId) runTasks.set(command.runId, command.taskId)
    const check = () => {
      if (stopped || controller.signal.aborted || version !== generation || client !== getClient())
        throw new Error('The browser connection changed; inspect the page before retrying')
      if (Date.now() >= command.expiresAt) throw new Error('Browser command expired')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const canceled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          close(command.taskId, false)
          reject(new Error('Browser command canceled or expired; inspect the page before retrying'))
        },
        { once: true },
      )
      timer = setTimeout(() => controller.abort(), Math.max(0, command.expiresAt - Date.now()))
    })
    try {
      const { capture, ...result } = await Promise.race([execute(command, check), canceled])
      check()
      await Promise.race([
        capture
          ? client.uploadBrowserCapture(owner, command.id, capture)
          : client.replyBrowser(owner, command.id, { result }),
        canceled,
      ])
      check()
      if (activeTask === command.taskId && command.request.action === 'open')
        onSelect(command.taskId, command.app)
    } catch (error) {
      void client
        .replyBrowser(owner, command.id, {
          error: error instanceof Error ? error.message.slice(0, 1000) : 'Browser command failed',
        })
        .catch(() => undefined)
    } finally {
      clearTimeout(timer)
      if (running.get(command.taskId) === controller) running.delete(command.taskId)
      if (command.runId) runTasks.delete(command.runId)
    }
  }
  const loop = async () => {
    while (!stopped) {
      const client = getClient()
      const version = generation
      try {
        const command = await client.pollBrowser(owner)
        if (stopped) break
        if (client !== getClient() || version !== generation) continue
        if (command) void run(command, client, version)
      } catch {
        invalidate()
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
  }
  void loop()
  return {
    disconnected: invalidate,
    reconnected() {
      invalidate()
      for (const taskId of sessions.keys()) reconcile(taskId)
    },
    ended(runId: string) {
      const taskId = runTasks.get(runId)
      if (taskId) running.get(taskId)?.abort()
    },
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
      reconcile(taskId)
    },
    close() {
      stopped = true
      invalidate()
      hide()
      for (const id of sessions.keys()) close(id)
    },
  }
}
