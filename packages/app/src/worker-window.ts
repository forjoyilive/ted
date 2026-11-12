import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  executionHome,
  executionServiceOwner,
  startExecutionService,
  stopExecutionService,
  workerRequest,
} from '@ted/daemon/execution'
import { parseWorkerPairRequest, type WorkerStatus } from '@ted/protocol'
import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export function createWorkerWindow(hidden = false) {
  let window: BrowserWindow | undefined
  const home = executionHome()
  const owner = () => createHash('sha256').update(app.getPath('userData')).digest('hex')
  async function ensure() {
    await startExecutionService(home, process.env, owner())
  }
  return {
    async open() {
      if (window && !window.isDestroyed()) {
        if (!hidden) {
          window.show()
          window.focus()
        }
        return
      }
      const created = new BrowserWindow({
        width: 720,
        height: 850,
        minWidth: 560,
        minHeight: 500,
        title: 'TED · Worker',
        show: !hidden,
        webPreferences: {
          preload: path.join(import.meta.dirname, 'preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      window = created
      created.on('close', (event) => {
        event.preventDefault()
        created.hide()
      })
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      created.webContents.on('will-navigate', (event) => event.preventDefault())
      await created.loadFile(path.join(import.meta.dirname, '../dist/renderer/index.html'), {
        query: { worker: '1' },
      })
    },
    sender(event: IpcMainInvokeEvent): boolean {
      return (
        event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame
      )
    },
    async status(): Promise<WorkerStatus> {
      try {
        return await workerRequest(home, 'status')
      } catch (error) {
        if (
          !['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error
        return {
          state: 'stopped',
          message:
            'Paste pairing details from the main Mac, or Start to reconnect with saved pairing.',
          scopes: [],
        }
      }
    },
    async pair(value: unknown) {
      const input = parseWorkerPairRequest(value)
      await ensure()
      return workerRequest(home, 'pair', input)
    },
    async start() {
      await ensure()
      return workerRequest(home, 'start')
    },
    async stop() {
      return workerRequest(home, 'stop')
    },
    async close() {
      if ((await executionServiceOwner(home)) === owner()) await stopExecutionService(home)
      window?.destroy()
      window = undefined
    },
  }
}
