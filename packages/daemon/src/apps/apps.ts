import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import {
  type AppLog,
  type AppRef,
  type AppStarter,
  appEnvName,
  approvedOutsideSandbox,
  type DaemonEvent,
  type DeviceRequest,
  isDeviceApp,
  isEmulatorApp,
  isSimulatorApp,
  type OutsideSandboxApproval,
  type SimulatorSlots,
  type TaskApp,
  tedEnv,
} from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { worktreeCommandEnv } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import { holdsLock, isLockHeld } from '../lock.ts'
import { nodeEntry } from '../node-entry.ts'
import { withRunPermissions } from '../permissions.ts'
import { workCommand } from '../priority.ts'
import { markProcessRoot } from '../process-roots.ts'
import { redactSecrets } from '../redact.ts'
import { type LaunchAuthority, launchAuthority } from '../runs/launch-authority.ts'
import { type Sandbox, type SandboxScope, SandboxUnavailable, withSandboxEnv } from '../sandbox.ts'
import { signalGroup, signalProcess } from '../signal.ts'
import type { TedStore } from '../store/index.ts'
import { checkCpus } from '../tasks/check-slots.ts'
import { removeInside } from '../tasks/remove-files.ts'
import { certificateErrorCode } from '../tls-trust.ts'
import { isReservedEnvName } from '../workflow/check.ts'
import type { AppDeclaration } from './declared.ts'
import { createDevicePool } from './device-pool.ts'
import type { SimulatorApp } from './device-slots.ts'
import {
  type AndroidTools,
  createAndroidTools,
  createEmulators,
  type Emulators,
} from './emulators.ts'
import {
  type AppHostRecord,
  type AppLaunchFile,
  appFiles,
  appLogBytes,
  parseAppRecords,
} from './host-files.ts'
import { logSize, type ReadyRead, readyFromLaunch, readyLineSince } from './ready-line.ts'
import {
  createSimulators,
  createSimulatorTools,
  type Simulators,
  type SimulatorTools,
} from './simulators.ts'

const hostMain = fileURLToPath(new URL('./host.ts', import.meta.url))
const testMarkers = ['TED_EXIT_WITH_PID', 'TED_TEST_RUN', 'TED_TEST_FILE']
const logViewBytes = 512 * 1024

export interface AppRepo {
  name: string
  worktree: string
  env: Record<string, string>
  apps: AppDeclaration[]
}

export interface AppTask {
  displayId: string
  factoryId: string
  repos: AppRepo[]
  sandbox?: Omit<SandboxScope, 'tmp'>
  outsideSandbox?: readonly OutsideSandboxApproval[]
  cache?: string
}

export function outsideSandboxApproval(
  repo: Pick<AppRepo, 'name' | 'env'>,
  app: AppDeclaration,
): OutsideSandboxApproval {
  const sorted = (env: Record<string, string>) =>
    Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const declaration = createHash('sha256')
    .update(
      JSON.stringify([
        repo.name,
        app.name,
        app.kind,
        app.run,
        sorted(app.env),
        sorted(repo.env),
        app.electron === true,
      ]),
    )
    .digest('hex')
  return { repo: repo.name, app: app.name, declaration }
}

function refuseUnconfirmed(
  task: AppTask,
  repo: AppRepo,
  app: AppDeclaration,
  by: AppStarter,
  confirmed: { declaration?: string },
): void {
  if (by !== 'human' || task.sandbox === undefined) return
  const current = outsideSandboxApproval(repo, app)
  if (confirmed.declaration === current.declaration) return
  if (approvedOutsideSandbox(task.outsideSandbox, current)) return
  throw new RequestError(
    409,
    `Ted didn’t start ${app.name}: running it outside the sandbox needs your confirmation for its current command. Start it again and confirm.`,
  )
}

export interface SimulatorOptions {
  dir: string
  supported?: boolean
  tools?: SimulatorTools
  xcrun?: string
  idb?: string
  open?: string
  banners?: Banners
  pollMs?: number
  idleMs?: number
}

export interface EmulatorOptions {
  dir: string
  supported?: boolean
  tools?: AndroidTools
  emulator?: string
  adb?: string
  avdmanager?: string
  banners?: Banners
  pollMs?: number
  idleMs?: number
  bootTimeoutMs?: number
}

export interface StartOptions {
  runId?: string
  shutDown?: string
  reason?: string
  confirmed?: { declaration?: string }
}

export interface AppsOptions {
  appsDir: string
  store: TedStore
  busy?: () => Promise<boolean>
  env?: () => NodeJS.ProcessEnv
  task(taskId: string): Promise<AppTask>
  keep(taskId: string): boolean
  emit(event: DaemonEvent): void
  idle?: IdleTimer
  pollMs?: number
  readyTimeoutMs?: number
  buildTurnMs?: number
  stopGraceMs?: number
  logBytes?: number
  simulators?: SimulatorOptions
  emulators?: EmulatorOptions
  sandbox: Sandbox
  sandboxProblem(factoryId: string): Promise<string | undefined>
}

export interface Apps {
  list(taskId: string): Promise<TaskApp[]>
  start(taskId: string, ref: AppRef, by: AppStarter, options?: StartOptions): Promise<TaskApp>
  stop(taskId: string, ref: AppRef): Promise<TaskApp>
  restart(taskId: string, ref: AppRef, by: AppStarter, declaration?: string): Promise<TaskApp>
  log(taskId: string, ref: AppRef): Promise<AppLog>
  envFor(taskId: string): Promise<Record<string, string>>
  stopRepo(taskId: string, repo: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  simulators(): SimulatorSlots
  emulators(): SimulatorSlots
  show(taskId: string, ref: AppRef): Promise<TaskApp>
  screenshot(taskId: string, ref: AppRef): Promise<{ file: string; app: TaskApp }>
  control(taskId: string, request: DeviceRequest): Promise<string>
  record(
    taskId: string,
    ref: AppRef,
    action: 'start' | 'stop',
  ): Promise<{ file?: string; app: TaskApp }>
  withSimulatorRequest: Simulators['withRequest']
  close(): Promise<void>
}

interface Instance {
  repo: string
  name: string
  kind: TaskApp['kind']
  port?: number
  url?: string
  debugUrl?: string
  ready: 'url' | 'start'
  startedAt: string
  startedBy?: AppStarter
  runId?: string
  restart?: boolean
  sandboxed?: boolean
  waitingFor?: string
  readyAt?: string
  builtAt?: string
  readyFrom?: number
  ended?: {
    at: string
    how: 'stopped' | 'exited' | 'failed'
    code?: number
    signal?: string
    problem?: string
  }
}

interface Runner {
  launch(input: {
    dir: string
    run: string
    cwd: string
    env: NodeJS.ProcessEnv
    logBytes: number
    authority: LaunchAuthority
    shell?: string[]
    fds?: readonly number[]
    lowPriority: boolean
  }): Promise<void>
}

const processRunner: Runner = {
  async launch({ dir, run, cwd, env, logBytes, shell, fds = [], authority, lowPriority }) {
    const files = appFiles(dir)
    const launch: AppLaunchFile = {
      run,
      cwd,
      logBytes,
      authority,
      ...(shell !== undefined && { shell }),
      ...(fds.length > 0 && { bindFds: fds.length }),
    }
    await writeFile(files.launch, JSON.stringify(launch), { mode: 0o600 })
    await rm(files.records, { force: true })
    await appendFile(files.log, `$ ${run}\n`, { mode: 0o600 })
    const entry = nodeEntry(hostMain, [dir])
    const host = workCommand(entry.command, entry.args, lowPriority)
    const child = spawn(host.command, host.args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', ...fds],
      cwd: dir,
      env: { ...env, ...markers(), ELECTRON_RUN_AS_NODE: '1' },
    })
    child.unref()
    for (let waited = 0; ; waited += 25) {
      const records = parseAppRecords(await readFile(files.records, 'utf8').catch(() => ''))
      if (records.some((record) => record.t === 'start')) break
      if (waited >= 10_000) {
        child.kill('SIGKILL')
        throw new RequestError(409, 'The App did not start; Ted stopped its host')
      }
      await sleep(25)
    }
  },
}

const runners: Record<TaskApp['kind'], Runner> = {
  web: processRunner,
  command: processRunner,
  'ios-simulator': processRunner,
  'android-emulator': processRunner,
}

function markers(): Record<string, string> {
  return Object.fromEntries(
    testMarkers.flatMap((name) => {
      const value = tedEnv(name)
      return value === undefined ? [] : [[name, value]]
    }),
  )
}

const slug = (name: string) => appEnvName(name).toLowerCase()

const interpolate = (text: string, values: Record<string, string>) =>
  text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => values[name] ?? whole)

export function createApps(options: AppsOptions): Apps {
  const { appsDir, store } = options
  const pollMs = options.pollMs ?? 250
  const readyTimeoutMs = options.readyTimeoutMs ?? 5 * 60_000
  const stopGraceMs = options.stopGraceMs ?? 10_000
  const watching = new Map<string, Promise<void>>()
  const stopping = new Set<string>()
  const busy = new Map<string, Promise<unknown>>()
  const portsTaken = new Map<number, string>()
  let closed = false

  const onThread = (taskId: string) => store.getTask(taskId) !== undefined
  const thread: Pick<TedStore, 'appStarted' | 'appExited' | 'appStopped' | 'appStartFailed'> = {
    appStarted: (input) => onThread(input.taskId) && store.appStarted(input),
    appExited: (input) => onThread(input.taskId) && store.appExited(input),
    appStopped: (input) => onThread(input.taskId) && store.appStopped(input),
    appStartFailed: (input) => onThread(input.taskId) && store.appStartFailed(input),
  }
  const taskDir = (taskId: string) => path.join(appsDir, taskId)
  const dirOf = (taskId: string, repo: string, name: string) =>
    path.join(taskDir(taskId), repo, slug(name))
  const keyOf = (taskId: string, repo: string, name: string) => `${taskId}/${repo}/${slug(name)}`
  const portsFile = (taskId: string) => path.join(taskDir(taskId), 'ports.json')

  const pool = createDevicePool({
    limit: () => store.settings().maxRunningDevices,
    oneAtATime: () => store.settings().buildDeviceAppsOneAtATime,
    ...(options.buildTurnMs !== undefined && { turnMs: options.buildTurnMs }),
  })
  const readyFrom = new Map<string, ReadyRead>()

  const simulatorOptions = options.simulators ?? {
    dir: path.join(path.dirname(appsDir), 'simulators'),
    supported: false,
  }
  const sims = createSimulators({
    dir: simulatorOptions.dir,
    store,
    tools:
      simulatorOptions.tools ??
      createSimulatorTools({
        ...(simulatorOptions.xcrun !== undefined && { xcrun: simulatorOptions.xcrun }),
        ...(simulatorOptions.idb !== undefined && { idb: simulatorOptions.idb }),
        ...(simulatorOptions.open !== undefined && { open: simulatorOptions.open }),
        env: () => options.env?.() ?? process.env,
      }),
    supported: simulatorOptions.supported ?? process.platform === 'darwin',
    ...(simulatorOptions.banners !== undefined && { banners: simulatorOptions.banners }),
    ...(options.idle !== undefined && { idle: options.idle }),
    ...(options.busy !== undefined && { busy: options.busy }),
    pool,
    ...(simulatorOptions.pollMs !== undefined && { pollMs: simulatorOptions.pollMs }),
    ...(simulatorOptions.idleMs !== undefined && { idleMs: simulatorOptions.idleMs }),
    emit: options.emit,
    async appLive(taskId, repo, name) {
      const state = stateOf(await readInstance(dirOf(taskId, repo, name)))
      return state === 'running' || state === 'starting' || state === 'waiting'
    },
    async stopApp(taskId, repo, name) {
      await serial(keyOf(taskId, repo, name), () => stopNow(taskId, repo, name))
    },
  })

  const emulatorOptions = options.emulators ?? {
    dir: path.join(path.dirname(appsDir), 'emulators'),
    supported: false,
  }
  const emus: Emulators = createEmulators({
    dir: emulatorOptions.dir,
    store,
    tools:
      emulatorOptions.tools ??
      createAndroidTools({
        ...(emulatorOptions.emulator !== undefined && { emulator: emulatorOptions.emulator }),
        ...(emulatorOptions.adb !== undefined && { adb: emulatorOptions.adb }),
        ...(emulatorOptions.avdmanager !== undefined && {
          avdmanager: emulatorOptions.avdmanager,
        }),
        env: () => options.env?.() ?? process.env,
      }),
    supported:
      emulatorOptions.supported ?? (process.platform === 'darwin' || process.platform === 'linux'),
    ...(emulatorOptions.banners !== undefined && { banners: emulatorOptions.banners }),
    ...(options.idle !== undefined && { idle: options.idle }),
    ...(options.busy !== undefined && { busy: options.busy }),
    pool,
    ...(emulatorOptions.pollMs !== undefined && { pollMs: emulatorOptions.pollMs }),
    ...(emulatorOptions.idleMs !== undefined && { idleMs: emulatorOptions.idleMs }),
    ...(emulatorOptions.bootTimeoutMs !== undefined && {
      bootTimeoutMs: emulatorOptions.bootTimeoutMs,
    }),
    emit: options.emit,
    async appLive(taskId, repo, name) {
      const state = stateOf(await readInstance(dirOf(taskId, repo, name)))
      return state === 'running' || state === 'starting' || state === 'waiting'
    },
    async stopApp(taskId, repo, name) {
      await serial(keyOf(taskId, repo, name), () => stopNow(taskId, repo, name))
    },
  })

  const devicesFor = (kind: TaskApp['kind']) => (kind === 'android-emulator' ? emus : sims)
  const supportedApp = (app: { kind: TaskApp['kind'] }) =>
    !isDeviceApp(app) || devicesFor(app.kind).supported

  const simApp = (taskId: string, task: AppTask, repo: string, app: AppDeclaration) =>
    ({
      taskId,
      displayId: task.displayId,
      factoryId: task.factoryId,
      repo,
      name: app.name,
      device: isEmulatorApp(app)
        ? (app.device ?? '')
        : (sims.deviceType(taskId, repo, app.name) ?? app.device ?? 'iPhone 16'),
    }) satisfies SimulatorApp

  const deviceEnv = (app: AppDeclaration, id: string): Record<string, string> =>
    isEmulatorApp(app)
      ? { ANDROID_SERIAL: id, TED_EMULATOR_SERIAL: id }
      : { TED_SIMULATOR_UDID: id }

  for (const taskId of safeDirs(appsDir)) {
    for (const [key, port] of Object.entries(readPortsSync(portsFile(taskId)))) {
      portsTaken.set(port, `${taskId}/${key}`)
    }
  }

  function changed(taskId: string): void {
    options.emit({ type: 'apps-changed', taskId })
  }

  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = busy.get(key) ?? Promise.resolve()
    const next = before.catch(() => undefined).then(work)
    busy.set(key, next)
    return next.finally(() => {
      if (busy.get(key) === next) busy.delete(key)
    })
  }

  async function readInstance(dir: string): Promise<Instance | undefined> {
    try {
      return JSON.parse(await readFile(appFiles(dir).instance, 'utf8')) as Instance
    } catch {
      return undefined
    }
  }

  async function writeInstance(dir: string, instance: Instance): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = appFiles(dir).instance
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(instance), { mode: 0o600 })
    await rename(tmp, file)
  }

  async function records(dir: string): Promise<AppHostRecord[]> {
    return parseAppRecords(await readFile(appFiles(dir).records, 'utf8').catch(() => ''))
  }

  function stateOf(instance: Instance | undefined): TaskApp['state'] {
    if (!instance) return 'stopped'
    if (instance.ended) {
      return instance.ended.how === 'stopped'
        ? 'stopped'
        : instance.ended.how === 'exited'
          ? 'exited'
          : 'failed'
    }
    if (instance.waitingFor !== undefined) return 'waiting'
    return instance.readyAt !== undefined || instance.ready === 'start' ? 'running' : 'starting'
  }

  function toApp(
    taskId: string,
    repo: string,
    app: AppDeclaration,
    instance: Instance | undefined,
  ): TaskApp {
    const state = stateOf(instance)
    const live = state === 'running' || state === 'starting'
    const ended = instance?.ended
    const simulator = isDeviceApp(app)
      ? devicesFor(app.kind).info(taskId, repo, app.name)
      : undefined
    const waiter =
      state === 'waiting' && instance?.waitingFor !== undefined
        ? pool.waiter(instance.waitingFor)
        : undefined
    const holder = waiter !== undefined && !waiter.asking ? pool.holder() : undefined
    const waitingOn =
      holder !== undefined && holder.key !== keyOf(taskId, repo, app.name)
        ? { displayId: holder.displayId, app: holder.app }
        : undefined
    return {
      repo,
      name: app.name,
      kind: app.kind,
      state,
      ...(instance?.port !== undefined && { port: instance.port }),
      ...(live && instance?.url !== undefined && { url: instance.url }),
      ...(instance && { startedAt: instance.startedAt }),
      ...(instance?.builtAt !== undefined && { builtAt: instance.builtAt }),
      ...(instance?.startedBy !== undefined && { startedBy: instance.startedBy }),
      ...(ended && { endedAt: ended.at }),
      ...(ended?.code !== undefined && { exitCode: ended.code }),
      ...(ended?.signal !== undefined && { signal: ended.signal }),
      ...(ended?.problem !== undefined && { problem: ended.problem }),
      ...(state === 'waiting' &&
        instance?.waitingFor !== undefined && { waitingFor: instance.waitingFor }),
      ...(waitingOn !== undefined && { waitingOn }),
      ...(waiter?.asking === true && { asking: true }),
      ...(simulator !== undefined && { simulator }),
      ...(app.electron && { electron: true }),
      ...(app.preview !== undefined && { preview: app.preview }),
    }
  }

  function declared(
    task: AppTask,
    ref: AppRef,
  ): { task: AppTask; repo: AppRepo; app: AppDeclaration } | undefined {
    const wanted = slug(ref.name.trim())
    for (const repo of task.repos) {
      if (ref.repo !== undefined && ref.repo !== repo.name) continue
      const app = repo.apps.find((a) => slug(a.name) === wanted)
      if (app) return { task, repo, app }
    }
    return undefined
  }

  async function find(
    taskId: string,
    ref: AppRef,
  ): Promise<{ task: AppTask; repo: AppRepo; app: AppDeclaration }> {
    const task = await options.task(taskId)
    const found = declared(task, ref)
    if (found) return found
    const names = task.repos.flatMap((r) => r.apps.map((a) => a.name))
    if (task.repos.length === 0) {
      throw new RequestError(409, `${task.displayId} has no worktree yet, so no App can run`)
    }
    throw new RequestError(
      404,
      names.length === 0
        ? `${task.displayId}’s repos declare no Apps`
        : `No App named ${ref.name}. This Task’s Apps: ${names.join(', ')}`,
    )
  }

  async function readPorts(taskId: string): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(portsFile(taskId), 'utf8')) as Record<string, number>
    } catch {
      return {}
    }
  }

  async function writePorts(taskId: string, ports: Record<string, number>): Promise<void> {
    await mkdir(taskDir(taskId), { recursive: true, mode: 0o700 })
    await writeFile(portsFile(taskId), JSON.stringify(ports), { mode: 0o600 })
  }

  async function pickPort(owner: string): Promise<number> {
    for (let tries = 0; tries < 50; tries++) {
      const port = await ephemeralPort()
      if (!portsTaken.has(port)) {
        portsTaken.set(port, owner)
        return port
      }
    }
    throw new RequestError(503, 'Ted couldn’t find a free port')
  }

  function allocate(
    taskId: string,
    task: AppTask,
    recheck?: { repo: string; app: AppDeclaration },
  ): Promise<Record<string, number>> {
    return serial(`ports:${taskId}`, () => allocateNow(taskId, task, recheck))
  }

  async function allocateNow(
    taskId: string,
    task: AppTask,
    recheck?: { repo: string; app: AppDeclaration },
  ): Promise<Record<string, number>> {
    const ports = await readPorts(taskId)
    let dirty = false
    for (const repo of task.repos) {
      for (const app of repo.apps) {
        if (isDeviceApp(app)) continue
        const key = `${repo.name}/${slug(app.name)}`
        const owner = `${taskId}/${key}`
        const fixed = app.port
        if (fixed !== undefined) {
          if (ports[key] !== fixed) {
            if (ports[key] !== undefined && portsTaken.get(ports[key]) === owner) {
              portsTaken.delete(ports[key])
            }
            ports[key] = fixed
            dirty = true
          }
          continue
        }
        const current = ports[key]
        const recheckThis = recheck?.repo === repo.name && recheck.app === app
        if (
          current !== undefined &&
          (portsTaken.get(current) ?? owner) === owner &&
          (!recheckThis || (await portFree(current)))
        ) {
          portsTaken.set(current, owner)
          continue
        }
        if (current !== undefined && portsTaken.get(current) === owner) portsTaken.delete(current)
        ports[key] = await pickPort(owner)
        dirty = true
      }
    }
    if (dirty) await writePorts(taskId, ports)
    return ports
  }

  function urlFor(app: AppDeclaration, port: number): string {
    return interpolate(app.url ?? `http://localhost:\${PORT}`, { PORT: String(port) })
  }

  function appVars(task: AppTask, ports: Record<string, number>): Record<string, string> {
    const vars: Record<string, string> = {}
    for (const repo of task.repos) {
      for (const app of repo.apps) {
        const port = ports[`${repo.name}/${slug(app.name)}`]
        if (port === undefined) continue
        const name = appEnvName(app.name)
        if (vars[`TED_APP_${name}_PORT`] !== undefined) continue
        vars[`TED_APP_${name}_PORT`] = String(port)
        vars[`TED_APP_${name}_URL`] = urlFor(app, port)
      }
    }
    return vars
  }

  async function envFor(taskId: string): Promise<Record<string, string>> {
    const task = await options.task(taskId)
    return appVars(task, await allocate(taskId, task))
  }

  async function failStart(
    taskId: string,
    dir: string,
    repo: string,
    app: AppDeclaration,
    problem: string,
    port?: number,
  ): Promise<TaskApp> {
    const at = new Date().toISOString()
    const instance: Instance = {
      repo,
      name: app.name,
      kind: app.kind,
      ready: app.ready,
      ...(port !== undefined && { port }),
      startedAt: at,
      ended: { at, how: 'failed', problem },
    }
    await writeInstance(dir, instance)
    thread.appStartFailed({ taskId, repo, name: app.name, problem })
    changed(taskId)
    return toApp(taskId, repo, app, instance)
  }

  async function startNow(
    taskId: string,
    ref: AppRef,
    by: AppStarter,
    start: StartOptions,
    restarting: boolean,
  ): Promise<TaskApp> {
    const { task, repo, app } = await find(taskId, ref)
    if (start.confirmed !== undefined) refuseUnconfirmed(task, repo, app, by, start.confirmed)
    const { runId } = start
    let restart = restarting
    const dir = dirOf(taskId, repo.name, app.name)
    const key = keyOf(taskId, repo.name, app.name)
    const existing = await readInstance(dir)
    const state = stateOf(existing)
    if (state === 'running' || state === 'starting' || state === 'waiting') {
      const humanTakesOver =
        by === 'human' &&
        (existing?.sandboxed === true || (state === 'waiting' && existing?.startedBy !== 'human'))
      if (!humanTakesOver) return toApp(taskId, repo.name, app, existing)
      await stopNow(taskId, repo.name, app.name)
      restart = true
    }
    if (isSimulatorApp(app) && !sims.supported) {
      throw new RequestError(409, `Ted can’t run ${app.name}: iOS simulator Apps run only on macOS`)
    }
    if (isEmulatorApp(app) && !emus.supported) {
      throw new RequestError(
        409,
        `Ted can’t run ${app.name}: Android emulator Apps run only on macOS and Linux`,
      )
    }
    if (isEmulatorApp(app) && (app.device ?? '').trim() === '') {
      throw new RequestError(
        409,
        `Ted can’t run ${app.name}: set \`device:\` to the Android virtual device it runs on, such as Pixel_8_API_35`,
      )
    }
    const hold = store.newWorkHold()
    if (hold !== undefined) {
      throw new RequestError(
        409,
        `The disk is almost full, so Ted holds new Apps until there’s space`,
      )
    }
    if (isDeviceApp(app)) {
      await restored
      const got = await devicesFor(app.kind).acquire(
        simApp(taskId, task, repo.name, app),
        by,
        start,
      )
      if ('waiting' in got) {
        const instance: Instance = {
          repo: repo.name,
          name: app.name,
          kind: app.kind,
          ready: app.ready,
          startedAt: new Date().toISOString(),
          startedBy: by,
          ...(runId !== undefined && { runId }),
          ...(restart && { restart }),
          waitingFor: got.waiting,
        }
        await writeInstance(dir, instance)
        changed(taskId)
        watch(taskId, key, dir)
        return toApp(taskId, repo.name, app, instance)
      }
      return launch(
        taskId,
        task,
        repo,
        app,
        by,
        runId,
        restart,
        undefined,
        deviceEnv(app, got.udid),
      )
    }
    const ports = await allocate(taskId, task, { repo: repo.name, app })
    const port = ports[`${repo.name}/${slug(app.name)}`] as number
    if (app.port !== undefined && !(await portFree(port))) {
      const problem = `port ${port} is taken`
      await failStart(taskId, dir, repo.name, app, problem, port)
      throw new RequestError(
        409,
        `Port ${port} is taken, so Ted couldn’t start ${app.name}. Stop whatever uses it, or remove \`port:\` from the App in workflow.yaml.`,
      )
    }
    return launch(taskId, task, repo, app, by, runId, restart, port, {})
  }

  async function launch(
    taskId: string,
    task: AppTask,
    repo: AppRepo,
    app: AppDeclaration,
    by: AppStarter,
    runId: string | undefined,
    restart: boolean,
    port: number | undefined,
    extra: Record<string, string>,
  ): Promise<TaskApp> {
    if (isDeviceApp(app)) {
      const log = appFiles(dirOf(taskId, repo.name, app.name)).log
      readyFrom.set(keyOf(taskId, repo.name, app.name), readyFromLaunch(await logSize(log)))
    }
    return withRunPermissions(store, { taskId }, async () => {
      task = await options.task(taskId)
      const dir = dirOf(taskId, repo.name, app.name)
      const key = keyOf(taskId, repo.name, app.name)
      const vars = appVars(task, await allocate(taskId, task))
      const portVars: Record<string, string> = port === undefined ? {} : { PORT: String(port) }
      const scope = by === 'human' ? undefined : task.sandbox
      const electron = app.electron === true && port !== undefined
      const electronVars = electron ? electronEnv(port, by, scope !== undefined) : {}
      const driven = electron && by !== 'human'
      const logFrom = readyFrom.get(key)?.floor
      const cpus = () =>
        checkCpus(os.availableParallelism(), pool.beginBuild(key), store.settings().checkCpuPercent)
      const launchVars = isDeviceApp(app) ? { ...extra, TED_APP_CPUS: String(cpus()) } : extra
      const values = { ...vars, ...portVars, ...launchVars }
      const ownEnv = Object.fromEntries(
        Object.entries(app.env)
          .filter(([name]) => name.toUpperCase() !== 'PORT' && !isReservedEnvName(name))
          .map(([name, value]) => [name, interpolate(value, values)]),
      )
      const env = worktreeCommandEnv(
        repo.env,
        {
          ...ownEnv,
          ...vars,
          ...portVars,
          ...launchVars,
          ...electronVars,
          TED_TASK: task.displayId,
        },
        options.env?.() ?? process.env,
      )
      const url = app.kind === 'web' && port !== undefined ? urlFor(app, port) : undefined
      const sandboxed = await sandboxFor(scope && { ...scope, electron }, task, dir)
      if ('problem' in sandboxed) {
        pool.endTurn(key)
        await failStart(taskId, dir, repo.name, app, sandboxed.problem, port)
        throw new RequestError(409, `Ted couldn’t start ${app.name}: ${sandboxed.problem}`)
      }
      const instance: Instance = {
        repo: repo.name,
        name: app.name,
        kind: app.kind,
        ...(port !== undefined && { port }),
        ...(url !== undefined && { url }),
        ...(driven && { debugUrl: `http://127.0.0.1:${port}/json/version` }),
        ready: electron && !driven ? 'start' : app.ready,
        startedAt: new Date().toISOString(),
        startedBy: by,
        ...(sandboxed.shell !== undefined && { sandboxed: true }),
        ...(logFrom !== undefined && { readyFrom: logFrom }),
      }
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await writeInstance(dir, instance)
        await runners[app.kind].launch({
          dir,
          run: app.run,
          cwd: repo.worktree,
          env: withSandboxEnv(env, sandboxed.env),
          logBytes: options.logBytes ?? appLogBytes,
          authority: launchAuthority(store),
          lowPriority: by !== 'human' && store.settings().lowPriorityWork,
          ...(sandboxed.shell !== undefined && { shell: sandboxed.shell, fds: sandboxed.fds }),
        })
      } catch (error) {
        pool.endTurn(key)
        throw error
      } finally {
        await sandboxed.close?.()
      }
      thread.appStarted({
        taskId,
        repo: repo.name,
        name: app.name,
        ...(port !== undefined && { port }),
        ...(url !== undefined && { url }),
        by,
        ...(runId !== undefined && { runId }),
        restart,
      })
      changed(taskId)
      watch(taskId, key, dir)
      return toApp(taskId, repo.name, app, instance)
    })
  }

  async function sandboxFor(
    scope: AppTask['sandbox'],
    task: AppTask,
    dir: string,
  ): Promise<
    | {
        shell?: string[]
        fds?: readonly number[]
        close?: () => Promise<void>
        env: Record<string, string>
      }
    | { problem: string }
  > {
    if (scope === undefined) return { env: await unsandboxedCaches(task) }
    const problem = await options.sandboxProblem(task.factoryId)
    if (problem !== undefined) return { problem }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await removeInside(dir, 'tmp')
    const tmp = appFiles(dir).tmp
    await mkdir(tmp, { mode: 0o700 })
    try {
      const wrapped = await options.sandbox.wrap(['/bin/sh', '-c'], { ...scope, tmp })
      return { shell: wrapped.argv, fds: wrapped.fds, close: wrapped.close, env: wrapped.env }
    } catch (error) {
      if (error instanceof SandboxUnavailable) return { problem: error.message }
      throw error
    }
  }

  async function unsandboxedCaches(task: AppTask): Promise<Record<string, string>> {
    if (task.cache === undefined) return {}
    try {
      return await options.sandbox.buildCaches(task.cache)
    } catch (error) {
      if (error instanceof SandboxUnavailable) return {}
      throw error
    }
  }

  async function hostAlive(dir: string): Promise<boolean> {
    return isLockHeld(appFiles(dir).lock)
  }

  async function hostPid(dir: string): Promise<number | undefined> {
    const text = await readFile(appFiles(dir).records, 'utf8').catch(() => '')
    const start = parseAppRecords(text).find((r) => r.t === 'start')
    return start?.t === 'start' ? start.hostPid : undefined
  }

  async function stopHost(key: string, dir: string): Promise<void> {
    stopping.add(key)
    try {
      const started = Date.now() + 10_000
      let pid = await hostPid(dir)
      while (pid === undefined && Date.now() < started) {
        if ((await records(dir)).some((r) => r.t === 'exit')) break
        await sleep(50)
        pid = await hostPid(dir)
      }
      const deadline = Date.now() + stopGraceMs
      const lock = appFiles(dir).lock
      if (pid !== undefined && (await holdsLock(lock, pid))) {
        try {
          signalProcess(pid, 'SIGTERM')
        } catch {}
      }
      while ((await hostAlive(dir)) && Date.now() < deadline) await sleep(50)
      if (pid !== undefined && (await holdsLock(lock, pid))) {
        const child = (await records(dir)).find((r) => r.t === 'start')
        try {
          if (child?.t === 'start') signalGroup(child.pid, 'SIGKILL')
        } catch {}
        try {
          signalProcess(pid, 'SIGKILL')
        } catch {}
      }
      await watching.get(key)
    } finally {
      stopping.delete(key)
    }
  }

  async function saidReady(dir: string, key: string): Promise<boolean> {
    const said = await readyLineSince(appFiles(dir).log, readyFrom.get(key) ?? readyFromLaunch(0))
    readyFrom.set(key, said.read)
    return said.ready
  }

  async function settle(
    taskId: string,
    dir: string,
    instance: Instance,
    exit: Extract<AppHostRecord, { t: 'exit' }> | undefined,
    stoppedByTed: boolean,
  ): Promise<void> {
    const at = new Date().toISOString()
    if (stoppedByTed || exit?.stopped === true) {
      instance.ended = { at, how: 'stopped' }
    } else {
      instance.ended = {
        at,
        how: 'exited',
        ...(exit?.code !== undefined && exit.code !== null && { code: exit.code }),
        ...(exit?.signal !== undefined && exit.signal !== null && { signal: exit.signal }),
        ...(exit?.error !== undefined && { problem: exit.error }),
      }
      thread.appExited({
        taskId,
        repo: instance.repo,
        name: instance.name,
        ...(instance.ended.code !== undefined && { code: instance.ended.code }),
        ...(instance.ended.signal !== undefined && { signal: instance.ended.signal }),
      })
    }
    await writeInstance(dir, instance)
    changed(taskId)
  }

  function watch(taskId: string, key: string, dir: string): void {
    if (watching.has(key)) return
    const release = options.idle?.hold()
    const done = follow(taskId, key, dir)
      .catch((error: unknown) => console.error(`stopped watching App ${key}:`, error))
      .finally(() => {
        watching.delete(key)
        release?.()
      })
    watching.set(key, done)
  }

  async function waitForSlot(
    taskId: string,
    dir: string,
    instance: Instance & { waitingFor: string },
  ): Promise<'waiting' | 'launched' | 'ended'> {
    await restored
    const key = keyOf(taskId, instance.repo, instance.name)
    const end = async (how: 'stopped' | 'failed', problem?: string) => {
      // stopHost holds this key's turn while it awaits the follower, so waiting for the turn here
      // could deadlock; try again on the next poll instead.
      if (busy.has(key)) return 'waiting' as const
      return serial(key, async () => {
        const current = await readInstance(dir)
        if (!current || current.ended) return 'ended' as const
        if (current.waitingFor !== instance.waitingFor) return 'waiting' as const
        current.ended = {
          at: new Date().toISOString(),
          how,
          ...(problem !== undefined && { problem }),
        }
        await writeInstance(dir, current)
        if (problem !== undefined) {
          thread.appStartFailed({ taskId, repo: instance.repo, name: instance.name, problem })
        }
        changed(taskId)
        return 'ended' as const
      })
    }
    const looked = await options.task(taskId).catch((error: Error) => error)
    const taskGone = looked instanceof RequestError && looked.status === 404
    if (looked instanceof Error && !taskGone) return 'waiting'
    const found = looked instanceof Error ? undefined : declared(looked, instance)
    if (!found) {
      const ended = await end('stopped')
      if (ended === 'ended') devicesFor(instance.kind).withdraw(instance.waitingFor)
      return ended
    }
    const { task, repo, app } = found
    if (closed) return 'waiting'
    if (store.newWorkHold() !== undefined) {
      devicesFor(app.kind).list(instance.waitingFor, simApp(taskId, task, repo.name, app))
      return 'waiting'
    }
    const got = await devicesFor(app.kind).wait(
      instance.waitingFor,
      simApp(taskId, task, repo.name, app),
    )
    if (got.state === 'pending') return 'waiting'
    const current = await readInstance(dir)
    if (!current || current.ended) return 'ended'
    if (current.waitingFor !== instance.waitingFor) return 'waiting'
    if (got.state === 'denied') {
      return end(
        'failed',
        `No ${isEmulatorApp(app) ? 'emulator' : 'simulator'} slot: the human denied${got.text === undefined ? '' : `. They said: “${got.text}”`}`,
      )
    }
    if (got.state === 'gone') return end('stopped')
    await launch(
      taskId,
      task,
      repo,
      app,
      instance.startedBy ?? 'human',
      instance.runId,
      instance.restart === true,
      undefined,
      deviceEnv(app, got.udid),
    )
    return 'launched'
  }

  async function follow(taskId: string, key: string, dir: string): Promise<void> {
    let marked: { pid: number; unmark: () => void } | undefined
    try {
      await followHost(taskId, dir, key, async (pid, name) => {
        if (marked?.pid === pid) return
        marked?.unmark()
        marked = { pid, unmark: () => {} }
        if (!(await holdsLock(appFiles(dir).lock, pid)) || marked.pid !== pid) return
        const task = store.getTask(taskId)?.displayId
        marked.unmark = markProcessRoot(pid, {
          kind: 'app',
          appName: name,
          ...(task !== undefined && { task }),
        })
      })
    } finally {
      marked?.unmark()
      if (!closed) pool.endTurn(key)
      readyFrom.delete(key)
    }
  }

  async function followHost(
    taskId: string,
    dir: string,
    key: string,
    onHost: (pid: number, name: string) => Promise<void>,
  ): Promise<void> {
    let launchedAt = Date.now()
    while (!closed) {
      const instance = await readInstance(dir)
      if (!instance || instance.ended) return
      if (instance.waitingFor !== undefined) {
        const waited = await waitForSlot(taskId, dir, {
          ...instance,
          waitingFor: instance.waitingFor,
        })
        if (waited === 'ended') return
        if (waited === 'launched') launchedAt = Date.now()
        else await sleep(pollMs)
        continue
      }
      const found = await records(dir)
      const start = found.find((r) => r.t === 'start')
      if (start?.t === 'start') await onHost(start.hostPid, instance.name)
      const exit = found.find((r) => r.t === 'exit')
      if (exit?.t === 'exit') {
        await settle(taskId, dir, instance, exit, stopping.has(key))
        return
      }
      const started = found.some((r) => r.t === 'start')
      if (!(await hostAlive(dir)) && (started || Date.now() - launchedAt > 10_000)) {
        const late = (await records(dir)).find((r) => r.t === 'exit')
        await settle(
          taskId,
          dir,
          instance,
          late?.t === 'exit' ? late : undefined,
          stopping.has(key),
        )
        return
      }
      if (started && pool.building(key) && (await saidReady(dir, key))) {
        pool.endTurn(key)
        instance.builtAt = new Date().toISOString()
        await writeInstance(dir, instance)
        changed(taskId)
      }
      const readyUrl = instance.url ?? instance.debugUrl
      if (instance.readyAt === undefined && instance.ready === 'url' && readyUrl && started) {
        const answer = await answers(readyUrl)
        if (answer.kind === 'ready') {
          instance.readyAt = new Date().toISOString()
          await writeInstance(dir, instance)
          changed(taskId)
        } else if (
          answer.kind === 'untrusted' ||
          Date.now() - Date.parse(instance.startedAt) > readyTimeoutMs
        ) {
          const where = readyUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
          const problem =
            answer.kind === 'untrusted'
              ? `it answered over HTTPS with a certificate this Mac doesn’t trust (${answer.reason}). Use a certificate from a trusted authority, such as one made with mkcert, or serve the App over http.`
              : `it didn’t answer at ${where} within ${minutes(readyTimeoutMs)}`
          stopping.add(key)
          void stopHost(key, dir).catch(() => undefined)
          while (await hostAlive(dir)) await sleep(50)
          const at = new Date().toISOString()
          instance.ended = { at, how: 'failed', problem }
          await writeInstance(dir, instance)
          thread.appStartFailed({ taskId, repo: instance.repo, name: instance.name, problem })
          changed(taskId)
          return
        }
      }
      await sleep(pollMs)
    }
  }

  async function list(taskId: string): Promise<TaskApp[]> {
    const task = await options.task(taskId)
    const apps: TaskApp[] = []
    for (const repo of task.repos) {
      for (const app of repo.apps) {
        if (!supportedApp(app)) continue
        const approval = outsideSandboxApproval(repo, app)
        const ask =
          task.sandbox !== undefined && !approvedOutsideSandbox(task.outsideSandbox, approval)
        apps.push({
          ...toApp(taskId, repo.name, app, await readInstance(dirOf(taskId, repo.name, app.name))),
          ...(ask && { confirmOutsideSandbox: true, outsideSandboxApproval: approval }),
        })
      }
    }
    for (const { repo, app, instance } of await undeclared(taskId, task)) {
      apps.push({ ...toApp(taskId, repo, app, instance), removed: true })
    }
    return apps
  }

  async function undeclared(
    taskId: string,
    task: AppTask,
  ): Promise<{ repo: string; app: AppDeclaration; instance: Instance }[]> {
    const root = taskDir(taskId)
    const found: { repo: string; app: AppDeclaration; instance: Instance }[] = []
    for (const repoName of safeDirs(root)) {
      const declared = task.repos.find((r) => r.name === repoName)?.apps ?? []
      for (const appSlug of safeDirs(path.join(root, repoName))) {
        if (declared.some((a) => slug(a.name) === appSlug)) continue
        const instance = await readInstance(path.join(root, repoName, appSlug))
        if (!instance || !isLiveInstance(instance)) continue
        found.push({
          repo: repoName,
          app: {
            name: instance.name,
            kind: instance.kind,
            run: '',
            ready: instance.ready,
            env: {},
            ...(instance.url !== undefined && { url: instance.url }),
          },
          instance,
        })
      }
    }
    return found
  }

  async function findListed(
    taskId: string,
    ref: AppRef,
  ): Promise<{ repo: { name: string }; app: AppDeclaration }> {
    try {
      return await find(taskId, ref)
    } catch (error) {
      const wanted = slug(ref.name.trim())
      const gone = (await undeclared(taskId, await options.task(taskId))).find(
        (u) => slug(u.app.name) === wanted && (ref.repo === undefined || ref.repo === u.repo),
      )
      if (!gone) throw error
      return { repo: { name: gone.repo }, app: gone.app }
    }
  }

  function isLiveInstance(instance: Instance): boolean {
    const state = stateOf(instance)
    return state === 'running' || state === 'starting' || state === 'waiting'
  }

  async function stopNow(taskId: string, repo: string, name: string): Promise<boolean> {
    const dir = dirOf(taskId, repo, name)
    const key = keyOf(taskId, repo, name)
    const instance = await readInstance(dir)
    const state = stateOf(instance)
    if (instance && state === 'waiting' && instance.waitingFor !== undefined) {
      instance.ended = { at: new Date().toISOString(), how: 'stopped' }
      await writeInstance(dir, instance)
      devicesFor(instance.kind).withdraw(instance.waitingFor)
      changed(taskId)
      return true
    }
    if (!instance || (state !== 'running' && state !== 'starting')) return false
    await stopHost(key, dir)
    const after = await readInstance(dir)
    if (after && !after.ended) {
      after.ended = { at: new Date().toISOString(), how: 'stopped' }
      await writeInstance(dir, after)
    }
    changed(taskId)
    return true
  }

  async function simulatorApp(taskId: string, ref: AppRef) {
    const found = await find(taskId, ref)
    if (!isSimulatorApp(found.app) || !sims.supported) {
      throw new RequestError(409, `${found.app.name} isn’t an iOS simulator App`)
    }
    return found
  }

  async function deviceApp(taskId: string, ref: AppRef) {
    const found = await find(taskId, ref)
    if (!isDeviceApp(found.app) || !devicesFor(found.app.kind).supported) {
      throw new RequestError(
        409,
        `${found.app.name} isn’t an iOS simulator or Android emulator App`,
      )
    }
    return found
  }

  async function stopAll(taskId: string, repo?: string): Promise<void> {
    const root = taskDir(taskId)
    for (const repoName of safeDirs(root)) {
      if (repo !== undefined && repoName !== repo) continue
      for (const appSlug of safeDirs(path.join(root, repoName))) {
        const instance = await readInstance(path.join(root, repoName, appSlug))
        if (instance)
          await serial(keyOf(taskId, repoName, instance.name), () =>
            stopNow(taskId, repoName, instance.name),
          )
      }
    }
  }

  async function forget(taskId: string): Promise<void> {
    const ports = await readPorts(taskId)
    for (const port of Object.values(ports)) {
      if (portsTaken.get(port)?.startsWith(`${taskId}/`)) portsTaken.delete(port)
    }
    await removeInside(appsDir, taskId)
  }

  const restored = (async () => {
    const reattach: { taskId: string; key: string; dir: string }[] = []
    for (const taskId of safeDirs(appsDir)) {
      if (!options.keep(taskId)) continue
      const root = taskDir(taskId)
      for (const repoName of safeDirs(root)) {
        for (const appSlug of safeDirs(path.join(root, repoName))) {
          const dir = path.join(root, repoName, appSlug)
          const instance = await readInstance(dir)
          if (!instance || instance.ended) continue
          const key = keyOf(taskId, repoName, instance.name)
          if (isDeviceApp(instance) && instance.waitingFor === undefined && !instance.builtAt) {
            readyFrom.set(key, readyFromLaunch(instance.readyFrom ?? 0))
            pool.restoreTurn(
              { key, displayId: store.getTask(taskId)?.displayId ?? taskId, app: instance.name },
              Date.parse(instance.startedAt),
            )
          }
          reattach.push({ taskId, key, dir })
        }
      }
    }
    return reattach
  })().catch((error: Error) => {
    console.error('couldn’t restore the device build turn:', error)
    return []
  })

  void (async () => {
    for (const { taskId, key, dir } of await restored) watch(taskId, key, dir)
    for (const taskId of safeDirs(appsDir)) {
      if (options.keep(taskId)) continue
      await stopAll(taskId).catch(() => undefined)
      await sims.remove(taskId).catch(() => undefined)
      await emus.remove(taskId).catch(() => undefined)
      await forget(taskId).catch(() => undefined)
    }
    for (const taskId of emus.taskIds()) {
      if (!options.keep(taskId)) await emus.remove(taskId).catch(() => undefined)
    }
  })().catch((error: unknown) => console.error('couldn’t reattach to Apps:', error))

  return {
    list,
    envFor,
    async start(taskId, ref, by, start = {}) {
      const { repo, app } = await find(taskId, ref)
      return serial(keyOf(taskId, repo.name, app.name), () =>
        startNow(taskId, { repo: repo.name, name: app.name }, by, start, false),
      )
    },
    async stop(taskId, ref) {
      const { repo, app } = await findListed(taskId, ref)
      return serial(keyOf(taskId, repo.name, app.name), async () => {
        if (await stopNow(taskId, repo.name, app.name)) {
          thread.appStopped({ taskId, repo: repo.name, name: app.name })
        }
        if (isDeviceApp(app)) await devicesFor(app.kind).shutDown(taskId, repo.name, app.name)
        return toApp(taskId, repo.name, app, await readInstance(dirOf(taskId, repo.name, app.name)))
      })
    },
    async restart(taskId, ref, by, declaration) {
      const { task, repo, app } = await find(taskId, ref)
      const confirmed = { ...(declaration !== undefined && { declaration }) }
      refuseUnconfirmed(task, repo, app, by, confirmed)
      return serial(keyOf(taskId, repo.name, app.name), async () => {
        const wasLive = await stopNow(taskId, repo.name, app.name)
        return startNow(taskId, { repo: repo.name, name: app.name }, by, { confirmed }, wasLive)
      })
    },
    simulators: () => sims.slots(),
    emulators: () => emus.slots(),
    async show(taskId, ref) {
      const { repo, app } = await deviceApp(taskId, ref)
      const key = keyOf(taskId, repo.name, app.name)
      if (isEmulatorApp(app)) {
        const { rebooted } = await emus.show(taskId, repo.name, app.name)
        if (rebooted) {
          await serial(key, async () => {
            const instance = await readInstance(dirOf(taskId, repo.name, app.name))
            const state = stateOf(instance)
            if (state !== 'running' && state !== 'starting') return
            await stopNow(taskId, repo.name, app.name)
            await startNow(
              taskId,
              { repo: repo.name, name: app.name },
              instance?.startedBy ?? 'human',
              instance?.runId === undefined ? {} : { runId: instance.runId },
              true,
            )
          })
        }
      } else await sims.show(taskId, repo.name, app.name)
      return toApp(taskId, repo.name, app, await readInstance(dirOf(taskId, repo.name, app.name)))
    },
    async screenshot(taskId, ref) {
      const { repo, app } = await deviceApp(taskId, ref)
      const file = await devicesFor(app.kind).screenshot(taskId, repo.name, app.name)
      const instance = await readInstance(dirOf(taskId, repo.name, app.name))
      return { file, app: toApp(taskId, repo.name, app, instance) }
    },
    async control(taskId, request) {
      const { repo, app } = await deviceApp(taskId, request.app)
      if (isEmulatorApp(app)) return emus.control(taskId, repo.name, app.name, request)
      if (request.action !== 'size') return sims.control(taskId, repo.name, app.name, request)
      if (request.density !== undefined)
        throw new RequestError(400, 'An iOS simulator’s density comes with its device type')
      const before = sims.deviceType(taskId, repo.name, app.name)
      const chosen = await sims.chooseDeviceType(taskId, repo.name, app.name, request.size ?? '')
      const deviceOf = (type: string | undefined) => type ?? app.device ?? 'iPhone 16'
      if (chosen === before) return `${app.name} already runs on ${deviceOf(chosen)}.`
      const device = deviceOf(chosen)
      const dir = dirOf(taskId, repo.name, app.name)
      const instance = await readInstance(dir)
      const state = stateOf(instance)
      sims.setDeviceType(taskId, repo.name, app.name, chosen)
      if (state !== 'running' && state !== 'starting' && state !== 'waiting')
        return `${app.name} will run on ${device} when you start it with ted run-app ${app.name}.`
      const restartOn = () =>
        serial(keyOf(taskId, repo.name, app.name), async () => {
          const wasLive = await stopNow(taskId, repo.name, app.name)
          return startNow(
            taskId,
            { repo: repo.name, name: app.name },
            instance?.startedBy ?? 'automation',
            instance?.runId === undefined ? {} : { runId: instance.runId },
            wasLive,
          )
        })
      let restarted: TaskApp
      try {
        restarted = await restartOn()
      } catch (error) {
        sims.setDeviceType(taskId, repo.name, app.name, before)
        const back = await restartOn().then(
          () => true,
          () => false,
        )
        const why = error instanceof Error ? error.message : String(error)
        throw new RequestError(
          409,
          `Ted couldn’t run ${app.name} on ${device}: ${why} ${
            back
              ? `${app.name} runs on ${deviceOf(before)} again.`
              : `Start it again with ted run-app ${app.name}.`
          }`,
        )
      }
      return restarted.state === 'waiting'
        ? `${app.name} will run on ${device} once a simulator slot is free; ted run-app ${app.name} waits for it.`
        : `${app.name} now runs on ${device}. Read it again with ted app screen ${app.name}.`
    },
    async record(taskId, ref, action) {
      const { repo, app } = await simulatorApp(taskId, ref)
      const file =
        action === 'start'
          ? await sims.startRecording(taskId, repo.name, app.name).then(() => undefined)
          : await sims.stopRecording(taskId, repo.name, app.name)
      const instance = await readInstance(dirOf(taskId, repo.name, app.name))
      return {
        ...(file !== undefined && { file }),
        app: toApp(taskId, repo.name, app, instance),
      }
    },
    withSimulatorRequest: (comment, work) =>
      comment.simulator?.platform === 'android'
        ? emus.withRequest(comment, work)
        : sims.withRequest(comment, work),
    async log(taskId, ref) {
      const { repo, app } = await findListed(taskId, ref)
      const files = appFiles(dirOf(taskId, repo.name, app.name))
      const current = await readFile(files.log).catch(() => Buffer.alloc(0))
      const previous =
        current.length >= logViewBytes
          ? Buffer.alloc(0)
          : await readTail(files.previousLog, logViewBytes - current.length)
      const both = Buffer.concat([previous, current])
      const truncated = both.length > logViewBytes || previous.length > 0
      const tail = both.subarray(Math.max(0, both.length - logViewBytes)).toString('utf8')
      return { text: redactSecrets(stripVTControlCharacters(tail)), truncated }
    },
    async stopRepo(taskId, repo) {
      await stopAll(taskId, repo)
      await sims.remove(taskId, repo)
      await emus.remove(taskId, repo)
    },
    async stopTask(taskId) {
      await stopAll(taskId)
      await sims.remove(taskId)
      await emus.remove(taskId)
      await forget(taskId)
      changed(taskId)
    },
    async close() {
      closed = true
      await Promise.all(watching.values())
      await sims.close()
      await emus.close()
    },
  }
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.round(ms / 60_000))
  return ms < 60_000
    ? `${Math.round(ms / 1000)} seconds`
    : `${count} minute${count === 1 ? '' : 's'}`
}

async function readTail(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r').catch(() => undefined)
  if (!handle) return Buffer.alloc(0)
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer
  } finally {
    await handle.close()
  }
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(e.name))
      .map((e) => e.name)
  } catch {
    return []
  }
}

function readPortsSync(file: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })
}

export async function portFree(port: number): Promise<boolean> {
  const bound = await new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      server.close(() => resolve(true)),
    )
  })
  if (!bound) return false
  const answered = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
  return !answered
}

export function electronEnv(
  port: number,
  by: AppStarter,
  sandboxed: boolean,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (by === 'human') return {}
  const args = [
    `--remote-debugging-port=${port}`,
    ...(sandboxed ? ['--no-sandbox'] : []),
    ...(platform === 'linux' ? ['--ozone-platform=headless'] : []),
  ]
  return { TED_ELECTRON_ARGS: args.join(' '), TED_ELECTRON_HIDDEN: '1' }
}

type Answer = { kind: 'ready' } | { kind: 'waiting' } | { kind: 'untrusted'; reason: string }
let trustedCertificates: string[] | undefined
function answers(url: string): Promise<Answer> {
  return new Promise((resolve) => {
    const respond = (response: http.IncomingMessage) => {
      response.resume()
      resolve({ kind: (response.statusCode ?? 500) < 500 ? 'ready' : 'waiting' })
    }
    trustedCertificates ??= [
      ...tls.getCACertificates('default'),
      ...tls.getCACertificates('system'),
    ]
    const request = url.startsWith('https:')
      ? https.get(url, { timeout: 1_000, ca: trustedCertificates }, respond)
      : http.get(url, { timeout: 1_000 }, respond)
    request.once('timeout', () => request.destroy())
    request.once('error', (error) =>
      resolve(
        certificateErrorCode(error)
          ? { kind: 'untrusted', reason: error.message.split(';')[0] ?? error.message }
          : { kind: 'waiting' },
      ),
    )
  })
}
