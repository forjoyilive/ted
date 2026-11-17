import { busyMarks, defaultWorkingRuns, type Priority } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { nextBusy } from '../src/busy.ts'
import {
  continuationFlags,
  queueOrder,
  recentContinuationMs,
  startsNow,
} from '../src/tasks/queue.ts'

const task = (id: string, priority: Priority, rank: number, factoryId = 'nb') =>
  ({ id, kind: 'task', priority, rank, factoryId }) as const

describe('queueOrder', () => {
  test('setup, sub-agents, Planning, Coordinators, drafts and Automations come before Tasks', () => {
    const order = queueOrder([
      task('urgent-task', 'urgent', 1),
      { id: 'automation', kind: 'automation', rank: 1 },
      { id: 'draft', kind: 'automation-draft', rank: 1 },
      { id: 'coordinator', kind: 'coordinator', rank: 1 },
      { id: 'planning', kind: 'planning', rank: 1 },
      { id: 'sub-agent', kind: 'sub-agent', rank: 1 },
      { id: 'setup', kind: 'setup-task', rank: 1 },
    ])
    expect(order.map((e) => e.id)).toEqual([
      'setup',
      'sub-agent',
      'coordinator',
      'planning',
      'draft',
      'automation',
      'urgent-task',
    ])
  })

  test('Tasks go by Priority, Urgent first, then by rank, across Factories', () => {
    const order = queueOrder([
      task('none', 'none', 1),
      task('low', 'low', 2, 'ms'),
      task('high-later', 'high', 9),
      task('medium', 'medium', 3),
      task('high-first', 'high', 4, 'ms'),
      task('urgent', 'urgent', 5),
    ])
    expect(order.map((e) => e.id)).toEqual([
      'urgent',
      'high-first',
      'high-later',
      'medium',
      'low',
      'none',
    ])
  })

  test('answered Tasks precede new Tasks and follow Priority then manual order', () => {
    const order = queueOrder([
      task('new-urgent', 'urgent', 0),
      { ...task('answered-low', 'low', 1), kind: 'continuation' },
      { ...task('answered-high-later', 'high', 9), kind: 'continuation' },
      { ...task('answered-high-first', 'high', 3), kind: 'continuation' },
    ])
    expect(order.map((entry) => entry.id)).toEqual([
      'answered-high-first',
      'answered-high-later',
      'answered-low',
      'new-urgent',
    ])
  })

  test('entries of one class keep their rank order', () => {
    const order = queueOrder([
      { id: 'second', kind: 'automation', rank: 2 },
      { id: 'first', kind: 'automation', rank: 1 },
    ])
    expect(order.map((e) => e.id)).toEqual(['first', 'second'])
  })
})

describe('startsNow', () => {
  const queue = queueOrder([
    task('a', 'high', 1),
    task('b', 'medium', 2, 'ms'),
    task('c', 'medium', 3),
  ])

  test('starts entries in queue order while the machine has room', () => {
    const started = startsNow(queue, { limit: 2, working: 0, byFactory: {}, caps: {} })
    expect(started.map((e) => e.id)).toEqual(['a', 'b'])
  })

  test('starts nothing when the machine is full, even over the limit', () => {
    expect(startsNow(queue, { limit: 2, working: 3, byFactory: {}, caps: {} })).toEqual([])
  })

  test('skips an entry whose Factory is at its cap and lets the next one start', () => {
    const started = startsNow(queue, {
      limit: 6,
      working: 1,
      byFactory: { ms: 1 },
      caps: { ms: 1 },
    })
    expect(started.map((e) => e.id)).toEqual(['a', 'c'])
  })

  test('a Factory cap counts the entries started in the same pass', () => {
    const started = startsNow(queue, { limit: 6, working: 0, byFactory: {}, caps: { nb: 1 } })
    expect(started.map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('Automation admission', () => {
  const automationQueue = queueOrder([
    { id: 'firing', kind: 'automation', rank: 1, factoryId: 'nb' },
    { id: 'draft', kind: 'automation-draft', rank: 1, factoryId: 'nb' },
    task('same-factory', 'high', 1),
    task('other-factory', 'high', 2, 'ms'),
  ])

  test.each([
    {
      name: 'machine capacity',
      use: { limit: 1, working: 2, byFactory: {}, caps: {} },
      expected: ['draft', 'firing'],
    },
    {
      name: 'Factory capacity',
      use: { limit: 6, working: 1, byFactory: { nb: 1 }, caps: { nb: 1 } },
      expected: ['draft', 'firing', 'other-factory'],
    },
    {
      name: 'busy computer',
      use: { limit: 6, working: 1, byFactory: {}, caps: {}, busy: true },
      expected: ['draft', 'firing'],
    },
  ])('bypasses $name while ordinary work respects it', ({ use, expected }) => {
    expect(startsNow(automationQueue, use).map((e) => e.id)).toEqual(expected)
  })

  test('both kinds count against machine and Factory capacity in the same pass', () => {
    expect(
      startsNow(automationQueue, { limit: 2, working: 0, byFactory: {}, caps: {} }).map(
        (e) => e.id,
      ),
    ).toEqual(['draft', 'firing'])
    expect(
      startsNow(automationQueue, { limit: 6, working: 0, byFactory: {}, caps: { nb: 2 } }).map(
        (e) => e.id,
      ),
    ).toEqual(['draft', 'firing', 'other-factory'])
  })
})

describe('startsNow with a slot handoff', () => {
  const subAgent = (id: string, rank: number, factoryId = 'nb') =>
    ({ id, kind: 'sub-agent', rank, factoryId }) as const
  const queue = queueOrder([
    subAgent('other-task', 1),
    subAgent('handed', 2),
    subAgent('same-task', 3),
    task('a', 'high', 1),
  ])

  test('a handed-off entry starts with the machine over its limit, and nothing else does', () => {
    const started = startsNow(queue, {
      limit: 2,
      working: 3,
      byFactory: {},
      caps: {},
      handoffs: new Set(['handed']),
    })
    expect(started.map((e) => e.id)).toEqual(['handed'])
  })

  test('a handed-off entry starts with its Factory at its cap', () => {
    const started = startsNow(queue, {
      limit: 6,
      working: 1,
      byFactory: { nb: 1 },
      caps: { nb: 1 },
      handoffs: new Set(['handed']),
    })
    expect(started.map((e) => e.id)).toEqual(['handed'])
  })

  test('a handed-off entry that starts while there is room uses a slot', () => {
    const started = startsNow(queue, {
      limit: 2,
      working: 0,
      byFactory: {},
      caps: {},
      handoffs: new Set(['handed']),
    })
    expect(started.map((e) => e.id)).toEqual(['other-task', 'handed'])
  })

  test('a handed-off entry counts towards its Factory’s cap for the entries after it', () => {
    const started = startsNow(queue, {
      limit: 6,
      working: 0,
      byFactory: {},
      caps: { nb: 2 },
      handoffs: new Set(['handed']),
    })
    expect(started.map((e) => e.id)).toEqual(['other-task', 'handed'])
  })
})

describe('chats', () => {
  const ordered = queueOrder([
    task('a', 'high', 1),
    { id: 'plan', kind: 'planning', rank: 2, factoryId: 'nb' },
    { id: 'coordinator', kind: 'coordinator', rank: 1, factoryId: 'nb' },
    { id: 'side-chat', kind: 'side-chat', rank: 3, factoryId: 'nb' },
    { id: 'auto', kind: 'automation', rank: 0, factoryId: 'other' },
  ])

  test('share the Planning tier', () => {
    expect(ordered.map((e) => e.id)).toEqual(['coordinator', 'plan', 'side-chat', 'auto', 'a'])
  })

  test.each([
    { name: 'a full machine', use: { limit: 1, working: 3, byFactory: {}, caps: {} } },
    {
      name: 'a Factory at its cap',
      use: { limit: 6, working: 1, byFactory: { nb: 1 }, caps: { nb: 1 } },
    },
    {
      name: 'a busy computer',
      use: { limit: 6, working: 1, byFactory: {}, caps: {}, busy: true },
    },
  ])('start with $name', ({ use }) => {
    expect(startsNow(ordered, use).map((e) => e.id)).toEqual(
      expect.arrayContaining(['coordinator', 'plan', 'side-chat']),
    )
  })

  test('take no slot from the work after them', () => {
    expect(
      startsNow(ordered, { limit: 2, working: 0, byFactory: {}, caps: { nb: 1 } }).map((e) => e.id),
    ).toEqual(['coordinator', 'plan', 'side-chat', 'auto', 'a'])
  })
})

const quiet = { loadRatio: 0, memoryAvailable: 1 }

describe('nextBusy', () => {
  test('holds at one runnable process per core, and not below it', () => {
    expect(nextBusy(undefined, { ...quiet, loadRatio: busyMarks.load.holdAt })).toEqual({
      loadRatio: 1,
    })
    expect(nextBusy(undefined, { ...quiet, loadRatio: 4.404 })).toEqual({ loadRatio: 4.4 })
    expect(nextBusy(undefined, { ...quiet, loadRatio: 0.99 })).toBeUndefined()
  })

  test('once holding for load, keeps holding until it is below the resume mark', () => {
    const held = { loadRatio: 1.2 }
    expect(nextBusy(held, { ...quiet, loadRatio: 0.99 })).toEqual({ loadRatio: 0.99 })
    expect(nextBusy(held, { ...quiet, loadRatio: busyMarks.load.resumeBelow })).toEqual({
      loadRatio: 0.75,
    })
    expect(nextBusy(held, { ...quiet, loadRatio: 0.74 })).toBeUndefined()
    expect(nextBusy(undefined, { ...quiet, loadRatio: 0.8 })).toBeUndefined()
  })

  test('holds below 10% of memory available and keeps holding until it is above 20%', () => {
    expect(nextBusy(undefined, { ...quiet, memoryAvailable: 0.1 })).toBeUndefined()
    const held = nextBusy(undefined, { ...quiet, memoryAvailable: 0.071 })
    expect(held).toEqual({ memoryAvailable: 0.07 })
    expect(nextBusy(held, { ...quiet, memoryAvailable: 0.2 })).toEqual({ memoryAvailable: 0.2 })
    expect(nextBusy(held, { ...quiet, memoryAvailable: 0.21 })).toBeUndefined()
  })

  test('carries each resource that holds, and a load hold doesn’t keep memory held', () => {
    const both = nextBusy(undefined, { loadRatio: 2, memoryAvailable: 0.05 })
    expect(both).toEqual({ loadRatio: 2, memoryAvailable: 0.05 })
    expect(nextBusy({ loadRatio: 2 }, { loadRatio: 0.9, memoryAvailable: 0.15 })).toEqual({
      loadRatio: 0.9,
    })
  })

  test('a figure that can’t be read, or the zeros Windows reports, never holds', () => {
    expect(nextBusy({ loadRatio: 2 }, { ...quiet, loadRatio: Number.NaN })).toBeUndefined()
    expect(nextBusy({ loadRatio: 2 }, { ...quiet, loadRatio: 0 })).toBeUndefined()
    const memory = { memoryAvailable: 0.05 }
    expect(nextBusy(memory, { ...quiet, memoryAvailable: Number.NaN })).toBeUndefined()
  })
})

describe('defaultWorkingRuns', () => {
  test('one working Run per 4 GB of memory, from 2 to 8', () => {
    const gb = 1024 ** 3
    expect([4, 8, 16, 18, 24, 32, 64].map((n) => defaultWorkingRuns(n * gb))).toEqual([
      2, 2, 4, 4, 6, 8, 8,
    ])
    expect(defaultWorkingRuns(Number.NaN)).toBe(6)
  })
})

describe('startsNow while this computer is busy', () => {
  const queue = queueOrder([task('a', 'high', 1), task('b', 'medium', 2, 'ms')])
  const subAgent = (id: string, rank: number) =>
    ({ id, kind: 'sub-agent', rank, factoryId: 'nb' }) as const

  test('starts nothing while anything is working, even with slots free', () => {
    const use = { limit: 6, working: 1, byFactory: {}, caps: {}, busy: true }
    expect(startsNow(queue, use)).toEqual([])
  })

  test('with nothing working, starts the first entry and only that one', () => {
    const use = { limit: 6, working: 0, byFactory: {}, caps: {}, busy: true }
    expect(startsNow(queue, use).map((e) => e.id)).toEqual(['a'])
  })

  test('with nothing working, a Factory at its cap is still skipped for the next entry', () => {
    const use = { limit: 6, working: 0, byFactory: {}, caps: { nb: 0 }, busy: true }
    expect(startsNow(queue, use).map((e) => e.id)).toEqual(['b'])
  })

  test('a handed-off sub-agent still starts, and nothing else does', () => {
    const started = startsNow(queueOrder([subAgent('other', 1), subAgent('handed', 2), ...queue]), {
      limit: 6,
      working: 2,
      byFactory: {},
      caps: {},
      handoffs: new Set(['handed']),
      busy: true,
    })
    expect(started.map((e) => e.id)).toEqual(['handed'])
  })

  test('without the hold the same queue starts', () => {
    const use = { limit: 6, working: 1, byFactory: {}, caps: {}, busy: false }
    expect(startsNow(queue, use).map((e) => e.id)).toEqual(['a', 'b'])
  })

  test('a continuation after Checks or an answer starts, but not past the limit or a cap', () => {
    const after = {
      id: 'checked',
      kind: 'continuation',
      rank: 3,
      factoryId: 'nb',
      skipsBusy: true,
    } as const
    const ordered = queueOrder([...queue, after])
    expect(
      startsNow(ordered, { limit: 6, working: 1, byFactory: {}, caps: {}, busy: true }).map(
        (e) => e.id,
      ),
    ).toEqual(['checked'])
    expect(
      startsNow(ordered, { limit: 1, working: 1, byFactory: {}, caps: {}, busy: true }),
    ).toEqual([])
    expect(
      startsNow(ordered, {
        limit: 6,
        working: 1,
        byFactory: { nb: 1 },
        caps: { nb: 1 },
        busy: true,
      }),
    ).toEqual([])
  })
})

describe('continuations after Checks or an answer', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  test('skip the busy hold, and count as recent for 10 minutes', () => {
    expect(continuationFlags(ago(60_000), now)).toEqual({ skipsBusy: true, recent: true })
    expect(continuationFlags(ago(recentContinuationMs), now)).toEqual({ skipsBusy: true })
  })

  test('a recent one goes ahead of other continuations, whatever their Priority', () => {
    const order = queueOrder([
      task('new', 'urgent', 0),
      { id: 'old', kind: 'continuation', priority: 'urgent', rank: 1 },
      { id: 'recent', kind: 'continuation', priority: 'low', rank: 2, recent: true },
    ])
    expect(order.map((e) => e.id)).toEqual(['recent', 'old', 'new'])
  })
})
