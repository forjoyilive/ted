import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  AppSimulator,
  BootedSimulator,
  Comment,
  DaemonEvent,
  DevicePoint,
  DeviceRequest,
  SimulatorAsk,
  SimulatorSlots,
} from '@ted/protocol'
import { identity } from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import type { TedStore } from '../store/index.ts'
import {
  androidKeyCodes,
  androidSize,
  centre,
  formatScreen,
  inputText,
  parseUiDump,
  parseWmSize,
  screenBounds,
} from './android-screen.ts'
import type {
  SimulatorApp,
  SimulatorRequestEffects,
  Simulators,
  SimulatorWait,
} from './simulators.ts'

export interface AndroidResult {
  code: number
  stdout: string
  stderr: string
  bytes: Buffer
}

export interface AndroidTools {
  adb(args: string[]): Promise<AndroidResult>
  avdmanager(args: string[], input?: string): Promise<AndroidResult>
  emulator(args: string[]): Promise<AndroidResult>
  launch(args: string[], log: string): ChildProcess
}

export function androidSdk(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const given = env.ANDROID_HOME || env.ANDROID_SDK_ROOT
  if (given) return given
  const home = env.HOME || os.homedir()
  return platform === 'darwin'
    ? path.join(home, 'Library', 'Android', 'sdk')
    : path.join(home, 'Android', 'Sdk')
}

function avdmanagerIn(sdk: string): string {
  const latest = path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
  if (existsSync(latest)) return latest
  const old = path.join(sdk, 'tools', 'bin', 'avdmanager')
  return existsSync(old) ? old : latest
}

export function createAndroidTools(options: {
  emulator?: string
  adb?: string
  avdmanager?: string
  env: () => NodeJS.ProcessEnv
}): AndroidTools {
  const sdk = () => androidSdk(options.env())
  const bin = {
    emulator: () => options.emulator ?? path.join(sdk(), 'emulator', 'emulator'),
    adb: () => options.adb ?? path.join(sdk(), 'platform-tools', 'adb'),
    avdmanager: () => options.avdmanager ?? avdmanagerIn(sdk()),
  }
  const run = (command: string, args: string[], input?: string) =>
    new Promise<AndroidResult>((resolve) => {
      const child = execFile(
        command,
        args,
        {
          env: options.env(),
          timeout: 300_000,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof error.code === 'number' ? error.code : error.code ? 127 : 1
          const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout))
          const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr)
          resolve({
            code,
            stdout: bytes.toString('utf8'),
            stderr: err || error?.message || '',
            bytes,
          })
        },
      )
      child.stdin?.end(input ?? '')
    })
  return {
    adb: (args) => run(bin.adb(), args),
    avdmanager: (args, input) => run(bin.avdmanager(), args, input),
    emulator: (args) => run(bin.emulator(), args),
    launch(args, log) {
      const out = openSync(log, 'a', 0o600)
      try {
        const child = spawn(bin.emulator(), args, {
          env: options.env(),
          detached: true,
          stdio: ['ignore', out, out],
        })
        child.unref()
        return child
      } finally {
        closeSync(out)
      }
    },
  }
}

export interface Emulators
  extends Omit<
    Simulators,
    'show' | 'startRecording' | 'stopRecording' | 'deviceType' | 'chooseDeviceType'
  > {
  show(taskId: string, repo: string, name: string): Promise<{ rebooted: boolean }>
  control(taskId: string, repo: string, name: string, request: DeviceRequest): Promise<string>
  taskIds(): string[]
}

interface DeviceRecord {
  avd: string
  taskId: string
  repo: string
  name: string
  device: string
  serial?: string
  window?: boolean
  lastUsedAt: string
  shutDown?: { at: string; for?: string }
  owner?: string
}

export const emulatorToolsProblem = 'emulator-tools'

const lineTicket = 'line:'
const firstPort = 5554
const showSnapshot = 'ted-show'

const slug = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .toLowerCase()

export function emulatorAvdName(
  edition: string,
  displayId: string,
  repo: string,
  app: string,
): string {
  return `${edition}_${displayId}_${slug(repo)}_${slug(app)}`.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function parseAvdList(text: string): { name: string; path?: string }[] {
  return text.split(/^-{3,}\s*$/m).flatMap((block) => {
    const name = /^\s*Name:\s*(.+?)\s*$/m.exec(block)?.[1]
    const where = /^\s*Path:\s*(.+?)\s*$/m.exec(block)?.[1]
    return name === undefined ? [] : [{ name, ...(where !== undefined && { path: where }) }]
  })
}

export function avdImage(config: string): { image?: string; hardware?: string } {
  const values = new Map(
    config.split('\n').flatMap((line) => {
      const at = line.indexOf('=')
      return at === -1 ? [] : [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const]
    }),
  )
  const sysdir = values.get('image.sysdir.1')
  const image = sysdir
    ?.replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .join(';')
  const hardware = values.get('hw.device.name')
  return {
    ...(image !== undefined && image !== '' && { image }),
    ...(hardware !== undefined && hardware !== '' && { hardware }),
  }
}

export function parseAdbDevices(text: string): Map<string, string> {
  return new Map(
    text.split('\n').flatMap((line) => {
      const [serial, state] = line.trim().split(/\s+/)
      return serial?.startsWith('emulator-') && state !== undefined
        ? [[serial, state] as const]
        : []
    }),
  )
}

export function createEmulators(options: {
  dir: string
  store: TedStore
  tools: AndroidTools
  supported: boolean
  banners?: Banners
  idle?: IdleTimer
  emit(event: DaemonEvent): void
  appLive(taskId: string, repo: string, name: string): Promise<boolean>
  stopApp(taskId: string, repo: string, name: string): Promise<void>
  pollMs?: number
  idleMs?: number
  bootTimeoutMs?: number
}): Emulators {
  const { dir, store, tools, supported } = options
  const pollMs = options.pollMs ?? 3_000
  const idleMs = options.idleMs ?? 30 * 60_000
  const bootTimeoutMs = options.bootTimeoutMs ?? 5 * 60_000
  const file = path.join(dir, 'devices.json')
  const captures = path.join(dir, 'captures')
  const logs = path.join(dir, 'logs')
  const records = new Map<string, DeviceRecord>(Object.entries(readRecords(file)))
  const screens = new Map<string, { refs: Map<string, DevicePoint>; rotation: number }>()
  const running = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()
  let releaseIdle: (() => void) | undefined
  let closed = false
  let refreshing: Promise<void> | undefined
  const line: string[] = []

  const keyOf = (taskId: string, repo: string, name: string) => `${taskId}/${repo}/${slug(name)}`
  const recordOf = (taskId: string, repo: string, name: string) =>
    records.get(keyOf(taskId, repo, name))
  const isRunning = (record: DeviceRecord) => record.serial !== undefined && running.has(record.avd)

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
    return store.settings().maxRunningEmulators
  }

  function slots(): SimulatorSlots {
    const list: BootedSimulator[] = [...records.values()]
      .filter(isRunning)
      .map((r) => {
        const task = store.getTask(r.taskId)
        return {
          udid: r.serial as string,
          taskId: r.taskId,
          displayId: task?.displayId ?? r.owner ?? r.taskId,
          title: task?.title ?? '',
          repo: r.repo,
          app: r.name,
          device: r.device,
          lastUsedAt: r.lastUsedAt,
          recording: false,
        }
      })
      .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))
    return { supported, limit: limit(), booted: list }
  }

  function changed(): void {
    if (running.size > 0) releaseIdle ??= options.idle?.hold()
    else {
      releaseIdle?.()
      releaseIdle = undefined
    }
    options.emit({ type: 'emulators-changed', emulators: slots() })
    const tasks = new Set([...records.values()].map((r) => r.taskId))
    for (const taskId of tasks) options.emit({ type: 'apps-changed', taskId })
  }

  async function adbDevices(): Promise<Map<string, string>> {
    const result = await tools.adb(['devices'])
    if (result.code !== 0) {
      throw new RequestError(409, `adb didn’t list its devices: ${firstLine(result.stderr)}`)
    }
    return parseAdbDevices(result.stdout)
  }

  async function avdOf(serialId: string): Promise<string | undefined> {
    const result = await tools.adb(['-s', serialId, 'emu', 'avd', 'name'])
    if (result.code !== 0) return undefined
    return result.stdout.split('\n')[0]?.trim() || undefined
  }

  async function check(factoryId: string): Promise<void> {
    if (!supported) throw new RequestError(409, 'Android emulator Apps run only on macOS and Linux')
    const [adb, emulator, avdmanager] = await Promise.all([
      tools.adb(['version']),
      tools.emulator(['-list-avds']),
      tools.avdmanager(['list', 'avd', '-c']),
    ])
    const ref = { problem: emulatorToolsProblem, factoryId }
    const missing = [
      adb.code !== 0 && 'adb',
      emulator.code !== 0 && 'emulator',
      avdmanager.code !== 0 && 'avdmanager',
    ].filter((name): name is string => name !== false)
    if (missing.length === 0) {
      options.banners?.clear(ref)
      return
    }
    options.banners?.raise({
      ...ref,
      severity: 'stops-work',
      text: 'Android SDK not found · Android emulator Apps can’t start',
      action: { label: 'Check again' },
    })
    throw new RequestError(
      409,
      `TED couldn’t run the Android SDK’s ${missing.join(', ')}, so it can’t start Android emulator Apps. Install Android Studio with its command-line tools, or set ANDROID_HOME in your shell profile, then press Check again on the banner.`,
    )
  }

  options.banners?.onAction(emulatorToolsProblem, async (banner) => {
    if (banner.factoryId === undefined) return
    await check(banner.factoryId).catch(() => undefined)
  })

  async function avdExists(avd: string): Promise<boolean> {
    const result = await tools.emulator(['-list-avds'])
    return result.code === 0 && result.stdout.split('\n').some((l) => l.trim() === avd)
  }

  async function createDevice(app: SimulatorApp): Promise<DeviceRecord> {
    const missing = new RequestError(
      409,
      `Android has no virtual device called “${app.device}”. Set \`device:\` on ${app.name} to one that \`emulator -list-avds\` lists, such as Pixel_8_API_35.`,
    )
    const listed = await tools.avdmanager(['list', 'avd'])
    const source = parseAvdList(listed.stdout).find((a) => a.name === app.device)
    if (listed.code !== 0 || source?.path === undefined) throw missing
    const config = await readFile(path.join(source.path, 'config.ini'), 'utf8').catch(() => '')
    const { image, hardware } = avdImage(config)
    if (image === undefined) {
      throw new RequestError(
        409,
        `TED couldn’t read the system image of ${app.device}. Open it once in Android Studio’s Device Manager, then run ${app.name} again.`,
      )
    }
    const avd = emulatorAvdName(identity().name, app.displayId, app.repo, app.name)
    const created = await tools.avdmanager(
      [
        'create',
        'avd',
        '--name',
        avd,
        '--package',
        image,
        ...(hardware !== undefined ? ['--device', hardware] : []),
        '--force',
      ],
      'no\n',
    )
    if (created.code !== 0) {
      throw new RequestError(
        409,
        `TED couldn’t make an emulator from ${app.device}: ${firstLine(created.stderr || created.stdout)}`,
      )
    }
    const record: DeviceRecord = {
      avd,
      taskId: app.taskId,
      repo: app.repo,
      name: app.name,
      device: app.device,
      lastUsedAt: new Date().toISOString(),
      ...(store.getTask(app.taskId) === undefined && { owner: app.displayId }),
    }
    records.set(keyOf(app.taskId, app.repo, app.name), record)
    await save()
    return record
  }

  async function deleteAvd(record: DeviceRecord): Promise<boolean> {
    try {
      await kill(record)
    } catch {
      return false
    }
    const result = await tools.avdmanager(['delete', 'avd', '--name', record.avd])
    return (
      result.code === 0 ||
      /no Android Virtual Device named/i.test(`${result.stderr}\n${result.stdout}`)
    )
  }

  async function ensureDevice(app: SimulatorApp): Promise<DeviceRecord> {
    const record = recordOf(app.taskId, app.repo, app.name)
    if (record && record.device === app.device) {
      if (await avdExists(record.avd)) return record
    } else if (record && !(await deleteAvd(record))) {
      throw new RequestError(
        409,
        `TED couldn’t remove ${app.name}’s old emulator for ${record.device}, so it left it in place. Stop it and run ${app.name} again.`,
      )
    }
    return createDevice(app)
  }

  async function freePort(): Promise<number> {
    const listed = await adbDevices()
    const taken = new Set([
      ...[...listed.keys()],
      ...[...records.values()].filter(isRunning).map((r) => r.serial),
    ])
    for (let port = firstPort; port < firstPort + 32; port += 2) {
      if (!taken.has(`emulator-${port}`)) return port
    }
    throw new RequestError(409, 'Every emulator port adb watches is in use')
  }

  async function waitForBoot(record: DeviceRecord, child: ChildProcess, log: string) {
    const serialId = record.serial as string
    let exited: number | null | undefined
    child.once('exit', (code) => {
      exited = code
    })
    child.once('error', () => {
      exited = -1
    })
    const deadline = Date.now() + bootTimeoutMs
    while (Date.now() < deadline) {
      if (exited !== undefined) {
        const tail = await readFile(log, 'utf8').catch(() => '')
        throw new RequestError(
          409,
          `The emulator for ${record.device} stopped before it booted: ${lastLine(tail) || `exit code ${exited}`}`,
        )
      }
      const result = await tools.adb(['-s', serialId, 'shell', 'getprop', 'sys.boot_completed'])
      if (result.code === 0 && result.stdout.trim() === '1') return
      await sleep(Math.min(pollMs, 1_000))
    }
    await kill(record).catch(() => undefined)
    throw new RequestError(409, `The emulator for ${record.device} didn’t finish booting in time`)
  }

  async function boot(record: DeviceRecord, show?: { snapshot: string }): Promise<void> {
    const port = await freePort()
    record.serial = `emulator-${port}`
    await save()
    await mkdir(logs, { recursive: true, mode: 0o700 })
    const log = path.join(logs, `${record.avd}.log`)
    await writeFile(log, '', { mode: 0o600 })
    const child = tools.launch(
      [
        '-avd',
        record.avd,
        '-port',
        String(port),
        ...(show ? ['-snapshot', show.snapshot] : ['-no-window']),
        '-no-audio',
        '-no-boot-anim',
        '-no-snapshot-save',
      ],
      log,
    )
    running.add(record.avd)
    try {
      await waitForBoot(record, child, log)
    } catch (error) {
      running.delete(record.avd)
      changed()
      throw error
    }
    record.lastUsedAt = new Date().toISOString()
    record.window = show !== undefined
    delete record.shutDown
    await save()
    changed()
  }

  async function kill(record: DeviceRecord): Promise<void> {
    const serialId = record.serial
    const forget = () => {
      running.delete(record.avd)
      delete record.serial
    }
    if (serialId === undefined) return forget()
    if (!(await adbDevices()).has(serialId)) return forget()
    const avd = await avdOf(serialId)
    if (avd === undefined) {
      throw new RequestError(
        409,
        `TED couldn’t tell which emulator runs as ${serialId}, so it left it running`,
      )
    }
    if (avd !== record.avd) return forget()
    await tools.adb(['-s', serialId, 'emu', 'kill'])
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (!(await adbDevices()).has(serialId)) return forget()
      await sleep(Math.min(pollMs, 500))
    }
    throw new RequestError(
      409,
      `TED couldn’t shut down the emulator for ${record.device}; it’s still running as ${serialId}`,
    )
  }

  async function shutDownRecord(
    record: DeviceRecord,
    why: { for?: string; idle?: boolean; human?: boolean },
  ): Promise<void> {
    await kill(record)
    record.shutDown = {
      at: new Date().toISOString(),
      ...(why.for !== undefined && { for: why.for }),
    }
    delete record.window
    await save()
    if (!why.human) {
      void options.stopApp(record.taskId, record.repo, record.name).catch(() => undefined)
      store.emulatorShutDown({
        taskId: record.taskId,
        repo: record.repo,
        name: record.name,
        ...(why.for !== undefined && { forTask: why.for }),
        idle: why.idle === true,
      })
    }
    changed()
  }

  async function freshRunning(): Promise<Set<string>> {
    const listed = await adbDevices()
    const now = new Set<string>()
    for (const record of records.values()) {
      if (record.serial === undefined || !listed.has(record.serial)) continue
      if ((await avdOf(record.serial)) === record.avd) now.add(record.avd)
    }
    const before = [...running].sort().join()
    running.clear()
    for (const avd of now) running.add(avd)
    if ([...running].sort().join() !== before) changed()
    return running
  }

  function runningRecord(serialId: string): DeviceRecord | undefined {
    return [...records.values()].find((r) => r.serial === serialId && isRunning(r))
  }

  function needsLive(taskId: string, repo: string, name: string): DeviceRecord {
    const record = recordOf(taskId, repo, name)
    if (!record || !isRunning(record)) {
      throw new RequestError(
        409,
        `${name}’s emulator isn’t running. Run it first with ted run-app ${name}.`,
      )
    }
    return record
  }

  function shutDownChoice(serialId: string, requester: DeviceRecord): DeviceRecord {
    const target = runningRecord(serialId)
    if (!target) throw new RequestError(409, 'That emulator isn’t running any more')
    if (target === requester) throw new RequestError(409, 'Pick another emulator to shut down')
    return target
  }

  function touch(record: DeviceRecord): void {
    record.lastUsedAt = new Date().toISOString()
    void save().catch(() => undefined)
  }

  async function idleCheck(): Promise<void> {
    for (const record of [...records.values()]) {
      if (!isRunning(record)) continue
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
      await freshRunning()
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

  async function waitInLine(ticket: string, app: SimulatorApp): Promise<SimulatorWait> {
    const record = recordOf(app.taskId, app.repo, app.name)
    if (!record) return { state: 'gone' }
    if (!line.includes(ticket)) line.push(ticket)
    if (line[0] !== ticket || running.size >= limit()) return { state: 'pending' }
    return serial(async () => {
      const now = await freshRunning()
      if (line[0] !== ticket) return { state: 'pending' } as const
      if (now.size >= limit() && !isRunning(record)) return { state: 'pending' } as const
      if (!isRunning(record)) await boot(record)
      line.shift()
      return { state: 'granted', udid: record.serial as string } as const
    })
  }

  const granted = (record: DeviceRecord) => ({ udid: record.serial as string })

  return {
    supported,
    slots,
    info(taskId, repo, name): AppSimulator | undefined {
      const record = recordOf(taskId, repo, name)
      if (!record) return undefined
      const live = isRunning(record)
      return {
        device: record.device,
        booted: live,
        ...(live && record.window === true && { window: true }),
        ...(record.shutDown && !live && { shutDown: record.shutDown }),
      }
    },
    acquire(app, by, { runId, shutDown, reason }) {
      return serial(async () => {
        await check(app.factoryId)
        const record = await ensureDevice(app)
        const now = await freshRunning()
        if (isRunning(record)) {
          touch(record)
          return granted(record)
        }
        if (now.size < limit()) {
          await boot(record)
          return granted(record)
        }
        if (by === 'automation') {
          const ticket = `${lineTicket}${randomUUID()}`
          line.push(ticket)
          return { waiting: ticket }
        }
        if (by === 'human' || runId === undefined) {
          if (shutDown === undefined) {
            throw new RequestError(
              409,
              limit() === 1
                ? `The only emulator slot is taken. Choose an emulator to shut down, then run ${app.name} again.`
                : `All ${limit()} emulators are running. Choose one to shut down, then run ${app.name} again.`,
            )
          }
          await shutDownRecord(shutDownChoice(shutDown, record), { for: app.displayId })
          await boot(record)
          return granted(record)
        }
        const ask: SimulatorAsk = {
          platform: 'android',
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
          title: `${app.name} needs an emulator · ${ask.booted.length} of ${ask.limit} running`,
          body: [
            reason?.trim() ?? '',
            `Pick one to shut down, or deny and ${who} carries on without ${app.name}.`,
          ]
            .filter((text) => text !== '')
            .join(' '),
          simulator: ask,
        })
        return { waiting: comment.id }
      })
    },
    async wait(commentId, app) {
      if (commentId.startsWith(lineTicket)) return waitInLine(commentId, app)
      const comment = store.getComment(commentId)
      const answer = comment?.answer
      const record = recordOf(app.taskId, app.repo, app.name)
      if (!comment || !record) return { state: 'gone' }
      if (answer) {
        if (record.serial === undefined) return { state: 'gone' }
        if (answer.kind === 'approved') return { state: 'granted', udid: record.serial }
        if (answer.kind === 'withdrawn' && 'slotFreed' in answer) {
          return { state: 'granted', udid: record.serial }
        }
        if (answer.kind === 'denied') {
          return { state: 'denied', ...(answer.text !== undefined && { text: answer.text }) }
        }
        return { state: 'gone' }
      }
      if (running.size >= limit()) return { state: 'pending' }
      return serial(async () => {
        if (store.getComment(commentId)?.answer) return { state: 'pending' } as const
        const now = await freshRunning()
        if (now.size >= limit() && !isRunning(record)) return { state: 'pending' } as const
        if (!isRunning(record)) await boot(record)
        store.answerPermission(commentId, {
          kind: 'withdrawn',
          at: new Date().toISOString(),
          slotFreed: true,
        })
        return { state: 'granted', udid: record.serial as string } as const
      })
    },
    withdraw(commentId) {
      if (commentId.startsWith(lineTicket)) {
        const at = line.indexOf(commentId)
        if (at !== -1) line.splice(at, 1)
        return
      }
      if (store.getComment(commentId)?.answer) return
      store.answerPermission(commentId, {
        kind: 'withdrawn',
        at: new Date().toISOString(),
        appGone: true,
      })
    },
    withRequest<T>(
      comment: Comment,
      work: (effects: SimulatorRequestEffects) => Promise<T>,
    ): Promise<T> {
      return serial(async () => {
        const requester = () => {
          const ask = comment.simulator
          const record = ask && recordOf(comment.taskId, ask.repo, ask.app)
          if (!record) throw new RequestError(409, 'the App that asked has stopped')
          return record
        }
        return work({
          assertApp() {
            requester()
          },
          async hasRoom() {
            const record = requester()
            const now = await freshRunning()
            return isRunning(record) || now.size < limit()
          },
          async boot() {
            const record = requester()
            if (!isRunning(record)) await boot(record)
          },
          async shutDown(serialId) {
            const record = requester()
            const target = shutDownChoice(serialId, record)
            const owner = store.getTask(target.taskId)?.displayId ?? target.owner ?? target.taskId
            const forTask = store.getTask(comment.taskId)?.displayId ?? comment.taskId
            await shutDownRecord(target, { for: forTask })
            return owner
          },
        })
      })
    },
    shutDown(taskId, repo, name) {
      return serial(async () => {
        const record = recordOf(taskId, repo, name)
        if (!record || !isRunning(record)) return
        await shutDownRecord(record, { human: true })
      })
    },
    show(taskId, repo, name) {
      return serial(async () => {
        const record = needsLive(taskId, repo, name)
        if (record.window === true) {
          touch(record)
          return { rebooted: false }
        }
        const serialId = record.serial as string
        const saved = await tools.adb([
          '-s',
          serialId,
          'emu',
          'avd',
          'snapshot',
          'save',
          showSnapshot,
        ])
        if (saved.code !== 0 || /^KO/m.test(saved.stdout)) {
          throw new RequestError(
            409,
            `TED couldn’t save ${record.device}’s state, so it left the emulator as it was: ${firstLine(saved.stderr || saved.stdout)}`,
          )
        }
        await kill(record)
        changed()
        await boot(record, { snapshot: showSnapshot })
        return { rebooted: true }
      })
    },
    async screenshot(taskId, repo, name) {
      const record = needsLive(taskId, repo, name)
      await mkdir(captures, { recursive: true, mode: 0o700 })
      const out = path.join(captures, `${randomUUID()}.png`)
      const result = await tools.adb(['-s', record.serial as string, 'exec-out', 'screencap', '-p'])
      if (result.code !== 0 || result.bytes.length === 0) {
        throw new RequestError(409, `TED couldn’t take the screenshot: ${firstLine(result.stderr)}`)
      }
      await writeFile(out, result.bytes, { mode: 0o600 })
      touch(record)
      return out
    },
    async control(taskId, repo, name, request) {
      const record = needsLive(taskId, repo, name)
      const key = keyOf(taskId, repo, name)
      const adb = async (args: string[], what: string) => {
        const result = await tools.adb(['-s', record.serial as string, ...args])
        if (result.code !== 0)
          throw new RequestError(
            409,
            `TED couldn’t ${what}: ${firstLine(result.stderr || result.stdout)}`,
          )
        return result
      }
      const inside = async (...points: DevicePoint[]) => {
        const natural = parseWmSize(
          (await adb(['shell', 'wm', 'size'], 'read the screen size')).stdout,
        )
        if (!natural) throw new RequestError(409, 'TED couldn’t read the screen size')
        const size = screenBounds(natural, screens.get(key)?.rotation ?? 0)
        for (const { x, y } of points) {
          if (x >= size.width || y >= size.height)
            throw new RequestError(
              400,
              `${x},${y} is off the screen, which is ${size.width}x${size.height}`,
            )
        }
      }
      touch(record)
      switch (request.action) {
        case 'screen': {
          const out = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], 'read the screen')
          const screen = parseUiDump(out.stdout)
          if (!screen)
            throw new RequestError(409, 'TED couldn’t read the screen; try again in a moment')
          screens.set(key, {
            refs: new Map(screen.elements.map((e) => [e.ref, centre(e)])),
            rotation: screen.rotation,
          })
          return formatScreen(name, screen, randomUUID().slice(0, 8))
        }
        case 'tap': {
          let point = request.point
          if (request.ref !== undefined) {
            point = screens.get(key)?.refs.get(request.ref)
            if (!point)
              throw new RequestError(
                409,
                `No element ${request.ref} on the last screen read. Run ted app screen ${name} again.`,
              )
          }
          if (!point) throw new RequestError(400, 'Tap an element reference or a point x,y')
          await inside(point)
          await adb(['shell', 'input', 'tap', String(point.x), String(point.y)], 'tap')
          return `Tapped ${point.x},${point.y}. Run ted app screen ${name} to see what changed.`
        }
        case 'swipe': {
          const { point: from, to } = request
          if (!from || !to) throw new RequestError(400, 'Give the swipe’s start and end points')
          await inside(from, to)
          await adb(
            ['shell', 'input', 'swipe', ...[from.x, from.y, to.x, to.y, 300].map(String)],
            'swipe',
          )
          return `Swiped from ${from.x},${from.y} to ${to.x},${to.y}.`
        }
        case 'type': {
          const typed = inputText(request.text ?? '')
          if (typed === undefined)
            throw new RequestError(
              400,
              'TED can type only printable ASCII characters into an Android emulator, without line breaks or %s (Android types %s as a space); press enter with ted app key',
            )
          await adb(['shell', 'input', 'text', typed], 'type')
          return `Typed ${(request.text ?? '').length} characters.`
        }
        case 'key': {
          const code = request.key === undefined ? undefined : androidKeyCodes[request.key]
          if (code === undefined) throw new RequestError(400, 'Give a key')
          await adb(['shell', 'input', 'keyevent', String(code)], `press ${request.key}`)
          return `Pressed ${request.key}.`
        }
        case 'appearance': {
          const dark = request.appearance === 'dark'
          await adb(
            ['shell', 'cmd', 'uimode', 'night', dark ? 'yes' : 'no'],
            `switch to ${request.appearance} mode`,
          )
          return `${name} is in ${dark ? 'dark' : 'light'} mode.`
        }
        case 'size': {
          const size = androidSize(request.size ?? '')
          if (typeof size === 'string' && size !== 'reset') throw new RequestError(400, size)
          screens.delete(key)
          if (size === 'reset') {
            await adb(['shell', 'wm', 'size', 'reset'], 'reset the screen size')
            await adb(['shell', 'wm', 'density', 'reset'], 'reset the screen density')
            return `${name}’s screen is back to its own size and density.`
          }
          await adb(['shell', 'wm', 'size', `${size.width}x${size.height}`], 'resize the screen')
          if (request.density !== undefined)
            await adb(['shell', 'wm', 'density', String(request.density)], 'set the density')
          return `${name}’s screen is ${size.width}x${size.height}${request.density !== undefined ? ` at ${request.density} dpi` : ''}. Read it again with ted app screen ${name}.`
        }
        default:
          throw new RequestError(400, `ted app ${request.action} isn’t an input action`)
      }
    },
    remove(taskId, repo) {
      return serial(async () => {
        const gone = [...records.entries()].filter(
          ([, r]) => r.taskId === taskId && (repo === undefined || r.repo === repo),
        )
        if (gone.length === 0) return
        for (const [key, record] of gone) {
          if (!(await deleteAvd(record))) continue
          await rm(path.join(logs, `${record.avd}.log`), { force: true })
          records.delete(key)
          screens.delete(key)
        }
        await save()
        changed()
      })
    },
    taskIds: () => [...new Set([...records.values()].map((r) => r.taskId))],
    refresh,
    async close() {
      closed = true
      if (timer) clearInterval(timer)
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

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? ''
}
