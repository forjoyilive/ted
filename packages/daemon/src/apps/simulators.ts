import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppSimulator,
  AppStarter,
  Comment,
  DaemonEvent,
  DevicePoint,
  DeviceRequest,
  SimulatorSlots,
} from '@ted/protocol'
import { identity } from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import type { TedStore } from '../store/index.ts'
import { centre, formatScreen } from './android-screen.ts'
import type { DevicePool } from './device-pool.ts'
import {
  createDeviceSlots,
  type DeviceDriver,
  firstLine,
  type SimulatorApp,
  type SimulatorRequestEffects,
  type SimulatorWait,
  type SlotRecord,
} from './device-slots.ts'
import { iosKeyCodes, iosText, parseIdbScreen } from './ios-screen.ts'

export interface SimctlResult {
  code: number
  stdout: string
  stderr: string
}

export interface SimulatorTools {
  simctl(args: string[]): Promise<SimctlResult>
  idb(args: string[]): Promise<SimctlResult>
  open(args: string[]): Promise<SimctlResult>
  record(udid: string, file: string): ChildProcess
}

export function createSimulatorTools(options: {
  xcrun?: string
  idb?: string
  open?: string
  env: () => NodeJS.ProcessEnv
}): SimulatorTools {
  const xcrun = options.xcrun ?? 'xcrun'
  const idb = options.idb ?? 'idb'
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
    idb: (args) => run(idb, args),
    open: (args) => run(opener, args),
    record(udid, file) {
      return spawn(xcrun, ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], {
        env: options.env(),
        stdio: 'ignore',
      })
    },
  }
}

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
  list(commentId: string, app: SimulatorApp): void
  withdraw(commentId: string): void
  withRequest<T>(
    comment: Comment,
    work: (effects: SimulatorRequestEffects) => Promise<T>,
  ): Promise<T>
  shutDown(taskId: string, repo: string, name: string): Promise<void>
  show(taskId: string, repo: string, name: string): Promise<void>
  screenshot(taskId: string, repo: string, name: string): Promise<string>
  control(taskId: string, repo: string, name: string, request: DeviceRequest): Promise<string>
  deviceType(taskId: string, repo: string, name: string): string | undefined
  setDeviceType(taskId: string, repo: string, name: string, type: string | undefined): void
  chooseDeviceType(
    taskId: string,
    repo: string,
    name: string,
    size: string,
  ): Promise<string | undefined>
  startRecording(taskId: string, repo: string, name: string): Promise<void>
  stopRecording(taskId: string, repo: string, name: string): Promise<string>
  remove(taskId: string, repo?: string): Promise<void>
  refresh(): Promise<void>
  close(): Promise<void>
}

interface DeviceRecord extends SlotRecord {
  udid: string
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

const simulatorViewers = [
  {
    bundle: 'com.apple.iphonesimulator',
    args: (udid: string) => ['--args', '-CurrentDeviceUDID', udid],
  },
  { bundle: 'com.apple.dt.Devices', args: (udid: string) => [`devices://device/open?id=${udid}`] },
]

export const simulatorToolsProblem = 'simulator-tools'

export const idbMissing =
  'Ted drives iOS simulators through Meta’s idb, which isn’t installed on this Mac. Install it with brew install facebook/fb/idb-companion and pip3 install fb-idb, then try again.'

export function createSimulators(options: {
  dir: string
  store: TedStore
  tools: SimulatorTools
  supported: boolean
  banners?: Banners
  idle?: IdleTimer
  busy?: () => Promise<boolean>
  pool: DevicePool
  emit(event: DaemonEvent): void
  appLive(taskId: string, repo: string, name: string): Promise<boolean>
  stopApp(taskId: string, repo: string, name: string): Promise<void>
  pollMs?: number
  idleMs?: number
}): Simulators {
  const { dir, store, tools, supported } = options
  const captures = path.join(dir, 'captures')
  const booted = new Set<string>()
  const recordings = new Map<string, Recording>()
  const screens = new Map<
    string,
    { refs: Map<string, DevicePoint>; width: number; height: number }
  >()
  const deviceTypes = new Map<string, string>()

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
        ? 'Xcode not found, so Ted can’t start iOS simulator Apps. Install Xcode, open it once to finish setting up, then press Check again on the banner.'
        : 'Xcode has no iOS simulator runtime, so Ted can’t start iOS simulator Apps. Add one in Xcode → Settings → Components, then press Check again on the banner.',
    )
  }

  options.banners?.onAction(simulatorToolsProblem, async (banner) => {
    if (banner.factoryId === undefined) return
    await check(banner.factoryId).catch(() => undefined)
  })

  async function createDevice(app: SimulatorApp): Promise<DeviceRecord> {
    const listed = await listDevices()
    const name = `${identity().name} ${app.displayId} ${app.name}`
    const source = listed
      .filter((d) => d.name === app.device && d.isAvailable && d.state !== 'Booted')
      .sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0]
    let created = source ? await tools.simctl(['clone', source.udid, name]) : undefined
    if (created?.code !== 0) {
      created = await tools.simctl(['create', name, app.device])
    }
    const udid = created.stdout.trim().split('\n').at(-1)?.trim() ?? ''
    if (created.code !== 0 || udid === '') {
      throw new RequestError(
        409,
        `Xcode has no simulator called “${app.device}”. Set \`device:\` on ${app.name} to one Xcode lists, such as iPhone 16.`,
      )
    }
    return {
      udid,
      taskId: app.taskId,
      repo: app.repo,
      name: app.name,
      device: app.device,
      lastUsedAt: new Date().toISOString(),
    }
  }

  async function ensureDevice(
    app: SimulatorApp,
    record: DeviceRecord | undefined,
  ): Promise<DeviceRecord> {
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

  const driver: DeviceDriver<DeviceRecord> = {
    words: { noun: 'simulator', article: 'a', live: 'booted' },
    event: (simulators) => ({ type: 'simulators-changed', simulators }),
    slotId: (record) => record.udid,
    isLive: (record) => booted.has(record.udid),
    recording: (record) => recordings.has(record.udid),
    check,
    ensure: ensureDevice,
    async refreshLive(records) {
      const listed = await listDevices()
      const now = new Set(listed.filter((d) => d.state === 'Booted').map((d) => d.udid))
      const ours = new Set(records.map((r) => r.udid).filter((u) => now.has(u)))
      const before = [...booted].sort().join()
      booted.clear()
      for (const udid of ours) booted.add(udid)
      return [...booted].sort().join() !== before
    },
    async boot(record) {
      const result = await tools.simctl(['boot', record.udid])
      if (result.code !== 0 && !/current state: Booted/i.test(result.stderr)) {
        throw new RequestError(
          409,
          `Ted couldn’t boot ${record.device}: ${firstLine(result.stderr)}`,
        )
      }
      booted.add(record.udid)
    },
    async stop(record) {
      const result = await tools.simctl(['shutdown', record.udid])
      if (result.code !== 0 && !/current state: Shutdown/i.test(result.stderr)) {
        throw new RequestError(
          409,
          `Ted couldn’t shut down ${record.device}: ${firstLine(result.stderr)}`,
        )
      }
      booted.delete(record.udid)
    },
    async remove(key, record) {
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
      screens.delete(key)
      deviceTypes.delete(key)
      return true
    },
    shutDownRecorded: (input) => store.simulatorShutDown(input),
    async close() {
      for (const recording of recordings.values()) recording.child.kill('SIGINT')
      await Promise.all([...recordings.values()].map((r) => r.ended))
    },
  }

  async function openViewer(udid: string): Promise<SimctlResult> {
    const failures: string[] = []
    for (const viewer of simulatorViewers) {
      const result = await tools.open(['-b', viewer.bundle, ...viewer.args(udid)])
      if (result.code === 0) return result
      failures.push(firstLine(result.stderr))
    }
    return { code: 1, stdout: '', stderr: failures.join('; ') }
  }

  const deviceSlots = createDeviceSlots({
    dir,
    store,
    supported,
    driver,
    pool: options.pool,
    ...(options.idle !== undefined && { idle: options.idle }),
    ...(options.busy !== undefined && { busy: options.busy }),
    emit: options.emit,
    appLive: options.appLive,
    stopApp: options.stopApp,
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
    ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
  })
  const { keyOf, recordOf, needsLive, touch, changed } = deviceSlots

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
    slots: deviceSlots.slots,
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
    acquire: deviceSlots.acquire,
    wait: deviceSlots.wait,
    list: deviceSlots.list,
    withdraw: deviceSlots.withdraw,
    withRequest: deviceSlots.withRequest,
    shutDown(taskId, repo, name) {
      return deviceSlots.serial(async () => {
        const record = recordOf(taskId, repo, name)
        if (!record || !booted.has(record.udid)) return
        if (recordings.has(record.udid))
          await stopRecordingOf(record).then((f) => rm(f, { force: true }))
        await deviceSlots.shutDown(record, { human: true })
      })
    },
    async show(taskId, repo, name) {
      const record = needsLive(taskId, repo, name)
      const opened = await openViewer(record.udid)
      if (opened.code !== 0) {
        throw new RequestError(
          409,
          `Ted couldn’t open Simulator or Xcode’s DeviceHub: ${opened.stderr || 'no app found'}`,
        )
      }
      touch(record)
    },
    async screenshot(taskId, repo, name) {
      const record = needsLive(taskId, repo, name)
      await mkdir(captures, { recursive: true, mode: 0o700 })
      const out = path.join(captures, `${randomUUID()}.png`)
      const result = await tools.simctl(['io', record.udid, 'screenshot', out])
      if (result.code !== 0) {
        await rm(out, { force: true })
        throw new RequestError(409, `Ted couldn’t take the screenshot: ${firstLine(result.stderr)}`)
      }
      touch(record)
      return out
    },
    async control(taskId, repo, name, request) {
      const record = needsLive(taskId, repo, name)
      const key = keyOf(taskId, repo, name)
      const udid = record.udid
      const idb = async (args: string[], what: string) => {
        const [group = '', verb = '', ...rest] = args
        const result = await tools.idb([group, verb, '--udid', udid, ...rest])
        if (result.code === 127 || /ENOENT/.test(result.stderr))
          throw new RequestError(409, idbMissing)
        if (result.code !== 0)
          throw new RequestError(
            409,
            `Ted couldn’t ${what}: ${firstLine(result.stderr || result.stdout)}`,
          )
        return result
      }
      const read = async () => {
        const out = await idb(['ui', 'describe-all', '--json'], 'read the screen')
        const screen = parseIdbScreen(out.stdout)
        if (!screen)
          throw new RequestError(409, 'Ted couldn’t read the screen; try again in a moment')
        screens.set(key, {
          refs: new Map(screen.elements.map((e) => [e.ref, centre(e)])),
          width: screen.width,
          height: screen.height,
        })
        return screen
      }
      const inside = async (...points: DevicePoint[]) => {
        const size = screens.get(key) ?? (await read())
        for (const { x, y } of points) {
          if (x >= size.width || y >= size.height)
            throw new RequestError(
              400,
              `${x},${y} is off the screen, which is ${size.width}x${size.height} points`,
            )
        }
      }
      touch(record)
      switch (request.action) {
        case 'screen':
          return formatScreen(name, await read(), randomUUID().slice(0, 8))
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
          await idb(['ui', 'tap', String(point.x), String(point.y)], 'tap')
          return `Tapped ${point.x},${point.y}. Run ted app screen ${name} to see what changed.`
        }
        case 'swipe': {
          const { point: from, to } = request
          if (!from || !to) throw new RequestError(400, 'Give the swipe’s start and end points')
          await inside(from, to)
          await idb(['ui', 'swipe', ...[from.x, from.y, to.x, to.y].map(String)], 'swipe')
          return `Swiped from ${from.x},${from.y} to ${to.x},${to.y}.`
        }
        case 'type': {
          const text = request.text ?? ''
          if (!iosText(text))
            throw new RequestError(
              400,
              'Ted can type only printable ASCII characters into an iOS simulator, without line breaks; press enter with ted app key',
            )
          await idb(['ui', 'text', '--', text], 'type')
          return `Typed ${text.length} characters.`
        }
        case 'key': {
          if (request.key === 'back')
            throw new RequestError(
              400,
              'iOS has no back key. Tap the screen’s back button instead, usually at the top left.',
            )
          if (request.key === 'home') {
            await idb(['ui', 'button', 'HOME'], 'press home')
            return 'Pressed home.'
          }
          const code = request.key === undefined ? undefined : iosKeyCodes[request.key]
          if (code === undefined) throw new RequestError(400, 'Give a key')
          await idb(['ui', 'key', String(code)], `press ${request.key}`)
          return `Pressed ${request.key}.`
        }
        case 'appearance': {
          const dark = request.appearance === 'dark'
          const result = await tools.simctl(['ui', udid, 'appearance', dark ? 'dark' : 'light'])
          if (result.code !== 0)
            throw new RequestError(
              409,
              `Ted couldn’t switch to ${request.appearance} mode: ${firstLine(result.stderr)}`,
            )
          return `${name} is in ${dark ? 'dark' : 'light'} mode.`
        }
        default:
          throw new RequestError(400, `ted app ${request.action} isn’t an input action`)
      }
    },
    deviceType(taskId, repo, name) {
      return deviceTypes.get(keyOf(taskId, repo, name))
    },
    setDeviceType(taskId, repo, name, type) {
      const key = keyOf(taskId, repo, name)
      if (type === undefined) deviceTypes.delete(key)
      else deviceTypes.set(key, type)
      screens.delete(key)
    },
    async chooseDeviceType(taskId, repo, name, size) {
      if (size === 'reset') return undefined
      needsLive(taskId, repo, name)
      if (/^\d+x\d+$/.test(size))
        throw new RequestError(
          400,
          'An iOS simulator’s screen can’t be resized. Name a device type instead, such as ted app size <App> "iPhone SE (3rd generation)", or reset.',
        )
      const result = await tools.simctl(['list', 'devicetypes', '--json'])
      if (result.code !== 0)
        throw new RequestError(
          409,
          `Xcode didn’t list its device types: ${firstLine(result.stderr)}`,
        )
      const listed = (
        ((parseJson(result.stdout) as { devicetypes?: unknown[] }).devicetypes ?? []) as Record<
          string,
          unknown
        >[]
      )
        .map((t) => t.name)
        .filter((n): n is string => typeof n === 'string')
      const found = listed.find((n) => n.toLowerCase() === size.toLowerCase())
      if (!found) {
        const phones = listed.filter((n) => /^(iPhone|iPad)/.test(n)).slice(-8)
        throw new RequestError(
          400,
          `Xcode has no device type called “${size}”.${phones.length > 0 ? ` Try one of: ${phones.join(', ')}.` : ''}`,
        )
      }
      return found
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
    remove: deviceSlots.remove,
    refresh: deviceSlots.refresh,
    close: deviceSlots.close,
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
