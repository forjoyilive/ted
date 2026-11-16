import type { AutomationRequest, Comment, Factory, FactoryLayout, InboxItem } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { factoryScope } from '../src/renderer/factory-layout.ts'
import {
  type Grouped,
  groupInbox,
  inboxChips,
  inFactory,
  nextSelection,
  requestKind,
  waitingByFactory,
} from '../src/renderer/inbox.ts'

const item = (id: string, factoryId = 'nb') =>
  ({ request: { id }, task: { id: `t-${id}`, factoryId } }) as unknown as InboxItem

const factories = [
  { id: 'nb', name: 'Notebook' },
  { id: 'ms', name: 'Marketing site' },
] as Factory[]

describe('Inbox chips', () => {
  test('All counts every waiting request, then one chip per Factory with its count', () => {
    const items = [item('a'), item('b', 'ms'), item('c')]
    expect(inboxChips(items, factories)).toEqual([
      { label: 'All', count: 3 },
      { factoryId: 'nb', label: 'Notebook', count: 2 },
      { factoryId: 'ms', label: 'Marketing site', count: 1 },
    ])
    expect(inFactory(items, (id) => id === 'ms').map((i) => i.request.id)).toEqual(['b'])
    expect(inFactory(items, undefined)).toBe(items)
  })

  test('each Factory group gets a chip before the Factories, counting its Factories’ requests', () => {
    const three = [...factories, { id: 'docs', name: 'Docs' }] as Factory[]
    const layout: FactoryLayout = {
      items: [
        { factoryId: 'nb' },
        { group: { id: 'g1', name: 'Clients', factoryIds: ['ms', 'docs'] } },
      ],
    }
    const items = [item('a'), item('b', 'ms'), item('c', 'docs')]
    const questions = [{ id: 'q', factoryId: 'docs' }] as unknown as AutomationRequest[]
    expect(inboxChips(items, three, questions, [], layout)).toEqual([
      { label: 'All', count: 4 },
      { groupId: 'g1', label: 'Clients', count: 3 },
      { factoryId: 'nb', label: 'Notebook', count: 1 },
      { factoryId: 'ms', label: 'Marketing site', count: 1 },
      { factoryId: 'docs', label: 'Docs', count: 2 },
    ])
    const inClients = factoryScope(layout, { groupId: 'g1' })
    expect(inFactory(items, inClients).map((i) => i.request.id)).toEqual(['b', 'c'])
  })
})

describe('Automation questions', () => {
  test('count in All and in their Factory’s chip', () => {
    const questions = [{ id: 'q', factoryId: 'ms' }] as unknown as AutomationRequest[]
    expect(inboxChips([item('a')], factories, questions)).toEqual([
      { label: 'All', count: 2 },
      { factoryId: 'nb', label: 'Notebook', count: 1 },
      { factoryId: 'ms', label: 'Marketing site', count: 1 },
    ])
    expect(waitingByFactory([item('a')], questions)).toEqual({ nb: 1, ms: 1 })
  })
})

describe('after answering', () => {
  const before = [item('a'), item('b'), item('c')]

  test('the selection moves to the next row', () => {
    expect(nextSelection(before, [item('a'), item('c')], 'b')?.request.id).toBe('c')
  })

  test('the last row moves the selection up; an empty Inbox selects nothing', () => {
    expect(nextSelection(before, [item('a'), item('b')], 'c')?.request.id).toBe('b')
    expect(nextSelection(before, [], 'c')).toBeNull()
  })

  test('a newly waiting request is selected when none of the old neighbors remains', () => {
    expect(nextSelection(before, [item('new')], 'b')?.request.id).toBe('new')
  })

  test('selection includes Automation questions and planning requests in row order', () => {
    const plan = { request: { id: 'plan' } }
    const task = { request: { id: 'task' } }
    const question = { request: { id: 'automation' } }
    expect(nextSelection([plan, task, question], [plan, question], 'task')).toBe(question)
    expect(nextSelection([plan, question], [plan], 'automation')).toBe(plan)
    expect(nextSelection([question], [], 'automation')).toBeNull()
  })

  test('nothing moves while the selected request is still waiting, or when nothing was selected', () => {
    expect(nextSelection(before, before, 'b')).toBeUndefined()
    expect(nextSelection(before, [item('a')], undefined)).toBeUndefined()
    expect(nextSelection(before, [item('a')], 'elsewhere')).toBeUndefined()
  })
})

describe('Group by', () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime()
  const at = (daysAgo: number, hour: number) =>
    new Date(2026, 10, 12 - daysAgo, hour, 0).toISOString()
  const row = (id: string, grouped: Partial<Grouped>) => ({
    id,
    grouped: { kind: 'question', at: at(0, 9), ...grouped } satisfies Grouped,
  })
  const shape = (groups: ReturnType<typeof groupInbox<ReturnType<typeof row>>>) =>
    groups.map((group) => [group.label, group.rows.map((r) => r.id)])

  test('None keeps the rows as one unnamed group, and an empty Inbox has no group', () => {
    const rows = [row('a', {}), row('b', { kind: 'signoff' })]
    expect(shape(groupInbox(rows, 'none', now))).toEqual([['', ['a', 'b']]])
    expect(groupInbox([], 'none', now)).toEqual([])
    expect(groupInbox([], 'kind', now)).toEqual([])
  })

  test('a request’s kind comes from what it asks for', () => {
    const kind = (request: Partial<Comment>) => requestKind({ kind: 'question', ...request })
    expect(kind({ kind: 'permission' })).toBe('blocking')
    expect(kind({ kind: 'permission', purpose: { kind: 'simulator' } })).toBe('blocking')
    expect(kind({ failed: { runId: 'r1' } })).toBe('blocking')
    expect(kind({ purpose: { kind: 'failure' } })).toBe('blocking')
    expect(kind({ purpose: { kind: 'failed-run' } })).toBe('blocking')
    expect(kind({ kind: 'signoff' })).toBe('signoff')
    expect(kind({ kind: 'review' })).toBe('signoff')
    expect(kind({ purpose: { kind: 'gate' } })).toBe('signoff')
    for (const purpose of ['question', 'round', 'proposal', 'size-check', 'linear-team'] as const) {
      expect(kind({ purpose: { kind: purpose } })).toBe('question')
    }
    expect(kind({ kind: 'round' })).toBe('question')
    expect(kind({ kind: 'proposal' })).toBe('question')
  })

  test('Kind puts Blocking a Run first, keeps each group’s order and hides empty headings', () => {
    const rows = [
      row('q1', {}),
      row('s1', { kind: 'signoff' }),
      row('b1', { kind: 'blocking' }),
      row('q2', {}),
    ]
    expect(shape(groupInbox(rows, 'kind', now))).toEqual([
      ['Blocking a Run', ['b1']],
      ['Questions', ['q1', 'q2']],
      ['Sign-Offs', ['s1']],
    ])
    expect(shape(groupInbox([row('s1', { kind: 'signoff' })], 'kind', now))).toEqual([
      ['Sign-Offs', ['s1']],
    ])
  })

  test('Age splits at the start of today and six days before it, and marks only Older', () => {
    const rows = [
      row('midnight', { at: at(0, 0) }),
      row('yesterday', { at: at(1, 23) }),
      row('six', { at: at(6, 0) }),
      row('seven', { at: at(7, 23) }),
    ]
    const groups = groupInbox(rows, 'age', now)
    expect(shape(groups)).toEqual([
      ['Today', ['midnight']],
      ['Earlier this week', ['yesterday', 'six']],
      ['Older', ['seven']],
    ])
    expect(groups.map((group) => group.old)).toEqual([undefined, undefined, true])
  })

  test('Descending reverses the groups but keeps No Stage last; Oldest first reverses the rows', () => {
    const rows = [
      row('plan', {}),
      row('review', { stage: 'review' }),
      row('clarify2', { stage: 'clarify' }),
      row('clarify1', { stage: 'clarify' }),
    ]
    expect(
      shape(groupInbox(rows, 'stage', now, { groupsReversed: true, oldestFirst: false })),
    ).toEqual([
      ['Review', ['review']],
      ['Clarify', ['clarify2', 'clarify1']],
      ['No Stage', ['plan']],
    ])
    expect(
      shape(groupInbox(rows, 'stage', now, { groupsReversed: false, oldestFirst: true })),
    ).toEqual([
      ['Clarify', ['clarify1', 'clarify2']],
      ['Review', ['review']],
      ['No Stage', ['plan']],
    ])
    expect(
      shape(groupInbox(rows, 'kind', now, { groupsReversed: true, oldestFirst: true })),
    ).toEqual([['Questions', ['clarify1', 'clarify2', 'review', 'plan']]])
    expect(
      shape(groupInbox(rows, 'none', now, { groupsReversed: true, oldestFirst: true })),
    ).toEqual([['', ['clarify1', 'clarify2', 'review', 'plan']]])
  })

  test('Stage follows the Workflow’s order and puts requests without a Stage last', () => {
    const rows = [
      row('plan', {}),
      row('review', { stage: 'review' }),
      row('clarify', { stage: 'clarify' }),
      row('work', { stage: 'work' }),
    ]
    expect(shape(groupInbox(rows, 'stage', now))).toEqual([
      ['Clarify', ['clarify']],
      ['Work', ['work']],
      ['Review', ['review']],
      ['No Stage', ['plan']],
    ])
  })

  test('Factory group follows the layout order, then No group', () => {
    const layout: FactoryLayout = {
      items: [
        { group: { id: 'g2', name: 'Internal', factoryIds: ['nb'] } },
        { factoryId: 'other' },
        { group: { id: 'g1', name: 'Clients', factoryIds: ['ms'] } },
        { group: { id: 'g3', name: 'Empty', factoryIds: [] } },
      ],
    }
    const rows = [
      row('loose', { factoryId: 'other' }),
      row('client', { factoryId: 'ms' }),
      row('own', { factoryId: 'nb' }),
    ]
    expect(shape(groupInbox(rows, 'factory-group', now, undefined, layout))).toEqual([
      ['Internal', ['own']],
      ['Clients', ['client']],
      ['No Factory group', ['loose']],
    ])
    expect(
      shape(
        groupInbox(
          rows,
          'factory-group',
          now,
          { groupsReversed: true, oldestFirst: false },
          layout,
        ),
      ),
    ).toEqual([
      ['Clients', ['client']],
      ['Internal', ['own']],
      ['No Factory group', ['loose']],
    ])
  })

  test('Priority goes from Urgent to No priority and puts requests without a Task last', () => {
    const rows = [
      row('plan', {}),
      row('low', { priority: 'low' }),
      row('none', { priority: 'none' }),
      row('urgent1', { priority: 'urgent' }),
      row('medium', { priority: 'medium' }),
      row('urgent2', { priority: 'urgent' }),
    ]
    expect(shape(groupInbox(rows, 'priority', now))).toEqual([
      ['Urgent', ['urgent1', 'urgent2']],
      ['Medium', ['medium']],
      ['Low', ['low']],
      ['No Priority', ['none']],
      ['Not from a Task', ['plan']],
    ])
  })
})
