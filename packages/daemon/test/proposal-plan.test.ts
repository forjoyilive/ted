import { type Proposal, planProposal } from '@ted/protocol'
import { describe, expect, test } from 'vitest'

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
  test('with every row checked, the first piece is kept and the rest are created', () => {
    const plan = planProposal(split, [])
    expect(plan.creates).toBe(4)
    expect(plan.rows.map((r) => [r.row, r.first, r.create, r.blockedBy, r.dropped])).toEqual([
      [1, true, false, [], []],
      [2, false, true, [1], []],
      [3, false, true, [2], []],
      [4, false, true, [3], []],
      [5, false, true, [], []],
    ])
    expect(plan.unblocked).toEqual([5])
  })

  test('unchecking a row others need drops that blocker and counts one fewer', () => {
    const plan = planProposal(split, [3])
    expect(plan.creates).toBe(3)
    expect(plan.rows[2]).toMatchObject({ row: 3, create: false })
    expect(plan.rows[3]).toMatchObject({ row: 4, create: true, blockedBy: [], dropped: [3] })
    expect(plan.unblocked).toEqual([4, 5])
  })

  test('a dependent does not take on the unchecked row’s own blockers', () => {
    const plan = planProposal(split, [2, 3])
    expect(plan.rows[3]).toMatchObject({ blockedBy: [], dropped: [3] })
    expect(plan.rows[2]).toMatchObject({ create: false, dropped: [] })
  })

  test('the first piece can’t be unchecked', () => {
    expect(planProposal(split, [1]).rows[0]).toMatchObject({ first: true, create: false })
    expect(planProposal(split, [1]).creates).toBe(4)
  })

  test('creation order puts each blocker before the Tasks it blocks', () => {
    const plan = planProposal({ rows: [row('A', [3]), row('B', [1]), row('C')] }, [])
    expect(plan.order).toEqual([3, 1, 2])
    expect(plan.creates).toBe(3)
  })
})
