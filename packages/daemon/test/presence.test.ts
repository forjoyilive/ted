import { afterEach, expect, test, vi } from 'vitest'
import { createPresence, presenceStaleMs } from '../src/presence.ts'

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
