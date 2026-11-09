import path from 'node:path'
import { withDaemon } from '@ted/daemon/launch'
import { type DaemonClient, type DaemonEvent, tedHome } from '@ted/protocol'
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'

const requests: Record<string, (client: DaemonClient, ...args: unknown[]) => Promise<unknown>> = {
  listTasks: (client) => client.listTasks(),
  listComments: (client, taskId) => client.listComments(String(taskId)),
  listFactories: (client) => client.listFactories(),
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
}

let window: BrowserWindow | undefined
const forward = (event: DaemonEvent) => window?.webContents.send('ted:event', event)

async function start(): Promise<void> {
  const client = await withDaemon(tedHome(), async (client) => {
    await client.subscribe(forward)
    return client
  })

  ipcMain.handle('ted:request', (_event, name: string, ...args: unknown[]) => {
    const request = Object.hasOwn(requests, name) ? requests[name] : undefined
    if (!request) throw new Error(`unknown request ${name}`)
    return request(client, ...args)
  })

  window = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'TED',
    webPreferences: {
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
