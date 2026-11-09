import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { withDaemon } from '@ted/daemon/launch'
import {
  type Activity,
  type Banner,
  type CreateTaskRequest,
  type DaemonClient,
  type DaemonEvent,
  defaultMachineSettings,
  downloadUrl,
  type MachineSettings,
  noActivity,
  type RestoreBackupRequest,
  type RunFixRequest,
  tedHome,
} from '@ted/protocol'
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
  shell,
  Tray,
} from 'electron'
import {
  appMenu,
  closeNotice,
  type MenuCommand,
  type MenuEntry,
  type MenuState,
  type Platform,
  quitAnswer,
  quitDialog,
  quitPlan,
  statusMenu,
  trayLabel,
  trayWarning,
  windowTitle,
} from './background.ts'
import { nextReturn } from './renderer/banners.ts'
import { thirdPartyLicenses } from './third-party.ts'
import { dotPng, trayIconPng } from './tray-icon.ts'

const requests: Record<string, (client: DaemonClient, ...args: unknown[]) => Promise<unknown>> = {
  listTasks: (client) => client.listTasks(),
  listComments: (client, taskId) => client.listComments(String(taskId)),
  getRun: async (client, runId) => (await client.getRun(String(runId))).run,
  setTaskLead: (client, taskId, lead) =>
    client.setTaskLead(String(taskId), lead as Parameters<DaemonClient['setTaskLead']>[1]),
  useDefaultModel: (client, taskId) => client.useDefaultModel(String(taskId)),
  listStageEntries: (client, taskId) => client.listStageEntries(String(taskId)),
  listFactories: (client) => client.listFactories(),
  createTask: (client, input) => client.createTask(input as CreateTaskRequest),
  taskDefaults: (client, factoryId) => client.taskDefaults(String(factoryId)),
  uploadAttachment: (client, name, mediaType, bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('attachment bytes must be a Uint8Array')
    return client.uploadAttachment(
      { name: String(name), mediaType: String(mediaType) },
      new Uint8Array(bytes),
    )
  },
  setupLog: (client, taskId, repo) => client.setupLog(String(taskId), String(repo)),
  locateLocalFolder: async (client, key) => {
    const options: OpenDialogOptions = {
      title: 'Locate the local folder',
      properties: ['openDirectory'],
    }
    const chosen = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const [folder] = chosen.filePaths
    if (chosen.canceled || folder === undefined) return undefined
    return client.setLocalFolder(String(key), folder)
  },
  getSettings: (client) => client.getSettings(),
  updateSettings: (client, changes) => client.updateSettings(changes as Partial<MachineSettings>),
  getDataStatus: (client) => client.getDataStatus(),
  listBackups: (client) => client.listBackups(),
  restoreBackup: (client, name) =>
    client.restoreBackup({ name: String(name) } satisfies RestoreBackupRequest),
  copyText: async (_, text) => clipboard.writeText(String(text)),
  downloadTed: () => shell.openExternal(downloadUrl),
  getCommandLine: (client) => client.getCommandLine(),
  installCommandLine: (client) => client.installCommandLine(),
  thirdPartyLicenses: async () => {
    const root = path.resolve(import.meta.dirname, '../../..')
    return readFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), 'utf8').catch(() =>
      thirdPartyLicenses(root),
    )
  },
  quit: async () => app.quit(),
  getProfile: (client) => client.getProfile(),
  getDiagnostics: (client) => client.getDiagnostics(),
  readDaemonLog: (client) => client.readDaemonLog(),
  readRunOutput: (client, runId) => client.readRunOutput(String(runId)),
  copyReport: async (client) => {
    clipboard.writeText((await client.getReport()).text)
  },
  tedFolder: async () => {
    const folder = tedHome()
    const home = homedir()
    const shown = folder.startsWith(`${home}${path.sep}`) ? `~${folder.slice(home.length)}` : folder
    return { path: `${shown}${path.sep}`, platform: process.platform }
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
  listBanners: (client) => client.listBanners(),
  dismissBanner: (client, id) => client.dismissBanner(String(id)),
  actOnBanner: (client, id) => client.actOnBanner(String(id)),
  getIntegrations: (client) => client.getIntegrations(),
  checkIntegrations: (client) => client.checkIntegrations(),
  runFix: (client, request) => client.runFix(request as RunFixRequest),
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

const platform = process.platform as Platform
const hiddenWindow = process.env.TED_HIDDEN_WINDOW === '1'

let client: DaemonClient | undefined
let window: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let state: MenuState = { activity: noActivity, banners: [] }
let settings: MachineSettings = defaultMachineSettings
let bannerTimer: NodeJS.Timeout | undefined

const sendToRenderer = (event: unknown) => window?.webContents.send('ted:event', event)

function applySettings(next: MachineSettings): void {
  settings = next
  nativeTheme.themeSource = next.appearance
}

function forward(event: DaemonEvent): void {
  if (event.type === 'settings-changed') applySettings(event.settings)
  if (event.type === 'data-status' && event.status.state === 'ready') {
    loadState().catch((error: unknown) => console.error('loading settings failed:', error))
  }
  if (event.type === 'activity-changed') state = { ...state, activity: event.activity }
  if (event.type === 'banner-raised' || event.type === 'banner-updated') {
    state = {
      ...state,
      banners: [...state.banners.filter((b) => b.id !== event.banner.id), event.banner],
    }
  }
  if (event.type === 'banner-cleared') {
    state = { ...state, banners: state.banners.filter((b) => b.id !== event.id) }
  }
  if (event.type === 'open-requested') showWindow()
  else sendToRenderer(event)
  refresh()
}

function run(command: MenuCommand): void {
  if (command.kind === 'quit') return void requestQuit()
  if (command.kind === 'restart-to-update') return
  showWindow()
  if (command.kind !== 'open-ted') sendToRenderer({ type: 'menu-command', command })
}

function toElectron(entries: MenuEntry[]): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    if (entry.type === 'separator') return { type: 'separator' }
    if (entry.type === 'role') return { role: entry.role }
    if (entry.type === 'submenu') {
      return entry.submenu.length === 0 && entry.role !== undefined
        ? { role: entry.role }
        : { label: entry.label, submenu: toElectron(entry.submenu) }
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
  const waiting = state.activity.waitingOnYou
  if (platform === 'linux') app.setBadgeCount(waiting)
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
    if (platform === 'darwin') tray.setTitle(trayLabel(state.activity))
    tray.setToolTip(waiting > 0 ? `TED · ${waiting} waiting on you` : 'TED')
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
  const notice = closeNotice(platform, existsSync(noticeFile()))
  if (!notice || hiddenWindow) return
  new Notification(notice).show()
  await writeFile(noticeFile(), '')
}

function keepRunningInBackground(): void {
  window?.hide()
  if (platform === 'darwin') app.dock?.hide()
}

async function quitCompletely(): Promise<void> {
  quitting = true
  await client?.shutdown().catch((error: unknown) => console.error(error))
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
  const created = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: windowTitle(platform, state.activity.waitingOnYou),
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
  created.on('page-title-updated', (event) => event.preventDefault())
  created.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    void closeToBackground()
  })
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  await created.loadFile(path.join(import.meta.dirname, '../dist/renderer/index.html'))
}

async function loadState(): Promise<void> {
  if (!client) return
  applySettings(await client.getSettings())
  const [activity, banners]: [Activity, Banner[]] = await Promise.all([
    client.getActivity(),
    client.listBanners(),
  ])
  state = { ...state, activity, banners }
  refresh()
}

async function start(): Promise<void> {
  const connected = await withDaemon(tedHome(), async (client) => {
    await client.subscribe(forward, { app: true })
    return client
  })
  client = connected
  if ((await connected.getDataStatus()).state === 'ready') await loadState()

  ipcMain.handle('ted:request', (_event, name: string, ...args: unknown[]) => {
    const request = Object.hasOwn(requests, name) ? requests[name] : undefined
    if (!request) throw new Error(`unknown request ${name}`)
    return request(connected, ...args)
  })

  if (hiddenWindow) app.dock?.hide()
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    void requestQuit()
  })
  app.on('window-all-closed', () => undefined)
  app.on('activate', showWindow)
  app.on('second-instance', showWindow)
  refresh()
  await createWindow()
}

app.setName('TED')
if (app.isPackaged) process.env.TED_APP_EXECUTABLE = process.env.APPIMAGE || process.execPath
if (process.env.TED_HOME) app.setPath('userData', path.join(tedHome(), 'electron'))

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  // Electron emits 'ready' only after this module finishes evaluating, so a top-level await deadlocks.
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        'TED couldn’t start',
        error instanceof Error ? error.message : String(error),
      )
      app.exit(1)
    })
}
