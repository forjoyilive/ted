import { randomUUID } from 'node:crypto'
import {
  type BrowserCommand,
  type BrowserResult,
  type DaemonClient,
  DaemonRequestError,
  type PreviewSize,
  previewSize,
  previewSizeLabel,
  previewSizeOf,
  previewSizeValue,
  type TaskApp,
} from '@ted/protocol'
import { isLoopbackUrl } from '@ted/protocol/app'
import { isNumber, isString } from '@ted/protocol/parse'
import type { BrowserWindow, Session, WebContentsView } from 'electron'
import {
  closeGuest,
  type GuestPage,
  openGuest,
  type PageResult,
  runOnPage,
} from './browser-page.ts'
import type { GuestProxyRules } from './browser-proxy.ts'
import { applyEmulation, type PreviewEmulation, previewEmulation } from './preview-emulation.ts'

type Page = GuestPage & {
  app: TaskApp
  view: WebContentsView
  emulation?: PreviewEmulation
  originalAgent?: string
  frameHeight?: number
  zoom?: number
}

interface ChosenSize {
  size: PreviewSize
  byAgent: boolean
}

export type BrowserNotice =
  | { type: 'select'; taskId: string; app: TaskApp }
  | { type: 'history'; taskId: string; app: TaskApp; canGoBack: boolean; canGoForward: boolean }

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViews {
  session: Pick<typeof import('electron').session, 'fromPartition'>
  WebContentsView: typeof import('electron').WebContentsView
}

async function stopSessionWorkers(ses: Session, electron: BrowserViews) {
  await ses.clearStorageData({ storages: ['serviceworkers'] })
  if (Object.keys(ses.serviceWorkers.getAllRunning()).length === 0) return
  // Unregistering does not stop a worker kept alive by event.waitUntil().
  // Electron closes a view’s page when the view is garbage collected, which fails a command
  // still waiting on it, so every use below goes through the view to keep it referenced.
  const view = new electron.WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const closeControl = () => {
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
  }
  // Chromium gives up on a worker that won’t stop after 5 s and only then answers, so wait longer.
  const timer = setTimeout(closeControl, 10_000)
  try {
    await view.webContents.loadURL('about:blank')
    view.webContents.debugger.attach('1.3')
    await view.webContents.debugger.sendCommand('ServiceWorker.enable')
    await view.webContents.debugger.sendCommand('ServiceWorker.stopAllWorkers')
  } finally {
    clearTimeout(timer)
    closeControl()
  }
}

export function createTaskBrowsers(
  getWindow: () => BrowserWindow | undefined,
  getClient: () => DaemonClient,
  notify: (notice: BrowserNotice) => void,
  electron: BrowserViews,
  timing: { captureMs?: number; reloadMs?: number } = {},
  proxy?: GuestProxyRules,
) {
  const pages = new Map<string, Page>()
  const sessions = new Map<string, { session: Session; apps: Map<string, TaskApp> }>()
  const appKey = (app: TaskApp) => JSON.stringify([app.repo, app.name])
  const sizes = new Map<string, Map<string, ChosenSize>>()
  const sizeFor = (taskId: string, app: TaskApp): ChosenSize =>
    sizes.get(taskId)?.get(appKey(app)) ?? { size: previewSizeOf(app.preview), byAgent: false }
  const emulate = async (page: Page, taskId: string) => {
    const contents = page.view.webContents
    if (contents.isDestroyed()) return
    const next = previewEmulation(
      sizeFor(taskId, page.app).size,
      page.frameHeight ?? 720,
      page.zoom ?? 1,
    )
    page.originalAgent ??= contents.getUserAgent()
    const settle = () => {
      page.emulation = next
      page.inputScale = next.metrics?.scale ?? 1
      page.touch = next.device !== undefined
    }
    let reloading = false
    try {
      await applyEmulation(
        {
          send: (method, params) => contents.debugger.sendCommand(method, params),
          reload: () =>
            new Promise<void>((resolve, reject) => {
              reloading = true
              const done = () => {
                contents.off('did-stop-loading', done)
                resolve()
              }
              contents.on('did-stop-loading', done)
              AbortSignal.timeout(timing.reloadMs ?? 15_000).addEventListener('abort', () => {
                contents.off('did-stop-loading', done)
                reject(
                  new Error(
                    'The page didn’t finish loading at its new size; take a snapshot to check it',
                  ),
                )
              })
              contents.reload()
            }),
          loaded: () => !['', 'about:blank'].includes(contents.getURL()),
        },
        page.emulation,
        next,
        page.originalAgent,
      )
    } catch (error) {
      if (reloading) settle()
      throw error
    }
    settle()
  }
  let activeTask: string | undefined
  let shown: string | undefined
  let presentation = 0
  let stopped = false
  let generation = 0
  const running = new Map<string, AbortController>()
  const commands = new Map<string, AbortController>()
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
      closeGuest(page)
    }
    if (forget) {
      const ses = sessions.get(id)
      sessions.delete(id)
      if (ses) {
        ses.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
        void stopSessionWorkers(ses.session, electron)
          .finally(() => ses.session.clearStorageData())
          .catch(() => undefined)
      }
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
    const previousSession = sessions.get(taskId)
    await valid(taskId, app)
    check()
    if (sessions.get(taskId) !== previousSession)
      throw new Error('The Task’s browser session changed; reopen the App')
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
      sessions.get(taskId)?.session ?? electron.session.fromPartition(`ted-browser-${randomUUID()}`)
    const reused = sessions.has(taskId)
    const retainedSession = sessions.get(taskId) ?? {
      session: ses,
      apps: new Map<string, TaskApp>(),
    }
    retainedSession.apps.set(appKey(app), app)
    sessions.set(taskId, retainedSession)
    const checkSession = () => {
      check()
      if (sessions.get(taskId) !== retainedSession)
        throw new Error('The Task’s browser session changed; reopen the App')
    }
    if (reused) {
      await stopSessionWorkers(ses, electron)
      checkSession()
      await ses.closeAllConnections()
      checkSession()
    }
    let opened: Page | undefined
    let view: WebContentsView | undefined
    try {
      return (await openGuest(ses, app.url as string, {
        check: checkSession,
        ...(proxy && { proxy }),
        host: (webPreferences) => {
          const created = new electron.WebContentsView({ webPreferences })
          created.setBounds({ x: 0, y: 0, width: 1024, height: 720 })
          view = created
          return {
            contents: created.webContents,
            resize: (width, height) => created.setBounds({ x: 0, y: 0, width, height }),
          }
        },
        created: (guest) => {
          const page: Page = Object.assign(guest, { app, view: view as WebContentsView })
          const { capture: plain, script } = page.driver
          page.driver = {
            ...page.driver,
            capture: async () => {
              const metrics = page.emulation?.metrics
              if (!metrics) return plain()
              const contents = page.view.webContents
              const shot = async () => {
                const density = await script('devicePixelRatio').catch(() => undefined)
                if (!isNumber(density) || !Number.isFinite(density) || density <= 0)
                  return undefined
                // Chromium lays out a page without a viewport meta tag wider than a mobile frame
                // and zooms it out to fit; the capture’s clip is in unzoomed page pixels.
                const zoom = await script('visualViewport ? visualViewport.scale : 1').catch(
                  () => undefined,
                )
                if (!isNumber(zoom) || !Number.isFinite(zoom) || zoom <= 0) return undefined
                // A view that isn’t on screen may not draw a frame for the debugger’s capture;
                // a capture that stays hidden makes it draw without showing it.
                void contents
                  .capturePage(undefined, { stayHidden: true, stayAwake: true })
                  .catch(() => undefined)
                const { data } = await contents.debugger.sendCommand('Page.captureScreenshot', {
                  format: 'png',
                  clip: {
                    x: 0,
                    y: 0,
                    width: metrics.width / zoom,
                    height: metrics.height / zoom,
                    scale: zoom / density,
                  },
                })
                return isString(data) ? data : undefined
              }
              const data = await Promise.race([
                shot(),
                new Promise<undefined>((resolve) =>
                  AbortSignal.timeout(timing.captureMs ?? 5_000).addEventListener('abort', () =>
                    resolve(undefined),
                  ),
                ),
              ])
              if (data === undefined)
                throw new Error('Couldn’t capture the page at its preview size; try again')
              return new Uint8Array(Buffer.from(data, 'base64'))
            },
          }
          opened = page
          pages.set(taskId, opened)
          const contents = page.view.webContents
          const report = () => {
            if (!page.ready || pages.get(taskId) !== page || contents.isDestroyed()) return
            notify({
              type: 'history',
              taskId,
              app: page.app,
              canGoBack: contents.navigationHistory.canGoBack(),
              canGoForward: contents.navigationHistory.canGoForward(),
            })
          }
          contents.on('did-navigate', report)
          contents.on('did-navigate-in-page', report)
        },
        beforeLoad: async () => {
          if (opened) await emulate(opened, taskId)
        },
        gone: () => {
          if (opened && pages.get(taskId) === opened) close(taskId)
        },
      })) as Page
    } catch (error) {
      if (opened && pages.get(taskId) === opened) close(taskId, false)
      throw error
    }
  }
  const execute = async (command: BrowserCommand, check: () => void): Promise<PageResult> => {
    check()
    if (command.request.action === 'resize' || command.request.action === 'color-scheme')
      throw new Error('resize and color-scheme work only in an Automation Run’s browser')
    if (command.runId && (await getClient().getRun(command.runId)).run.state === 'finished')
      throw new Error('This Run has ended')
    const page = await ensure(command.taskId, command.app, check)
    check()
    if (command.request.action === 'size') {
      const size = previewSize(command.request.value ?? '')
      if (isString(size)) throw new Error(size)
      const chosen = sizes.get(command.taskId) ?? new Map<string, ChosenSize>()
      chosen.set(appKey(page.app), { size, byAgent: command.runId !== undefined })
      sizes.set(command.taskId, chosen)
      await emulate(page, command.taskId)
      return {
        url: page.view.webContents.getURL(),
        text: `Preview size: ${previewSizeLabel(size)}`,
        ...historyOf(page),
      }
    }
    const result = await runOnPage(
      page,
      { request: command.request, expiresAt: command.expiresAt, url: command.app.url as string },
      {
        check,
        current: () => pages.get(command.taskId) === page,
        closeAfterPartialInput: () => close(command.taskId, false),
      },
    )
    return { ...result, ...historyOf(page) }
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
    commands.set(command.id, controller)
    if (command.runId) runTasks.set(command.runId, command.taskId)
    const check = () => {
      if (stopped || controller.signal.aborted || version !== generation || client !== getClient())
        throw new Error('The browser connection changed; inspect the page before retrying')
      if (Date.now() >= command.expiresAt) throw new Error('Browser command expired')
    }
    const release = () => {
      if (running.get(command.taskId) === controller) running.delete(command.taskId)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const canceled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          const holder = running.get(command.taskId)
          if (!holder || holder === controller) close(command.taskId, false)
          reject(new Error('Browser command canceled or expired; inspect the page before retrying'))
        },
        { once: true },
      )
      timer = setTimeout(() => controller.abort(), Math.max(0, command.expiresAt - Date.now()))
    })
    try {
      const { capture, ...result } = await Promise.race([execute(command, check), canceled])
      check()
      release()
      await Promise.race([
        capture
          ? client.uploadBrowserCapture(owner, command.id, capture)
          : client.replyBrowser(owner, command.id, { result }),
        canceled,
      ])
      check()
      if (activeTask === command.taskId && command.request.action === 'open')
        notify({ type: 'select', taskId: command.taskId, app: command.app })
    } catch (error) {
      void client
        .replyBrowser(owner, command.id, {
          error: error instanceof Error ? error.message.slice(0, 1000) : 'Browser command failed',
        })
        .catch(() => undefined)
    } finally {
      clearTimeout(timer)
      release()
      commands.delete(command.id)
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
        if (command?.canceled) {
          commands.get(command.id)?.abort()
          void client.replyBrowser(owner, command.id, { canceled: true }).catch(() => undefined)
        } else if (command) void run(command, client, version)
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
    async present(taskId: string, bounds: BrowserBounds, zoom: number) {
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
      page.frameHeight = Math.max(1, Math.round(bounds.height))
      page.zoom = zoom
      await emulate(page, taskId).catch(() => undefined)
      if (version !== presentation) return
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
      if (!page?.ready && running.has(taskId))
        return { url: '', text: 'Opening…', opening: true as const }
      if (!page) return { url: '', text: 'Open a running web App' }
      await valid(taskId, page.app)
      const chosen = sizeFor(taskId, page.app)
      const history = page.view.webContents.navigationHistory
      return {
        url: page.view.webContents.getURL(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
        text: page.ready ? (page.error ?? 'Ready') : 'Opening…',
        size: previewSizeValue(chosen.size),
        ...(chosen.byAgent && { sizeByAgent: true as const }),
        blocked: page.blocked,
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

function historyOf(page: Page): Pick<BrowserResult, 'canGoBack' | 'canGoForward'> {
  const contents = page.view.webContents
  if (contents.isDestroyed()) return {}
  return {
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  }
}
