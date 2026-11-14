import { expect, test } from 'vitest'
import { clockWait, systemClock } from '../src/clock.ts'
import { startIdleTimer } from '../src/idle.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'

test('manual time keeps deadline order, intervals and cancellation, including cancellation inside a callback', () => {
  const clock = new ManualClock(1000)
  const seen: number[] = []
  const interval = clock.interval(() => {
    seen.push(clock.now())
  }, 10)
  clock.timeout(() => interval.cancel(), 25)
  const canceled = clock.timeout(() => {
    throw new Error('canceled timer fired')
  }, 15)
  canceled.cancel()
  clock.advance(30)
  expect(seen).toEqual([1010, 1020])
  expect(clock.now()).toBe(1030)
  expect(clock.pending).toEqual([])
})

test('clock waits finish on a deadline or abort and remove their timers', async () => {
  const clock = new ManualClock()
  const stopping = new AbortController()
  const deadline = clockWait(clock, 10, stopping.signal)
  clock.advance(10)
  await deadline
  const aborted = clockWait(clock, 10, stopping.signal)
  stopping.abort()
  await aborted
  await clockWait(clock, 10, stopping.signal)
  expect(clock.pending).toEqual([])
})

test('the default clock waits on real Node timers and supports cancellation', async () => {
  const stopping = new AbortController()
  const before = systemClock.now()
  await clockWait(systemClock, 1, stopping.signal)
  expect(systemClock.now()).toBeGreaterThanOrEqual(before)
  const timer = systemClock.interval(() => {
    throw new Error('canceled interval fired')
  }, 1)
  timer.unref()
  timer.cancel()
})

test('event waits subscribe before checking and recheck events that arrive during a read', async () => {
  const listeners = new Set<() => void>()
  const gate = Promise.withResolvers<void>()
  let value = 0
  let calls = 0
  const waiting = eventWait(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async () => {
      calls++
      const captured = value
      if (calls === 1) {
        value = 1
        for (const listener of listeners) listener()
        await gate.promise
      }
      return captured === 1 ? captured : undefined
    },
    'an event during a read',
  )
  gate.resolve()
  expect(await waiting).toBe(1)
  expect(calls).toBe(2)
  expect(listeners.size).toBe(0)
})

test('event waits clean up on a failed check and on timeout', async () => {
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  await expect(
    eventWait(
      subscribe,
      () => {
        throw new Error('read failed')
      },
      'read',
    ),
  ).rejects.toThrow('read failed')
  expect(listeners.size).toBe(0)
  await expect(eventWait(subscribe, () => undefined, 'missing event', 1)).rejects.toThrow(
    'timed out waiting for missing event',
  )
  expect(listeners.size).toBe(0)
})

test('idle holds cancel a deadline and the last release starts a full new delay', () => {
  const clock = new ManualClock()
  let idles = 0
  const idle = startIdleTimer({
    afterMs: 100,
    onIdle: () => {
      idles++
    },
    clock,
  })
  clock.advance(99)
  const release = idle.hold()
  const other = idle.hold()
  clock.advance(1000)
  expect(idles).toBe(0)
  release()
  release()
  clock.advance(1000)
  expect(idles).toBe(0)
  other()
  clock.advance(99)
  expect(idles).toBe(0)
  clock.advance(1)
  expect(idles).toBe(1)
  idle.cancel()
  expect(clock.pending).toEqual([])
})

test('the unattended time runs through holds and starts again with a client or Run output', () => {
  const clock = new ManualClock()
  let idles = 0
  let unattended = 0
  const idle = startIdleTimer({
    afterMs: 100,
    onIdle: () => {
      idles++
    },
    unattended: {
      afterMs: 1000,
      onUnattended: () => {
        unattended++
      },
    },
    clock,
  })
  const work = idle.hold()
  clock.advance(900)
  idle.heard()
  clock.advance(999)
  expect(unattended).toBe(0)
  const client = idle.attend()
  clock.advance(5000)
  idle.heard()
  expect(unattended).toBe(0)
  client()
  client()
  clock.advance(999)
  expect([idles, unattended]).toEqual([0, 0])
  clock.advance(1)
  expect([idles, unattended]).toEqual([0, 1])
  work()
  idle.cancel()
  clock.advance(5000)
  expect([idles, unattended]).toEqual([0, 1])
})
