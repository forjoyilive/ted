import type { Priority, Proposal, ProposalCreated, ProposalLink, ProposalPlan } from '@ted/protocol'
import { likelyFilesSection, planProposal, priorities } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { NewTask, TedStore } from '../store/index.ts'

export function approvedShape(
  proposal: Proposal,
  requested: readonly number[] | undefined,
  unlink: readonly ProposalLink[] = [],
): { skip: number[]; unlinked: ProposalLink[]; shape: ProposalPlan } {
  const skip = [...(requested ?? [])].sort((a, b) => a - b)
  const outside = skip.find((row) => row < 1 || row > proposal.rows.length)
  if (outside !== undefined) throw new RequestError(400, `the proposal has no row ${outside}`)
  const missing = unlink.find((l) => !proposal.rows[l.row - 1]?.blockedBy.includes(l.blocker))
  if (missing !== undefined) {
    throw new RequestError(400, `row ${missing.row} isn’t blocked by row ${missing.blocker}`)
  }
  const shape = planProposal(proposal, skip, unlink)
  if (shape.creates === 0) throw new RequestError(400, 'check at least one row to create')
  const unlinked = shape.rows.flatMap((r) => r.unlinked.map((blocker) => ({ row: r.row, blocker })))
  return { skip, unlinked, shape }
}

export async function createProposalTasks(
  store: Pick<TedStore, 'createTask'>,
  proposal: Proposal,
  shape: ProposalPlan,
  options: {
    parentId?: string
    factoryId: string
    fields: (row: number) => Pick<NewTask, 'lead' | 'splitFrom' | 'plan' | 'coordinatorOperation'>
  },
): Promise<ProposalCreated['tasks']> {
  const ids = new Map<number, string>()
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
      description: [piece.description ?? piece.scope, likelyFilesSection(piece.files ?? [])]
        .filter((part) => part !== '')
        .join('\n\n'),
      priority: piece.priority,
      factoryId: options.factoryId,
      ...options.fields(row),
      blockedBy,
      ...(options.parentId !== undefined && { parentId: options.parentId }),
      startRequested: false,
    })
    ids.set(row, made.id)
    created.push({ row, id: made.id, displayId: made.displayId })
  }
  return created.sort((a, b) => a.row - b.row)
}

export function highestPriority(given: readonly (Priority | undefined)[]): Priority {
  return priorities.find((p) => p !== 'none' && given.includes(p)) ?? 'none'
}
