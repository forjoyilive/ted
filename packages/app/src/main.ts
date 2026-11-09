import path from 'node:path'
import {
  crashReport,
  type DaemonConnection,
  daemonRestartDelaysMs,
  superviseDaemon,
} from '@ted/daemon/launch'
import { type DaemonClient, type MachineSettings, tedHome, tedVersion } from '@ted/protocol'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, nativeTheme } from 'electron'
import type { AppEvent } from './renderer/ted.ts'

const requests: Record<string, (client: DaemonClient, ...args: unknown[]) => Promise<unknown>> = {
  listTasks: (client) => client.listTasks(),
  listComments: (client, taskId) => client.listComments(String(taskId)),
  listFactories: (client) => client.listFactories(),
  getSettings: (client) => client.getSettings(),
  updateSettings: (client, changes) => client.updateSettings(changes as Partial<MachineSettings>),
  listBanners: (client) => client.listBanners(),
  dismissBanner: (client, id) => client.dismissBanner(String(id)),
  actOnBanner: (client, id) => client.actOnBanner(String(id)),
}

const keepsStopping = 'TED’s background process keeps stopping'

let window: BrowserWindow | undefined
const hiddenWindow = process.env.TED_HIDDEN_WINDOW === '1'
const home = tedHome()
const restartDelaysMs = process.env.TED_RESTART_DELAYS_MS?.split(',').map(Number) ?? [
  ...daemonRestartDelaysMs,
]

const applySettings = ({ appearance }: MachineSettings) => {
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
