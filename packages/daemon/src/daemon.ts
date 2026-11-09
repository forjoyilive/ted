import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { type DaemonInfo, tedPaths } from '@ted/protocol'
import { createAgents } from './agents/index.ts'
import { createAttachments } from './attachments.ts'
import { startIdleTimer } from './idle.ts'
import { acquireLock } from './lock.ts'
import { loadRunTokens } from './run-token.ts'
import { startRunManager } from './runs/run-manager.ts'
import { listen } from './server.ts'
import { openStore } from './store/index.ts'
import { createTasks } from './tasks/tasks.ts'
import { createWorkflows } from './workflow/workflows.ts'

export interface DaemonOptions {
  home: string
  version: string
  claudeBin?: string
  codexBin?: string
  idleExit?: { afterMs: number; onIdle: () => void }
  keepaliveMs?: number
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
  const idle = options.idleExit && startIdleTimer(options.idleExit)
  const runTokens = await loadRunTokens(paths.runTokenKey)
  const agents = createAgents({
    ...(options.claudeBin !== undefined && { claudeBin: options.claudeBin }),
    ...(options.codexBin !== undefined && { codexBin: options.codexBin }),
  })
  const runs = await startRunManager({
    home: paths.home,
    store,
    agents,
    tokens: runTokens,
    ...(idle && { idle }),
  })
  const attachments = createAttachments(paths.attachments)
  const tasks = createTasks({
    store,
    runs,
    workflows: createWorkflows({ store, libraryDir: paths.library, reposDir: paths.repos }),
    reposDir: paths.repos,
    worktreesDir: paths.worktrees,
    defaultLead: () => agents.defaultLead(),
    attachmentFile: (attachment) => attachments.file(attachment),
  })
  const token = randomBytes(32).toString('hex')
  const { server, port } = await listen({
    version: options.version,
    token,
    store,
    keepaliveMs: options.keepaliveMs ?? 30_000,
    runs,
    agents,
    runTokens,
    tasks,
    attachments,
    reposDir: paths.repos,
    ...(idle && { idle }),
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
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await tasks.close()
      await runs.close()
      await store.close()
      lock.release()
    },
  }
}
