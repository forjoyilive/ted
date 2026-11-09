import type { Proposal } from './task.ts'

export interface ProposalPlanRow {
  row: number
  first: boolean
  create: boolean
  blockedBy: number[]
  dropped: number[]
}

export interface ProposalPlan {
  rows: ProposalPlanRow[]
  creates: number
  unblocked: number[]
  order: number[]
}

export function planProposal(proposal: Proposal, skip: readonly number[]): ProposalPlan {
  const first = (row: number) => row === 1 && proposal.firstPiece !== undefined
  const kept = (row: number) => first(row) || !skip.includes(row)
  const rows = proposal.rows.map((r, i) => {
    const row = i + 1
    const included = kept(row)
    return {
      row,
      first: first(row),
      create: included && !first(row),
      blockedBy: included ? r.blockedBy.filter(kept) : [],
      dropped: included ? r.blockedBy.filter((b) => !kept(b)) : [],
    }
  })
  const created = rows.filter((r) => r.create)
  return {
    rows,
    creates: created.length,
    unblocked: created.filter((r) => r.blockedBy.length === 0).map((r) => r.row),
    order: creationOrder(rows),
  }
}

function creationOrder(rows: readonly ProposalPlanRow[]): number[] {
  const order: number[] = []
  const placed = new Set<number>()
  const visit = (row: number, path: Set<number>) => {
    if (placed.has(row) || path.has(row)) return
    const found = rows[row - 1]
    if (!found) return
    path.add(row)
    for (const blocker of found.blockedBy) visit(blocker, path)
    path.delete(row)
    placed.add(row)
    if (found.create) order.push(row)
  }
  for (const r of rows) visit(r.row, new Set())
  return order
}

export function proposalCycle(blockedBy: readonly (readonly number[])[]): number[] | undefined {
  const state = new Map<number, 'visiting' | 'done'>()
  const stack: number[] = []
  const visit = (row: number): number[] | undefined => {
    if (state.get(row) === 'done') return undefined
    if (state.get(row) === 'visiting') return [...stack.slice(stack.indexOf(row)), row]
    state.set(row, 'visiting')
    stack.push(row)
    for (const next of blockedBy[row - 1] ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(row, 'done')
    return undefined
  }
  for (let row = 1; row <= blockedBy.length; row++) {
    const cycle = visit(row)
    if (cycle) return cycle
  }
  return undefined
}
