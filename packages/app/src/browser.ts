import { randomUUID } from 'node:crypto'
import {
  type BrowserCommand,
  type DaemonClient,
  DaemonRequestError,
  type TaskApp,
} from '@ted/protocol'
import { isLoopbackUrl } from '@ted/protocol/app'
import type { BrowserWindow, Session, WebContentsView } from 'electron'
import {
  closeGuest,
  type GuestPage,
  openGuest,
  type PageResult,
  runOnPage,
} from './browser-page.ts'

type Page = GuestPage & { app: TaskApp; view: WebContentsView }

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
  onSelect: (taskId: string, app: TaskApp) => void,
  electron: BrowserViews,
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
          opened = Object.assign(guest, { app, view: view as WebContentsView })
          pages.set(taskId, opened)
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
    return runOnPage(
      page,
      { request: command.request, expiresAt: command.expiresAt, url: command.app.url as string },
      {
        check,
        current: () => pages.get(command.taskId) === page,
        closeAfterPartialInput: () => close(command.taskId, false),
      },
    )
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
      if (!page?.ready && running.has(taskId))
        return { url: '', text: 'Opening…', opening: true as const }
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
