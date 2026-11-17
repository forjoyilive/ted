import type { Proposal } from '@ted/protocol'
import type { ProposalPlanRow } from '@ted/protocol/proposal'

export function rowList(rows: readonly number[]): string {
  if (rows.length <= 1) return rows.join('')
  return `${rows.slice(0, -1).join(', ')} and ${rows.at(-1)}`
}

export function blockedByText(rows: readonly number[]): string {
  return rows.length === 0 ? '—' : `blocked by ${rows.join(', ')}`
}

export function wouldStart(rows: readonly number[]): string {
  if (rows.length === 0) return '(none would start)'
  return `(${rows.length === 1 ? 'row' : 'rows'} ${rowList(rows)} would start)`
}

export function droppedWarning(row: ProposalPlanRow): string | undefined {
  if (row.dropped.length === 0) return undefined
  const rows = rowList(row.dropped)
  return `Blocked by ${row.dropped.length === 1 ? 'row' : 'rows'} ${rows}, which won’t be created. ${
    row.blockedBy.length === 0
      ? 'This Task will have no blocker.'
      : `It stays blocked by ${row.blockedBy.length === 1 ? 'row' : 'rows'} ${rowList(row.blockedBy)}.`
  }`
}

export function createLabel(count: number): string {
  return `Create ${count} ${count === 1 ? 'Task' : 'Tasks'}`
}

export function parentLine(proposal: Proposal): string {
  return proposal.firstPiece
    ? `${proposal.firstPiece.displayId} becomes the parent of these Tasks and runs after they merge.`
    : 'Ted creates a parent Task for these Tasks. It runs after they merge.'
}
