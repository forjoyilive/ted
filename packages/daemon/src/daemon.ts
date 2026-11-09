import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { type DaemonInfo, tedPaths } from '@ted/protocol'
import { startIdleTimer } from './idle.ts'
import { acquireLock } from './lock.ts'
import { listen } from './server.ts'
import { openStore } from './store/index.ts'

export interface DaemonOptions {
  home: string
  version: string
  idleExit?: { afterMs: number; onIdle: () => void }
}

export interface RunningDaemon {
  port: number
  stop(): Promise<void>
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const paths = tedPaths(options.home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  const lock = acquireLock(paths.daemonLock)
  const store = await openStore({ directory: paths.store }).catch((error: unknown) => {
    lock.release()
    throw error
  })
  const token = randomBytes(32).toString('hex')
  const idle = options.idleExit && startIdleTimer(options.idleExit)
  const { server, port } = await listen({
    version: options.version,
    token,
    store,
    ...(idle && { onRequest: idle.reset }),
  })
  const info: DaemonInfo = { port, token, pid: process.pid, version: options.version }
  const tmp = `${paths.daemonInfo}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(info), { mode: 0o600 })
  await rename(tmp, paths.daemonInfo)

  return {
    port,
    async stop() {
      idle?.cancel()
      await rm(paths.daemonInfo, { force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await store.close()
      lock.release()
    },
  }
}
