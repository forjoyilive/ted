import type { RunSlots, SimulatorSlots, Task, TaskApp } from '@ted/protocol'
import { devicesLine } from '@ted/protocol'
import { noChecks } from '@ted/protocol/slots'
import { describe, expect, test } from 'vitest'
import { appStatusLine, needsSlot, previewChoice } from '../src/renderer/apps.ts'
import {
  busyDetail,
  busyMeters,
  busyReason,
  checkedAgo,
  nowLine,
  runsLine,
  waitedFor,
} from '../src/renderer/slots.ts'

const task = (preview?: { url: string; label: string }) =>
  ({
    repos: [
      {
        name: 'app',
        pullRequest: {
          number: 482,
          state: 'draft',
          ...(preview && { preview: { ...preview, source: 'deployment' } }),
        },
      },
    ],
  }) as Task

const app = (fields: Partial<TaskApp>): TaskApp => ({
  repo: 'app',
  name: 'Web',
  kind: 'web',
  state: 'stopped',
  ...fields,
})

describe('the sign-off Preview row', () => {
  test('a hosted preview comes first', () => {
    const hosted = task({ url: 'https://notebook-pr-482.vercel.app', label: 'Vercel' })
    const running = app({ state: 'running', url: 'http://localhost:5174' })
    expect(previewChoice(hosted, [running])).toMatchObject({
      kind: 'hosted',
      hosted: { repo: 'app', pullRequest: 482 },
    })
  })

  test('without one, the running Web App', () => {
    const api = app({ name: 'API', kind: 'command', state: 'running' })
    const running = app({ state: 'running', url: 'http://localhost:5174' })
    expect(previewChoice(task(), [api, running])).toEqual({ kind: 'local', app: running })
  })

  test('else Run, or Run again once the App has run', () => {
    expect(previewChoice(task(), [app({})])).toMatchObject({ kind: 'run', again: false })
    const crashed = app({ state: 'exited', exitCode: 1, startedAt: '2026-11-09T10:00:00Z' })
    expect(previewChoice(task(), [crashed])).toMatchObject({ kind: 'run', again: true })
  })

  test('without a web App, a command App opens its own window', () => {
    const desk = app({ name: 'Ted Dev', kind: 'command' })
    expect(previewChoice(task(), [desk])).toEqual({ kind: 'window', app: desk })
  })

  test('nothing when the Task has no web or command App and no hosted preview', () => {
    expect(previewChoice(task(), [app({ kind: 'ios-simulator' })])).toBeUndefined()
  })
})

describe('App status lines', () => {
  const now = Date.parse('2026-11-09T10:31:00Z')

  test('say where it runs, how long, or why it stopped', () => {
    expect(appStatusLine(app({ state: 'running', url: 'http://localhost:5174/' }), now)).toBe(
      'localhost:5174',
    )
    expect(
      appStatusLine(
        app({ kind: 'command', state: 'running', startedAt: '2026-11-09T10:00:00Z' }),
        now,
      ),
    ).toBe('Running · 31m')
    expect(appStatusLine(app({ state: 'exited', exitCode: 1 }), now)).toBe('Exited with code 1')
    expect(appStatusLine(app({ state: 'failed', problem: 'port 3000 is taken' }), now)).toBe(
      'Couldn’t start: port 3000 is taken',
    )
    expect(appStatusLine(app({ endedAt: '2026-11-09T10:11:00Z' }), now)).toBe('Stopped 20m ago')
    expect(appStatusLine(app({}), now)).toBe('Not running')
    expect(
      appStatusLine(app({ state: 'running', url: 'http://localhost:5174', removed: true }), now),
    ).toBe('Removed from settings · localhost:5174')
  })
})

describe('iOS simulator Apps', () => {
  const now = Date.parse('2026-11-09T10:31:00Z')
  const iPhone = (fields: Partial<TaskApp>) =>
    app({ name: 'iPhone', kind: 'ios-simulator', ...fields })
  const booted = (count: number): SimulatorSlots => ({
    supported: true,
    limit: 3,
    booted: Array.from({ length: count }, (_, n) => ({
      udid: `U${n}`,
      taskId: `t${n}`,
      displayId: `NB-${40 + n}`,
      title: 'A Task',
      repo: 'app',
      app: 'iPhone',
      device: 'iPhone 17',
      lastUsedAt: '2026-11-09T10:00:00Z',
      recording: false,
    })),
    waiting: [],
  })

  test('the row says whether its simulator is booted or why it was shut down', () => {
    expect(
      appStatusLine(
        iPhone({ state: 'running', simulator: { device: 'iPhone 17', booted: true } }),
        now,
      ),
    ).toBe('iPhone 17 · booted')
    expect(
      appStatusLine(
        iPhone({
          simulator: {
            device: 'iPhone 17',
            booted: false,
            shutDown: { at: '2026-11-09T10:11:00Z', for: 'NB-44' },
          },
        }),
        now,
      ),
    ).toBe('Shut down 20m ago to free a slot for NB-44')
    expect(
      appStatusLine(
        iPhone({ state: 'waiting', simulator: { device: 'iPhone 17', booted: false } }),
        now,
      ),
    ).toBe('Waiting for a simulator · iPhone 17')
  })

  test('▶ asks which simulator to shut down only when every slot is booted', () => {
    expect(needsSlot(iPhone({}), booted(2))).toBe(false)
    expect(needsSlot(iPhone({}), booted(3))).toBe(true)
    expect(needsSlot(iPhone({ simulator: { device: 'iPhone 17', booted: true } }), booted(3))).toBe(
      false,
    )
    expect(needsSlot(app({}), booted(3))).toBe(false)
  })

  test('the footer and Limits lines count simulators and emulators together, and say nothing when unsupported', () => {
    expect(devicesLine(booted(3))).toBe('Simulators and emulators 3 of 3 running')
    expect(devicesLine(booted(0))).toBeUndefined()
    expect(devicesLine({ ...booted(1), supported: false })).toBeUndefined()
    const waiter = {
      taskId: 't9',
      displayId: 'NB-49',
      title: 'Another Task',
      repo: 'app',
      app: 'iPhone',
      device: 'iPhone 17',
      place: 1,
      waitingFor: { kind: 'device' as const },
    }
    expect(devicesLine({ ...booted(3), waiting: [waiter, { ...waiter, place: 2 }] })).toBe(
      'Simulators and emulators 3 of 3 running · 2 waiting',
    )
    expect(devicesLine({ ...booted(0), waiting: [waiter] })).toBe(
      'Simulators and emulators 0 of 3 running · 1 waiting',
    )
    const slots: RunSlots = {
      working: 4,
      limit: 6,
      queued: 2,
      holders: [],
      queue: [],
      factories: [],
      checks: noChecks,
    }
    expect(nowLine(slots, booted(1))).toBe(
      'Now: 4 of 6 slots in use · 2 queued · 1 of 3 simulators and emulators running',
    )
    expect(nowLine(slots, { ...booted(1), supported: false })).toBe(
      'Now: 4 of 6 slots in use · 2 queued',
    )
  })
})

describe('Android emulator Apps', () => {
  const now = Date.parse('2026-11-09T10:31:00Z')
  const phone = (fields: Partial<TaskApp>) =>
    app({ name: 'android', kind: 'android-emulator', ...fields })
  const running = (count: number): SimulatorSlots => ({
    supported: true,
    limit: 2,
    booted: Array.from({ length: count }, (_, n) => ({
      udid: `emulator-${5554 + 2 * n}`,
      taskId: `t${n}`,
      displayId: `NB-${40 + n}`,
      title: 'A Task',
      repo: 'app',
      app: 'android',
      device: 'Pixel_8_API_35',
      lastUsedAt: '2026-11-09T10:00:00Z',
      recording: false,
    })),
    waiting: [],
  })

  test('the row says whether the emulator has a window, and ▶ asks only when every slot is taken', () => {
    const device = 'Pixel_8_API_35'
    expect(
      appStatusLine(phone({ state: 'running', simulator: { device, booted: true } }), now),
    ).toBe('Pixel_8_API_35 · running, no window')
    expect(
      appStatusLine(
        phone({ state: 'running', simulator: { device, booted: true, window: true } }),
        now,
      ),
    ).toBe('Pixel_8_API_35 · running in a window')
    expect(
      appStatusLine(phone({ state: 'waiting', simulator: { device, booted: false } }), now),
    ).toBe('Waiting for an emulator · Pixel_8_API_35')
    expect(needsSlot(phone({}), running(1))).toBe(false)
    expect(needsSlot(phone({}), running(2))).toBe(true)
    expect(
      appStatusLine(
        phone({
          state: 'waiting',
          simulator: { device, booted: false },
          waitingOn: { displayId: 'NB-40', app: 'ios' },
        }),
        now,
      ),
    ).toBe('Waiting for NB-40’s ios to finish building')
    const slots: RunSlots = {
      working: 4,
      limit: 6,
      queued: 2,
      holders: [],
      queue: [],
      factories: [],
      checks: noChecks,
    }
    expect(nowLine(slots, undefined, running(1))).toBe(
      'Now: 4 of 6 slots in use · 2 queued · 1 of 2 simulators and emulators running',
    )
  })
})

test('the sidebar names slot usage and its limit, including above-limit and queued-only work', () => {
  const slots: RunSlots = {
    working: 7,
    limit: 6,
    queued: 1,
    holders: [],
    queue: [],
    factories: [],
    checks: noChecks,
  }
  expect(runsLine(slots)).toBe('7 of 6 slots in use · 1 queued')
  expect(runsLine({ ...slots, working: 1, queued: 0 })).toBe('1 of 6 slots in use')
  expect(runsLine({ ...slots, working: 0 })).toBe('0 of 6 slots in use · 1 queued')
  expect(runsLine({ ...slots, working: 0, queued: 0 })).toBe('0 of 6 slots in use')
  expect(
    runsLine({
      ...slots,
      busy: {
        cpuInUse: 0.95,
        cpuHeld: true,
        since: '2026-01-01T00:00:00.000Z',
        checkedAt: '2026-01-01T00:00:00.000Z',
      } as const,
    }),
  ).toBe('7 of 6 slots in use · 1 queued')
})

test('the sidebar counts running and waiting Checks beside the agents', () => {
  const slots: RunSlots = {
    working: 1,
    limit: 6,
    queued: 7,
    holders: [],
    queue: [],
    factories: [],
    checks: { ...noChecks, running: 3, waiting: 1 },
    busy: {
      cpuInUse: 0.95,
      cpuHeld: true,
      since: '2026-01-01T00:00:00.000Z',
      checkedAt: '2026-01-01T00:00:00.000Z',
    } as const,
  }
  expect(runsLine(slots)).toBe('1 of 6 slots in use · 3 checks running, 1 waiting · 7 queued')
  expect(nowLine(slots)).toBe(
    'Now: 1 of 6 slots in use · 3 checks running, 1 waiting · 7 queued · computer is busy',
  )
  const { busy: _, ...calm } = slots
  expect(runsLine({ ...calm, queued: 0, checks: { ...noChecks, running: 1 } })).toBe(
    '1 of 6 slots in use · 1 check running',
  )
  expect(runsLine({ ...calm, queued: 0, checks: { ...noChecks, waiting: 2 } })).toBe(
    '1 of 6 slots in use · 2 checks waiting',
  )
})

const hold = {
  cpuInUse: 0.81,
  memoryInUse: 0.84,
  cpuHeld: true,
  since: '2026-01-01T10:00:00.000Z',
  checkedAt: '2026-01-01T10:04:30.000Z',
} as const

test('a busy hold’s text names each resource that holds, with its figure and marks', () => {
  expect(busyDetail({ ...hold, memoryInUse: 0.93, memoryHeld: true })).toBe(
    [
      'CPU: 81% in use · waits above 90%, starts again below 75%',
      'Memory: 93% in use · waits above 90%, starts again below 80%',
    ].join('\n'),
  )
  expect(busyDetail(hold)).toBe('CPU: 81% in use · waits above 90%, starts again below 75%')
})

test('the busy card colours each figure by the marks it has passed and says what holds', () => {
  expect(busyMeters(hold)).toMatchObject([
    { name: 'CPU', zone: 'close', held: true, rule: 'Starts again below 75%' },
    { name: 'Memory', zone: 'close', held: false, rule: 'Close · waits above 90%' },
  ])
  expect(busyMeters({ ...hold, cpuInUse: 0.95, memoryInUse: 0.5 })).toMatchObject([
    { zone: 'over' },
    { zone: 'fine', rule: 'Fine · waits above 90%' },
  ])
  expect(
    busyMeters({ since: hold.since, checkedAt: hold.checkedAt, memoryHeld: true })[0],
  ).toMatchObject({ zone: 'fine' })
  expect(busyReason(hold)).toBe('The CPU is busy.')
  expect(busyReason({ since: hold.since, checkedAt: hold.checkedAt, memoryHeld: true })).toBe(
    'Memory is nearly full.',
  )
  expect(busyReason({ ...hold, memoryHeld: true })).toBe(
    'CPU and memory are both past their marks.',
  )
  const at = (iso: string) => Date.parse(iso)
  expect(waitedFor(hold.since, at('2026-01-01T10:00:40Z'))).toBe('under a minute')
  expect(waitedFor(hold.since, at('2026-01-01T10:02:10Z'))).toBe('2 min')
  expect(waitedFor(hold.since, at('2026-01-01T11:05:00Z'))).toBe('1 h 5 min')
  expect(checkedAgo(hold.checkedAt, at('2026-01-01T10:04:36Z'))).toBe('6 s ago')
  expect(checkedAgo(hold.checkedAt, at('2026-01-01T10:06:40Z'))).toBe('2 min ago')
})
