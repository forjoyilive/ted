import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AnswerRequest,
  AppSimulator,
  AppStarter,
  BootedSimulator,
  Comment,
  DaemonEvent,
  SimulatorAsk,
  SimulatorSlots,
} from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import type { TedStore } from '../store/index.ts'

export interface SimctlResult {
  code: number
  stdout: string
  stderr: string
}

export interface SimulatorTools {
  simctl(args: string[]): Promise<SimctlResult>
  open(args: string[]): Promise<void>
  record(udid: string, file: string): ChildProcess
}

export function createSimulatorTools(options: {
  xcrun?: string
  open?: string
  env: () => NodeJS.ProcessEnv
}): SimulatorTools {
  const xcrun = options.xcrun ?? 'xcrun'
  const opener = options.open ?? '/usr/bin/open'
  const run = (command: string, args: string[]) =>
    new Promise<SimctlResult>((resolve) => {
      execFile(
        command,
        args,
        { env: options.env(), timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof error.code === 'number' ? error.code : error.code ? 127 : 1
          resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || '') })
        },
      )
    })
  return {
    simctl: (args) => run(xcrun, ['simctl', ...args]),
    async open(args) {
      await run(opener, args)
    },
    record(udid, file) {
      return spawn(xcrun, ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], {
        env: options.env(),
        stdio: 'ignore',
      })
    },
  }
}

export interface SimulatorApp {
  taskId: string
  displayId: string
  factoryId: string
  repo: string
  name: string
  device: string
}

export type SimulatorWait =
  | { state: 'pending' }
  | { state: 'granted'; udid: string }
  | { state: 'denied'; text?: string }
  | { state: 'gone' }

export interface Simulators {
  readonly supported: boolean
  slots(): SimulatorSlots
  info(taskId: string, repo: string, name: string): AppSimulator | undefined
  acquire(
    app: SimulatorApp,
    by: AppStarter,
    input: { runId?: string; shutDown?: string; reason?: string },
  ): Promise<{ udid: string } | { waiting: string }>
  wait(commentId: string, app: SimulatorApp): Promise<SimulatorWait>
  withdraw(commentId: string): void
  answer(comment: Comment, request: AnswerRequest, text: string): Promise<Comment>
  shutDown(taskId: string, repo: string, name: string): Promise<void>
  show(taskId: string, repo: string, name: string): Promise<void>
  screenshot(taskId: string, repo: string, name: string): Promise<string>
  startRecording(taskId: string, repo: string, name: string): Promise<void>
  stopRecording(taskId: string, repo: string, name: string): Promise<string>
  remove(taskId: string, repo?: string): Promise<void>
  refresh(): Promise<void>
  close(): Promise<void>
}

interface DeviceRecord {
  udid: string
  taskId: string
  repo: string
  name: string
  device: string
  lastUsedAt: string
  shutDown?: { at: string; for?: string }
}

interface ListedDevice {
  udid: string
  name: string
  state: string
  isAvailable: boolean
  runtime: string
}

interface Recording {
  child: ChildProcess
  file: string
  ended: Promise<void>
}

export const simulatorToolsProblem = 'simulator-tools'

const slug = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_').toLowerCase()

export function createSimulators(options: {
  dir: string
  store: TedStore
  tools: SimulatorTools
  supported: boolean
  banners?: Banners
  idle?: IdleTimer
  emit(event: DaemonEvent): void
  appLive(taskId: string, repo: string, name: string): Promise<boolean>
  stopApp(taskId: string, repo: string, name: string): Promise<void>
  pollMs?: number
  idleMs?: number
}): Simulators {
  const { dir, store, tools, supported } = options
  const pollMs = options.pollMs ?? 3_000
  const idleMs = options.idleMs ?? 30 * 60_000
  const file = path.join(dir, 'devices.json')
  const captures = path.join(dir, 'captures')
  const records = new Map<string, DeviceRecord>(Object.entries(readRecords(file)))
  const booted = new Set<string>()
  const recordings = new Map<string, Recording>()
  let queue: Promise<unknown> = Promise.resolve()
  let releaseIdle: (() => void) | undefined
  let closed = false
  let refreshing: Promise<void> | undefined

  const keyOf = (taskId: string, repo: string, name: string) => `${taskId}/${repo}/${slug(name)}`
  const recordOf = (taskId: string, repo: string, name: string) =>
    records.get(keyOf(taskId, repo, name))

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => undefined).then(work)
    queue = next
    return next
  }

  async function save(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(records)), { mode: 0o600 })
    await rename(tmp, file)
  }

  function limit(): number {
    return store.settings().maxBootedSimulators
  }

  function slots(): SimulatorSlots {
    const list: BootedSimulator[] = [...records.values()]
      .filter((r) => booted.has(r.udid))
      .map((r) => {
        const task = store.getTask(r.taskId)
        return {
          udid: r.udid,
          taskId: r.taskId,
          displayId: task?.displayId ?? r.taskId,
          title: task?.title ?? '',
          repo: r.repo,
          app: r.name,
          device: r.device,
          lastUsedAt: r.lastUsedAt,
          recording: recordings.has(r.udid),
        }
      })
      .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))
    return { supported, limit: limit(), booted: list }
  }

  function changed(): void {
    if (booted.size > 0) releaseIdle ??= options.idle?.hold()
    else {
      releaseIdle?.()
      releaseIdle = undefined
    }
    options.emit({ type: 'simulators-changed', simulators: slots() })
    const tasks = new Set([...records.values()].map((r) => r.taskId))
    for (const taskId of tasks) options.emit({ type: 'apps-changed', taskId })
  }

  async function listDevices(): Promise<ListedDevice[]> {
    const result = await tools.simctl(['list', 'devices', '--json'])
    if (result.code !== 0) {
      throw new RequestError(409, `Xcode didn’t list its simulators: ${firstLine(result.stderr)}`)
    }
    const parsed = parseJson(result.stdout) as { devices?: Record<string, unknown[]> }
    return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) =>
      (Array.isArray(devices) ? devices : []).flatMap((d) => {
        const device = d as Record<string, unknown>
        return typeof device.udid === 'string' && typeof device.name === 'string'
          ? [
              {
                udid: device.udid,
                name: device.name,
                state: String(device.state ?? ''),
                isAvailable: device.isAvailable !== false,
                runtime,
              },
            ]
          : []
      }),
    )
  }

  async function check(factoryId: string): Promise<void> {
    if (!supported) throw new RequestError(409, 'iOS simulator Apps run only on macOS')
    const result = await tools.simctl(['list', 'runtimes', '--json'])
    const runtimes =
      result.code === 0
        ? (
            ((parseJson(result.stdout) as { runtimes?: unknown[] }).runtimes ?? []) as Record<
              string,
              unknown
            >[]
          ).filter(
            (r) =>
              r.isAvailable !== false &&
              (r.platform === 'iOS' || String(r.identifier ?? '').includes('.iOS-')),
          )
        : []
    const ref = { problem: simulatorToolsProblem, factoryId }
    if (result.code === 0 && runtimes.length > 0) {
      options.banners?.clear(ref)
      return
    }
    const missingXcode = result.code !== 0
    options.banners?.raise({
      ...ref,
      severity: 'stops-work',
      text: missingXcode
        ? 'Xcode not found · iOS simulator Apps can’t start'
        : 'No iOS simulator runtime · iOS simulator Apps can’t start',
      action: { label: 'Check again' },
    })
    throw new RequestError(
      409,
      missingXcode
        ? 'Xcode not found, so TED can’t start iOS simulator Apps. Install Xcode, open it once to finish setting up, then press Check again on the banner.'
        : 'Xcode has no iOS simulator runtime, so TED can’t start iOS simulator Apps. Add one in Xcode → Settings → Components, then press Check again on the banner.',
    )
  }

  options.banners?.onAction(simulatorToolsProblem, async (banner) => {
    if (banner.factoryId === undefined) return
    await check(banner.factoryId).catch(() => undefined)
  })

  async function createDevice(app: SimulatorApp): Promise<DeviceRecord> {
    const listed = await listDevices()
    const name = `TED ${app.displayId} ${app.name}`
    const source = listed
      .filter((d) => d.name === app.device && d.isAvailable && d.state !== 'Booted')
      .sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0]
    let created = source ? await tools.simctl(['clone', source.udid, name]) : undefined
    if (!created || created.code !== 0) {
      created = await tools.simctl(['create', name, app.device])
    }
    const udid = created.stdout.trim().split('\n').at(-1)?.trim() ?? ''
    if (created.code !== 0 || udid === '') {
      throw new RequestError(
        409,
        `Xcode has no simulator called “${app.device}”. Set \`device:\` on ${app.name} to one Xcode lists, such as iPhone 16.`,
      )
    }
    const record: DeviceRecord = {
      udid,
      taskId: app.taskId,
      repo: app.repo,
      name: app.name,
      device: app.device,
      lastUsedAt: new Date().toISOString(),
    }
    records.set(keyOf(app.taskId, app.repo, app.name), record)
    await save()
    return record
  }

  async function boot(record: DeviceRecord): Promise<void> {
    const result = await tools.simctl(['boot', record.udid])
    if (result.code !== 0 && !/current state: Booted/i.test(result.stderr)) {
      throw new RequestError(409, `TED couldn’t boot ${record.device}: ${firstLine(result.stderr)}`)
    }
    await tools.open(['-g', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', record.udid])
    record.lastUsedAt = new Date().toISOString()
    delete record.shutDown
    booted.add(record.udid)
    await save()
    changed()
  }

  async function shutDownRecord(
    record: DeviceRecord,
    why: { for?: string; idle?: boolean; human?: boolean },
  ): Promise<void> {
    const result = await tools.simctl(['shutdown', record.udid])
    if (result.code !== 0 && !/current state: Shutdown/i.test(result.stderr)) {
      throw new RequestError(
        409,
        `TED couldn’t shut down ${record.device}: ${firstLine(result.stderr)}`,
      )
    }
    booted.delete(record.udid)
    record.shutDown = {
      at: new Date().toISOString(),
      ...(why.for !== undefined && { for: why.for }),
    }
    await save()
    if (!why.human) {
      await options.stopApp(record.taskId, record.repo, record.name).catch(() => undefined)
      store.simulatorShutDown({
        taskId: record.taskId,
        repo: record.repo,
        name: record.name,
        ...(why.for !== undefined && { forTask: why.for }),
        idle: why.idle === true,
      })
    }
    changed()
  }

  async function freshBooted(): Promise<Set<string>> {
    const listed = await listDevices()
    const now = new Set(listed.filter((d) => d.state === 'Booted').map((d) => d.udid))
    const ours = new Set([...records.values()].map((r) => r.udid).filter((u) => now.has(u)))
    const before = [...booted].sort().join()
    booted.clear()
    for (const udid of ours) booted.add(udid)
    if ([...booted].sort().join() !== before) changed()
    return booted
  }

  async function ensureDevice(app: SimulatorApp): Promise<DeviceRecord> {
    const record = recordOf(app.taskId, app.repo, app.name)
    if (record && record.device === app.device) {
      const listed = await listDevices()
      if (listed.some((d) => d.udid === record.udid)) return record
    } else if (record) {
      await tools.simctl(['shutdown', record.udid])
      await tools.simctl(['delete', record.udid])
      booted.delete(record.udid)
    }
    return createDevice(app)
  }

  function bootedRecord(udid: string): DeviceRecord | undefined {
    return [...records.values()].find((r) => r.udid === udid && booted.has(udid))
  }

  function needsLive(taskId: string, repo: string, name: string): DeviceRecord {
    const record = recordOf(taskId, repo, name)
    if (!record || !booted.has(record.udid)) {
      throw new RequestError(
        409,
        `${name}’s simulator isn’t booted. Run it first with ted run-app ${name}.`,
      )
    }
    return record
  }

  function shutDownChoice(udid: string, requester: string): DeviceRecord {
    const target = bootedRecord(udid)
    if (!target) throw new RequestError(409, 'That simulator isn’t booted any more')
    const owner = store.getTask(target.taskId)?.displayId ?? target.taskId
    if (recordings.has(udid)) {
      throw new RequestError(409, `${owner}’s simulator is recording, so it can’t be shut down`)
    }
    if (target.taskId === requester) {
      throw new RequestError(409, 'Pick another Task’s simulator to shut down')
    }
    return target
  }

  function touch(record: DeviceRecord): void {
    record.lastUsedAt = new Date().toISOString()
    void save().catch(() => undefined)
  }

  async function idleCheck(): Promise<void> {
    for (const record of [...records.values()]) {
      if (!booted.has(record.udid) || recordings.has(record.udid)) continue
      if (Date.now() - Date.parse(record.lastUsedAt) < idleMs) continue
      if (await options.appLive(record.taskId, record.repo, record.name)) {
        touch(record)
        continue
      }
      await shutDownRecord(record, { idle: true }).catch(() => undefined)
    }
  }

  async function refresh(): Promise<void> {
    if (!supported || closed || records.size === 0) return
    refreshing ??= serial(async () => {
      await freshBooted()
      await idleCheck()
    })
      .catch(() => undefined)
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }

  const timer = supported ? setInterval(() => void refresh(), pollMs) : undefined
  timer?.unref()
  if (supported && records.size > 0) void refresh()

  async function stopRecordingOf(record: DeviceRecord): Promise<string> {
    const recording = recordings.get(record.udid)
    if (!recording) {
      throw new RequestError(409, `${record.name} isn’t recording. Start with --start.`)
    }
    recording.child.kill('SIGINT')
    const killer = setTimeout(() => recording.child.kill('SIGKILL'), 15_000)
    await recording.ended
    clearTimeout(killer)
    recordings.delete(record.udid)
    touch(record)
    changed()
    return recording.file
  }

  return {
    supported,
    slots,
    info(taskId, repo, name) {
      const record = recordOf(taskId, repo, name)
      if (!record) return undefined
      return {
        device: record.device,
        booted: booted.has(record.udid),
        ...(recordings.has(record.udid) && { recording: true }),
        ...(record.shutDown && !booted.has(record.udid) && { shutDown: record.shutDown }),
      }
    },
    acquire(app, by, { runId, shutDown, reason }) {
      return serial(async () => {
        await check(app.factoryId)
        const record = await ensureDevice(app)
        const now = await freshBooted()
        if (now.has(record.udid)) {
          touch(record)
          return { udid: record.udid }
        }
        if (now.size < limit()) {
          await boot(record)
          return { udid: record.udid }
        }
        if (by === 'human' || runId === undefined) {
          if (shutDown === undefined) {
            throw new RequestError(
              409,
              limit() === 1
                ? `The only simulator slot is taken. Choose a simulator to shut down, then run ${app.name} again.`
                : `All ${limit()} simulators are booted. Choose one to shut down, then run ${app.name} again.`,
            )
          }
          await shutDownRecord(shutDownChoice(shutDown, app.taskId), { for: app.displayId })
          await boot(record)
          return { udid: record.udid }
        }
        const ask: SimulatorAsk = {
          app: app.name,
          repo: app.repo,
          device: app.device,
          limit: limit(),
          booted: slots().booted,
        }
        const who = by === 'task-lead' ? 'the Task Lead' : 'the sub-agent'
        const comment = store.requestSimulator({
          taskId: app.taskId,
          runId,
          title: `${app.name} needs a simulator · ${ask.booted.length} of ${ask.limit} booted`,
          body: [
            reason?.trim() ?? '',
            `Pick one to shut down, or deny and ${who} carries on without ${app.name}.`,
          ]
            .filter((line) => line !== '')
            .join(' '),
          simulator: ask,
        })
        return { waiting: comment.id }
      })
    },
    async wait(commentId, app) {
      const comment = store.getComment(commentId)
      const answer = comment?.answer
      const record = recordOf(app.taskId, app.repo, app.name)
      if (!comment || !record) return { state: 'gone' }
      if (answer) {
        if (answer.kind === 'approved') return { state: 'granted', udid: record.udid }
        if (answer.kind === 'withdrawn' && 'slotFreed' in answer) {
          return { state: 'granted', udid: record.udid }
        }
        if (answer.kind === 'denied') {
          return { state: 'denied', ...(answer.text !== undefined && { text: answer.text }) }
        }
        return { state: 'gone' }
      }
      if (booted.size >= limit()) return { state: 'pending' }
      return serial(async () => {
        if (store.getComment(commentId)?.answer) return { state: 'pending' } as const
        const now = await freshBooted()
        if (now.size >= limit() && !now.has(record.udid)) return { state: 'pending' } as const
        if (!now.has(record.udid)) await boot(record)
        store.answerPermission(commentId, {
          kind: 'withdrawn',
          at: new Date().toISOString(),
          slotFreed: true,
        })
        return { state: 'granted', udid: record.udid } as const
      })
    },
    withdraw(commentId) {
      if (store.getComment(commentId)?.answer) return
      store.answerPermission(commentId, {
        kind: 'withdrawn',
        at: new Date().toISOString(),
        appGone: true,
      })
    },
    answer(comment, request, text) {
      return serial(async () => {
        const current = store.getComment(comment.id)
        if (current?.answer?.kind === 'withdrawn') {
          throw new RequestError(409, 'this request was withdrawn')
        }
        if (current?.answer) throw new RequestError(409, 'this request has already been answered')
        const at = new Date().toISOString()
        if (request.action === 'deny') {
          return store.answerPermission(comment.id, {
            kind: 'denied',
            at,
            ...(text !== '' && { text }),
          })
        }
        if (request.action !== 'approve') {
          throw new RequestError(400, 'answer a simulator request with a simulator to shut down, or Deny')
        }
        const ask = comment.simulator as SimulatorAsk
        const record = recordOf(comment.taskId, ask.repo, ask.app)
        if (!record) throw new RequestError(409, 'the App that asked has stopped')
        const now = await freshBooted()
        if (now.has(record.udid) || now.size < limit()) {
          if (!now.has(record.udid)) await boot(record)
          return store.answerPermission(comment.id, { kind: 'withdrawn', at, slotFreed: true })
        }
        if (request.simulator === undefined) {
          throw new RequestError(400, 'pick the simulator to shut down')
        }
        const target = shutDownChoice(request.simulator, comment.taskId)
        const owner = store.getTask(target.taskId)?.displayId ?? target.taskId
        const requester = store.getTask(comment.taskId)?.displayId ?? comment.taskId
        await shutDownRecord(target, { for: requester })
        await boot(record)
        return store.answerPermission(comment.id, {
          kind: 'approved',
          at,
          shutDown: owner,
          ...(text !== '' && { text }),
        })
      })
    },
    shutDown(taskId, repo, name) {
      return serial(async () => {
        const record = recordOf(taskId, repo, name)
        if (!record || !booted.has(record.udid)) return
        if (recordings.has(record.udid)) await stopRecordingOf(record).then((f) => rm(f, { force: true }))
        await shutDownRecord(record, { human: true })
      })
    },
    async show(taskId, repo, name) {
      const record = needsLive(taskId, repo, name)
      await tools.open(['-a', 'Simulator', '--args', '-CurrentDeviceUDID', record.udid])
      touch(record)
    },
    async screenshot(taskId, repo, name) {
      const record = needsLive(taskId, repo, name)
      await mkdir(captures, { recursive: true, mode: 0o700 })
      const out = path.join(captures, `${randomUUID()}.png`)
      const result = await tools.simctl(['io', record.udid, 'screenshot', out])
      if (result.code !== 0) {
        await rm(out, { force: true })
        throw new RequestError(409, `TED couldn’t take the screenshot: ${firstLine(result.stderr)}`)
      }
      touch(record)
      return out
    },
    async startRecording(taskId, repo, name) {
      const record = needsLive(taskId, repo, name)
      if (recordings.has(record.udid)) {
        throw new RequestError(409, `${name} is already recording. Stop it with --stop.`)
      }
      await mkdir(captures, { recursive: true, mode: 0o700 })
      const out = path.join(captures, `${randomUUID()}.mov`)
      const child = tools.record(record.udid, out)
      const ended = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.once('error', () => resolve())
      })
      recordings.set(record.udid, { child, file: out, ended })
      void ended.then(() => {
        if (recordings.get(record.udid)?.child === child && child.exitCode !== 0) {
          recordings.delete(record.udid)
          changed()
        }
      })
      touch(record)
      changed()
    },
    async stopRecording(taskId, repo, name) {
      const record = recordOf(taskId, repo, name)
      if (!record) throw new RequestError(409, `${name} isn’t recording. Start with --start.`)
      return stopRecordingOf(record)
    },
    remove(taskId, repo) {
      return serial(async () => {
        const gone = [...records.entries()].filter(
          ([, r]) => r.taskId === taskId && (repo === undefined || r.repo === repo),
        )
        if (gone.length === 0) return
        for (const [key, record] of gone) {
          const recording = recordings.get(record.udid)
          if (recording) {
            recording.child.kill('SIGINT')
            await recording.ended
            recordings.delete(record.udid)
            await rm(recording.file, { force: true })
          }
          await tools.simctl(['shutdown', record.udid])
          await tools.simctl(['delete', record.udid])
          booted.delete(record.udid)
          records.delete(key)
        }
        await save()
        changed()
      })
    },
    refresh,
    async close() {
      closed = true
      if (timer) clearInterval(timer)
      for (const recording of recordings.values()) recording.child.kill('SIGINT')
      await Promise.all([...recordings.values()].map((r) => r.ended))
      releaseIdle?.()
      releaseIdle = undefined
    },
  }
}

function readRecords(file: string): Record<string, DeviceRecord> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, DeviceRecord>
  } catch {
    return {}
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
