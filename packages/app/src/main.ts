import path from 'node:path'
import { withDaemon } from '@ted/daemon/launch'
import {
  type CreateTaskRequest,
  type DaemonClient,
  type DaemonEvent,
  type MachineSettings,
  tedHome,
} from '@ted/protocol'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'

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
  getSettings: (client) => client.getSettings(),
  updateSettings: (client, changes) => client.updateSettings(changes as Partial<MachineSettings>),
  listBanners: (client) => client.listBanners(),
  dismissBanner: (client, id) => client.dismissBanner(String(id)),
  actOnBanner: (client, id) => client.actOnBanner(String(id)),
}

let window: BrowserWindow | undefined
const hiddenWindow = process.env.TED_HIDDEN_WINDOW === '1'
const applySettings = ({ appearance }: MachineSettings) => {
  nativeTheme.themeSource = appearance
}
const forward = (event: DaemonEvent) => {
  if (event.type === 'settings-changed') applySettings(event.settings)
  window?.webContents.send('ted:event', event)
}

async function start(): Promise<void> {
  const client = await withDaemon(tedHome(), async (client) => {
    await client.subscribe(forward)
    return client
  })
  applySettings(await client.getSettings())

  ipcMain.handle('ted:request', (_event, name: string, ...args: unknown[]) => {
    const request = Object.hasOwn(requests, name) ? requests[name] : undefined
    if (!request) throw new Error(`unknown request ${name}`)
    return request(client, ...args)
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
