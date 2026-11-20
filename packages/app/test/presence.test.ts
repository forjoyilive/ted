import type { PresenceReport } from '@ted/protocol'
import { expect, test } from 'vitest'
import {
  awayAfterIdleSeconds,
  type Every,
  heartbeatMs,
  idleCheckMs,
  type PresenceMonitor,
  startPresenceReporter,
} from '../src/presence.ts'

type ScreenEvent = 'lock-screen' | 'unlock-screen'

function fakeMonitor() {
  const listeners = new Map<ScreenEvent, Set<() => void>>()
  const state = { idleSeconds: 0 }
  const monitor: PresenceMonitor = {
    getSystemIdleTime: () => state.idleSeconds,
    on(event: ScreenEvent, listener: () => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event: ScreenEvent, listener: () => void) {
      listeners.get(event)?.delete(listener)
    },
  }
  const emit = (event: ScreenEvent) => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  const count = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  return { monitor, state, emit, count }
}

function fakeTimers() {
  const timers = new Map<number, Set<() => void>>()
  const every: Every = (ms, run) => {
    const set = timers.get(ms) ?? new Set()
    set.add(run)
    timers.set(ms, set)
    return () => set.delete(run)
  }
  const tick = (ms: number) => {
    for (const run of timers.get(ms) ?? []) run()
  }
  const live = () => [...timers.values()].reduce((sum, set) => sum + set.size, 0)
  return { every, tick, live }
}

function setup() {
  const screen = fakeMonitor()
  const timers = fakeTimers()
  const reports: boolean[] = []
  let connected = true
  const reporter = startPresenceReporter({
    monitor: screen.monitor,
    every: timers.every,
    client: () =>
      connected
        ? {
            reportPresence: async (input: PresenceReport) => {
              reports.push(input.away)
              return input
            },
          }
        : undefined,
  })
  return {
    reporter,
    screen,
    timers,
    reports,
    disconnect: () => {
      connected = false
    },
  }
}

test('reports at start, then only when idle time crosses two minutes, plus a heartbeat', () => {
  const { reporter, screen, timers, reports } = setup()
  expect(reports).toEqual([false])

  screen.state.idleSeconds = awayAfterIdleSeconds - 1
  timers.tick(idleCheckMs)
  expect(reports).toEqual([false])

  screen.state.idleSeconds = awayAfterIdleSeconds
  timers.tick(idleCheckMs)
  expect(reports).toEqual([false, true])
  expect(reporter.away()).toBe(true)
  timers.tick(idleCheckMs)
  expect(reports).toEqual([false, true])

  timers.tick(heartbeatMs)
  expect(reports).toEqual([false, true, true])

  screen.state.idleSeconds = 0
  timers.tick(idleCheckMs)
  expect(reports).toEqual([false, true, true, false])
  reporter.stop()
})

test('locking the screen reports away at once, and unlocking reports back', () => {
  const { reporter, screen, reports } = setup()
  screen.emit('lock-screen')
  expect(reports).toEqual([false, true])
  screen.emit('unlock-screen')
  expect(reports).toEqual([false, true, false])
  reporter.stop()
})

test('a locked screen stays away even when idle time is short', () => {
  const { reporter, screen, timers, reports } = setup()
  screen.emit('lock-screen')
  screen.state.idleSeconds = 0
  timers.tick(idleCheckMs)
  expect(reports).toEqual([false, true])
  reporter.stop()
})

test('without a connected daemon nothing is sent, and stopping removes every timer and listener', () => {
  const { reporter, screen, timers, reports, disconnect } = setup()
  disconnect()
  screen.emit('lock-screen')
  timers.tick(heartbeatMs)
  expect(reports).toEqual([false])

  reporter.stop()
  expect(timers.live()).toBe(0)
  expect(screen.count()).toBe(0)
})
