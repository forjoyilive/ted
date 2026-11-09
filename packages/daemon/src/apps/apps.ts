import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import {
  type AppLog,
  type AppRef,
  type AppStarter,
  appEnvName,
  type DaemonEvent,
  type TaskApp,
} from '@ted/protocol'
import { worktreeCommandEnv } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import { isLockHeld } from '../lock.ts'
import { nodeEntry } from '../node-entry.ts'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import { removeInside } from '../tasks/remove-files.ts'
import { isReservedEnvName } from '../workflow/check.ts'
import type { AppDeclaration } from './declared.ts'
import {
  type AppHostRecord,
  type AppLaunchFile,
  appFiles,
  appLogBytes,
  parseAppRecords,
} from './host-files.ts'

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
  repos: AppRepo[]
}

export interface AppsOptions {
  appsDir: string
  store: TedStore
  env?: () => NodeJS.ProcessEnv
  task(taskId: string): Promise<AppTask>
  keep(taskId: string): boolean
  emit(event: DaemonEvent): void
  idle?: IdleTimer
  pollMs?: number
  readyTimeoutMs?: number
  stopGraceMs?: number
  logBytes?: number
}

export interface Apps {
  list(taskId: string): Promise<TaskApp[]>
  start(taskId: string, ref: AppRef, by: AppStarter, runId?: string): Promise<TaskApp>
  stop(taskId: string, ref: AppRef): Promise<TaskApp>
  restart(taskId: string, ref: AppRef, by: AppStarter, runId?: string): Promise<TaskApp>
  log(taskId: string, ref: AppRef): Promise<AppLog>
  envFor(taskId: string): Promise<Record<string, string>>
  stopRepo(taskId: string, repo: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  close(): Promise<void>
}

interface Instance {
  repo: string
  name: string
  kind: TaskApp['kind']
  port?: number
  url?: string
  ready: 'url' | 'start'
  startedAt: string
  startedBy?: AppStarter
  readyAt?: string
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
  }): Promise<void>
}

const processRunner: Runner = {
  async launch({ dir, run, cwd, env, logBytes }) {
    const files = appFiles(dir)
    const launch: AppLaunchFile = { run, cwd, logBytes }
    await writeFile(files.launch, JSON.stringify(launch), { mode: 0o600 })
    await rm(files.records, { force: true })
    await appendFile(files.log, `$ ${run}\n`, { mode: 0o600 })
    const host = nodeEntry(hostMain, [dir])
    spawn(host.command, host.args, {
      detached: true,
      stdio: 'ignore',
      cwd: dir,
      env: { ...env, ...markers(), ELECTRON_RUN_AS_NODE: '1' },
    }).unref()
  },
}

const runners: Partial<Record<TaskApp['kind'], Runner>> = {
  web: processRunner,
  command: processRunner,
}

function markers(): Record<string, string> {
  return Object.fromEntries(
    testMarkers.flatMap((name) => {
      const value = process.env[name]
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

  const taskDir = (taskId: string) => path.join(appsDir, taskId)
  const dirOf = (taskId: string, repo: string, name: string) =>
    path.join(taskDir(taskId), repo, slug(name))
  const keyOf = (taskId: string, repo: string, name: string) => `${taskId}/${repo}/${slug(name)}`
  const portsFile = (taskId: string) => path.join(taskDir(taskId), 'ports.json')

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
    return instance.readyAt !== undefined || instance.ready === 'start' ? 'running' : 'starting'
  }

  function toApp(repo: string, app: AppDeclaration, instance: Instance | undefined): TaskApp {
    const state = stateOf(instance)
    const live = state === 'running' || state === 'starting'
    const ended = instance?.ended
    return {
      repo,
      name: app.name,
      kind: app.kind,
      state,
      ...(instance?.port !== undefined && { port: instance.port }),
      ...(live && instance?.url !== undefined && { url: instance.url }),
      ...(instance && { startedAt: instance.startedAt }),
      ...(instance?.startedBy !== undefined && { startedBy: instance.startedBy }),
      ...(ended && { endedAt: ended.at }),
      ...(ended?.code !== undefined && { exitCode: ended.code }),
      ...(ended?.signal !== undefined && { signal: ended.signal }),
      ...(ended?.problem !== undefined && { problem: ended.problem }),
    }
  }

  async function find(
    taskId: string,
    ref: AppRef,
  ): Promise<{ task: AppTask; repo: AppRepo; app: AppDeclaration }> {
    const task = await options.task(taskId)
    const wanted = slug(ref.name.trim())
    for (const repo of task.repos) {
      if (ref.repo !== undefined && ref.repo !== repo.name) continue
      const app = repo.apps.find((a) => slug(a.name) === wanted)
      if (app) return { task, repo, app }
    }
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
    throw new RequestError(503, 'TED couldn’t find a free port')
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
        if (app.kind === 'ios-simulator') continue
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
    store.appStartFailed({ taskId, repo, name: app.name, problem })
    changed(taskId)
    return toApp(repo, app, instance)
  }

  async function startNow(
    taskId: string,
    ref: AppRef,
    by: AppStarter,
    runId: string | undefined,
    restart: boolean,
  ): Promise<TaskApp> {
    const { task, repo, app } = await find(taskId, ref)
    const dir = dirOf(taskId, repo.name, app.name)
    const key = keyOf(taskId, repo.name, app.name)
    const existing = await readInstance(dir)
    const state = stateOf(existing)
    if (state === 'running' || state === 'starting') return toApp(repo.name, app, existing)
    const runner = runners[app.kind]
    if (!runner) {
      throw new RequestError(
        409,
        `TED can’t run ${app.name}: iOS simulator Apps aren’t supported yet`,
      )
    }
    const hold = store.newWorkHold()
    if (hold !== undefined) {
      throw new RequestError(
        409,
        `The disk is almost full, so TED holds new Apps until there’s space`,
      )
    }
    const ports = await allocate(taskId, task, { repo: repo.name, app })
    const port = ports[`${repo.name}/${slug(app.name)}`] as number
    if (app.port !== undefined && !(await portFree(port))) {
      const problem = `port ${port} is taken`
      await failStart(taskId, dir, repo.name, app, problem, port)
      throw new RequestError(
        409,
        `Port ${port} is taken, so TED couldn’t start ${app.name}. Stop whatever uses it, or remove \`port:\` from the App in workflow.yaml.`,
      )
    }
    const vars = appVars(task, ports)
    const values = { ...vars, PORT: String(port) }
    const ownEnv = Object.fromEntries(
      Object.entries(app.env)
        .filter(([name]) => name.toUpperCase() !== 'PORT' && !isReservedEnvName(name))
        .map(([name, value]) => [name, interpolate(value, values)]),
    )
    const env = worktreeCommandEnv(
      repo.env,
      { ...ownEnv, ...vars, PORT: String(port), TED_TASK: task.displayId },
      options.env?.() ?? process.env,
    )
    const url = app.kind === 'web' ? urlFor(app, port) : undefined
    const instance: Instance = {
      repo: repo.name,
      name: app.name,
      kind: app.kind,
      port,
      ...(url !== undefined && { url }),
      ready: app.ready,
      startedAt: new Date().toISOString(),
      startedBy: by,
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeInstance(dir, instance)
    await runner.launch({
      dir,
      run: app.run,
      cwd: repo.worktree,
      env,
      logBytes: options.logBytes ?? appLogBytes,
    })
    store.appStarted({
      taskId,
      repo: repo.name,
      name: app.name,
      port,
      ...(url !== undefined && { url }),
      by,
      ...(runId !== undefined && { runId }),
      restart,
    })
    changed(taskId)
    watch(taskId, key, dir)
    return toApp(repo.name, app, instance)
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
      if (pid !== undefined && (await hostAlive(dir))) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {}
      }
      while ((await hostAlive(dir)) && Date.now() < deadline) await sleep(50)
      if (await hostAlive(dir)) {
        const child = (await records(dir)).find((r) => r.t === 'start')
        for (const target of [
          ...(child?.t === 'start' && child.pid !== null ? [-child.pid] : []),
          ...(pid !== undefined ? [pid] : []),
        ]) {
          try {
            process.kill(target, 'SIGKILL')
          } catch {}
        }
      }
      await watching.get(key)
    } finally {
      stopping.delete(key)
    }
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
      store.appExited({
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

  async function follow(taskId: string, key: string, dir: string): Promise<void> {
    const launchedAt = Date.now()
    while (!closed) {
      const instance = await readInstance(dir)
      if (!instance || instance.ended) return
      const found = await records(dir)
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
      if (instance.readyAt === undefined && instance.ready === 'url' && instance.url && started) {
        if (await answers(instance.url)) {
          instance.readyAt = new Date().toISOString()
          await writeInstance(dir, instance)
          changed(taskId)
        } else if (Date.now() - Date.parse(instance.startedAt) > readyTimeoutMs) {
          const where = instance.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
          const problem = `it didn’t answer at ${where} within ${minutes(readyTimeoutMs)}`
          stopping.add(key)
          void stopHost(key, dir).catch(() => undefined)
          while (await hostAlive(dir)) await sleep(50)
          const at = new Date().toISOString()
          instance.ended = { at, how: 'failed', problem }
          await writeInstance(dir, instance)
          store.appStartFailed({ taskId, repo: instance.repo, name: instance.name, problem })
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
        apps.push(toApp(repo.name, app, await readInstance(dirOf(taskId, repo.name, app.name))))
      }
    }
    for (const { repo, app, instance } of await undeclared(taskId, task)) {
      apps.push({ ...toApp(repo, app, instance), removed: true })
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
    return state === 'running' || state === 'starting'
  }

  async function stopNow(taskId: string, repo: string, name: string): Promise<boolean> {
    const dir = dirOf(taskId, repo, name)
    const key = keyOf(taskId, repo, name)
    const instance = await readInstance(dir)
    const state = stateOf(instance)
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

  void (async () => {
    for (const taskId of safeDirs(appsDir)) {
      if (!options.keep(taskId)) {
        await stopAll(taskId).catch(() => undefined)
        await forget(taskId).catch(() => undefined)
        continue
      }
      const root = taskDir(taskId)
      for (const repoName of safeDirs(root)) {
        for (const appSlug of safeDirs(path.join(root, repoName))) {
          const dir = path.join(root, repoName, appSlug)
          const instance = await readInstance(dir)
          if (instance && !instance.ended) {
            watch(taskId, keyOf(taskId, repoName, instance.name), dir)
          }
        }
      }
    }
  })().catch((error: unknown) => console.error('couldn’t reattach to Apps:', error))

  return {
    list,
    envFor,
    async start(taskId, ref, by, runId) {
      const { repo, app } = await find(taskId, ref)
      return serial(keyOf(taskId, repo.name, app.name), () =>
        startNow(taskId, { repo: repo.name, name: app.name }, by, runId, false),
      )
    },
    async stop(taskId, ref) {
      const { repo, app } = await findListed(taskId, ref)
      return serial(keyOf(taskId, repo.name, app.name), async () => {
        if (await stopNow(taskId, repo.name, app.name)) {
          store.appStopped({ taskId, repo: repo.name, name: app.name })
        }
        return toApp(repo.name, app, await readInstance(dirOf(taskId, repo.name, app.name)))
      })
    },
    async restart(taskId, ref, by, runId) {
      const { repo, app } = await find(taskId, ref)
      return serial(keyOf(taskId, repo.name, app.name), async () => {
        const wasLive = await stopNow(taskId, repo.name, app.name)
        return startNow(taskId, { repo: repo.name, name: app.name }, by, runId, wasLive)
      })
    },
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
    stopRepo: (taskId, repo) => stopAll(taskId, repo),
    async stopTask(taskId) {
      await stopAll(taskId)
      await forget(taskId)
      changed(taskId)
    },
    async close() {
      closed = true
      await Promise.all(watching.values())
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

function answers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const get = url.startsWith('https:') ? https.get : http.get
    const request = get(url, { timeout: 1_000, rejectUnauthorized: false }, (response) => {
      response.resume()
      resolve((response.statusCode ?? 500) < 500)
    })
    request.once('timeout', () => request.destroy())
    request.once('error', () => resolve(false))
  })
}
