#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'

export interface StubIdbScreen {
  screen: 'home' | 'details'
  typed?: string
  keys?: string[]
  home?: number
}

interface StubElement {
  type: string
  label?: string
  value?: string
  id?: string
  frame: [number, number, number, number]
}

const width = 402
const height = 874

const stubScreens: Record<StubIdbScreen['screen'], StubElement[]> = {
  home: [
    { type: 'StaticText', label: 'Widgets', frame: [20, 100, 362, 40] },
    { type: 'Button', label: 'Open details', id: 'open', frame: [20, 300, 362, 50] },
  ],
  details: [
    { type: 'Button', label: 'Back', id: 'back', frame: [8, 54, 80, 44] },
    { type: 'StaticText', label: 'Details', frame: [20, 100, 362, 40] },
    { type: 'StaticText', label: 'Price: 10 widgets for $5', frame: [20, 250, 362, 40] },
    { type: 'Button', label: 'Buy', id: 'buy', frame: [20, 270, 362, 50] },
  ],
}

const file = process.env.TED_STUB_XCRUN
const args = process.argv.slice(2)

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function locked<T>(work: () => T): T {
  const lock = `${file}.lock`
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (tries > 400) throw new Error('stub-idb: state is locked')
      sleep(10)
    }
  }
  try {
    return work()
  } finally {
    rmdirSync(lock)
  }
}

interface State {
  idb?: boolean
  idbSupportsXcode27?: boolean
  devices?: Record<string, { udid: string; state: string }[]>
  ui?: Record<string, StubIdbScreen>
}

if (!file) fail('stub-idb: no state file')
if (args[0] === '--help') {
  const state = JSON.parse(readFileSync(file, 'utf8')) as State
  if (state.idbSupportsXcode27) console.log('    --log-hid-details VALUE')
  process.exit(0)
}
const selectedCompanion = args[0] === '--companion-path'
if (selectedCompanion) {
  if (args[1] !== process.argv[1]) fail('stub-idb: unexpected companion path')
  args.splice(0, 2)
}
const [group, verb, flag, udid = '', ...rest] = args
if (group !== 'ui' || flag !== '--udid') fail(`stub-idb: unexpected arguments ${args.join(' ')}`)

class Failure {
  message: string
  code: number
  constructor(message: string, code: number) {
    this.message = message
    this.code = code
  }
}

function refuse(message: string, code = 1): never {
  throw new Failure(message, code)
}

const output = locked(() => {
  try {
    return act()
  } catch (error) {
    if (error instanceof Failure) return error
    throw error
  }
})
if (output instanceof Failure) fail(output.message, output.code)
if (output !== '') console.log(output)

function act(): string {
  const state = JSON.parse(readFileSync(file as string, 'utf8')) as State
  if (state.idb === false) refuse('idb: command not found', 127)
  if (state.idbSupportsXcode27 && !selectedCompanion) refuse('stub-idb: companion path is required')
  const device = Object.values(state.devices ?? {})
    .flat()
    .find((d) => d.udid === udid)
  if (!device) refuse(`Target with udid ${udid} is not available`)
  if (device.state !== 'Booted') refuse(`Target ${udid} is not booted`)
  const screens = state.ui ?? {}
  const ui = screens[udid] ?? { screen: 'home' }
  screens[udid] = ui
  state.ui = screens
  let out = ''
  switch (verb) {
    case 'describe-all': {
      const elements = [
        {
          type: 'Application',
          AXLabel: 'Widgets',
          frame: { x: 0, y: 0, width, height },
          enabled: true,
        },
        ...stubScreens[ui.screen].map((e) => ({
          type: e.type,
          AXLabel: e.label ?? null,
          AXValue: e.value ?? null,
          AXUniqueId: e.id ?? null,
          frame: { x: e.frame[0], y: e.frame[1], width: e.frame[2], height: e.frame[3] },
          enabled: true,
        })),
      ]
      out = JSON.stringify(elements)
      break
    }
    case 'tap': {
      const [x, y] = rest.map(Number) as [number, number]
      const hit = stubScreens[ui.screen].find(
        (e) =>
          e.type === 'Button' &&
          x >= e.frame[0] &&
          x < e.frame[0] + e.frame[2] &&
          y >= e.frame[1] &&
          y < e.frame[1] + e.frame[3],
      )
      if (hit?.id === 'open') ui.screen = 'details'
      if (hit?.id === 'back') ui.screen = 'home'
      break
    }
    case 'text':
      if (rest[0] !== '--') refuse('stub-idb: text needs --')
      ui.typed = `${ui.typed ?? ''}${rest[1] ?? ''}`
      break
    case 'key':
      ui.keys = [...(ui.keys ?? []), rest[0] ?? '']
      break
    case 'button':
      if (rest[0] !== 'HOME') refuse(`stub-idb: unknown button ${rest[0]}`)
      ui.home = (ui.home ?? 0) + 1
      break
    case 'swipe':
      if (rest.length !== 4) refuse('stub-idb: swipe needs four numbers')
      break
    default:
      refuse(`stub-idb: unknown ui command ${verb}`)
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file as string)
  return out
}
