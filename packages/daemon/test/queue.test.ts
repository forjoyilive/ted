import { busyMarks, defaultWorkingRuns, type Priority } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { type BusyState, nextBusy } from '../src/busy.ts'
import {
  continuationFlags,
  queueOrder,
  recentContinuationMs,
  stageQueue,
  startsNow,
} from '../src/tasks/queue.ts'

const task = (id: string, priority: Priority, rank: number, factoryId = 'nb') =>
  ({ id, kind: 'task', priority, rank, factoryId }) as const

describe('queueOrder', () => {
  test('setup, sub-agents, Planning, Coordinators, drafts and Automations come before Tasks', () => {
    const order = queueOrder([
      task('urgent-task', 'urgent', 1),
      { ...task('cleanup-task', 'none', 2), stageRank: 2 },
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
      'cleanup-task',
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

  test('Stage rank comes first among Tasks, ahead of continuations, recency and Priority', () => {
    const order = queueOrder([
      task('new-work-urgent', 'urgent', 0),
      { ...task('answered-work-urgent', 'urgent', 1), kind: 'continuation', recent: true },
      { ...task('new-merge-low', 'low', 2), stageRank: 1 },
      { ...task('answered-merge-none', 'none', 3), kind: 'continuation', stageRank: 1 },
      { ...task('new-cleanup-none', 'none', 4), stageRank: 2 },
    ])
    expect(order.map((entry) => entry.id)).toEqual([
      'new-cleanup-none',
      'answered-merge-none',
      'new-merge-low',
      'answered-work-urgent',
      'new-work-urgent',
    ])
  })

  test('a held or revived Task Lead in a lower-ranked Stage waits behind a queued Task in a higher one', () => {
    const ordered = queueOrder([
      { id: 'held-work', kind: 'continuation', rank: -1, factoryId: 'nb', stageRank: 0 },
      { id: 'revived-work', kind: 'continuation', rank: -1, factoryId: 'nb', stageRank: 0 },
      { ...task('queued-merge', 'none', 7), stageRank: 1 },
      { ...task('new-work', 'urgent', 0), stageRank: 0 },
    ])
    expect(ordered.map((entry) => entry.id)).toEqual([
      'queued-merge',
      'held-work',
      'revived-work',
      'new-work',
    ])
    expect(
      startsNow(ordered, { limit: 2, working: 1, byFactory: {}, caps: {} }).map((e) => e.id),
    ).toEqual(['queued-merge'])
  })

  test('skipping the busy hold doesn’t move a new Task ahead of continuations', () => {
    const order = queueOrder([
      task('new-urgent', 'urgent', 0),
      { ...task('skips-low', 'low', 5), skipsBusy: true },
      { ...task('answered-low', 'low', 3), kind: 'continuation' },
    ])
    expect(order.map((entry) => entry.id)).toEqual(['answered-low', 'new-urgent', 'skips-low'])
  })

  test('entries of one class keep their rank order', () => {
    const order = queueOrder([
      { id: 'second', kind: 'automation', rank: 2 },
      { id: 'first', kind: 'automation', rank: 1 },
    ])
    expect(order.map((e) => e.id)).toEqual(['first', 'second'])
  })
})

describe('stageQueue', () => {
  test('Cleanup ranks 2 and skips the busy hold, Merge ranks 1, other Stages 0', () => {
    expect(stageQueue({}, 'cleanup')).toEqual({ rank: 2, skipsBusy: true })
    expect(stageQueue({}, 'merge')).toEqual({ rank: 1, skipsBusy: false })
    expect(stageQueue({}, 'work')).toEqual({ rank: 0, skipsBusy: false })
    expect(stageQueue({}, 'qa')).toEqual({ rank: 0, skipsBusy: false })
  })

  test('workflow.yaml’s priority and skip_busy_hold replace the defaults', () => {
    const stages = {
      cleanup: { priority: 0, skip_busy_hold: false },
      merge: { skip_busy_hold: true },
      work: { priority: 3 },
    }
    expect(stageQueue(stages, 'cleanup')).toEqual({ rank: 0, skipsBusy: false })
    expect(stageQueue(stages, 'merge')).toEqual({ rank: 1, skipsBusy: true })
    expect(stageQueue(stages, 'work')).toEqual({ rank: 3, skipsBusy: false })
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

const quiet = { cpuInUse: 0, memoryAvailable: 1 }
const confirmMs = 15_000

function readings(...steps: { cpuInUse?: number; memoryAvailable?: number; at: number }[]) {
  let state: BusyState = {}
  return steps.map((step) => {
    state = nextBusy(state, { ...quiet, ...step }, confirmMs)
    return state.hold
  })
}

describe('nextBusy', () => {
  test('holds for CPU only after two readings above 90%, a check apart', () => {
    const [first, early, second] = readings(
      { cpuInUse: 0.95, at: 0 },
      { cpuInUse: 0.97, at: 5_000 },
      { cpuInUse: 0.942, at: confirmMs },
    )
    expect(first).toBeUndefined()
    expect(early).toBeUndefined()
    expect(second).toMatchObject({ cpuInUse: 0.94, cpuHeld: true, memoryInUse: 0 })
    expect(second?.memoryHeld).toBeUndefined()
    expect(second?.since).toBe(new Date(confirmMs).toISOString())
  })

  test('a short spike, a reading at 90% or a long gap starts no CPU hold', () => {
    expect(
      readings(
        { cpuInUse: 0.95, at: 0 },
        { cpuInUse: 0.5, at: 1 },
        { cpuInUse: 0.95, at: confirmMs },
      ),
    ).toEqual([undefined, undefined, undefined])
    expect(
      readings({ cpuInUse: busyMarks.cpu.holdAbove, at: 0 }, { cpuInUse: 0.9, at: confirmMs }),
    ).toEqual([undefined, undefined])
    expect(readings({ cpuInUse: 0.95, at: 0 }, { cpuInUse: 0.95, at: 10 * 60_000 })).toEqual([
      undefined,
      undefined,
    ])
  })

  test('once holding for CPU, keeps holding until it is below 75%, and keeps its start', () => {
    const [, held, easing, atMark, lifted] = readings(
      { cpuInUse: 0.95, at: 0 },
      { cpuInUse: 0.95, at: confirmMs },
      { cpuInUse: 0.81, at: 2 * confirmMs },
      { cpuInUse: busyMarks.cpu.resumeBelow, at: 3 * confirmMs },
      { cpuInUse: 0.74, at: 4 * confirmMs },
    )
    expect(easing).toMatchObject({ cpuInUse: 0.81, cpuHeld: true, since: held?.since })
    expect(easing?.checkedAt).toBe(new Date(2 * confirmMs).toISOString())
    expect(atMark).toMatchObject({ cpuInUse: 0.75, cpuHeld: true })
    expect(lifted).toBeUndefined()
  })

  test('holds at once above 90% of memory in use and keeps holding until it is below 80%', () => {
    expect(readings({ memoryAvailable: 0.1, at: 0 })).toEqual([undefined])
    const [held, atMark, lifted] = readings(
      { memoryAvailable: 0.071, at: 0 },
      { memoryAvailable: 0.2, at: 1 },
      { memoryAvailable: 0.21, at: 2 },
    )
    expect(held).toMatchObject({ memoryInUse: 0.93, memoryHeld: true, cpuInUse: 0 })
    expect(held?.cpuHeld).toBeUndefined()
    expect(atMark).toMatchObject({ memoryInUse: 0.8, memoryHeld: true })
    expect(lifted).toBeUndefined()
  })

  test('a CPU hold doesn’t keep memory held', () => {
    const [, both, cpuOnly] = readings(
      { cpuInUse: 0.95, memoryAvailable: 0.05, at: 0 },
      { cpuInUse: 0.95, memoryAvailable: 0.05, at: confirmMs },
      { cpuInUse: 0.85, memoryAvailable: 0.25, at: 2 * confirmMs },
    )
    expect(both).toMatchObject({ cpuHeld: true, memoryHeld: true })
    expect(cpuOnly).toMatchObject({ cpuHeld: true, memoryInUse: 0.75 })
    expect(cpuOnly?.memoryHeld).toBeUndefined()
  })

  test('a figure that can’t be read never holds', () => {
    expect(
      readings(
        { cpuInUse: 0.95, at: 0 },
        { cpuInUse: 0.95, at: confirmMs },
        { cpuInUse: Number.NaN, at: 2 * confirmMs },
      )[2],
    ).toBeUndefined()
    expect(
      readings({ memoryAvailable: 0.05, at: 0 }, { memoryAvailable: Number.NaN, at: 1 })[1],
    ).toBeUndefined()
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
  test('a Task in Cleanup starts past the hold, but not past the limit', () => {
    const cleanup = { ...task('cleanup', 'none', 9), skipsBusy: true } as const
    const ordered = queueOrder([...queue, cleanup])
    expect(
      startsNow(ordered, { limit: 6, working: 1, byFactory: {}, caps: {}, busy: true }).map(
        (e) => e.id,
      ),
    ).toEqual(['cleanup'])
    expect(
      startsNow(ordered, { limit: 1, working: 1, byFactory: {}, caps: {}, busy: true }),
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
