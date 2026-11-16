import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { executionHome } from '@ted/daemon/execution'
import {
  clearQuit,
  crashReport,
  type DaemonConnection,
  type DaemonSupervisor,
  daemonRestartDelaysMs,
  markQuit,
  stopTedProcesses,
  superviseDaemon,
  watchExitWith,
} from '@ted/daemon/launch'
import { processMemory } from '@ted/daemon/process-memory'
import {
  type Activity,
  type Banner,
  countWaiting,
  type DaemonClient,
  type DaemonEvent,
  defaultMachineSettings,
  downloadUrl,
  edition,
  type Factory,
  isLoopbackUrl,
  linearKeyPage,
  type MachineSettings,
  newIssueUrl,
  noActivity,
  parseAsanaTaskUrl,
  parseGitHubIssueUrl,
  parseLinearUrl,
  remoteExecutionOn,
  tedEnv,
  tedHome,
  tedPaths,
  tedVersion,
  type WaitingRequest,
} from '@ted/protocol'
import { factoryIconEmojiOf } from '@ted/protocol/factory-icon'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  nativeTheme,
  type OpenDialogOptions,
  session,
  shell,
  Tray,
} from 'electron'
import { appIconPng } from './app-icon.ts'
import { authorizeAsana } from './asana.ts'
import { showAttachmentInFolder } from './attachment-preview.ts'
import {
  appMenu,
  appName,
  closeNotice,
  dockBadge,
  type MenuCommand,
  type MenuEntry,
  type MenuState,
  type Platform,
  quitAnswer,
  quitDialog,
  quitPlan,
  statusMenu,
  trayLabel,
  trayToolTip,
  trayWarning,
  windowTitle,
} from './background.ts'
import { createTaskBrowsers } from './browser.ts'
import type { CustomHandlers, CustomRequests } from './custom-requests.ts'
import { getAutomation, taskBrief } from './daemon-adapters.ts'
import { forwardDaemonRequest, isForwardedRequest } from './daemon-requests.ts'
import { saveFactoryExport } from './export.ts'
import { openIntegrationInstructions } from './integration-instructions.ts'
import {
  createLoginItem,
  type LoginItem,
  recordLoginItem,
  startsInBackground,
} from './login-item.ts'
import {
  createNotifications,
  type NotificationAsk,
  type NotificationOffer,
  type Notifier,
  notificationOffer,
  notificationsAllowed,
  notificationsOnNotice,
  recordingNotifier,
  silentNotifier,
} from './notifications.ts'
import {
  isFigmaLink,
  keepFramesInPlace,
  registerPrototypeScheme,
  servePrototypes,
} from './prototype.ts'
import { nextReturn } from './renderer/banners.ts'
import { thirdPartyLicenses } from './third-party.ts'
import { dotPng, trayIconPng } from './tray-icon.ts'
import { fileLog, handleUncaught, ignoreBrokenPipes, startupLog, watchParent } from './uncaught.ts'
import { testFeedSource } from './update-source.ts'
import {
  allowedUpdateUrl,
  createUpdates,
  electronUpdateSource,
  failedUpdate,
  type MakeSource,
  type UpdateStatus,
  type Updates,
  updateMenuVersion,
} from './updates.ts'
import { openMarkdownLink } from './web-link.ts'
import { createWorkerWindow } from './worker-window.ts'

const githubLink =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/pull\/\d+|\/blob\/[A-Za-z0-9_.%-]+\/\.ted\/[A-Za-z0-9_./-]+(?:#L\d+)?)?$/
const backupName = /^(pre-update|daily|before-restore)-\d{8}(-\d{6})?(-\d+)?$/

const requests = {
  showAttachmentInFolder: (client, attachment) =>
    showAttachmentInFolder(client, attachment, app.getPath('userData'), shell.showItemInFolder),
  taskBrief,
  openMarkdownLink: (_client, url) => openMarkdownLink(url, shell.openExternal),
  openTaskSource: async (client, taskId) => {
    const task = (await client.listTasks()).find((t) => t.id === String(taskId))
    const link =
      task?.source &&
      (parseLinearUrl(task.source.url) ??
        parseAsanaTaskUrl(task.source.url) ??
        parseGitHubIssueUrl(task.source.url))
    if (!link) throw new Error('This Task has no Linear issue, Asana task or GitHub issue to open')
    await shell.openExternal(link.url)
  },
  openPullRequest: async (client, taskId, repoName) => {
    const task = (await client.listTasks()).find((t) => t.id === String(taskId))
    const url = task?.repos.find((r) => r.name === String(repoName))?.pullRequest?.url
    if (url === undefined || !/^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(url)) {
      throw new Error('That pull request has no GitHub link')
    }
    await shell.openExternal(url)
  },
  openFigmaLink: async (client, taskId, commentId) => {
    const comment = (await client.listComments(String(taskId))).find(
      (c) => c.id === String(commentId),
    )
    const url = comment?.design?.figma?.url
    if (url === undefined || !isFigmaLink(url)) throw new Error('That design has no Figma link')
    await shell.openExternal(url)
  },
  openAppPreview: async (client, taskId, repo, name) => {
    const app = (await client.listApps(String(taskId))).find(
      (a) => a.repo === String(repo) && a.name === String(name),
    )
    if (app?.url === undefined || app.kind !== 'web' || !isLoopbackUrl(app.url)) {
      throw new Error('That App isn’t running')
    }
    sendToRenderer({
      type: 'browser-open',
      taskId: String(taskId),
      app: { repo: app.repo, name: app.name, browser: true },
    })
  },
  presentBrowser: async (_client, taskId, _repo, _name, bounds) => {
    const rect = bounds
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
      throw new Error('Invalid browser view')
    await taskBrowsers?.present(String(taskId), rect)
  },
  hideBrowser: async (_client, temporary) => taskBrowsers?.hide(temporary === true),
  browserState: async (_client, taskId) => taskBrowsers?.state(String(taskId)),
  externalBrowser: async (_client, taskId) => {
    const url = await taskBrowsers?.external(String(taskId))
    if (url) await shell.openExternal(url)
  },
  openRunAppPreview: async (client, runId, repo, name) => {
    const app = (await client.listRunApps(String(runId))).find(
      (a) => a.repo === String(repo) && a.name === String(name),
    )
    if (app?.url === undefined || app.kind !== 'web' || !isLoopbackUrl(app.url)) {
      throw new Error('That App isn’t running')
    }
    await shell.openExternal(app.url)
  },
  openHostedPreview: async (client, taskId, repoName) => {
    const task = (await client.listTasks()).find((t) => t.id === String(taskId))
    const url = task?.repos.find((r) => r.name === String(repoName))?.pullRequest?.preview?.url
    if (url === undefined || !/^https?:\/\/[^\s]+$/.test(url) || !URL.canParse(url)) {
      throw new Error('That pull request has no preview')
    }
    await shell.openExternal(url)
  },
  exportFactory: (client, factoryId, format) =>
    saveFactoryExport(client, factoryId, format, async (filename, extension) => {
      const options = {
        title: 'Export Factory',
        defaultPath: filename,
        filters: [{ name: extension === 'json' ? 'JSON' : 'Markdown', extensions: [extension] }],
      }
      const chosen = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      return chosen.canceled ? undefined : chosen.filePath
    }),
  chooseFolder: async (_, title) => {
    const options: OpenDialogOptions = {
      title: String(title),
      properties: ['openDirectory'],
    }
    const chosen = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const [folder] = chosen.filePaths
    return chosen.canceled ? undefined : folder
  },
  homeFolder: async () => homedir(),
  showFactoryFolder: async (client, factoryId) => {
    const factory = (await client.listFactories()).find((f) => f.id === String(factoryId))
    const folder = factory?.localFolder
    if (!folder?.found) throw new Error('This Factory has no local folder')
    const error = await shell.openPath(folder.path)
    if (error !== '') throw new Error(error)
  },
  openOnGitHub: async (_, target) => {
    const url = String(target)
    if (!githubLink.test(url)) {
      throw new Error('That isn’t a GitHub repo or pull request link')
    }
    await shell.openExternal(url)
  },
  copyText: async (_, text) => clipboard.writeText(String(text)),
  downloadTed: () => shell.openExternal(downloadUrl),
  thirdPartyLicenses: async () => {
    const root = path.resolve(import.meta.dirname, '../../..')
    return readFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), 'utf8').catch(() =>
      thirdPartyLicenses(root),
    )
  },
  quit: async () => app.quit(),
  copyReport: async (client) => {
    clipboard.writeText((await client.getReport()).text)
  },
  memoryUse: async (client) => {
    const [use, own] = await Promise.all([client.getMemoryUse(), appUsage()])
    return { ...use, app: { count: own.count, bytes: own.memoryBytes } }
  },
  resourceUsage: async (client) => {
    const [usage, own] = await Promise.all([client.getProcessUsage(), appUsage()])
    return {
      cpuPercent: usage.cpuPercent + own.cpuPercent,
      memoryBytes: usage.memoryBytes + own.memoryBytes,
    }
  },
  tedFolder: async () => {
    const folder = tedHome()
    const home = homedir()
    const shown = folder.startsWith(`${home}${path.sep}`) ? `~${folder.slice(home.length)}` : folder
    return { path: `${shown}${path.sep}`, platform: process.platform }
  },
  showBackupInFolder: async (_, name) => {
    const backup = String(name)
    if (!backupName.test(backup)) throw new Error('no such backup')
    shell.showItemInFolder(path.join(tedPaths(tedHome()).backups, backup))
  },
  showTedFolder: async () => {
    const error = await shell.openPath(tedHome())
    if (error !== '') throw new Error(error)
  },
  chooseProfilePicture: async (client) => {
    const picture = await choosePicture()
    return picture === undefined
      ? client.getSettings()
      : client.updateSettings({ profilePicture: picture })
  },
  runFix: async (client, request) => {
    const result = await client.runFix(request)
    if ('url' in result) await openIntegrationInstructions(result.url, shell.openExternal)
    return result
  },
  authorizeAsana: (client) => authorizeAsana(client, shell.openExternal),
  openAsanaSetup: () => shell.openExternal('https://app.asana.com/0/my-apps'),
  openLinearKeyPage: () => shell.openExternal(linearKeyPage),
  openWorker: async () => workerWindow.open(),
  getAutomation,
} satisfies CustomHandlers<
  | 'openWorker'
  | 'showAttachmentInFolder'
  | 'taskBrief'
  | 'openTaskSource'
  | 'openPullRequest'
  | 'openFigmaLink'
  | 'openMarkdownLink'
  | 'openAppPreview'
  | 'presentBrowser'
  | 'hideBrowser'
  | 'browserState'
  | 'externalBrowser'
  | 'openHostedPreview'
  | 'openRunAppPreview'
  | 'exportFactory'
  | 'chooseFolder'
  | 'homeFolder'
  | 'showFactoryFolder'
  | 'openOnGitHub'
  | 'copyText'
  | 'downloadTed'
  | 'thirdPartyLicenses'
  | 'quit'
  | 'copyReport'
  | 'memoryUse'
  | 'resourceUsage'
  | 'tedFolder'
  | 'showBackupInFolder'
  | 'showTedFolder'
  | 'chooseProfilePicture'
  | 'runFix'
  | 'authorizeAsana'
  | 'openAsanaSetup'
  | 'openLinearKeyPage'
  | 'getAutomation'
>

async function appUsage(): Promise<{ count: number; cpuPercent: number; memoryBytes: number }> {
  const metrics = app.getAppMetrics()
  const memory = await processMemory(metrics.map((metric) => metric.pid))
  return {
    count: metrics.length,
    cpuPercent: metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0),
    memoryBytes: metrics.reduce((sum, metric) => sum + (memory.get(metric.pid) ?? 0), 0),
  }
}

const pictureSize = 256

async function choosePicture(): Promise<string | undefined> {
  const options = {
    title: 'Choose a profile picture',
    properties: ['openFile' as const],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp'] }],
  }
  const { canceled, filePaths } = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  const file = filePaths[0]
  if (canceled || file === undefined) return undefined
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error('TED couldn’t read that picture.')
  const { width, height } = image.getSize()
  const side = Math.min(width, height)
  const square = image.crop({
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    width: side,
    height: side,
  })
  const size = Math.min(side, pictureSize)
  return square.resize({ width: size, height: size, quality: 'best' }).toDataURL()
}

const remoteExecution = remoteExecutionOn()
const workerOnly = remoteExecution && process.argv.includes('--worker')
const platform = process.platform as Platform
const hiddenWindow = tedEnv('TED_HIDDEN_WINDOW') === '1' || tedEnv('TED_ELECTRON_HIDDEN') === '1'

const testLaunch = hiddenWindow || tedEnv('TED_EXIT_WITH_PID') !== undefined
const appLogFolder = workerOnly ? executionHome() : tedPaths(tedHome()).logs
const logUncaught = fileLog(path.join(appLogFolder, 'app.log'))
const traceStartup = startupLog(path.join(appLogFolder, 'app-startup.log'), testLaunch)
traceStartup('main-evaluated')

watchExitWith(() => app.exit(0))
if (testLaunch) watchParent(() => app.exit(0))
ignoreBrokenPipes([process.stdout, process.stderr], (error) => {
  logUncaught('Lost stdout or stderr:', error)
  if (testLaunch) app.exit(0)
})

process.on('uncaughtException', (error) => {
  handleUncaught(error, {
    hidden: testLaunch,
    log: logUncaught,
    show: (title, detail) => dialog.showErrorBox(title, detail),
  })
})

const testAppToken = app.isPackaged ? undefined : tedEnv('TED_APP_TOKEN')
delete process.env.TED_APP_TOKEN
const skipFirstLaunch = !app.isPackaged && tedEnv('TED_SKIP_FIRST_LAUNCH') === '1'
delete process.env.TED_SKIP_FIRST_LAUNCH
const testUpdateFeed = app.isPackaged ? undefined : tedEnv('TED_UPDATE_FEED')
const testUpdateLog = tedEnv('TED_UPDATE_LOG')
delete process.env.TED_UPDATE_FEED
delete process.env.TED_UPDATE_LOG
const updateCheckEveryMs = 4 * 60 * 60_000
const firstUpdateCheckMs = 10_000

const restartDelaysMs = tedEnv('TED_RESTART_DELAYS_MS')?.split(',').map(Number) ?? [
  ...daemonRestartDelaysMs,
]
const keepsStopping = 'TED’s background process keeps stopping'

const workerWindow = createWorkerWindow(remoteExecution, hiddenWindow)
const workerRequests = {
  workerStatus: () => workerWindow.status(),
  workerPair: (input: unknown) => workerWindow.pair(input),
  workerStart: () => workerWindow.start(),
  workerStop: () => workerWindow.stop(),
  quit: async () => app.quit(),
}
function workerRequest(name: unknown, args: unknown[]) {
  if (typeof name !== 'string' || !Object.hasOwn(workerRequests, name))
    throw new Error('Unknown worker request')
  return (
    workerRequests[name as keyof typeof workerRequests] as (...args: unknown[]) => Promise<unknown>
  )(...args)
}

let supervisor: DaemonSupervisor | undefined
let client: DaemonClient | undefined
let taskBrowsers: ReturnType<typeof createTaskBrowsers> | undefined
let window: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let state: MenuState = { activity: noActivity, waiting: 0, banners: [] }
let settings: MachineSettings = defaultMachineSettings
let bannerTimer: NodeJS.Timeout | undefined
let loginItem: LoginItem | undefined
let loginItemApplied: boolean | undefined
let loginItemWork: Promise<void> = Promise.resolve()
let updates: Updates | undefined
let updateStatus: UpdateStatus = { state: 'unavailable' }

const loginItemsPane = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'

const sendToRenderer = (event: unknown) => window?.webContents.send('ted:event', event)

function applySettings(next: MachineSettings): void {
  settings = next
  nativeTheme.themeSource = next.appearance
  if (next.firstLaunchDone && next.startAtLogin !== loginItemApplied) {
    void applyLoginItem(next.startAtLogin)
  }
}

function applyLoginItem(enabled: boolean): Promise<void> {
  loginItemApplied = enabled
  loginItemWork = loginItemWork
    .then(async () => {
      if (!loginItem) return
      sendToRenderer({ type: 'login-item', state: await loginItem.apply(enabled) })
    })
    .catch((error: unknown) => console.error('Start at login failed:', error))
  return loginItemWork
}

function makeLoginItem(): LoginItem {
  const log = tedEnv('TED_LOGIN_ITEM_LOG')
  if (log) return recordLoginItem(log, tedEnv('TED_LOGIN_ITEM_STATUS'))
  return createLoginItem({
    platform: process.platform,
    packaged: app.isPackaged && edition === 'release',
    macVersion: Number.parseInt(process.getSystemVersion(), 10),
    executable: process.env.APPIMAGE || process.execPath,
    autostartDir: path.join(
      process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
      'autostart',
    ),
    getLoginItemSettings: (options) => app.getLoginItemSettings(options),
    setLoginItemSettings: (options) => app.setLoginItemSettings(options),
  })
}

function forward(event: DaemonEvent): void {
  const drawn = state
  if (event.type === 'run-updated' && event.run.state === 'finished')
    taskBrowsers?.ended(event.run.id)
  if (event.type === 'apps-changed' || event.type === 'task-deleted' || event.type === 'task-reset')
    taskBrowsers?.changed(event.taskId)
  if (event.type === 'task-updated') taskBrowsers?.changed(event.task.id)
  if (event.type === 'settings-changed') applySettings(event.settings)
  if (event.type === 'data-status' && event.status.state === 'ready') {
    loadState().catch((error: unknown) => console.error('loading settings failed:', error))
  }
  if (event.type === 'activity-changed') state = { ...state, activity: event.activity }
  if (event.type === 'factory-added' || event.type === 'factory-updated') noteFactory(event.factory)
  if (event.type === 'factory-removed') factoryEmoji.delete(event.factoryId)
  if (event.type === 'inbox-changed') {
    state = { ...state, waiting: countWaiting(event.waiting) }
    notifications.waiting(event.waiting)
  }
  if (event.type === 'banner-raised' || event.type === 'banner-updated') {
    state = {
      ...state,
      banners: [...state.banners.filter((b) => b.id !== event.banner.id), event.banner],
    }
  }
  if (event.type === 'banner-cleared') {
    state = { ...state, banners: state.banners.filter((b) => b.id !== event.id) }
  }
  if (event.type === 'banner-raised') notifications.problem(event.banner)
  if (event.type === 'task-updated') notifications.merged(event.task)
  if (event.type === 'ted-stops-changed') {
    noteTedStops().catch((error: unknown) => console.error('reading stopped Tasks failed:', error))
  }
  if (event.type === 'open-requested') showWindow()
  else sendToRenderer(event)
  if (state !== drawn || event.type === 'settings-changed') refresh()
}

interface NotificationState extends NotificationAsk {
  off: boolean
}

const notificationFile = () => path.join(app.getPath('userData'), 'notifications.json')

function readNotificationState(): NotificationState {
  try {
    const saved = JSON.parse(readFileSync(notificationFile(), 'utf8')) as Partial<NotificationState>
    return {
      asked: saved.asked === true,
      declined: saved.declined === true,
      off: saved.off === true,
    }
  } catch {
    return { asked: false, declined: false, off: false }
  }
}

let notificationState: NotificationState | undefined
let notificationOffered = false

function currentNotificationState(): NotificationState {
  notificationState ??= readNotificationState()
  return notificationState
}

function currentNotificationOffer(): NotificationOffer {
  return notificationOffer(currentNotificationState(), platform === 'darwin', notificationOffered)
}

function saveNotificationState(changes: Partial<NotificationState>): void {
  const before = currentNotificationState()
  const offerBefore = currentNotificationOffer()
  const next = { ...before, ...changes }
  if (next.asked === before.asked && next.declined === before.declined && next.off === before.off)
    return
  notificationState = next
  writeFile(notificationFile(), JSON.stringify(next)).catch((error: unknown) =>
    console.error('saving the notification state failed:', error),
  )
  if (next.off !== before.off) sendToRenderer({ type: 'notifications-off', off: next.off })
  const offer = currentNotificationOffer()
  if (offer !== offerBefore) sendToRenderer({ type: 'notification-offer', offer })
}

const mayNotify = () =>
  notificationsAllowed(platform === 'darwin', currentNotificationState().asked)

function offerNotifications(): void {
  if (notificationOffered) return
  notificationOffered = true
  const offer = currentNotificationOffer()
  if (offer === 'offered') sendToRenderer({ type: 'notification-offer', offer })
}

function answerNotificationOffer(turnOn: boolean): void {
  notificationOffered = false
  saveNotificationState(turnOn ? { asked: true, declined: false } : { declined: true })
  sendToRenderer({ type: 'notification-offer', offer: currentNotificationOffer() })
  if (turnOn) notifier.show({ ...notificationsOnNotice, silent: !settings.notifySound }, showWindow)
}

const liveNotifications = new Set<Notification>()

function electronNotifier(): Notifier {
  return {
    show(notice, onClick) {
      if (!Notification.isSupported()) {
        saveNotificationState({ off: true })
        return { close: () => undefined }
      }
      const shown = new Notification(notice)
      liveNotifications.add(shown)
      shown.on('click', onClick)
      shown.on('show', () => saveNotificationState({ off: false }))
      shown.on('failed', () => saveNotificationState({ off: true }))
      shown.on('close', () => liveNotifications.delete(shown))
      shown.show()
      return {
        close: () => {
          liveNotifications.delete(shown)
          shown.close()
        },
      }
    },
    badge(count) {
      if (platform === 'darwin') app.dock?.setBadge(dockBadge(count))
      if (platform === 'linux') app.setBadgeCount(count)
    },
  }
}

function makeNotifier(): Notifier {
  const log = tedEnv('TED_NOTIFY_LOG')
  if (log) {
    const failing = tedEnv('TED_NOTIFY_STATUS') === 'off'
    return recordingNotifier(log, () => saveNotificationState({ off: true }), failing)
  }
  return hiddenWindow ? silentNotifier : electronNotifier()
}

const notifier = makeNotifier()

const factoryEmoji = new Map<string, string>()

function noteFactory(factory: Factory): void {
  const emoji = factoryIconEmojiOf(factory.icon)
  if (emoji === undefined) factoryEmoji.delete(factory.id)
  else factoryEmoji.set(factory.id, emoji)
}

const notifications = createNotifications({
  notifier,
  settings: () => settings,
  open: (notice) => run(notice.opens),
  asksPermission: platform === 'darwin',
  asked: () => currentNotificationState().asked,
  markAsked: () => saveNotificationState({ asked: true }),
  offer: offerNotifications,
  factoryEmoji: (factoryId) => factoryEmoji.get(factoryId),
})

const notificationsPane =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=design.kriya.ted'

function run(command: MenuCommand): void {
  if (command.kind === 'quit') return void requestQuit()
  if (command.kind === 'restart-to-update') return void restartToUpdate()
  if (command.kind === 'report-problem') return void reportProblem()
  showWindow()
  if (command.kind !== 'open-ted') sendToRenderer({ type: 'menu-command', command })
}

async function reportProblem(): Promise<void> {
  const report = await client?.getReport().catch(() => undefined)
  if (report) clipboard.writeText(report.text)
  await shell.openExternal(newIssueUrl(report !== undefined))
}

function toElectron(entries: MenuEntry[]): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    if (entry.type === 'separator') return { type: 'separator' }
    if (entry.type === 'role') return { role: entry.role }
    if (entry.type === 'submenu') {
      return entry.submenu.length === 0 && entry.role !== undefined
        ? { role: entry.role }
        : {
            label: entry.label,
            ...(entry.role === 'help' && { role: 'help' }),
            submenu: toElectron(entry.submenu),
          }
    }
    const { command, dot } = entry
    return {
      label: entry.label,
      enabled: entry.enabled,
      ...(entry.accelerator !== undefined && { accelerator: entry.accelerator }),
      ...(dot !== undefined && { icon: image(dotPng(dot, 2)) }),
      ...(command !== undefined && { click: () => run(command) }),
    }
  })
}

function image(png: Buffer): Electron.NativeImage {
  return nativeImage.createFromBuffer(png, { scaleFactor: 2 })
}

function wantsTray(): boolean {
  if (hiddenWindow) return false
  return platform === 'darwin' || (platform === 'linux' && settings.showTrayIcon)
}

function refresh(): void {
  const now = new Date()
  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectron(appMenu(platform, state, now))))
  const { waiting } = state
  notifier.badge(waiting)
  window?.setTitle(windowTitle(platform, waiting))

  if (!wantsTray()) {
    tray?.destroy()
    tray = undefined
  } else {
    const warning = trayWarning(state.banners, now)
    const icon = image(trayIconPng({ scale: 2, warning }))
    icon.setTemplateImage(!warning)
    tray ??= new Tray(icon)
    tray.setImage(icon)
    if (platform === 'darwin') tray.setTitle(trayLabel(waiting))
    tray.setToolTip(trayToolTip(waiting))
    tray.setContextMenu(Menu.buildFromTemplate(toElectron(statusMenu(state, now))))
  }

  clearTimeout(bannerTimer)
  const returns = nextReturn(state.banners, now)
  if (returns !== undefined) {
    bannerTimer = setTimeout(refresh, Math.min(returns - now.getTime() + 50, 2 ** 31 - 1))
    bannerTimer.unref()
  }
}

function showWindow(): void {
  if (hiddenWindow) return
  if (platform === 'darwin') void app.dock?.show()
  if (!window || window.isDestroyed()) return void createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

const noticeFile = () => path.join(app.getPath('userData'), 'background-notice-shown')

async function closeToBackground(): Promise<void> {
  window?.hide()
  const status = updates?.status
  if (status?.state === 'ready' && !status.asksPassword) {
    await writeFile(backgroundMarker(), '')
    return restartToUpdate()
  }
  const notice = closeNotice(platform, existsSync(noticeFile()))
  if (!notice || hiddenWindow || !mayNotify()) return
  new Notification(notice).show()
  await writeFile(noticeFile(), '')
}

function keepRunningInBackground(): void {
  window?.hide()
  if (platform === 'darwin') app.dock?.hide()
}

const backgroundMarker = () => path.join(app.getPath('userData'), 'start-in-background')
const pendingUpdateFile = () => path.join(app.getPath('userData'), 'pending-update')

async function takeFile(file: string): Promise<string | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text !== undefined) await rm(file, { force: true })
  return text?.trim()
}

function packageType(): string | undefined {
  if (!app.isPackaged || platform !== 'linux' || process.env.APPIMAGE) return undefined
  try {
    return readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    return undefined
  }
}

async function updateSource(asksPassword: boolean): Promise<MakeSource | undefined> {
  if (testUpdateFeed) {
    return testFeedSource(testUpdateFeed, {
      current: tedVersion,
      log: testUpdateLog ?? path.join(tedHome(), 'update.log'),
      exit: () => app.exit(0),
    })
  }
  if (!app.isPackaged || edition !== 'release') return undefined
  session
    .fromPartition('electron-updater', { cache: false })
    .webRequest.onBeforeRequest((details, callback) => {
      const allowed = allowedUpdateUrl(details.url)
      if (!allowed) console.error('TED’s updater refused a request to', details.url)
      callback({ cancel: !allowed })
    })
  const { default: updater } = await import('electron-updater')
  return electronUpdateSource(updater.autoUpdater, { installOnQuit: !asksPassword })
}

function showUpdate(status: UpdateStatus): void {
  updateStatus = status
  const version = updateMenuVersion(status)
  const { updateReady: _, ...rest } = state
  state = version === undefined ? rest : { ...rest, updateReady: version }
  sendToRenderer({ type: 'update', status })
  refresh()
}

async function startUpdates(supervised: DaemonSupervisor): Promise<void> {
  const failed = failedUpdate(await takeFile(pendingUpdateFile()), tedVersion)
  const kind = packageType()
  const asksPassword = kind === 'deb' || kind === 'rpm'
  const source = await updateSource(asksPassword)
  if (!source) {
    showUpdate(
      failed !== undefined ? { state: 'failed', version: failed } : { state: 'unavailable' },
    )
    return
  }
  updates = createUpdates({
    source: (emit) => {
      const made = source(emit)
      return {
        check: made.check,
        install: () => {
          quitting = true
          try {
            made.install()
          } catch (error) {
            emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
          }
        },
      }
    },
    current: tedVersion,
    asksPassword,
    ...(failed !== undefined && { failed }),
    onStatus: showUpdate,
    handOver: async (onWork) => {
      await workerWindow.prepareUpdate()
      await supervised.handOver({ onWork })
    },
    markPending: (version) => writeFile(pendingUpdateFile(), version),
    installFailed: async () => {
      quitting = false
      await rm(pendingUpdateFile(), { force: true })
      await supervised.resume()
      workerWindow.resume()
    },
  })
  showUpdate(updates.status)
  const check = () => updates?.check().catch((error: unknown) => console.error(error))
  setTimeout(check, testUpdateFeed ? 0 : firstUpdateCheckMs).unref()
  setInterval(check, updateCheckEveryMs).unref()
}

async function restartToUpdate(): Promise<void> {
  await updates?.restart().catch((error: unknown) => console.error('restart to update:', error))
}

const quitWaitMs = 10_000
const quitExitMs = 5_000

async function quitCompletely(): Promise<void> {
  quitting = true
  try {
    await workerWindow.close()
  } catch (error) {
    quitting = false
    logUncaught('Worker shutdown unresolved:', error)
    if (!testLaunch)
      dialog.showErrorBox(
        'Worker could not stop',
        'The execution service has not confirmed shutdown. Use Stop worker or inspect its isolated service log before quitting.',
      )
    return
  }
  window?.hide()
  if (edition === 'dev' && tedEnv('TED_DEMO') === '1') {
    await supervisor?.handOver({ maxWaitMs: 0 }).catch((error: unknown) => console.error(error))
  } else {
    await markQuit(tedHome()).catch((error: unknown) => console.error('quit mark:', error))
    supervisor?.close()
    const stopped = await Promise.race([
      (client?.shutdown() ?? Promise.reject(new Error('no daemon client'))).then(
        () => true,
        (error: unknown) => {
          console.error(error)
          return false
        },
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), quitWaitMs)),
    ])
    if (!stopped) {
      await stopTedProcesses(tedHome()).catch((error: unknown) =>
        console.error('stopping TED’s processes:', error),
      )
    }
  }
  setTimeout(() => app.exit(0), quitExitMs)
  app.quit()
}

let quitRequest: Promise<void> | undefined

function requestQuit(): Promise<void> {
  quitRequest ??= decideQuit().finally(() => {
    quitRequest = undefined
  })
  return quitRequest
}

async function decideQuit(): Promise<void> {
  const plan = quitPlan(state.activity, settings.quitWithWorkRunning)
  if (plan === 'stop' || (plan === 'ask' && hiddenWindow)) return quitCompletely()
  if (plan === 'keep-running') return keepRunningInBackground()
  const options = { ...quitDialog(state.activity), type: 'question' as const }
  const parent = window?.isVisible() ? window : undefined
  const { response, checkboxChecked } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  const answer = quitAnswer(response, checkboxChecked)
  if (answer.action === 'cancel') return
  if (answer.remember !== undefined) {
    await client?.updateSettings({ quitWithWorkRunning: answer.remember }).catch(() => undefined)
  }
  if (answer.action === 'stop') return quitCompletely()
  keepRunningInBackground()
}

async function createWindow(): Promise<void> {
  traceStartup('window-create-start')
  const created = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: windowTitle(platform, state.waiting),
    show: !hiddenWindow,
    webPreferences: {
      backgroundThrottling: !hiddenWindow,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window = created
  traceStartup('window-created')
  created.webContents.once('dom-ready', () => traceStartup('renderer-dom-ready'))
  created.webContents.once('did-fail-load', () => traceStartup('renderer-load-failed'))
  created.webContents.once('render-process-gone', () => traceStartup('renderer-process-gone'))
  created.once('unresponsive', () => traceStartup('window-unresponsive'))
  created.on('page-title-updated', (event) => event.preventDefault())
  created.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    void closeToBackground()
  })
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  keepFramesInPlace(created.webContents)
  traceStartup('renderer-load-start')
  await created.loadFile(
    path.join(import.meta.dirname, '../dist/renderer/index.html'),
    remoteExecution ? { query: { remoteExecution: 'on' } } : {},
  )
  traceStartup('renderer-load-finished')
}

let startChecked = false
const startSettled = Promise.withResolvers<void>()

async function startSettings(daemon: DaemonClient, first: boolean): Promise<MachineSettings> {
  let loaded = await daemon.getSettings()
  if (first && loaded.onboardingOnNextOpen && loaded.firstLaunchDone)
    loaded = await daemon.updateSettings({ firstLaunchDone: false })
  if (skipFirstLaunch && !loaded.firstLaunchDone)
    loaded = await daemon.updateSettings({ firstLaunchDone: true })
  return loaded
}

async function loadState(): Promise<void> {
  if (!client) return
  const first = !startChecked
  startChecked = true
  try {
    applySettings(await startSettings(client, first))
  } finally {
    if (first) startSettled.resolve()
  }
  const [activity, banners, waiting, factories]: [Activity, Banner[], WaitingRequest[], Factory[]] =
    await Promise.all([
      client.getActivity(),
      client.listBanners(),
      client.listWaiting(),
      client.listFactories(),
    ])
  factoryEmoji.clear()
  for (const factory of factories) noteFactory(factory)
  state = { ...state, activity, banners, waiting: countWaiting(waiting) }
  notifications.waiting(waiting)
  refresh()
  await noteTedStops().catch((error: unknown) =>
    console.error('reading stopped Tasks failed:', error),
  )
}

let startedInBackground = false

function windowHidden(): boolean {
  if (hiddenWindow) return true
  if (!window || window.isDestroyed()) return startedInBackground
  return !window.isVisible()
}

async function noteTedStops(): Promise<void> {
  if (!client) return
  const stops = await client.tedStops()
  notifications.tedStops(stops.length, windowHidden())
}

async function loadStateWhenReady(): Promise<void> {
  if ((await client?.getDataStatus())?.state === 'ready') await loadState()
}

function onConnection(connection: DaemonConnection): void {
  if (connection.state === 'connected') taskBrowsers?.reconnected()
  else taskBrowsers?.disconnected()
  sendToRenderer({ type: 'connection', connection })
  if (connection.state === 'connected') {
    notifications.forget()
    client = supervisor?.client
    loadStateWhenReady().catch((error: unknown) => console.error('loading state failed:', error))
  } else if (connection.state === 'stopped' && !hiddenWindow && mayNotify()) {
    new Notification({ title: appName, body: keepsStopping }).show()
  }
}

async function start(): Promise<void> {
  traceStartup('app-ready')
  if (workerOnly) {
    ipcMain.handle('ted:request', (event, name: unknown, ...args: unknown[]) => {
      if (!workerWindow.sender(event)) throw new Error('Untrusted worker request sender')
      return workerRequest(name, args)
    })
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: appName,
          submenu: [
            { label: 'Open worker', click: () => void workerWindow.open() },
            { label: 'Quit TED completely', click: () => app.quit() },
          ],
        },
        { role: 'editMenu' },
      ]),
    )
    app.on('window-all-closed', () => undefined)
    app.on('activate', () => void workerWindow.open())
    app.on('second-instance', () => void workerWindow.open())
    app.on('before-quit', (event) => {
      if (quitting) return
      event.preventDefault()
      quitting = true
      void workerWindow.close().then(
        () => app.quit(),
        (error: unknown) => {
          quitting = false
          logUncaught('Worker shutdown unresolved:', error)
          if (!testLaunch)
            dialog.showErrorBox(
              'Worker could not stop',
              'The execution service has not confirmed shutdown. Use Stop worker or inspect its isolated service log before quitting.',
            )
        },
      )
    })
    await workerWindow.open()
    return
  }
  if (platform === 'darwin' && edition === 'dev' && !hiddenWindow) {
    app.dock?.setIcon(nativeImage.createFromBuffer(appIconPng({ size: 512, edition })))
  }
  loginItem = makeLoginItem()
  const background =
    startsInBackground(process.argv) || (await takeFile(backgroundMarker())) !== undefined
  startedInBackground = background
  traceStartup(background ? 'background-mode' : 'window-mode')
  if (background) app.dock?.hide()
  if (tedEnv('TED_DEMO') === '1' && edition === 'dev') {
    const { checkDemoHome } = await import('@ted/daemon/demo')
    if (!(await checkDemoHome(tedHome()))?.complete)
      throw new Error('Prepare the demo home with pnpm app --demo first.')
  }
  traceStartup('daemon-connect-start')
  await clearQuit(tedHome())
  const supervised = await superviseDaemon(tedHome(), {
    app: true,
    ...(testAppToken && { appToken: testAppToken }),
    restartDelaysMs,
    onEvent: forward,
    onConnection,
  })
  traceStartup('daemon-connected')
  supervisor = supervised
  client = supervised.client
  taskBrowsers = createTaskBrowsers(
    () => window,
    () => supervised.client,
    (taskId, app) => {
      sendToRenderer({
        type: 'browser-open',
        taskId,
        app: { repo: app.repo, name: app.name, browser: true },
      })
    },
  )
  servePrototypes((file) => supervised.client.readAttachment(file))
  traceStartup('initial-state-start')
  await loadStateWhenReady()
  traceStartup('initial-state-finished')

  const appRequests = {
    connection: async () => supervised.connection,
    startSettled: () => startSettled.promise,
    loginItem: async () => {
      await loginItemWork
      return loginItem?.state() ?? 'unavailable'
    },
    openLoginItemsSettings: async () => {
      if (platform === 'darwin') await shell.openExternal(loginItemsPane)
    },
    notificationsOff: async () => currentNotificationState().off,
    notificationOffer: async () => currentNotificationOffer(),
    turnOnNotifications: async () => answerNotificationOffer(true),
    declineNotifications: async () => answerNotificationOffer(false),
    openNotificationSettings: async () => {
      if (platform === 'darwin') await shell.openExternal(notificationsPane)
    },
    restartDaemon: () => supervised.restart(),
    updateStatus: async () => updateStatus,
    checkForUpdates: async () => {
      await updates?.check()
      return updateStatus
    },
    restartToUpdate,
    async copyCrashReport() {
      const { connection } = supervised
      await clipboard.writeText(
        await crashReport(tedHome(), {
          version: tedVersion,
          crashes: connection.state === 'stopped' ? connection.crashes : [],
        }),
      )
    },
  } satisfies Pick<
    CustomRequests,
    | 'connection'
    | 'startSettled'
    | 'loginItem'
    | 'openLoginItemsSettings'
    | 'notificationsOff'
    | 'notificationOffer'
    | 'turnOnNotifications'
    | 'declineNotifications'
    | 'openNotificationSettings'
    | 'restartDaemon'
    | 'updateStatus'
    | 'checkForUpdates'
    | 'copyCrashReport'
    | 'restartToUpdate'
  >

  ipcMain.handle('ted:request', (event, name: unknown, ...args: unknown[]) => {
    if (workerWindow.sender(event)) return workerRequest(name, args)
    if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame)
      throw new Error('Untrusted request sender')
    if (typeof name !== 'string') throw new Error('unknown request')
    const appRequest = Object.hasOwn(appRequests, name)
      ? appRequests[name as keyof typeof appRequests]
      : undefined
    if (appRequest) return appRequest()
    const request = Object.hasOwn(requests, name)
      ? requests[name as keyof typeof requests]
      : undefined
    const forwarded = isForwardedRequest(name)
    if (!request && !forwarded) throw new Error(`unknown request ${name}`)
    if (supervised.connection.state !== 'connected') {
      throw new Error('TED’s background process isn’t running')
    }
    if (forwarded) return forwardDaemonRequest(supervised.client, name, args)
    return (request as (client: DaemonClient, ...args: unknown[]) => Promise<unknown>)(
      supervised.client,
      ...args,
    )
  })

  if (hiddenWindow) app.dock?.hide()
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    void requestQuit()
  })
  app.on('will-quit', () => {
    taskBrowsers?.close()
    supervised.close()
  })
  app.on('window-all-closed', () => undefined)
  app.on('activate', showWindow)
  app.on('second-instance', (_event, argv) => {
    if (remoteExecution && argv.includes('--worker')) void workerWindow.open()
    else showWindow()
  })
  refresh()
  traceStartup('updates-start')
  await startUpdates(supervised)
  traceStartup('updates-finished')
  if (background) {
    traceStartup('background-ready')
    return
  }
  await createWindow()
  if (tedEnv('TED_DEMO_STARTED'))
    console.log(`Demo window ready in ${Date.now() - Number(tedEnv('TED_DEMO_STARTED'))} ms`)
}

app.setName(appName)
registerPrototypeScheme()
if (app.isPackaged) process.env.TED_APP_EXECUTABLE = process.env.APPIMAGE || process.execPath
if (workerOnly) {
  await workerWindow.status()
  app.setPath('userData', path.join(executionHome(), 'electron'))
} else if (tedEnv('TED_HOME') || edition !== 'release') {
  app.setPath('userData', path.join(tedHome(), 'electron'))
}

if (!app.requestSingleInstanceLock()) {
  traceStartup('single-instance-refused')
  if (tedEnv('TED_SANDBOX_ELECTRON') === '1') {
    console.error(
      `${appName} couldn’t take its single-instance lock inside TED’s sandbox, so it can’t start.`,
    )
    app.exit(1)
  } else app.exit(0)
} else {
  // Electron emits 'ready' only after this module finishes evaluating, so a top-level await deadlocks.
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      traceStartup('startup-failed')
      if (testLaunch) console.error('TED could not start:', error)
      else
        dialog.showErrorBox(
          `${appName} couldn’t start`,
          error instanceof Error ? error.message : String(error),
        )
      app.exit(1)
    })
}
