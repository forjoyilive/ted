import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DaemonClient,
  type DaemonEvent,
  type DaemonInfo,
  type DataStatus,
  type PublicDaemonInfo,
  type Run,
  remoteExecutionOn,
  tedEnv,
  tedPaths,
} from '@ted/protocol'
import { effectiveTimeZone, requestSnoozePresets } from '@ted/protocol/time'
import { createAgentAvailability } from './agent-availability.ts'
import { createAgents } from './agents/index.ts'
import type { Apps } from './apps/apps.ts'
import { type AsanaOptions, createAsana } from './asana/asana.ts'
import { createAttachments } from './attachments.ts'
import { createAutomations } from './automations/automations.ts'
import { createBanners } from './banners.ts'
import { createBusyHold } from './busy.ts'
import { createChatArchiveCleanup } from './chat-expiry.ts'
import { builtInAgents } from './chats/agents.ts'
import { createChatCommands } from './chats/commands.ts'
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
import type { MakeDirectory } from './files.ts'
import { createAgentHealth } from './health/agent-health.ts'
import { agentHostsReachable, onlineFromFile, watchOnline } from './health/online.ts'
import { startIdleTimer } from './idle.ts'
import { createIntegrations } from './integrations.ts'
import { createLibrarySettings } from './library-settings.ts'
import { type LibraryWatchOptions, watchLibrary } from './library-watch.ts'
import { type Keyring, loadKeyring } from './linear/keyring.ts'
import { createLinear } from './linear/linear.ts'
import { acquireLock } from './lock.ts'
import { createMemoryWatch } from './memory-kills.ts'
import { phoneMoveApprovals } from './phones/approvals.ts'
import { serviceChatSource } from './phones/chats.ts'
import { createPhoneImages, type ImageShrinker } from './phones/images.ts'
import { osPhoneKeyrings, type PhoneKeyrings } from './phones/keys.ts'
import { createPhoneNotifier } from './phones/notifier.ts'
import { createPhones } from './phones/phones.ts'
import type { PhoneProblemSource } from './phones/problems.ts'
import { noPush, type PushService } from './phones/push.ts'
import { storeInbox } from './phones/requests.ts'
import { storeTaskSource } from './phones/tasks.ts'
import { createPlans, type Plans } from './plans/plans.ts'
import { createPresence } from './presence.ts'
import { QuitMarkedError, quitMarkedSync } from './quit-mark.ts'
import { redactSecrets } from './redact.ts'
import { pruneRunOutput, runOutputEnd } from './retention.ts'
import { loadRunTokens } from './run-token.ts'
import { createConversations } from './runs/conversations.ts'
import { sleepIdleRuns } from './runs/idle-sleep.ts'
import { type RunManager, startRunManager } from './runs/run-manager.ts'
import { createSteering } from './runs/steering.ts'
import { followTaskTokens } from './runs/task-tokens.ts'
import { restartOnNewVersions } from './runs/version-restarts.ts'
import { createSandbox } from './sandbox.ts'
import { listen } from './server.ts'
import { createShells } from './shells.ts'
import { createSideChats } from './side-chats/side-chats.ts'
import { createSlowMonitor } from './slow-moments.ts'
import { type HoldAwake, stayAwakeForPhones, stayAwakeWhileWorking } from './stay-awake.ts'
import { createStorage, type Storage } from './storage.ts'
import type { StoredFactory, TedStore } from './store/index.ts'
import { createArchiveCleanup } from './tasks/archive-expiry.ts'
import { createCheckSlots } from './tasks/check-slots.ts'
import { factoryRepos } from './tasks/repos.ts'
import { createTasks, type Tasks } from './tasks/tasks.ts'
import { createTerminalOpener, type OpenTerminal } from './terminal.ts'
import type { WorkflowSettings } from './workflow/check.ts'
import { createWorkflows, type Workflows } from './workflow/workflows.ts'

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
  piBin?: string
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
  github?: { uploadOrigins?: string[]; intakeLimit?: number }
  linear?: { apiUrl?: string; keyring?: Keyring; intakeLimit?: number }
  snoozes?: { now?: () => Date; checkEveryMs?: number }
  heldRequests?: { maxMs?: number }
  linearSyncMs?: number
  asanaSyncMs?: number
  githubSyncMs?: number
  onShutdown?: () => void
  holdAwake?: HoldAwake
  holdOnPower?: HoldAwake
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
  libraryWatch?: LibraryWatchOptions
  settingsMergeWaitMs?: number
  stallAfterMs?: number
  apps?: {
    pollMs?: number
    readyTimeoutMs?: number
    buildTurnMs?: number
    hostStartMs?: number
    stopGraceMs?: number
    logBytes?: number
  }
  runs?: { stopGraceMs?: number; inputAckMs?: number; inputRetries?: number; inputRetryMs?: number }
  simulators?: { supported?: boolean; pollMs?: number; idleMs?: number }
  emulators?: { supported?: boolean; pollMs?: number; idleMs?: number; bootTimeoutMs?: number }
  online?: DaemonOnlineOptions
  limitProbeMs?: number
  scratchMaxAgeMs?: number
  automations?: DaemonAutomationsOptions
  retention?: DaemonRetentionOptions
  idleSleep?: { now?: () => number; checkEveryMs?: number }
  oldestHost?: number
  editors?: DaemonEditorsOptions
  compaction?: DataOptions['compaction']
  stallProfiles?: StallProfiles
  outputDrop?: DataOptions['outputDrop']
  changesetTrim?: DataOptions['changesetTrim']
  slow?: { requestMs?: number; stallMs?: number }
  wrap?: DaemonWrappers
  mkdir?: MakeDirectory
  phones?: DaemonPhonesOptions
}

export interface DaemonPhonesOptions {
  keyrings?: PhoneKeyrings
  relayUrl?: string
  now?: () => number
  macName?: () => Promise<string>
  relayDelaysMs?: readonly number[]
  relayAnswerMs?: number
  relayListAckMs?: number
  push?: PushService
  presence?: { now?: () => number; staleMs?: number }
  shrinkImage?: ImageShrinker
}

export interface DaemonWrappers {
  store?: (store: TedStore) => TedStore
  runs?: (runs: RunManager, store: TedStore) => RunManager
  workflows?: (workflows: Workflows) => Workflows
  plans?: (plans: Plans) => Plans
  coordinators?: (coordinators: Coordinators) => Coordinators
  apps?: (apps: Apps) => Apps
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
  reporting(): boolean
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
    piBin: options.piBin ?? tedEnv('TED_PI_BIN') ?? 'pi',
    env: environment.current,
  })
  const openTerminal = given.openTerminal ?? createTerminalOpener({ tmpDir: paths.tmp })
  let openStore: TedStore | undefined
  const data = createData({
    home: paths.home,
    version: options.version,
    ...(options.onDataStatus && { onStatus: options.onDataStatus }),
    ...(options.compaction && { compaction: options.compaction }),
    ...(options.outputDrop && { outputDrop: options.outputDrop }),
    ...(options.changesetTrim && { changesetTrim: options.changesetTrim }),
    async startServices(opened, emit) {
      const store = options.wrap?.store?.(opened) ?? opened
      openStore = store
      await environmentRead
      const busy = createBusyHold({
        on: () => store.settings().waitWhenBusy,
        ...(options.load?.ratio !== undefined && { loadRatio: options.load.ratio }),
        ...(options.load?.memoryAvailable !== undefined && {
          memoryAvailable: options.load.memoryAvailable,
        }),
        ...(options.load?.checkEveryMs !== undefined && { confirmMs: options.load.checkEveryMs }),
      })
      const memory = createMemoryWatch({
        read: () => busy.memory(),
        ...(options.load?.checkEveryMs !== undefined && { everyMs: options.load.checkEveryMs }),
      })
      const sandbox = createSandbox({
        tedHome: paths.home,
        env: environment.current,
        ...(sandboxProgram && { program: sandboxProgram }),
      })
      store.setPiSandboxProblem(await sandbox.problem())
      const startedRuns = await startRunManager({
        sandbox,
        ...(sandboxProgram && { sandboxProgram }),
        home: paths.home,
        store,
        agents,
        tokens: runTokens,
        env: environment.current,
        memory,
        ...(idle && { idle }),
        ...(options.oldestHost !== undefined && { oldestHost: options.oldestHost }),
        ...options.runs,
        ...(options.mkdir !== undefined && { mkdir: options.mkdir }),
      })
      const runs = options.wrap?.runs?.(startedRuns, store) ?? startedRuns
      const bannerListeners = new Set<(event: DaemonEvent) => void>()
      const banners = createBanners({
        store,
        emit: (event) => {
          emit(event)
          for (const listener of bannerListeners) listener(event)
        },
      })
      const phoneProblemSource: PhoneProblemSource = {
        banners: () => banners.list(),
        factoryName: (factoryId) => store.getFactory(factoryId)?.name,
        subscribe(listener) {
          const unsubscribe = store.subscribe(listener)
          bannerListeners.add(listener)
          return () => {
            unsubscribe()
            bannerListeners.delete(listener)
          }
        },
      }
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
        sandbox,
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
      const createdWorkflows = createWorkflows({
        store,
        banners,
        libraryDir: paths.library,
        reposDir: paths.repos,
        tedVersion: options.version,
        onDrift: (drift) => emit({ type: 'drift-changed', drift }),
        onStages: (factoryId) => emit({ type: 'factory-stages-changed', factoryId }),
        onFactorySettings: async (factory, settings) => syncRepos?.(factory, settings),
      })
      const workflows = options.wrap?.workflows?.(createdWorkflows) ?? createdWorkflows
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
      const checkSlots = createCheckSlots({
        limit: () => store.settings().maxChecksAtOnce,
        cpuPercent: () => store.settings().checkCpuPercent,
      })
      const checkTries = createCheckTries({
        store,
        checkSlots,
        banners,
        workflows,
        reposDir: paths.repos,
        scratchDir: paths.scratch,
        emit,
        sandbox,
        env: environment.current,
        ...(options.scratchMaxAgeMs !== undefined && { maxAgeMs: options.scratchMaxAgeMs }),
        instructions: () => started?.instructionTries,
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
          if (!started) throw new RequestError(503, 'Ted is still starting')
          return started.create(input)
        },
        emit,
        ...(options.settingsMergeWaitMs !== undefined && {
          mergeWaitMs: options.settingsMergeWaitMs,
        }),
      })
      const libraryWatch = await watchLibrary({
        ...options.libraryWatch,
        libraryDir: paths.library,
        workflows,
        emit,
      })
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
      const tasks = createTasks({
        testReportingEnv: async (task, checkRunId, position, supported) => {
          const registration = await new DaemonClient(info, token, {
            appKey: appToken,
          }).tryRegisterTestInvocation(task.id, {
            id: randomUUID(),
            supported,
            label: 'Ted Check',
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
        chats: () => coordinators,
        setPullRequestCi: (factoryId, repo, mode) =>
          factorySettings.setPullRequestCi(factoryId, repo, mode),
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
        ...(options.linear?.intakeLimit !== undefined && {
          linearIntakeLimit: options.linear.intakeLimit,
        }),
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
          ...(options.github?.intakeLimit !== undefined && {
            intakeLimit: options.github.intakeLimit,
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
        ...(options.wrap?.apps !== undefined && { wrapApps: options.wrap.apps }),
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
        busy: async () => (await busy.check()) !== undefined || busy.pending(),
        memory,
        ...(options.load?.checkEveryMs !== undefined && {
          busyCheckEveryMs: options.load.checkEveryMs,
        }),
        ...(idle && { idle }),
        ...(options.clock && { clock: options.clock }),
        ...automationOptions,
      })
      const chatBuiltIns = await builtInAgents()
      const chatCommands = createChatCommands({
        home: paths.home,
        store,
        checkSlots,
        sandbox,
        banners,
        workflows,
        env: environment.current,
      })
      const createdPlans = createPlans({
        home: paths.home,
        builtInAgents: chatBuiltIns,
        commands: chatCommands,
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
      plans = options.wrap?.plans?.(createdPlans) ?? createdPlans
      const createdCoordinators = createCoordinators({
        home: paths.home,
        builtInAgents: chatBuiltIns,
        commands: chatCommands,
        env: environment.current,
        agents,
        automations,
        agentTargets: { library, factory: factorySettings },
        banners,
        reposDir: paths.repos,
        store,
        runs,
        tasks,
        health,
        steering,
        workflows,
        ...(options.mkdir !== undefined && { mkdir: options.mkdir }),
      })
      coordinators = options.wrap?.coordinators?.(createdCoordinators) ?? createdCoordinators
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
        paths.chatCode,
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
      const phoneImages = createPhoneImages({
        home: paths.home,
        comment: (id) => store.getComment(id),
        task: (id) => store.getTask(id),
        file: (attachment) => attachments.file(attachment),
        ...(options.phones?.shrinkImage && { shrink: options.phones.shrinkImage }),
      })
      const prunePhoneImages = () =>
        phoneImages
          .prune(options.retention?.now?.())
          .catch((error: Error) => console.error('pruning cached phone images failed:', error))
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
      const chatArchiveCleanup = createChatArchiveCleanup({
        store,
        plans,
        coordinators,
        ...(options.retention?.now && { now: options.retention.now }),
      })
      const sweepArchived = () =>
        Promise.all([archiveCleanup.sweep(), chatArchiveCleanup.sweep()]).catch((error: unknown) =>
          console.error('deleting archived Tasks or chats failed:', error),
        )
      void prune()
      void prunePhoneImages()
      void sweepArchived()
      let keptDays = store.settings().runOutputDays
      let archivedDays = store.settings().deleteArchivedAfterDays
      let archivedChatDays = store.settings().deleteArchivedChatsAfterDays
      const stopPruningOnChange = store.subscribe((event) => {
        if (event.type !== 'settings-changed') return
        if (
          event.settings.deleteArchivedAfterDays !== archivedDays ||
          event.settings.deleteArchivedChatsAfterDays !== archivedChatDays
        ) {
          archivedDays = event.settings.deleteArchivedAfterDays
          archivedChatDays = event.settings.deleteArchivedChatsAfterDays
          void sweepArchived()
        }
        if (event.settings.runOutputDays === keptDays) return
        keptDays = event.settings.runOutputDays
        void prune()
      })
      const pruneTimer = setInterval(() => {
        void prune()
        void prunePhoneImages()
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
      const conversations = createConversations({
        coordinators,
        steering,
        store,
        runs,
        agents,
        health,
        disk,
      })
      const phonePlans = plans
      const phoneMoves = phoneMoveApprovals(store, tasks)
      const phones = createPhones({
        phones: store.phones,
        inbox: storeInbox(
          store,
          {
            task: async (id, answer) => {
              await tasks.answerFromPhone(id, answer)
            },
            chat: async (chatId, id, answer) => {
              await coordinators.answerRequest(chatId, id, answer)
            },
            plan: async (id, answer) => {
              await phonePlans.answer(id, answer)
            },
            automation: async (id, answer) => {
              await automations.answer(id, answer)
            },
          },
          phoneMoves,
          async (id, answer) => {
            if (answer.action === 'stop-command') {
              await coordinators.stopOutside(answer.chatId, id)
            } else if (answer.action === 'approve-command') {
              await coordinators.answerOutsideCommand(
                answer.chatId,
                id,
                {
                  run: answer.decision !== 'decline',
                  always: answer.decision === 'always',
                },
                answer.revision,
              )
            } else {
              const comment = store.getComment(id)
              if (
                comment?.move?.askedBy === 'coordinator' &&
                comment.move.chatId === answer.chatId
              ) {
                if (answer.choices && Object.keys(answer.choices).length > 0)
                  throw new RequestError(400, 'A move to another Factory takes no choices.')
                await phoneMoves.answer(comment, answer.decision, answer.revision)
              } else {
                await coordinators.answerConfirmation(answer.chatId, id, answer)
              }
            }
          },
          async (id, choice) => {
            const now = options.snoozes?.now?.() ?? new Date(options.clock?.now() ?? Date.now())
            const until =
              choice === 'clear'
                ? null
                : requestSnoozePresets(now, effectiveTimeZone(store.settings())).find(
                    (preset) => preset.id === choice,
                  )?.until
            if (until === undefined) throw new RequestError(400, 'Choose a snooze time.')
            tasks.snoozeRequest(id, until)
            await store.persisted()
            return until
          },
        ),
        tasks: storeTaskSource(
          store,
          async (factoryId) => (await tasks.board(factoryId)).stages,
          (taskId) => tasks.hierarchyPreview(taskId).descendants.map((child) => child.id),
        ),
        taskChanges: {
          task: (ref) => store.getTask(ref),
          start: (ref) => tasks.startWithOutcome(ref),
          stop: (ref) => tasks.stop(ref),
          resume: (ref, comment) => tasks.resumeFromPhone(ref, comment),
          setPriority: (ref, priority) => tasks.setPriority(ref, priority),
          comment: (ref, caller, input) => tasks.comment(ref, caller, input),
          archive: (ref, options) => tasks.archive(ref, options),
          delete: (ref, options) => tasks.delete(ref, options),
          hierarchyRevision: (ref) => tasks.hierarchy(ref).revision,
        },
        taskCreation: {
          enabledProviders: () => store.settings().enabledAgents,
          piModels: () => health.models('pi'),
          factories: () => store.listFactories(),
          defaults: (factoryId) => tasks.defaults(factoryId),
          task: (ref) => store.getTask(ref),
          create: (input, caller) => tasks.create(input, caller),
          start: (ref) => tasks.start(ref),
        },
        uploads: {
          dir: paths.phoneUploads,
          save: (file, name, mediaType) => attachments.saveFile(file, name, mediaType),
        },
        chats: serviceChatSource({
          factories: () => store.listFactories(),
          coordinatorChats: (factoryId) => coordinators.chats(factoryId),
          coordinator: (chatId) => coordinators.get(chatId),
          coordinatorConversation: (chatId) => conversations.coordinatorChat(chatId),
          coordinatorMoves: (chatId) => store.coordinatorMoves(chatId),
          waitingMoveChats: () =>
            new Set(
              [...store.waiting(), ...store.snoozed()].flatMap((waiting) => {
                if (waiting.source !== 'task') return []
                const ask = store.getComment(waiting.id)?.move
                return ask?.askedBy === 'coordinator' && ask.chatId ? [ask.chatId] : []
              }),
            ),
          moveApproval: phoneMoves.read,
          plans: () => phonePlans.list(),
          plan: (planId) => phonePlans.detail(planId),
          runConversation: (runId) => conversations.chat(runId),
        }),
        chatChanges: {
          factories: () => store.listFactories(),
          agents: (factoryId) => coordinators.agents(factoryId),
          messageCoordinator: (chatId, message, retry) =>
            coordinators.message(chatId, message, retry),
          stopCoordinator: (chatId) => coordinators.stop(chatId),
          retryCoordinator: (chatId) => coordinators.retry(chatId),
          archiveCoordinator: (chatId) => coordinators.archiveChat(chatId),
          unarchiveCoordinator: (chatId) => coordinators.unarchiveChat(chatId),
          renameCoordinator: (chatId, title) => coordinators.renameChat(chatId, title),
          deleteCoordinator: (chatId) => coordinators.deleteChat(chatId),
          startCoordinator: (factoryId, input, retry) =>
            coordinators.start(factoryId, input, retry),
          plan: async (planId) => (await phonePlans.detail(planId)).plan,
          async sendToRun(chatId, runId, text, retry) {
            await conversations.send(runId, text, {
              interrupt: false,
              phoneChat: { chatId, retry },
            })
          },
          resumePlan: (planId, caller, message, retry) =>
            phonePlans.resume(planId, caller, message, retry),
          stopPlan: (planId, caller) => phonePlans.stop(planId, caller),
          archivePlan: (planId, caller) => phonePlans.archive(planId, caller),
          unarchivePlan: (planId, caller) => phonePlans.unarchive(planId, caller),
          renamePlan: (planId, title, caller) => phonePlans.rename(planId, title, caller),
          deletePlan: (planId, caller) => phonePlans.delete(planId, caller),
          startPlan: (input, caller, retry) => phonePlans.start(input, caller, retry),
        },
        images: phoneImages,
        problems: phoneProblemSource,
        planUsage: () => {
          const providers = health.list()
          return {
            providers: store.settings().enabledAgents.map((provider) => {
              const usage = providers.find(({ agent }) => agent === provider)?.planUsage
              return {
                provider,
                ...(usage?.windows.length && {
                  usage: {
                    at: usage.at,
                    windows: usage.windows.map(({ window, percent, resetsAt }) => ({
                      window,
                      percent,
                      ...(resetsAt !== undefined && { resetsAt }),
                    })),
                  },
                }),
              }
            }),
          }
        },
        dismissProblem: banners.dismissProblem,
        keyrings: options.phones?.keyrings ?? osPhoneKeyrings,
        version: options.version,
        ...(options.phones?.relayUrl !== undefined && { relayUrl: options.phones.relayUrl }),
        ...(options.phones?.now && { now: options.phones.now }),
        ...(options.phones?.macName && { macName: options.phones.macName }),
        ...(options.phones?.relayDelaysMs && { relayDelaysMs: options.phones.relayDelaysMs }),
        ...(options.phones?.relayAnswerMs !== undefined && {
          relayAnswerMs: options.phones.relayAnswerMs,
        }),
        ...(options.phones?.relayListAckMs !== undefined && {
          relayListAckMs: options.phones.relayListAckMs,
        }),
      })
      await phones.start()
      const presence = createPresence(options.phones?.presence)
      const phoneNotifier = createPhoneNotifier({
        store,
        presence,
        push: options.phones?.push ?? noPush,
        problems: phoneProblemSource,
        ...(options.phones?.now && { now: options.phones.now }),
      })
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
      const stayAwakeOnPower = options.holdOnPower && stayAwakeForPhones(store, options.holdOnPower)
      const taskTokens = followTaskTokens({ store, runs, agents })
      const versionRestarts = await restartOnNewVersions({
        store,
        health,
        conversations,
        versionsFile: path.join(paths.home, 'agent-versions.json'),
      })
      runs.envSource(async (run) => {
        if (run.taskId !== undefined) return tasks.runEnv(run)
        if (store.coordinators.forRun(run.id)?.runId === run.id) return coordinators.runEnv(run)
        if (store.plans.get(run.id) !== undefined) return plans.runEnv(run)
        return undefined
      })
      const wakeBanners = new Map<string, string>()
      const wakeSubject = (run: Run) => {
        const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
        if (task) {
          const who =
            run.parentRunId === undefined
              ? `${task.displayId}’s Task Lead`
              : `${task.displayId}’s sub-agent “${run.name ?? 'Sub-agent'}”`
          return {
            factoryId: task.factoryId,
            who,
            action: { label: 'Open Task', opens: { kind: 'task' as const, taskId: task.id } },
          }
        }
        const chat = store.coordinators.forRun(run.id)
        if (chat?.runId === run.id)
          return {
            factoryId: chat.factoryId,
            who: `The Coordinator chat “${chat.title ?? 'Coordinator'}”`,
          }
        const plan = store.plans.get(run.id)
        if (plan) return { factoryId: plan.factoryId, who: `The planning chat “${plan.title}”` }
        return undefined
      }
      runs.observe({
        wakeFailed(run, failures, reason) {
          const subject = wakeSubject(run)
          if (!subject || failures < 2) return
          wakeBanners.set(run.id, subject.factoryId)
          banners.raiseUnsaved({
            problem: 'run-wake-failed',
            subject: run.id,
            factoryId: subject.factoryId,
            severity: 'warning',
            text: redactSecrets(
              `${subject.who} couldn’t be started again after it was idle, and Ted keeps trying: ${reason.split('\n')[0] ?? ''}`,
            ),
            ...(subject.action && { action: subject.action }),
          })
        },
        woke(run) {
          const factoryId = wakeBanners.get(run.id)
          if (factoryId === undefined) return
          wakeBanners.delete(run.id)
          banners.clear({ problem: 'run-wake-failed', subject: run.id, factoryId })
        },
      })
      const idleSleep = sleepIdleRuns({
        store,
        runs,
        midWork: (taskId) => tasks.midWork(taskId),
        chatRests: (run) =>
          store.coordinators.forRun(run.id)?.runId === run.id
            ? coordinators.mayRest(run.id)
            : plans.mayRest(run.id),
        ...options.idleSleep,
      })
      if (options.checkAgentsOnStart) {
        health.check().catch((error: unknown) => console.error('agent health check failed:', error))
      }
      const services = {
        busy,
        execution,
        phones,
        presence,
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
        chatArchiveCleanup,
        async close() {
          openStore = undefined
          phoneNotifier.close()
          presence.close()
          phones.close()
          await execution.close()
          const shellsClosed = shells.close()
          await sideChats.close()
          chatCommands.close()
          await coordinators.close()
          await automations.close()
          plans.close()
          libraryWatch.close()
          versionRestarts.close()
          taskTokens.close()
          idleSleep.close()
          await checkTries.close()
          workflows.close()
          await factorySettings.close()
          stayAwake?.close()
          stayAwakeOnPower?.close()
          disk.close()
          clearInterval(pruneTimer)
          stopPruningOnChange()
          await archiveCleanup.close()
          await chatArchiveCleanup.close()
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
  await writePublicDaemonInfo(paths, { port, pid: process.pid, version: options.version })
  await data.open()

  return {
    port,
    appToken,
    reporting() {
      try {
        return openStore?.settings().reporting ?? false
      } catch {
        return false
      }
    },
    async stop(onStep) {
      await asana.close()
      idle?.cancel()
      slow.close()
      profiler.close()
      await rm(paths.daemonInfo, { force: true })
      await rm(paths.publicDaemonInfo, { force: true })
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

async function writePublicDaemonInfo(
  paths: ReturnType<typeof tedPaths>,
  info: PublicDaemonInfo,
): Promise<void> {
  await mkdir(paths.public, { recursive: true, mode: 0o700 })
  const tmp = `${paths.publicDaemonInfo}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(info), { mode: 0o600 })
  await rename(tmp, paths.publicDaemonInfo)
}
