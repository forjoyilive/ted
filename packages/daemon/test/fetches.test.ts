import { expect, test } from 'vitest'
import { createFetches } from '../src/workflow/fetches.ts'

function setup() {
  const started: { clone: string; end: (error?: Error) => void }[] = []
  const timers: { ms: number; fire: () => void; canceled: boolean; unrefed: boolean }[] = []
  const limits: typeof timers = []
  let now = 0
  const fetches = createFetches({
    now: () => now,
    everyMs: 60_000,
    limitMs: 120_000,
    timeout: (fire, ms) => {
      const timer = { ms, fire, canceled: false, unrefed: false }
      ;(ms === 120_000 ? limits : timers).push(timer)
      return {
        cancel: () => {
          timer.canceled = true
        },
        unref: () => {
          timer.unrefed = true
        },
      }
    },
    fetch: (clone) =>
      new Promise<void>((resolve, reject) => {
        started.push({ clone, end: (error) => (error ? reject(error) : resolve()) })
      }),
  })
  return {
    fetches,
    started,
    timers,
    limits,
    at: (time: number) => {
      now = time
    },
  }
}

const settled = () => new Promise((resolve) => setImmediate(resolve))

test('a fresh fetch never joins one that was already running, and callers that wait share the next', async () => {
  const { fetches, started } = setup()
  const first = fetches.fresh('a')
  const second = fetches.fresh('a')
  const third = fetches.fresh('a')
  const elsewhere = fetches.fresh('b')
  expect(started.map((s) => s.clone)).toEqual(['a', 'b'])
  started[0]?.end()
  await first
  await settled()
  expect(started.map((s) => s.clone)).toEqual(['a', 'b', 'a'])
  started[2]?.end()
  await Promise.all([second, third])
  started[1]?.end()
  await elsewhere
  expect(started).toHaveLength(3)
})

test('a background fetch joins a running one and is skipped for a minute after a success', async () => {
  const { fetches, started, at } = setup()
  const running = fetches.fresh('a')
  const joined = fetches.soon('a')
  expect(started).toHaveLength(1)
  started[0]?.end()
  await Promise.all([running, joined])

  at(59_999)
  void fetches.soon('a')
  expect(started).toHaveLength(1)
  const other = fetches.soon('b')
  expect(started).toHaveLength(2)
  started[1]?.end()
  await other

  at(60_000)
  const due = fetches.soon('a')
  expect(started).toHaveLength(3)
  started[2]?.end(new Error('offline'))
  await expect(due).rejects.toThrow('offline')
  const again = fetches.soon('a')
  expect(started).toHaveLength(4)
  started[3]?.end()
  await again

  const fresh = fetches.fresh('a')
  expect(started).toHaveLength(5)
  started[4]?.end()
  await fresh
})

test('a fresh fetch still runs after the one before it fails', async () => {
  const { fetches, started } = setup()
  const first = fetches.fresh('a')
  const next = fetches.fresh('a')
  started[0]?.end(new Error('offline'))
  await expect(first).rejects.toThrow('offline')
  await settled()
  expect(started).toHaveLength(2)
  started[1]?.end()
  await next
})

test('a skipped background fetch runs once when the minute ends, or ends with a fetch that starts sooner', async () => {
  const { fetches, started, timers, at } = setup()
  const first = fetches.soon('a')
  started[0]?.end()
  await first

  at(20_000)
  let ended = 0
  const count = () => {
    ended++
  }
  const waiting = [fetches.soon('a').then(count), fetches.soon('a').then(count)]
  await settled()
  expect(started).toHaveLength(1)
  expect(ended).toBe(0)
  expect(timers).toMatchObject([{ ms: 40_000, unrefed: true, canceled: false }])

  at(60_000)
  timers[0]?.fire()
  expect(started).toHaveLength(2)
  started[1]?.end()
  await Promise.all(waiting)
  expect(ended).toBe(2)

  at(70_000)
  const absorbed = fetches.soon('a')
  expect(timers).toHaveLength(2)
  const failing = fetches.fresh('a')
  started[2]?.end(new Error('offline'))
  await expect(failing).rejects.toThrow('offline')
  expect(timers[1]?.canceled).toBe(false)
  const fresh = fetches.fresh('a')
  started[3]?.end()
  await Promise.all([fresh, absorbed])
  expect(timers[1]?.canceled).toBe(true)
  timers[1]?.fire()
  expect(started).toHaveLength(4)

  at(80_000)
  const failed = fetches.soon('a')
  at(130_000)
  timers[2]?.fire()
  started[4]?.end(new Error('offline'))
  await expect(failed).rejects.toThrow('offline')

  const again = fetches.soon('a')
  expect(started).toHaveLength(6)
  started[5]?.end()
  await again
})

test('closing ends a waiting background fetch without fetching', async () => {
  const { fetches, started, timers, at } = setup()
  const first = fetches.soon('a')
  started[0]?.end()
  await first
  at(1_000)
  const waiting = fetches.soon('a')
  fetches.close()
  await waiting
  expect(timers[0]?.canceled).toBe(true)
  timers[0]?.fire()
  await fetches.soon('a')
  expect(started).toHaveLength(1)
  expect(timers).toHaveLength(1)
})

test('a fetch that never ends is given up on, so the next one can start', async () => {
  const { fetches, started, limits } = setup()
  const hung = fetches.fresh('a')
  const waiting = fetches.fresh('a')
  expect(started).toHaveLength(1)
  expect(limits[0]).toMatchObject({ ms: 120_000, unrefed: true, canceled: false })

  limits[0]?.fire()
  await expect(hung).rejects.toThrow('the fetch took more than 120 s')
  await settled()
  expect(started).toHaveLength(2)

  started[1]?.end()
  await waiting
  expect(limits[1]?.canceled).toBe(true)
})
