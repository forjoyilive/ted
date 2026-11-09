import { homedir } from 'node:os'
import path from 'node:path'
import {
  crashReport,
  type DaemonConnection,
  daemonRestartDelaysMs,
  superviseDaemon,
} from '@ted/daemon/launch'
import {
  type CreateTaskRequest,
  type DaemonClient,
  type MachineSettings,
  tedHome,
  tedVersion,
} from '@ted/protocol'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  nativeImage,
  nativeTheme,
  shell,
} from 'electron'
import type { AppEvent } from './renderer/ted.ts'

const requests: Record<string, (client: DaemonClient, ...args: unknown[]) => Promise<unknown>> = {
  listTasks: (client) => client.listTasks(),
  listComments: (client, taskId) => client.listComments(String(taskId)),
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
  getSettings: (client) => client.getSettings(),
  updateSettings: (client, changes) => client.updateSettings(changes as Partial<MachineSettings>),
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

const keepsStopping = 'TED’s background process keeps stopping'

let window: BrowserWindow | undefined
const hiddenWindow = process.env.TED_HIDDEN_WINDOW === '1'
const home = tedHome()
const restartDelaysMs = process.env.TED_RESTART_DELAYS_MS?.split(',').map(Number) ?? [
  ...daemonRestartDelaysMs,
]

const applySettings = ({ appearance }: Pick<MachineSettings, 'appearance'>) => {
  nativeTheme.themeSource = appearance
}
const send = (event: AppEvent) => window?.webContents.send('ted:event', event)

async function start(): Promise<void> {
  const supervisor = await superviseDaemon(home, {
    restartDelaysMs,
    onEvent(event) {
      if (event.type === 'settings-changed') applySettings(event.settings)
      send(event)
    },
    onConnection(connection: DaemonConnection) {
      send({ type: 'connection', connection })
      if (connection.state === 'connected') {
        void supervisor.client.getSettings().then(applySettings, () => undefined)
      } else if (connection.state === 'stopped' && Notification.isSupported()) {
        new Notification({ title: 'TED', body: keepsStopping }).show()
      }
    },
  })
  applySettings(await supervisor.client.getSettings())
  app.on('before-quit', () => supervisor.close())

  const appRequests: Record<string, () => Promise<unknown>> = {
    connection: async () => supervisor.connection,
    restartDaemon: () => supervisor.restart(),
    async copyCrashReport() {
      const { connection } = supervisor
      await clipboard.writeText(
        await crashReport(home, {
          version: tedVersion,
          crashes: connection.state === 'stopped' ? connection.crashes : [],
        }),
      )
    },
  }

  ipcMain.handle('ted:request', (_event, name: string, ...args: unknown[]) => {
    const appRequest = Object.hasOwn(appRequests, name) ? appRequests[name] : undefined
    if (appRequest) return appRequest()
    const request = Object.hasOwn(requests, name) ? requests[name] : undefined
    if (!request) throw new Error(`unknown request ${name}`)
    if (supervisor.connection.state !== 'connected') {
      throw new Error('TED’s background process isn’t running')
    }
    return request(supervisor.client, ...args)
  })

  if (hiddenWindow) app.dock?.hide()
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'TED',
    show: !hiddenWindow,
    webPreferences: {
      backgroundThrottling: !hiddenWindow,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  await window.loadFile(path.join(import.meta.dirname, '../dist/renderer/index.html'))
}

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
