import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { type DaemonInfo, tedPaths } from '@ted/protocol'
import { createAgents } from './agents/index.ts'
import { createAttachments } from './attachments.ts'
import { createBanners } from './banners.ts'
import { ensureClone } from './factories.ts'
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
  onShutdown?: () => void
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
  const banners = createBanners({ store })
  const workflows = createWorkflows({
    store,
    banners,
    libraryDir: paths.library,
    reposDir: paths.repos,
  })
  banners.onAction('clone-failed', async ({ factoryId }) => {
    const factory = factoryId === undefined ? undefined : store.getFactory(factoryId)
    if (factory) await ensureClone({ banners, reposDir: paths.repos }, factory)
  })
  for (const factory of store.listFactories()) {
    await workflows.resolve(factory, { fetch: false }).catch(() => undefined)
  }
  const tasks = createTasks({
    store,
    runs,
    workflows,
    banners,
    reposDir: paths.repos,
    worktreesDir: paths.worktrees,
    defaultLead: () => agents.defaultLead(),
    attachmentFile: (attachment) => attachments.file(attachment),
    logsDir: paths.logs,
    ...(idle && { idle }),
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
    banners,
    workflows,
    reposDir: paths.repos,
    appStreams: new Set(),
    onShutdown: options.onShutdown ?? (() => undefined),
    home: paths.home,
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
