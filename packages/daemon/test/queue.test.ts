import type { Priority } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { queueOrder, startsNow } from '../src/tasks/queue.ts'

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

test('Coordinator turns share the Planning tier and respect Factory caps', () => {
  const ordered = queueOrder([
    { id: 'plan', kind: 'planning', rank: 2, factoryId: 'nb' },
    { id: 'coordinator', kind: 'coordinator', rank: 1, factoryId: 'nb' },
    { id: 'auto', kind: 'automation', rank: 0, factoryId: 'other' },
  ])
  expect(ordered.map((e) => e.id)).toEqual(['coordinator', 'plan', 'auto'])
  expect(
    startsNow(ordered, { limit: 3, working: 0, byFactory: {}, caps: { nb: 1 } }).map((e) => e.id),
  ).toEqual(['coordinator', 'auto'])
})
