import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { type DaemonInfo, type DataStatus, tedPaths } from '@ted/protocol'
import { createAgents } from './agents/index.ts'
import { createAttachments } from './attachments.ts'
import { createBanners } from './banners.ts'
import { createData } from './data.ts'
import { createDiskWatch, excludeFromTimeMachine, freeBytesAt, volumeName } from './disk.ts'
import { ensureClone } from './factories.ts'
import { createAgentHealth } from './health/agent-health.ts'
import { createEnvironment } from './health/environment.ts'
import { startIdleTimer } from './idle.ts'
import { createIntegrations } from './integrations.ts'
import { acquireLock } from './lock.ts'
import { pruneRunOutput } from './retention.ts'
import { loadRunTokens } from './run-token.ts'
import { startRunManager } from './runs/run-manager.ts'
import { listen } from './server.ts'
import { createStorage } from './storage.ts'
import { createTasks } from './tasks/tasks.ts'
import { createTerminalOpener, type OpenTerminal } from './terminal.ts'
import { createWorkflows } from './workflow/workflows.ts'

export interface DaemonOptions {
  home: string
  version: string
  claudeBin?: string
  codexBin?: string
  idleExit?: { afterMs: number; onIdle: () => void }
  keepaliveMs?: number
  onDataStatus?: (status: DataStatus) => void
  checkAgentsOnStart?: boolean
  healthIntervalMs?: number
  fixPollMs?: number
  integrations?: DaemonIntegrationsOptions
  onShutdown?: () => void
  disk?: DaemonDiskOptions
}

export interface DaemonDiskOptions {
  freeBytes?: () => Promise<number>
  checkEveryMs?: number
  volumeName?: () => Promise<string>
  excludeFromBackups?: (dirs: string[]) => Promise<void>
}

export interface DaemonIntegrationsOptions {
  checkOnStart?: boolean
  ghBin?: string
  gitBin?: string
  loginShell?: boolean
  openTerminal?: OpenTerminal
  checkEveryMs?: number
  watchAfterFix?: { everyMs: number; forMs: number }
}

export interface RunningDaemon {
  port: number
  stop(): Promise<void>
}

const pruneEveryMs = 6 * 60 * 60 * 1000

async function readFakeFree(file: string): Promise<number> {
  return Number(await readFile(file, 'utf8'))
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
  const given = options.integrations ?? {}
  const environment = createEnvironment({ loginShell: given.loginShell ?? false })
  const environmentRead = environment.reload()
  const agents = createAgents({
    ...(options.claudeBin !== undefined && { claudeBin: options.claudeBin }),
    ...(options.codexBin !== undefined && { codexBin: options.codexBin }),
    env: environment.current,
  })
  const openTerminal = given.openTerminal ?? createTerminalOpener({ tmpDir: paths.tmp })
  const attachments = createAttachments(paths.attachments)
  const data = createData({
    home: paths.home,
    version: options.version,
    ...(options.onDataStatus && { onStatus: options.onDataStatus }),
    async startServices(store, emit) {
      await environmentRead
      const runs = await startRunManager({
        home: paths.home,
        store,
        agents,
        tokens: runTokens,
        env: environment.current,
        ...(idle && { idle }),
      })
      const banners = createBanners({ store, emit })
      const diskOptions = options.disk ?? {}
      const fakeFree = process.env.TED_FREE_BYTES_FILE
      let wake: () => void = () => undefined
      const disk = createDiskWatch({
        storeDir: paths.store,
        banners,
        hold(reason) {
          store.holdNewWork(reason)
          if (reason === undefined) wake()
        },
        freeBytes:
          diskOptions.freeBytes ??
          (fakeFree ? () => readFakeFree(fakeFree) : () => freeBytesAt(paths.home)),
        checkEveryMs: diskOptions.checkEveryMs ?? (fakeFree ? 1000 : 60_000),
      })
      const stopWatchingWrites = store.onWriteResult((error) =>
        error === undefined ? disk.writeSucceeded() : disk.writeFailed(),
      )
      await disk.check()
      const health = createAgentHealth({
        agents,
        environment,
        store,
        banners,
        home: paths.home,
        runEnv: () => runs.environment(),
        openTerminal,
        emit,
        ...(options.healthIntervalMs !== undefined && { intervalMs: options.healthIntervalMs }),
        ...(options.fixPollMs !== undefined && { fixPollMs: options.fixPollMs }),
      })
      const integrations = createIntegrations({
        store,
        banners,
        emit,
        openTerminal,
        loginShell: given.loginShell ?? false,
        ...(given.ghBin !== undefined && { ghBin: given.ghBin }),
        ...(given.gitBin !== undefined && { gitBin: given.gitBin }),
        ...(given.checkEveryMs !== undefined && { checkEveryMs: given.checkEveryMs }),
        ...(given.watchAfterFix !== undefined && { watchAfterFix: given.watchAfterFix }),
      })
      if (given.checkOnStart) integrations.start()
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
        agents,
        health,
        attachmentFile: (attachment) => attachments.file(attachment),
        logsDir: paths.logs,
        ...(idle && { idle }),
      })
      wake = () => tasks.wake()
      disk.start()
      const backupless = [paths.worktrees, paths.repos, paths.simulators, paths.scratch]
      Promise.all(backupless.map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })))
        .then(() => (diskOptions.excludeFromBackups ?? excludeFromTimeMachine)(backupless))
        .catch((error: unknown) =>
          console.error('couldn’t exclude folders from Time Machine:', error),
        )
      const prune = () =>
        pruneRunOutput({
          runsDir: paths.runs,
          isLive: (runId) => {
            const run = store.getRun(runId)
            return run !== undefined && run.state !== 'finished'
          },
        }).catch((error: unknown) => console.error('pruning Run output failed:', error))
      void prune()
      const pruneTimer = setInterval(() => void prune(), pruneEveryMs)
      pruneTimer.unref()
      const storage = createStorage({
        home: paths.home,
        store,
        disk,
        data,
        volumeName: diskOptions.volumeName ?? (() => volumeName(paths.home)),
      })
      if (options.checkAgentsOnStart) {
        health.check().catch((error: unknown) => console.error('agent health check failed:', error))
      }
      return {
        runs,
        tasks,
        banners,
        workflows,
        health,
        integrations,
        disk,
        storage,
        async close() {
          disk.close()
          clearInterval(pruneTimer)
          stopWatchingWrites()
          health.close()
          integrations.close()
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
    appStreams: new Set(),
    onShutdown: options.onShutdown ?? (() => undefined),
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
