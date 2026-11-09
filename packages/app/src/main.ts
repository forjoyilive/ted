import { homedir } from 'node:os'
import path from 'node:path'
import { withDaemon } from '@ted/daemon/launch'
import {
  type AnswerRequest,
  type CreateTaskRequest,
  type DaemonClient,
  type DaemonEvent,
  downloadUrl,
  type MachineSettings,
  type RestoreBackupRequest,
  tedHome,
} from '@ted/protocol'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  type OpenDialogOptions,
  shell,
} from 'electron'

const requests: Record<string, (client: DaemonClient, ...args: unknown[]) => Promise<unknown>> = {
  listTasks: (client) => client.listTasks(),
  listComments: (client, taskId) => client.listComments(String(taskId)),
  listInbox: (client) => client.listInbox(),
  answerRequest: (client, commentId, answer) =>
    client.answerRequest(String(commentId), answer as AnswerRequest),
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

let window: BrowserWindow | undefined
let client: DaemonClient | undefined
const hiddenWindow = process.env.TED_HIDDEN_WINDOW === '1'
const applySettings = ({ appearance }: Pick<MachineSettings, 'appearance'>) => {
  nativeTheme.themeSource = appearance
}
const loadSettings = async () => {
  if (client) applySettings(await client.getSettings())
}
const forward = (event: DaemonEvent) => {
  if (event.type === 'settings-changed') applySettings(event.settings)
  if (event.type === 'data-status' && event.status.state === 'ready') {
    loadSettings().catch((error: unknown) => console.error('loading settings failed:', error))
  }
  window?.webContents.send('ted:event', event)
}

async function start(): Promise<void> {
  client = await withDaemon(tedHome(), async (client) => {
    await client.subscribe(forward)
    return client
  })
  if ((await client.getDataStatus()).state === 'ready') await loadSettings()

  ipcMain.handle('ted:request', (_event, name: string, ...args: unknown[]) => {
    const request = Object.hasOwn(requests, name) ? requests[name] : undefined
    if (!request) throw new Error(`unknown request ${name}`)
    return request(client as DaemonClient, ...args)
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
