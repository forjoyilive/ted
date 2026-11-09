import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { type DaemonInfo, type DataStatus, tedPaths } from '@ted/protocol'
import { createAgents } from './agents/index.ts'
import { createAttachments } from './attachments.ts'
import { createAutomations } from './automations/automations.ts'
import { createBanners } from './banners.ts'
import { createCheckTries } from './check-tries.ts'
import { type CommandLineOptions, createCommandLine } from './command-line.ts'
import { createData } from './data.ts'
import { createDiskWatch, excludeFromTimeMachine, freeBytesAt, volumeName } from './disk.ts'
import { ensureClone } from './factories.ts'
import { createFactorySettings, storedRepos } from './factory-settings.ts'
import { cloneFailedProblem, createFactories } from './factory-setup.ts'
import { createAgentHealth } from './health/agent-health.ts'
import { createEnvironment } from './health/environment.ts'
import { agentHostsReachable, onlineFromFile, watchOnline } from './health/online.ts'
import { startIdleTimer } from './idle.ts'
import { createIntegrations } from './integrations.ts'
import { type Keyring, loadKeyring } from './linear/keyring.ts'
import { createLinear } from './linear/linear.ts'
import { acquireLock } from './lock.ts'
import { pruneRunOutput } from './retention.ts'
import { loadRunTokens } from './run-token.ts'
import { createConversations } from './runs/conversations.ts'
import { startRunManager } from './runs/run-manager.ts'
import { listen } from './server.ts'
import { type HoldAwake, stayAwakeWhileWorking } from './stay-awake.ts'
import { createStorage } from './storage.ts'
import type { StoredFactory } from './store/index.ts'
import { createTasks, type Tasks } from './tasks/tasks.ts'
import { createTerminalOpener, type OpenTerminal } from './terminal.ts'
import type { WorkflowSettings } from './workflow/check.ts'
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
  holdAwake?: HoldAwake
  commandLine?: CommandLineOptions
  disk?: DaemonDiskOptions
  nudgeAfterMs?: number
  appToken?: string
  mergePollMs?: number
  ciStuckMs?: { noChecks: number; pending: number }
  settingsMergeWaitMs?: number
  stallAfterMs?: number
  online?: DaemonOnlineOptions
  limitProbeMs?: number
  scratchMaxAgeMs?: number
  automations?: DaemonAutomationsOptions
}

export interface DaemonAutomationsOptions {
  now?: () => number
  checkEveryMs?: number
  graceMs?: number
}

export interface DaemonOnlineOptions {
  isOnline?: () => Promise<boolean>
  onlineEveryMs?: number
  offlineEveryMs?: number
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
  appToken: string
  stop(): Promise<void>
}

const pruneEveryMs = 6 * 60 * 60 * 1000

async function readFakeFree(file: string): Promise<number> {
  return Number(await readFile(file, 'utf8'))
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
        ...(options.limitProbeMs !== undefined && { probeAfterMs: options.limitProbeMs }),
      })
      const onlineOptions = options.online ?? {}
      const fakeOnline = process.env.TED_ONLINE_FILE
      const online = watchOnline({
        isOnline:
          onlineOptions.isOnline ??
          (fakeOnline ? () => onlineFromFile(fakeOnline) : agentHostsReachable),
        onChange: (now) => health.setOnline(now),
        ...(fakeOnline && { onlineEveryMs: 1000, offlineEveryMs: 1000 }),
        ...(onlineOptions.onlineEveryMs !== undefined && {
          onlineEveryMs: onlineOptions.onlineEveryMs,
        }),
        ...(onlineOptions.offlineEveryMs !== undefined && {
          offlineEveryMs: onlineOptions.offlineEveryMs,
        }),
      })
      void online.check()
      runs.observe({ retrying: () => void online.check() })
      const ghBin = given.ghBin ?? process.env.TED_GH_BIN
      const integrations = createIntegrations({
        store,
        banners,
        emit,
        openTerminal,
        loginShell: given.loginShell ?? false,
        ...(ghBin !== undefined && { ghBin }),
        ...(given.gitBin !== undefined && { gitBin: given.gitBin }),
        ...(given.checkEveryMs !== undefined && { checkEveryMs: given.checkEveryMs }),
        ...(given.watchAfterFix !== undefined && { watchAfterFix: given.watchAfterFix }),
      })
      if (given.checkOnStart) integrations.start()
      let syncRepos:
        | ((factory: StoredFactory, settings?: WorkflowSettings) => Promise<void>)
        | undefined
      const workflows = createWorkflows({
        store,
        banners,
        libraryDir: paths.library,
        reposDir: paths.repos,
        onFactorySettings: async (factory, settings) => syncRepos?.(factory, settings),
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
      syncRepos = async (factory, settings) => {
        const wanted = storedRepos(store, factory, settings)
        if (!wanted) return
        await factories.syncRepos(factory.id, wanted).catch((error: unknown) => {
          console.error(`couldn’t update ${factory.name}’s repos:`, error)
        })
      }
      const checkTries = createCheckTries({
        store,
        banners,
        workflows,
        reposDir: paths.repos,
        scratchDir: paths.scratch,
        emit,
        ...(options.scratchMaxAgeMs !== undefined && { maxAgeMs: options.scratchMaxAgeMs }),
      })
      const factorySettings = createFactorySettings({
        store,
        checkTries,
        installed: (kind) => agents.installed(kind),
        gh: integrations.gh,
        workflows,
        reposDir: paths.repos,
        health: async () => integrations.current() ?? (await integrations.check()),
        factories,
        ...(options.settingsMergeWaitMs !== undefined && {
          mergeWaitMs: options.settingsMergeWaitMs,
        }),
      })
      banners.onAction(cloneFailedProblem, async ({ factoryId }) => {
        const factory = factoryId === undefined ? undefined : store.getFactory(factoryId)
        if (!factory) return
        if (factory.clonedAt !== undefined) {
          await ensureClone({ banners, reposDir: paths.repos }, factory)
        }
        await factories.retry(factory.id)
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
        runsDir: paths.runs,
        libraryDir: paths.library,
        isCloned: (factoryId) => factories.isCloned(factoryId),
        gh: integrations.gh,
        ...(idle && { idle }),
        ...(options.nudgeAfterMs !== undefined && { nudgeAfterMs: options.nudgeAfterMs }),
        ...(options.mergePollMs !== undefined && { mergePollMs: options.mergePollMs }),
        ...(options.ciStuckMs !== undefined && { ciStuckMs: options.ciStuckMs }),
        ...(options.stallAfterMs !== undefined && { stallAfterMs: options.stallAfterMs }),
      })
      const automationOptions = options.automations ?? {}
      const automations = createAutomations({
        home: paths.home,
        store,
        runs,
        agents,
        health,
        banners,
        workflows,
        queue: tasks,
        ...(idle && { idle }),
        ...automationOptions,
      })
      wake = () => {
        tasks.wake()
        automations.check()
      }
      disk.start()
      const backupless = [paths.worktrees, paths.repos, paths.simulators, paths.scratch]
      const excludeFromBackups =
        diskOptions.excludeFromBackups ??
        (process.env.TED_TIME_MACHINE === 'off' ? async () => undefined : excludeFromTimeMachine)
      Promise.all(backupless.map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })))
        .then(() => excludeFromBackups(backupless))
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
      started = tasks
      factories.start()
      const stayAwake = options.holdAwake && stayAwakeWhileWorking(store, options.holdAwake)
      if (options.checkAgentsOnStart) {
        health.check().catch((error: unknown) => console.error('agent health check failed:', error))
      }
      const conversations = createConversations({
        home: paths.home,
        store,
        runs,
        agents,
        health,
        disk,
      })
      return {
        automations,
        runs,
        conversations,
        tasks,
        banners,
        workflows,
        health,
        integrations,
        disk,
        storage,
        factories,
        factorySettings,
        checkTries,
        async close() {
          automations.close()
          await checkTries.close()
          stayAwake?.close()
          disk.close()
          clearInterval(pruneTimer)
          stopWatchingWrites()
          online.close()
          health.close()
          integrations.close()
          await factories.close()
          await tasks.close()
          await runs.close()
        },
      }
    },
  })
  const commandLine = createCommandLine(options.commandLine)
  commandLine
    .refresh()
    .catch((error: unknown) => console.error('rewriting the ted command failed:', error))
  const token = randomBytes(32).toString('hex')
  const appToken = options.appToken ?? randomBytes(32).toString('hex')
  const { server, port } = await listen({
    version: options.version,
    token,
    appToken,
    appNonces: new Map(),
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
    commandLine,
    ...(idle && { idle }),
  })
  const info: DaemonInfo = { port, token, pid: process.pid, version: options.version }
  const tmp = `${paths.daemonInfo}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(info), { mode: 0o600 })
  await rename(tmp, paths.daemonInfo)
  await data.open()

  return {
    port,
    appToken,
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
