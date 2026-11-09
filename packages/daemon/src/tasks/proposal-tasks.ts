import type { Proposal, ProposalCreated, ProposalPlan } from '@ted/protocol'
import { planProposal } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { NewTask, TedStore } from '../store/index.ts'

export function approvedShape(
  proposal: Proposal,
  requested: readonly number[] | undefined,
  firstPiece: { name: string } | undefined,
): { skip: number[]; shape: ProposalPlan } {
  const skip = [...(requested ?? [])].sort((a, b) => a - b)
  const outside = skip.find((row) => row < 1 || row > proposal.rows.length)
  if (outside !== undefined) throw new RequestError(400, `the proposal has no row ${outside}`)
  if (firstPiece && skip.includes(1)) {
    throw new RequestError(400, `row 1 is ${firstPiece.name}, so it’s always kept`)
  }
  const shape = planProposal(proposal, skip)
  if (shape.creates === 0) throw new RequestError(400, 'check at least one row to create')
  return { skip, shape }
}

export async function createProposalTasks(
  store: Pick<TedStore, 'createTask'>,
  proposal: Proposal,
  shape: ProposalPlan,
  options: {
    firstPieceId: string | undefined
    factoryId: string
    fields: (row: number) => Pick<NewTask, 'lead' | 'splitFrom' | 'plan'>
  },
): Promise<ProposalCreated['tasks']> {
  const ids = new Map<number, string>()
  if (options.firstPieceId !== undefined) ids.set(1, options.firstPieceId)
  const created: ProposalCreated['tasks'] = []
  for (const row of shape.order) {
    const planned = shape.rows[row - 1]
    const piece = proposal.rows[row - 1]
    if (!planned || !piece) continue
    const blockedBy = planned.blockedBy.flatMap((b) => {
      const id = ids.get(b)
      return id === undefined ? [] : [id]
    })
    const made = await store.createTask({
      title: piece.title,
      description: piece.description ?? piece.scope,
      priority: piece.priority,
      factoryId: options.factoryId,
      ...options.fields(row),
      blockedBy,
      startRequested: blockedBy.length > 0,
    })
    ids.set(row, made.id)
    created.push({ row, id: made.id, displayId: made.displayId })
  }
  return created.sort((a, b) => a.row - b.row)
}
