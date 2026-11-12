import { expect, test } from 'vitest'
import { createFetches } from '../src/workflow/fetches.ts'

function setup() {
  const started: { clone: string; end: (error?: Error) => void }[] = []
  let now = 0
  const fetches = createFetches({
    now: () => now,
    everyMs: 60_000,
    fetch: (clone) =>
      new Promise<void>((resolve, reject) => {
        started.push({ clone, end: (error) => (error ? reject(error) : resolve()) })
      }),
  })
  return {
    fetches,
    started,
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
  await fetches.soon('a')
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
