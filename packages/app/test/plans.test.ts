import type { PlanRequest } from '@ted/protocol'
import { planTitle } from '@ted/protocol/plan'
import { describe, expect, test } from 'vitest'
import { inboxLabel, planStatusChip, requestState } from '../src/renderer/plans.ts'

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
