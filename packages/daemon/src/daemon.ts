import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { type DaemonInfo, type DataStatus, tedPaths } from '@ted/protocol'
import { createAgents } from './agents/index.ts'
import { createAttachments } from './attachments.ts'
import { createBanners } from './banners.ts'
import { createData } from './data.ts'
import { ensureClone } from './factories.ts'
import { cloneFailedProblem, createFactories } from './factory-setup.ts'
import { createAgentHealth } from './health/agent-health.ts'
import { createEnvironment } from './health/environment.ts'
import { startIdleTimer } from './idle.ts'
import { createIntegrations } from './integrations.ts'
import { type Keyring, loadKeyring } from './linear/keyring.ts'
import { createLinear } from './linear/linear.ts'
import { acquireLock } from './lock.ts'
import { loadRunTokens } from './run-token.ts'
import { startRunManager } from './runs/run-manager.ts'
import { listen } from './server.ts'
import { createTasks, type Tasks } from './tasks/tasks.ts'
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
  linear?: { apiUrl?: string; keyring?: Keyring }
  onShutdown?: () => void
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

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const paths = tedPaths(options.home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  const linear = createLinear({
    keyring: options.linear?.keyring ?? (await loadKeyring()),
    keyFile: paths.linearKeyFile,
    ...(options.linear?.apiUrl !== undefined && { apiUrl: options.linear.apiUrl }),
  })
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
      const banners = createBanners({ store })
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
      let started: Tasks | undefined
      const factories = createFactories({
        store,
        banners,
        gh: integrations.gh,
        workflows,
        reposDir: paths.repos,
        emit,
        login: () =>
          integrations.current()?.github.hosts.find((h) => h.host === 'github.com')?.login,
        onCloned: (factory) => started?.wake(factory.id),
        ...(idle && { idle }),
      })
      banners.onAction(cloneFailedProblem, async ({ factoryId }) => {
        const factory = factoryId === undefined ? undefined : store.getFactory(factoryId)
        if (!factory) return
        if (factory.clonedAt === undefined) await factories.retry(factory.id)
        else await ensureClone({ banners, reposDir: paths.repos }, factory)
      })
      for (const factory of store.listFactories()) {
        if (factory.clonedAt === undefined) continue
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
        linear,
        logsDir: paths.logs,
        isCloned: (factoryId) => factories.isCloned(factoryId),
        ...(idle && { idle }),
      })
      started = tasks
      factories.start()
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
        factories,
        async close() {
          health.close()
          integrations.close()
          await factories.close()
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
    linear,
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
