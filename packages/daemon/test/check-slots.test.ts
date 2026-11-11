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
