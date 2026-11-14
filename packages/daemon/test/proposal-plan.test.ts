import { type Proposal, planProposal } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { splitApprovedSummary } from '../src/tasks/split.ts'

const row = (title: string, blockedBy: number[] = []) => ({
  title,
  scope: `${title} scope`,
  priority: 'none' as const,
  blockedBy,
})

const split: Proposal = {
  firstPiece: { id: 't-41', displayId: 'NB-41' },
  rows: [
    row('Local note cache'),
    row('Sync queue with retry', [1]),
    row('Line-level merge', [2]),
    row('Conflict view', [3]),
    row('Offline badge'),
  ],
}

describe('planProposal', () => {
  test('with every row checked, every row is created, row 1 included', () => {
    const plan = planProposal(split, [])
    expect(plan.creates).toBe(5)
    expect(plan.rows.map((r) => [r.row, r.create, r.blockedBy, r.dropped])).toEqual([
      [1, true, [], []],
      [2, true, [1], []],
      [3, true, [2], []],
      [4, true, [3], []],
      [5, true, [], []],
    ])
    expect(plan.unblocked).toEqual([1, 5])
  })

  test('unchecking a row others need drops that blocker and counts one fewer', () => {
    const plan = planProposal(split, [3])
    expect(plan.creates).toBe(4)
    expect(plan.rows[2]).toMatchObject({ row: 3, create: false })
    expect(plan.rows[3]).toMatchObject({ row: 4, create: true, blockedBy: [], dropped: [3] })
    expect(plan.unblocked).toEqual([1, 4, 5])
  })

  test('a dependent does not take on the unchecked row’s own blockers', () => {
    const plan = planProposal(split, [2, 3])
    expect(plan.rows[3]).toMatchObject({ blockedBy: [], dropped: [3] })
    expect(plan.rows[2]).toMatchObject({ create: false, dropped: [] })
  })

  test('row 1 is an ordinary row: unchecking it drops it like any other', () => {
    const plan = planProposal(split, [1])
    expect(plan.rows[0]).toMatchObject({ create: false })
    expect(plan.rows[1]).toMatchObject({ create: true, blockedBy: [], dropped: [1] })
    expect(plan.creates).toBe(4)
  })

  test('creation order puts each blocker before the Tasks it blocks', () => {
    const plan = planProposal({ rows: [row('A', [3]), row('B', [1]), row('C')] }, [])
    expect(plan.order).toEqual([3, 1, 2])
    expect(plan.creates).toBe(3)
  })
})

describe('splitApprovedSummary', () => {
  test('a held approval still tells the next Run which child Tasks exist', () => {
    const summary = splitApprovedSummary(
      {
        tasks: [
          { row: 2, id: 'a', displayId: 'NB-42' },
          { row: 5, id: 'b', displayId: 'NB-43' },
        ],
        skipped: [3, 4],
        startUnblocked: false,
      },
      'Keep it small.',
    )
    expect(summary).toBe(
      'approved the split; TED created NB-42 (row 2), NB-43 (row 5) as child Tasks of this Task, which waits for them to merge; adding: Keep it small.',
    )
  })
})
