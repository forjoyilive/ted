import { afterEach, expect, test, vi } from 'vitest'
import { createPresence, idleBeforeAwayMs, presenceStaleMs } from '../src/presence.ts'

afterEach(() => {
  vi.useRealTimers()
})

test('the user is away until the app reports otherwise, and again once reports stop for 90 seconds', async () => {
  vi.useFakeTimers()
  const presence = createPresence({ now: () => Date.now() })
  const changes: boolean[] = []
  presence.subscribe((away) => changes.push(away))
  expect(presence.away()).toBe(true)

  presence.report(false)
  expect(presence.away()).toBe(false)
  await vi.advanceTimersByTimeAsync(presenceStaleMs - 1_000)
  presence.report(false)
  await vi.advanceTimersByTimeAsync(presenceStaleMs - 1_000)
  expect(presence.away()).toBe(false)
  expect(changes).toEqual([false])

  await vi.advanceTimersByTimeAsync(1_000)
  expect(changes).toEqual([false, true])
  expect(presence.away()).toBe(true)

  presence.report(false)
  presence.report(true)
  expect(changes).toEqual([false, true, false, true])
  presence.close()
})

test('the user left when the daemon started, 2 idle minutes before an away report, or at the last report before reports stopped', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-19T10:00:00Z'))
  const presence = createPresence({ now: () => Date.now() })
  const start = Date.now()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(presence.leftAt()).toBe(start)

  presence.report(false)
  expect(presence.leftAt()).toBeUndefined()
  await vi.advanceTimersByTimeAsync(10_000)
  presence.report(true)
  expect(presence.leftAt()).toBe(Date.now() - idleBeforeAwayMs)
  const left = Date.now() - idleBeforeAwayMs
  await vi.advanceTimersByTimeAsync(30_000)
  presence.report(true)
  expect(presence.leftAt()).toBe(left)

  presence.report(false)
  const lastSeen = Date.now()
  await vi.advanceTimersByTimeAsync(presenceStaleMs)
  expect(presence.away()).toBe(true)
  expect(presence.leftAt()).toBe(lastSeen)
  presence.close()
})
