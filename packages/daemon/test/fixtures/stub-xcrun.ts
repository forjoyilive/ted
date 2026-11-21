#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'

interface StubDevice {
  udid: string
  name: string
  state: 'Booted' | 'Shutdown'
  appearance?: 'light' | 'dark'
  isAvailable: boolean
  deviceTypeIdentifier: string
}

interface StubRuntime {
  identifier: string
  name: string
  platform: string
  isAvailable: boolean
}

interface StubState {
  xcode?: boolean
  xcodeVersion?: string
  runtimes?: StubRuntime[]
  devices?: Record<string, StubDevice[]>
  deviceTypes?: { name: string; identifier: string; createFails?: boolean }[]
  viewers?: string[]
}

const file = process.env.TED_STUB_XCRUN
const args = process.argv.slice(2)

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let heldLock: string | undefined

function locked<T>(work: () => T): T {
  const lock = `${file}.lock`
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (tries > 400) throw new Error('stub-xcrun: state is locked')
      sleep(10)
    }
  }
  heldLock = lock
  try {
    return work()
  } finally {
    heldLock = undefined
    rmdirSync(lock)
  }
}

function read(): StubState {
  if (!file) return { xcode: false }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StubState
  } catch {
    return { xcode: false }
  }
}

function write(state: StubState): void {
  if (!file) return
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file)
}

function fail(message: string, code = 1): never {
  if (heldLock !== undefined) rmdirSync(heldLock)
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function allDevices(state: StubState): StubDevice[] {
  return Object.values(state.devices ?? {}).flat()
}

function device(state: StubState, udid: string): StubDevice {
  const found = allDevices(state).find((d) => d.udid === udid || d.name === udid)
  if (!found) fail(`Invalid device: ${udid}`, 148)
  return found
}

if (file) appendFileSync(`${file}.calls`, `${JSON.stringify(args)}\n`)

const state = read()

const bundle = args.indexOf('-b')
if (bundle !== -1) {
  const id = args[bundle + 1] ?? ''
  if ((state.viewers ?? ['com.apple.iphonesimulator']).includes(id)) process.exit(0)
  fail(`Unable to find application with identifier ${id}`)
}
if (state.xcode !== false && args[0] === 'xcodebuild' && args[1] === '-version') {
  console.log(`Xcode ${state.xcodeVersion ?? '26.0'}`)
  process.exit(0)
}
if (state.xcode === false || args[0] !== 'simctl') {
  fail('xcrun: error: unable to find utility "simctl", not a developer tool or in PATH', 72)
}
const [, verb, ...rest] = args

if (verb === 'list') {
  const what = rest[0]
  if (what === 'runtimes') console.log(JSON.stringify({ runtimes: state.runtimes ?? [] }))
  else if (what === 'devicetypes') {
    console.log(JSON.stringify({ devicetypes: state.deviceTypes ?? [] }))
  } else console.log(JSON.stringify({ devices: state.devices ?? {} }))
  process.exit(0)
}

if (verb === 'io') {
  const [udid = '', action, ...more] = rest
  const target = device(state, udid)
  if (target.state !== 'Booted') fail('Unable to capture: device is not booted', 164)
  const out = more.at(-1) ?? fail('no output file')
  if (action === 'screenshot') {
    writeFileSync(out, Buffer.from(`PNG of ${target.name}`))
    console.log(`Wrote screenshot to: ${out}`)
    process.exit(0)
  }
  if (action === 'recordVideo') {
    writeFileSync(out, Buffer.from(`MOV of ${target.name} `))
    console.error('Recording started')
    const end = () => {
      appendFileSync(out, 'finished')
      process.exit(0)
    }
    process.on('SIGINT', end)
    process.on('SIGTERM', end)
    setInterval(() => undefined, 1_000)
  } else fail(`unknown io action ${action}`)
} else {
  const output = locked(() => {
    const current = read()
    const devices = current.devices ?? {}
    switch (verb) {
      case 'clone': {
        const [from = '', name = ''] = rest
        const source = device(current, from)
        if (source.state === 'Booted') {
          fail('Unable to clone device in current state: Booted', 149)
        }
        const runtime = Object.keys(devices).find((r) =>
          devices[r]?.some((d) => d.udid === source.udid),
        ) as string
        const udid = randomUUID().toUpperCase()
        devices[runtime]?.push({ ...source, udid, name, state: 'Shutdown' })
        write({ ...current, devices })
        return udid
      }
      case 'create': {
        const [name = '', type = '', runtime] = rest
        const known = (current.deviceTypes ?? []).find(
          (t) => t.name === type || t.identifier === type,
        )
        if (!known) fail(`Invalid device type: ${type}`, 148)
        if (known.createFails) fail(`Incompatible device: ${type}`, 148)
        const where = runtime ?? (current.runtimes ?? []).at(-1)?.identifier
        if (where === undefined) fail('No runtime', 148)
        const udid = randomUUID().toUpperCase()
        devices[where] = [
          ...(devices[where] ?? []),
          {
            udid,
            name,
            state: 'Shutdown',
            isAvailable: true,
            deviceTypeIdentifier: known.identifier,
          },
        ]
        write({ ...current, devices })
        return udid
      }
      case 'boot': {
        const target = device(current, rest[0] ?? '')
        if (target.state === 'Booted') {
          fail('Unable to boot device in current state: Booted', 149)
        }
        target.state = 'Booted'
        write(current)
        return ''
      }
      case 'shutdown': {
        const target = device(current, rest[0] ?? '')
        if (target.state !== 'Booted') {
          fail('Unable to shutdown device in current state: Shutdown', 149)
        }
        target.state = 'Shutdown'
        write(current)
        return ''
      }
      case 'openurl': {
        const [udid = '', url = ''] = rest
        const target = device(current, udid)
        if (target.state !== 'Booted' || !url.startsWith('ted-dev://pair?code='))
          fail('Unable to open the pairing link', 149)
        return ''
      }
      case 'ui': {
        const [udid = '', what, value] = rest
        const target = device(current, udid)
        if (target.state !== 'Booted')
          fail('Unable to change appearance: device is not booted', 149)
        if (what !== 'appearance' || (value !== 'light' && value !== 'dark'))
          fail(`unknown ui setting ${what} ${value}`)
        target.appearance = value
        write(current)
        return ''
      }
      case 'delete': {
        const target = device(current, rest[0] ?? '')
        for (const runtime of Object.keys(devices)) {
          devices[runtime] = (devices[runtime] ?? []).filter((d) => d.udid !== target.udid)
        }
        write({ ...current, devices })
        return ''
      }
      default:
        return fail(`unknown simctl verb ${verb}`)
    }
  })
  if (output !== '') console.log(output)
  process.exit(0)
}
