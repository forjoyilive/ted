import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { type DaemonInfo, type DataStatus, tedPaths } from '@ted/protocol'
import { createAgents } from './agents/index.ts'
import { createAttachments } from './attachments.ts'
import { createBanners } from './banners.ts'
import { createData } from './data.ts'
import { ensureClone } from './factories.ts'
import { createAgentHealth } from './health/agent-health.ts'
import { createEnvironment } from './health/environment.ts'
import { openInTerminal } from './health/terminal.ts'
import { startIdleTimer } from './idle.ts'
import { acquireLock } from './lock.ts'
import { loadRunTokens } from './run-token.ts'
import { startRunManager } from './runs/run-manager.ts'
import { listen } from './server.ts'
import { createTasks } from './tasks/tasks.ts'
import { createWorkflows } from './workflow/workflows.ts'

export interface DaemonOptions {
  home: string
  version: string
  claudeBin?: string
  codexBin?: string
  idleExit?: { afterMs: number; onIdle: () => void }
  keepaliveMs?: number
  onDataStatus?: (status: DataStatus) => void
  loginShell?: boolean
  openTerminal?: (command: string, env: NodeJS.ProcessEnv) => Promise<void>
  healthIntervalMs?: number
  fixPollMs?: number
}

export interface RunningDaemon {
  port: number
  stop(): Promise<void>
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const paths = tedPaths(options.home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  const lock = acquireLock(paths.daemonLock)
  const idle = options.idleExit && startIdleTimer(options.idleExit)
  const runTokens = await loadRunTokens(paths.runTokenKey).catch((error: unknown) => {
    lock.release()
    throw error
  })
  const environment = createEnvironment({ loginShell: options.loginShell ?? false })
  const environmentRead = environment.reload()
  const agents = createAgents({
    ...(options.claudeBin !== undefined && { claudeBin: options.claudeBin }),
    ...(options.codexBin !== undefined && { codexBin: options.codexBin }),
    env: environment.current,
  })
  const openTerminal =
    options.openTerminal ??
    ((command: string, env: NodeJS.ProcessEnv) =>
      openInTerminal({ command, env, scriptsDir: paths.fixScripts }))
  const attachments = createAttachments(paths.attachments)
  const data = createData({
    home: paths.home,
    version: options.version,
    ...(options.onDataStatus && { onStatus: options.onDataStatus }),
    async startServices(store) {
      await environmentRead
      const runs = await startRunManager({
        home: paths.home,
        store,
        agents,
        tokens: runTokens,
        env: environment.current,
        ...(idle && { idle }),
      })
      const banners = createBanners({ store })
      const health = createAgentHealth({
        agents,
        environment,
        store,
        banners,
        home: paths.home,
        runEnv: () => runs.environment(),
        openTerminal,
        ...(options.healthIntervalMs !== undefined && { intervalMs: options.healthIntervalMs }),
        ...(options.fixPollMs !== undefined && { fixPollMs: options.fixPollMs }),
      })
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
        health,
        attachmentFile: (attachment) => attachments.file(attachment),
        logsDir: paths.logs,
        ...(idle && { idle }),
      })
      health.check().catch((error: unknown) => console.error('agent health check failed:', error))
      return {
        runs,
        tasks,
        banners,
        workflows,
        health,
        subscribe: (listener) => health.subscribe(listener),
        async close() {
          health.close()
          await tasks.close()
          await runs.close()
        },
      }
    },
  })
  const token = randomBytes(32).toString('hex')
  const { server, port } = await listen({
    version: options.version,
    token,
    data,
    keepaliveMs: options.keepaliveMs ?? 30_000,
    agents,
    runTokens,
    attachments,
    reposDir: paths.repos,
    home: paths.home,
    ...(idle && { idle }),
  })
  const info: DaemonInfo = { port, token, pid: process.pid, version: options.version }
  const tmp = `${paths.daemonInfo}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(info), { mode: 0o600 })
  await rename(tmp, paths.daemonInfo)
  await data.open()

  return {
    port,
    async stop() {
      idle?.cancel()
      await rm(paths.daemonInfo, { force: true })
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await data.close()
      lock.release()
    },
  }
}
