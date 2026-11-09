import type { Plan, PlanRequest } from '@ted/protocol'
import { planTitle } from '@ted/protocol/plan'
import { describe, expect, test } from 'vitest'
import {
  chatActivity,
  inboxLabel,
  planDetailLine,
  planGroups,
  planStatusChip,
  plansFailedByFactory,
  planTasksLabel,
  requestState,
  startedDay,
} from '../src/renderer/plans.ts'

const round: PlanRequest = {
  id: 'r1',
  planId: 'p1',
  runId: 'p1',
  kind: 'round',
  author: 'run',
  title: 'Who can share',
  body: '',
  round: {
    number: 2,
    questions: [
      { question: 'A?', recommended: 'a' },
      { question: 'B?', recommended: 'b' },
      { question: 'C?', recommended: 'c' },
    ],
  },
  createdAt: '2026-11-10T10:05:00.000Z',
}

describe('planning chat text', () => {
  test('a chat is named after the first line of the first message, cut at 60 characters', () => {
    expect(planTitle('\n  Shared notebooks   with comments\nmore')).toBe(
      'Shared notebooks with comments',
    )
    expect(planTitle('x'.repeat(80))).toHaveLength(60)
  })

  test('Inbox rows read Plan · Round 2 · 3 questions and Plan · Proposal · 5 Tasks', () => {
    expect(inboxLabel(round)).toBe('Plan · Round 2 · 3 questions')
    const rows = Array.from({ length: 5 }, (_, i) => ({
      title: `T${i}`,
      scope: 's',
      priority: 'none' as const,
      blockedBy: [],
    }))
    expect(inboxLabel({ ...round, kind: 'proposal', proposal: { rows } })).toBe(
      'Plan · Proposal · 5 Tasks',
    )
  })

  test('the open request is pinned below; a replaced proposal reads Superseded', () => {
    expect(requestState(round, false)).toBe('pinned below')
    const changed: PlanRequest = {
      ...round,
      kind: 'proposal',
      answer: { kind: 'changes-requested', at: round.createdAt, text: 'Split it' },
    }
    expect(requestState(changed, false)).toBe('Superseded')
    expect(requestState(changed, true)).toBe('changes requested')
  })

  test('a queued chat shows its place in line', () => {
    expect(planStatusChip({ status: 'queued', queuePlace: 2 }).label).toBe('Queued · 2nd')
    expect(planStatusChip({ status: 'waiting' }).label).toBe('Waiting on you')
  })
})

const plan = (fields: Partial<Plan>): Plan => ({
  id: 'p',
  factoryId: 'f1',
  factoryKey: 'NB',
  title: 'Plan',
  message: 'Plan',
  agent: 'claude',
  status: 'idle',
  createdAt: '2026-11-10T10:05:00.000Z',
  createdTasks: 0,
  ...fields,
})

describe('Plans list', () => {
  test('open chats come first, newest first, and finished or stopped ones are past', () => {
    const groups = planGroups([
      plan({ id: 'a', status: 'finished', createdAt: '2026-11-01T10:00:00.000Z' }),
      plan({ id: 'b', status: 'failed', createdAt: '2026-11-02T10:00:00.000Z' }),
      plan({ id: 'c', status: 'waiting', createdAt: '2026-11-03T10:00:00.000Z' }),
      plan({ id: 'd', status: 'stopped', createdAt: '2026-11-04T10:00:00.000Z' }),
    ])
    expect(groups.open.map((p) => p.id)).toEqual(['c', 'b'])
    expect(groups.past.map((p) => p.id)).toEqual(['d', 'a'])
  })

  test('the Tasks column says what a chat proposed or created', () => {
    expect(planTasksLabel(plan({ status: 'waiting', proposedTasks: 5 }))).toBe('5 proposed')
    expect(planTasksLabel(plan({ status: 'finished', createdTasks: 2 }))).toBe('Created 2 Tasks')
    expect(planTasksLabel(plan({ status: 'finished', createdTasks: 1 }))).toBe('Created 1 Task')
    expect(planTasksLabel(plan({ status: 'stopped', proposedTasks: 3 }))).toBe('No Tasks')
    expect(planTasksLabel(plan({ status: 'working' }))).toBe('—')
    expect(planTasksLabel(plan({ status: 'failed' }))).toBe('—')
  })

  test('the status detail says what the chat waits on', () => {
    expect(planDetailLine(plan({ status: 'waiting', waitingOn: 'Round 2 · 3 questions' }))).toBe(
      'Round 2 · 3 questions',
    )
    expect(planDetailLine(plan({ status: 'idle' }))).toBe('Your turn to write')
    expect(planDetailLine(plan({ status: 'finished' }))).toBeUndefined()
  })

  test('a working chat shows what the planner last did', () => {
    expect(
      chatActivity([
        { kind: 'agent', id: '1', text: 'Thinking' },
        { kind: 'tool', id: '2', tool: 'Read', title: 'Reading src/export', status: 'done' },
      ]),
    ).toBe('Reading src/export')
    expect(chatActivity([{ kind: 'agent', id: '1', text: '\nLooking at the repo\nmore' }])).toBe(
      'Looking at the repo',
    )
    expect(chatActivity([])).toBeUndefined()
  })

  test('Started shows the day', () => {
    expect(startedDay('2026-11-10T10:05:00.000Z')).toMatch(/^Tue 10 Nov$/)
  })

  test('a failed chat marks its Factory for the Plans red dot', () => {
    expect(
      plansFailedByFactory([
        plan({ factoryId: 'f1', status: 'failed' }),
        plan({ factoryId: 'f2', status: 'finished' }),
      ]),
    ).toEqual(new Set(['f1']))
  })
})
