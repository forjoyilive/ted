import { expect, test, vi } from 'vitest'
import { createCheckSlots } from '../src/tasks/check-slots.ts'

test('immediate admission has identical queue and acquisition boundaries', async () => {
  const slots = createCheckSlots({ limit: () => 1 })
  const boundaries: unknown[] = []
  const release = await slots.take({ observe: (kind, at) => boundaries.push({ kind, at }) })
  expect(boundaries).toHaveLength(2)
  expect(boundaries).toEqual([
    { kind: 'entered', at: expect.any(String) },
    { kind: 'acquired', at: (boundaries[0] as { at: string }).at },
  ])
  release?.()
})

test('contention measures FIFO admission and canceled waiters never acquire', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime('2026-11-11T12:00:00Z')
    const slots = createCheckSlots({ limit: () => 1 })
    const first = await slots.take({})
    const events: string[] = []
    const second = slots.take({ observe: (kind, at) => events.push(`second ${kind} ${at}`) })
    const abort = new AbortController()
    const canceled = slots.take({
      signal: abort.signal,
      observe: (kind) => events.push(`canceled ${kind}`),
    })
    const third = slots.take({ observe: (kind) => events.push(`third ${kind}`) })
    vi.setSystemTime('2026-11-11T12:00:02Z')
    abort.abort()
    expect(await canceled).toBeUndefined()
    first?.()
    const release = await second
    expect(events).toEqual([
      'second entered 2026-11-11T12:00:00.000Z',
      'canceled entered',
      'third entered',
      'canceled canceled',
      'second acquired 2026-11-11T12:00:02.000Z',
    ])
    release?.()
    const last = await third
    expect(events.at(-1)).toBe('third acquired')
    last?.()
  } finally {
    vi.useRealTimers()
  }
})

test.each(['entered', 'acquired'] as const)(
  'a failed %s record rejects immediate admission without retaining capacity',
  async (boundary) => {
    const slots = createCheckSlots({ limit: () => 1 })
    await expect(
      slots.take({
        observe: (kind) => {
          if (kind === boundary) throw new Error('recording unavailable')
        },
      }),
    ).rejects.toThrow('recording unavailable')
    expect(slots.full()).toBe(false)
    const next = await slots.take({})
    expect(next).toBeTypeOf('function')
    next?.()
  },
)

test('a failed queued admission rejects and lets later requests acquire in FIFO order', async () => {
  const slots = createCheckSlots({ limit: () => 1 })
  const first = await slots.take({})
  const failed = expect(
    slots.take({
      observe: (kind) => {
        if (kind === 'acquired') throw new Error('recording unavailable')
      },
    }),
  ).rejects.toThrow('recording unavailable')
  const admitted: string[] = []
  const second = slots.take({
    observe: (kind) => {
      if (kind === 'acquired') admitted.push('second')
    },
  })
  const third = slots.take({
    observe: (kind) => {
      if (kind === 'acquired') admitted.push('third')
    },
  })
  expect(() => first?.()).not.toThrow()
  await failed
  const release = await second
  expect(admitted).toEqual(['second'])
  release?.()
  const last = await third
  expect(admitted).toEqual(['second', 'third'])
  last?.()
  expect(slots.full()).toBe(false)
})

test('a failed cancellation record rejects the removed waiter without stranding the line', async () => {
  const slots = createCheckSlots({ limit: () => 1 })
  const first = await slots.take({})
  const abort = new AbortController()
  const acquired: string[] = []
  const failed = expect(
    slots.take({
      signal: abort.signal,
      observe: (kind) => {
        if (kind === 'canceled') throw new Error('recording unavailable')
        if (kind === 'acquired') acquired.push('canceled')
      },
    }),
  ).rejects.toThrow('recording unavailable')
  const next = slots.take({
    observe: (kind) => {
      if (kind === 'acquired') acquired.push('next')
    },
  })
  abort.abort()
  await failed
  first?.()
  const release = await next
  expect(acquired).toEqual(['next'])
  release?.()
  expect(slots.full()).toBe(false)
})

test('recording an already aborted request can fail without retaining capacity', async () => {
  const slots = createCheckSlots({ limit: () => 1 })
  const abort = new AbortController()
  abort.abort()
  await expect(
    slots.take({
      signal: abort.signal,
      observe: (kind) => {
        if (kind === 'canceled') throw new Error('recording unavailable')
      },
    }),
  ).rejects.toThrow('recording unavailable')
  expect(slots.full()).toBe(false)
  const next = await slots.take({})
  expect(next).toBeTypeOf('function')
  next?.()
})
