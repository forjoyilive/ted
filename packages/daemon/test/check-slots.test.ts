import { checkCpuLimits, defaultMachineSettings } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { settingParsers } from '../src/routes/machine.ts'
import { checkCpus, checkCpusEnv, createCheckSlots } from '../src/tasks/check-slots.ts'

test('a Check may use the set share of the cores, divided between the Checks running when it starts, never under 1', async () => {
  expect(checkCpus(12, 1, 50)).toBe(6)
  expect(checkCpus(12, 2, 50)).toBe(3)
  expect(checkCpus(12, 3, 50)).toBe(2)
  expect(checkCpus(12, 0, 50)).toBe(6)
  expect(checkCpus(12, 1, 100)).toBe(12)
  expect(checkCpus(12, 1, 30)).toBe(3)
  expect(checkCpus(12, 2, 10)).toBe(1)
  expect(checkCpus(8, 1, 50)).toBe(4)
  expect(checkCpus(2, 1, 50)).toBe(1)
  expect(checkCpus(1, 4, 50)).toBe(1)
  expect(checkCpusEnv(6)).toEqual({ TED_CHECK_CPUS: '6' })

  let percent: number = defaultMachineSettings.checkCpuPercent
  const slots = createCheckSlots({ limit: () => 2, cores: () => 12, cpuPercent: () => percent })
  const first = await slots.take({})
  expect(slots.cpus()).toBe(6)
  const second = await slots.take({})
  expect(slots.cpus()).toBe(3)
  first?.()
  expect(slots.cpus()).toBe(6)
  percent = 100
  expect(slots.cpus()).toBe(12)
  second?.()
})

test('the Check CPU share is a multiple of 10 from 10 to 100, and the Scheduled Check setting is true or false', () => {
  expect(defaultMachineSettings).toMatchObject({
    checkCpuPercent: 50,
    limitScheduledCheckCpus: true,
  })
  expect(checkCpuLimits).toEqual({ min: 10, max: 100, step: 10 })
  for (const value of [10, 50, 100]) expect(settingParsers.checkCpuPercent(value)).toBe(value)
  for (const value of [0, 5, 55, 110, 50.5, '50', null, true]) {
    expect(() => settingParsers.checkCpuPercent(value), String(value)).toThrow(
      'checkCpuPercent must be a multiple of 10 from 10 to 100',
    )
  }
  expect(settingParsers.limitScheduledCheckCpus(false)).toBe(false)
  expect(settingParsers.limitScheduledCheckCpus(true)).toBe(true)
  for (const value of ['on', 1, null]) {
    expect(() => settingParsers.limitScheduledCheckCpus(value), String(value)).toThrow(
      'limitScheduledCheckCpus',
    )
  }
})

test('immediate admission has identical queue and acquisition boundaries', async () => {
  const slots = createCheckSlots({ limit: () => 1, cpuPercent: () => 50 })
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
    const slots = createCheckSlots({ limit: () => 1, cpuPercent: () => 50 })
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
    const slots = createCheckSlots({ limit: () => 1, cpuPercent: () => 50 })
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
  const slots = createCheckSlots({ limit: () => 1, cpuPercent: () => 50 })
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
  const slots = createCheckSlots({ limit: () => 1, cpuPercent: () => 50 })
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
  const slots = createCheckSlots({ limit: () => 1, cpuPercent: () => 50 })
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
