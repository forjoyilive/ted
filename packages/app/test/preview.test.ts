import type { RunSlots, SimulatorSlots, Task, TaskApp } from '@ted/protocol'
import { devicesLine } from '@ted/protocol'
import { noChecks } from '@ted/protocol/slots'
import { describe, expect, test } from 'vitest'
import { appStatusLine, needsSlot, previewChoice } from '../src/renderer/apps.ts'
import { busyDetail, nowLine, runsLine, statusDetail } from '../src/renderer/slots.ts'

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
  expect(runsLine({ ...slots, busy: { loadRatio: 1.4 } })).toContain('computer is busy')
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
    busy: { loadRatio: 1.4 },
  }
  expect(runsLine(slots)).toBe(
    '1 of 6 slots in use · 3 checks running, 1 waiting · 7 queued · computer is busy',
  )
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

test('hovering a busy hold names each resource that holds, with its figure and marks', () => {
  expect(busyDetail({ memoryAvailable: 0.07, loadRatio: 1.3 })).toBe(
    [
      'Memory available: 7% · waits below 10%, starts again above 20%',
      'CPU load: 1.30 per core · waits at 1, starts again below 0.75',
    ].join('\n'),
  )
  expect(statusDetail({ kind: 'queued', hold: 'computer is busy', busy: { loadRatio: 2 } })).toBe(
    'CPU load: 2.00 per core · waits at 1, starts again below 0.75',
  )
  expect(statusDetail({ kind: 'queued', place: 2 })).toBeUndefined()
})
