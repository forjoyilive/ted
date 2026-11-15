import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DaemonClient,
  type DaemonInfo,
  type DataStatus,
  remoteExecutionOn,
  tedEnv,
  tedPaths,
} from '@ted/protocol'
import { createAgentAvailability } from './agent-availability.ts'
import { createAgents } from './agents/index.ts'
import { type AsanaOptions, createAsana } from './asana/asana.ts'
import { createAttachments } from './attachments.ts'
import { createAutomations } from './automations/automations.ts'
import { createBanners } from './banners.ts'
import { createBusyHold } from './busy.ts'
import { createCheckTries } from './check-tries.ts'
import type { Clock } from './clock.ts'
import { createEnvironment, loginShell } from './command-env.ts'
import { type CommandLineOptions, createCommandLine } from './command-line.ts'
import { type Coordinators, createCoordinators } from './coordinators/coordinators.ts'
import { createCpuProfiler, type StallProfiles } from './cpu-profile.ts'
import { createData, type DataCloseStep, type DataOptions } from './data.ts'
import { createDiskWatch, excludeFromTimeMachine, freeBytesAt, volumeName } from './disk.ts'
import { createEditors, type LaunchEditor } from './editors.ts'
import { RequestError } from './errors.ts'
import { createExecutionCommands, type ExecutionCommands } from './execution/commands.ts'
import { createExecutionController } from './execution/controller.ts'
import { ensureClone } from './factories.ts'
import { createFactoryRemovals } from './factory-removal.ts'
import { createFactorySettings, storedRepos } from './factory-settings.ts'
import { cloneFailedProblem, createFactories } from './factory-setup.ts'
import { createAgentHealth } from './health/agent-health.ts'
import { agentHostsReachable, onlineFromFile, watchOnline } from './health/online.ts'
import { startIdleTimer } from './idle.ts'
import { createIntegrations } from './integrations.ts'
import { createLibrarySettings } from './library-settings.ts'
import { watchLibrary } from './library-watch.ts'
import { type Keyring, loadKeyring } from './linear/keyring.ts'
import { createLinear } from './linear/linear.ts'
import { acquireLock } from './lock.ts'
import { createMemoryWatch } from './memory-kills.ts'
import { createPlans, type Plans } from './plans/plans.ts'
import { QuitMarkedError, quitMarkedSync } from './quit-mark.ts'
import { pruneRunOutput, runOutputEnd } from './retention.ts'
import { loadRunTokens } from './run-token.ts'
import { createConversations } from './runs/conversations.ts'
import { startRunManager } from './runs/run-manager.ts'
import { createSteering } from './runs/steering.ts'
import { restartOnNewVersions } from './runs/version-restarts.ts'
import { createSandbox } from './sandbox.ts'
import { listen } from './server.ts'
import { createShells } from './shells.ts'
import { createSideChats } from './side-chats/side-chats.ts'
import { createSlowMonitor } from './slow-moments.ts'
import { type HoldAwake, stayAwakeWhileWorking } from './stay-awake.ts'
import { createStorage, type Storage } from './storage.ts'
import type { StoredFactory, TedStore } from './store/index.ts'
import { createArchiveCleanup } from './tasks/archive-expiry.ts'
import { createCheckSlots } from './tasks/check-slots.ts'
import { factoryRepos } from './tasks/repos.ts'
import { createTasks, type Tasks } from './tasks/tasks.ts'
import { createTerminalOpener, type OpenTerminal } from './terminal.ts'
import type { WorkflowSettings } from './workflow/check.ts'
import { createWorkflows } from './workflow/workflows.ts'

export interface DaemonOptions {
  home: string
  execution?: {
    enabled?: boolean
    now?: () => number
    ready?: (api: { commands: ExecutionCommands; store: TedStore }) => void
  }
  version: string
  claudeBin?: string
  codexBin?: string
  antigravityBin?: string
  idleExit?: {
    afterMs: number
    onIdle: () => void
    unattended?: { afterMs: number; onExit: (stoppedRuns: number) => void }
  }
  keepaliveMs?: number
  onDataStatus?: (status: DataStatus) => void
  checkAgentsOnStart?: boolean
  healthIntervalMs?: number
  fixPollMs?: number
  integrations?: DaemonIntegrationsOptions
  asana?: Omit<AsanaOptions, 'home' | 'keyring'> & { keyring?: Keyring; intakeLimit?: number }
  github?: { uploadOrigins?: string[] }
  linear?: { apiUrl?: string; keyring?: Keyring }
  snoozes?: { now?: () => Date; checkEveryMs?: number }
  heldRequests?: { maxMs?: number }
  linearSyncMs?: number
  asanaSyncMs?: number
  githubSyncMs?: number
  onShutdown?: () => void
  holdAwake?: HoldAwake
  commandLine?: CommandLineOptions
  disk?: DaemonDiskOptions
  clock?: Clock
  load?: DaemonLoadOptions
  nudgeAfterMs?: number
  appToken?: string
  mergePollMs?: number
  githubReadBurst?: number
  beforeMerge?: (taskId: string) => Promise<void>
  ciStuckMs?: { noChecks: number; pending: number }
  settingsMergeWaitMs?: number
  stallAfterMs?: number
  apps?: { pollMs?: number; readyTimeoutMs?: number; stopGraceMs?: number; logBytes?: number }
  runs?: { stopGraceMs?: number; inputAckMs?: number }
  simulators?: { supported?: boolean; pollMs?: number; idleMs?: number }
  emulators?: { supported?: boolean; pollMs?: number; idleMs?: number; bootTimeoutMs?: number }
  online?: DaemonOnlineOptions
  limitProbeMs?: number
  scratchMaxAgeMs?: number
  automations?: DaemonAutomationsOptions
  retention?: DaemonRetentionOptions
  oldestHost?: number
  editors?: DaemonEditorsOptions
  compaction?: DataOptions['compaction']
  stallProfiles?: StallProfiles
  outputDrop?: DataOptions['outputDrop']
  changesetTrim?: DataOptions['changesetTrim']
  slow?: { requestMs?: number; stallMs?: number }
}

export interface DaemonEditorsOptions {
  appDirs?: string[]
  launch?: LaunchEditor
}

export interface DaemonAutomationsOptions {
  clock?: Clock
  draftTimeoutMs?: number
  systemTimeZone?: () => string
  now?: () => number
  checkEveryMs?: number
  graceMs?: number
}

export interface DaemonRetentionOptions {
  now?: () => Date
  checkEveryMs?: number
}

export interface DaemonOnlineOptions {
  isOnline?: () => Promise<boolean>
  onlineEveryMs?: number
  offlineEveryMs?: number
}

export interface DaemonLoadOptions {
  ratio?: () => number
  memoryAvailable?: () => number
  checkEveryMs?: number
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
  stop(onStep?: (step: DaemonCloseStep) => void): Promise<void>
}

export type DaemonCloseStep = 'connections' | DataCloseStep

const pruneEveryMs = 6 * 60 * 60 * 1000

async function readFakeFree(file: string): Promise<number> {
  return Number(await readFile(file, 'utf8'))
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const xcrun = tedEnv('TED_XCRUN_BIN')
  const open = tedEnv('TED_OPEN_BIN')
  const idb = tedEnv('TED_IDB_BIN')
  const emulatorBin = tedEnv('TED_EMULATOR_BIN')
  const adbBin = tedEnv('TED_ADB_BIN')
  const avdmanagerBin = tedEnv('TED_AVDMANAGER_BIN')
  const sandboxProgram = tedEnv('TED_SANDBOX_BIN')
  const paths = tedPaths(options.home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  const attachments = createAttachments(paths.attachments)
  const linear = createLinear({
    keyring: options.linear?.keyring ?? (await loadKeyring()),
    keyFile: paths.linearKeyFile,
    files: {
      dir: paths.attachments,
      save: (file, name, mediaType) => attachments.saveFile(file, name, mediaType),
    },
    ...(options.linear?.apiUrl !== undefined && { apiUrl: options.linear.apiUrl }),
  })
  const asana = createAsana({
    ...options.asana,
    home: options.home,
    hold: () => idle?.hold() ?? (() => undefined),
    ...(options.clock && { clock: options.clock }),
    keyring:
      options.asana?.keyring ?? (await loadKeyring(process.env, process.platform, 'asana-oauth')),
  })
  const lock = acquireLock(paths.daemonLock)
  if (quitMarkedSync(options.home)) {
    lock.release()
    throw new QuitMarkedError()
  }
  const unattended = options.idleExit?.unattended
  const idle =
    options.idleExit &&
    startIdleTimer({
      afterMs: options.idleExit.afterMs,
      onIdle: options.idleExit.onIdle,
      ...(unattended && {
        unattended: {
          afterMs: unattended.afterMs,
          onUnattended: () =>
            void stopUnattendedRuns()
              .catch((error: unknown) => {
                console.error('couldn’t stop the Runs of an unattended daemon:', error)
                return 0
              })
              .then(unattended.onExit),
        },
      }),
      ...(options.clock && { clock: options.clock }),
    })
  async function stopUnattendedRuns(): Promise<number> {
    if (data.status().state !== 'ready') return 0
    const services = await data.services()
    services.tasks.stoppingForQuit()
    const stopped = await services.runs.stopAll()
    await services.store.persisted()
    return stopped
  }
  const runTokens = await loadRunTokens(paths.runTokenKey).catch((error: unknown) => {
    lock.release()
    throw error
  })
  const given = options.integrations ?? {}
  const environment = createEnvironment({ loginShell: given.loginShell ?? false })
  const environmentRead = environment.reload()
  const agents = createAgents({
    home: paths.home,
    ...(options.claudeBin !== undefined && { claudeBin: options.claudeBin }),
    ...(options.codexBin !== undefined && { codexBin: options.codexBin }),
    ...(options.antigravityBin !== undefined && { antigravityBin: options.antigravityBin }),
    env: environment.current,
  })
  const openTerminal = given.openTerminal ?? createTerminalOpener({ tmpDir: paths.tmp })
  const data = createData({
    home: paths.home,
    version: options.version,
    ...(options.onDataStatus && { onStatus: options.onDataStatus }),
    ...(options.compaction && { compaction: options.compaction }),
    ...(options.outputDrop && { outputDrop: options.outputDrop }),
    ...(options.changesetTrim && { changesetTrim: options.changesetTrim }),
    async startServices(store, emit) {
      await environmentRead
      const busy = createBusyHold({
        on: () => store.settings().waitWhenBusy,
        ...(options.load?.ratio !== undefined && { loadRatio: options.load.ratio }),
        ...(options.load?.memoryAvailable !== undefined && {
          memoryAvailable: options.load.memoryAvailable,
        }),
      })
      const memory = createMemoryWatch({
        read: () => busy.memory(),
        ...(options.load?.checkEveryMs !== undefined && { everyMs: options.load.checkEveryMs }),
      })
      const runs = await startRunManager({
        home: paths.home,
        store,
        agents,
        tokens: runTokens,
        env: environment.current,
        memory,
        ...(idle && { idle }),
        ...(options.oldestHost !== undefined && { oldestHost: options.oldestHost }),
        ...options.runs,
      })
      const banners = createBanners({ store, emit })
      const diskOptions = options.disk ?? {}
      const fakeFree = tedEnv('TED_FREE_BYTES_FILE')
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
      const fakeOnline = tedEnv('TED_ONLINE_FILE')
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
      const ghBin = given.ghBin ?? tedEnv('TED_GH_BIN')
      const integrations = createIntegrations({
        store,
        banners,
        emit,
        openTerminal,
        environment,
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
        tedVersion: options.version,
        onDrift: (drift) => emit({ type: 'drift-changed', drift }),
        onFactorySettings: async (factory, settings) => syncRepos?.(factory, settings),
      })
      let started: Tasks | undefined
      let storage: Storage | undefined
      const factories = createFactories({
        store,
        banners,
        gh: integrations.gh,
        workflows,
        reposDir: paths.repos,
        emit,
        login: () =>
          integrations.current()?.github.hosts.find((h) => h.host === 'github.com')?.login,
        onCloned: (factory) => {
          const tasks = started
          if (!tasks) return
          void tasks
            .setUpFactory(factory.id)
            .catch((error: unknown) =>
              console.error(`couldn’t create ${factory.name}’s setup Task:`, error),
            )
            .finally(() => tasks.wake(factory.id))
        },
        onReposRemoved: (repos) =>
          void storage?.removeUnusedClones(repos).catch((error: unknown) => {
            console.error('couldn’t remove the clones of removed repos:', error)
          }),
        ...(idle && { idle }),
      })
      syncRepos = async (factory, settings) => {
        const wanted = storedRepos(store, factory, settings)
        if (!wanted) return
        await factories.syncRepos(factory.id, wanted).catch((error: unknown) => {
          console.error(`couldn’t update ${factory.name}’s repos:`, error)
        })
      }
      const checkSlots = createCheckSlots({ limit: () => store.settings().maxChecksAtOnce })
      const checkTries = createCheckTries({
        store,
        checkSlots,
        banners,
        workflows,
        reposDir: paths.repos,
        scratchDir: paths.scratch,
        emit,
        env: environment.current,
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
        createTask: async (input) => {
          if (!started) throw new RequestError(503, 'TED is still starting')
          return started.create(input)
        },
        emit,
        ...(options.settingsMergeWaitMs !== undefined && {
          mergeWaitMs: options.settingsMergeWaitMs,
        }),
      })
      const libraryWatch = await watchLibrary({ libraryDir: paths.library, workflows, emit })
      const library = createLibrarySettings({
        store,
        workflows,
        libraryDir: paths.library,
        installed: (kind) => agents.installed(kind),
        emit,
        saved: (version) => libraryWatch.saw(version),
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
      await workflows.inherited().catch(() => undefined)
      let coordinators: Coordinators | undefined
      let taskDeliveryAllowed = (_runId: string) => true
      const steering = createSteering({
        home: paths.home,
        store,
        runs,
        isCurrentLead: (run) =>
          run.taskId !== undefined && store.getTask(run.taskId)?.leadRunId === run.id,
        deliveryFinished: (runId, error) => coordinators?.deliveryFinished(runId, error),
        canDeliver: (runId, admitted) =>
          !store.sideChats.forRun(runId) &&
          taskDeliveryAllowed(runId) &&
          (!store.coordinators.forRun(runId) ||
            coordinators?.deliveryAllowed(runId, admitted) === true),
      })
      let plans: Plans | undefined
      const sandbox = createSandbox({
        tedHome: paths.home,
        env: environment.current,
        ...(sandboxProgram && { program: sandboxProgram }),
      })
      const tasks = createTasks({
        testReportingEnv: async (task, checkRunId, position, supported) => {
          const registration = await new DaemonClient(info, token, {
            appKey: appToken,
          }).tryRegisterTestInvocation(task.id, {
            id: randomUUID(),
            supported,
            label: 'TED Check',
            checkRunId,
            position,
          })
          return registration && supported
            ? { TED_HOME: paths.home, TED_RUN_CAPABILITY: registration.token }
            : {}
        },
        ...(options.clock && { clock: options.clock }),
        steering,
        planning: () => plans,
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
        asana: {
          read: (path, query) => asana.read(path, query),
          user: () => asana.user(),
          comment: (gid, text, account) => asana.comment(gid, text, account),
          complete: (gid, account) => asana.complete(gid, account),
          account: () => asana.account(),
          files: {
            dir: paths.attachments,
            save: (file, name, mediaType) => attachments.saveFile(file, name, mediaType),
          },
          allowLoopbackFiles:
            new URL(options.asana?.apiOrigin ?? 'https://app.asana.com').hostname === '127.0.0.1',
          ...(options.asana?.intakeLimit !== undefined && {
            intakeLimit: options.asana.intakeLimit,
          }),
        },
        ...(options.snoozes !== undefined && { snoozes: options.snoozes }),
        ...(options.heldRequests !== undefined && { heldRequests: options.heldRequests }),
        ...(options.linearSyncMs !== undefined && { linearSyncMs: options.linearSyncMs }),
        ...(options.asanaSyncMs !== undefined && { asanaSyncMs: options.asanaSyncMs }),
        ...(options.githubSyncMs !== undefined && { githubSyncMs: options.githubSyncMs }),
        logsDir: paths.logs,
        runsDir: paths.runs,
        libraryDir: paths.library,
        isCloned: (factoryId) => factories.isCloned(factoryId),
        gh: integrations.gh,
        github: {
          files: {
            dir: paths.attachments,
            save: (file, name, mediaType) => attachments.saveFile(file, name, mediaType),
          },
          ...(options.github?.uploadOrigins !== undefined && {
            uploads: { origins: new Set(options.github.uploadOrigins) },
          }),
        },
        env: environment.current,
        ...(idle && { idle }),
        ...(options.nudgeAfterMs !== undefined && { nudgeAfterMs: options.nudgeAfterMs }),
        ...(options.mergePollMs !== undefined && { mergePollMs: options.mergePollMs }),
        ...(options.githubReadBurst !== undefined && {
          githubReadBurst: options.githubReadBurst,
        }),
        ...(options.beforeMerge !== undefined && { beforeMerge: options.beforeMerge }),
        ...(options.ciStuckMs !== undefined && { ciStuckMs: options.ciStuckMs }),
        ...(options.stallAfterMs !== undefined && { stallAfterMs: options.stallAfterMs }),
        busy,
        memory,
        ...(options.load?.checkEveryMs !== undefined && {
          busyCheckEveryMs: options.load.checkEveryMs,
        }),
        appsDir: paths.apps,
        ...(options.apps !== undefined && { apps: options.apps }),
        simulators: {
          dir: paths.simulators,
          ...(xcrun && { xcrun }),
          ...(idb && { idb }),
          ...(open && { open }),
          ...options.simulators,
        },
        emulators: {
          dir: paths.emulators,
          ...(emulatorBin && { emulator: emulatorBin }),
          ...(adbBin && { adb: adbBin }),
          ...(avdmanagerBin && { avdmanager: avdmanagerBin }),
          ...options.emulators,
        },
        saveAttachment: (file, name, mediaType) => attachments.saveFile(file, name, mediaType),
        checkSlots,
        sandbox,
      })
      taskDeliveryAllowed = (runId) => tasks.deliveryAllowed(runId)
      const shells = createShells({
        env: environment.current,
        async target(ref, repo) {
          const access = await tasks.worktreeAccess(ref, repo)
          return { ...access, env: { ...access.env, TED_HOME: paths.home } }
        },
        subscribe: (listener) => store.subscribe(listener),
        program: () => loginShell(environment.current()),
        onRunning: (count) => store.setShellsRunning(count),
        ...(idle && { idle }),
      })
      const editorOptions = options.editors ?? {}
      const editors = createEditors({
        env: environment.current,
        settings: () => store.settings(),
        ...(editorOptions.appDirs !== undefined && { appDirs: editorOptions.appDirs }),
        ...(editorOptions.launch !== undefined && { launch: editorOptions.launch }),
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
        apps: tasks,
        reposDir: paths.repos,
        sandbox,
        env: environment.current,
        checkSlots,
        libraryDir: paths.library,
        checkFailed: (input) => tasks.checkFailed(input),
        busy: async () => (await busy.check()) !== undefined,
        memory,
        ...(options.load?.checkEveryMs !== undefined && {
          busyCheckEveryMs: options.load.checkEveryMs,
        }),
        ...(idle && { idle }),
        ...(options.clock && { clock: options.clock }),
        ...automationOptions,
      })
      plans = createPlans({
        home: paths.home,
        store,
        runs,
        agents,
        health,
        banners,
        workflows,
        queue: tasks,
        reposDir: paths.repos,
        isCloned: (factoryId) => factories.isCloned(factoryId),
        startTask: (taskId) => tasks.start(taskId),
        planApproved: (taskId, input) => tasks.planApproved(taskId, input),
        stopLeadForChildren: (taskId) => tasks.stopLeadForChildren(taskId),
        planEnded: (taskId, input) => tasks.planEnded(taskId, input),
      })
      coordinators = createCoordinators({ home: paths.home, store, runs, tasks, health, steering })
      for (const run of store.listRuns()) {
        if (store.coordinators.forRun(run.id) && run.state !== 'finished')
          steering.syncQueuedFlag(run.id)
      }
      wake = () => {
        tasks.wake()
        automations.check()
      }
      disk.start()
      const backupless = [
        paths.worktrees,
        paths.repos,
        paths.simulators,
        paths.emulators,
        paths.scratch,
        paths.plans,
        paths.automationRuns,
      ]
      const excludeFromBackups =
        diskOptions.excludeFromBackups ??
        (tedEnv('TED_TIME_MACHINE') === 'off' ? async () => undefined : excludeFromTimeMachine)
      Promise.all(backupless.map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })))
        .then(() => excludeFromBackups(backupless))
        .catch((error: unknown) =>
          console.error('couldn’t exclude folders from Time Machine:', error),
        )
      const prune = () =>
        pruneRunOutput({
          runsDir: paths.runs,
          keepDays: store.settings().runOutputDays,
          endOf: (runId) => runOutputEnd(store, runId),
          ...(options.retention?.now && { now: options.retention.now() }),
        }).catch((error: unknown) => console.error('pruning Run output failed:', error))
      const archiveCleanup = createArchiveCleanup({
        store,
        tasks,
        ...(options.retention?.now && { now: options.retention.now }),
      })
      const sweepArchived = () =>
        archiveCleanup
          .sweep()
          .catch((error: unknown) => console.error('deleting archived Tasks failed:', error))
      void prune()
      void sweepArchived()
      let keptDays = store.settings().runOutputDays
      let archivedDays = store.settings().deleteArchivedAfterDays
      const stopPruningOnChange = store.subscribe((event) => {
        if (event.type !== 'settings-changed') return
        if (event.settings.deleteArchivedAfterDays !== archivedDays) {
          archivedDays = event.settings.deleteArchivedAfterDays
          void sweepArchived()
        }
        if (event.settings.runOutputDays === keptDays) return
        keptDays = event.settings.runOutputDays
        void prune()
      })
      const pruneTimer = setInterval(() => {
        void prune()
        void sweepArchived()
      }, options.retention?.checkEveryMs ?? pruneEveryMs)
      pruneTimer.unref()
      storage = createStorage({
        home: paths.home,
        store,
        disk,
        data,
        volumeName: diskOptions.volumeName ?? (() => volumeName(paths.home)),
      })
      started = tasks
      const sideChats = createSideChats({
        home: paths.home,
        store,
        runs,
        agents,
        health,
        tasks,
        ...(idle && { idle }),
      })
      const commands = createExecutionCommands({ store })
      options.execution?.ready?.({ commands, store })
      const execution = createExecutionController({
        home: paths.home,
        enabled: options.execution?.enabled ?? remoteExecutionOn(),
        store,
        commands,
        ...(options.execution?.now && { now: options.execution.now }),
        onProblem(text) {
          if (text)
            banners.raise({
              problem: 'execution-listener',
              severity: 'warning',
              text,
              action: { label: 'Open', opens: { kind: 'settings', section: 'machines' } },
            })
          else banners.clear({ problem: 'execution-listener' })
        },
        async repos() {
          const entries = await Promise.all(
            store.listFactories().map(async (factory) => {
              const { workflow } = await workflows.resolve(factory, { fetch: false })
              return factoryRepos(workflow, factory).map((repo) => ({
                factoryId: factory.id,
                factoryName: factory.name,
                repo: repo.repo.toLowerCase(),
              }))
            }),
          )
          return entries.flat()
        },
      })
      await execution.start()
      const factoryRemovals = createFactoryRemovals({
        execution,
        factorySettings,
        sideChats,
        coordinators,
        store,
        banners,
        tasks,
        automations,
        plans,
        factories,
        checkTries,
        workflows,
        storage: () => storage,
      })
      factories.start()
      const stayAwake = options.holdAwake && stayAwakeWhileWorking(store, options.holdAwake)
      const conversations = createConversations({
        coordinators,
        steering,
        store,
        runs,
        agents,
        health,
        disk,
      })
      const versionRestarts = await restartOnNewVersions({
        store,
        health,
        conversations,
        versionsFile: path.join(paths.home, 'agent-versions.json'),
      })
      if (options.checkAgentsOnStart) {
        health.check().catch((error: unknown) => console.error('agent health check failed:', error))
      }
      const services = {
        execution,
        sideChats,
        coordinators,
        automations,
        plans,
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
        factoryRemovals,
        checkTries,
        library,
        shells,
        editors,
        archiveCleanup,
        async close() {
          await execution.close()
          const shellsClosed = shells.close()
          await sideChats.close()
          await coordinators.close()
          await automations.close()
          plans.close()
          libraryWatch.close()
          versionRestarts.close()
          await checkTries.close()
          workflows.close()
          await factorySettings.close()
          stayAwake?.close()
          disk.close()
          clearInterval(pruneTimer)
          stopPruningOnChange()
          await archiveCleanup.close()
          stopWatchingWrites()
          online.close()
          health.close()
          await integrations.close()
          await factories.close()
          await tasks.close()
          await runs.close()
          await shellsClosed
        },
      }
      return { ...services, agentAvailability: createAgentAvailability({ ...services, store }) }
    },
  })
  const commandLine = createCommandLine(options.commandLine)
  commandLine
    .refresh()
    .catch((error: unknown) => console.error('rewriting the ted command failed:', error))
  const token = randomBytes(32).toString('hex')
  const appToken = options.appToken ?? randomBytes(32).toString('hex')
  const slow = createSlowMonitor(options.slow)
  const profiler = createCpuProfiler(paths.home, options.stallProfiles)
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
    asana,
    reposDir: paths.repos,
    appStreams: new Set(),
    onShutdown: options.onShutdown ?? (() => undefined),
    home: paths.home,
    commandLine,
    slow,
    profiler,
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
    async stop(onStep) {
      await asana.close()
      idle?.cancel()
      slow.close()
      profiler.close()
      await rm(paths.daemonInfo, { force: true })
      onStep?.('connections')
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await data.close(onStep)
      lock.release()
    },
  }
}
