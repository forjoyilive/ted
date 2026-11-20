import type { Proposal, ProposalLink, ProposalRow } from '@ted/protocol'
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

export function linkReason(row: ProposalRow, blocker: number): string {
  const shared = row.sharedFiles?.find((s) => s.row === blocker)?.files ?? []
  const why = shared.length === 0 ? 'Set by the agent' : `Both change ${shared.join(', ')}`
  return row.addedBlockedBy?.includes(blocker) ? `${why} (added by Ted)` : why
}

export interface TedLink extends ProposalLink {
  files: string[]
}

export function tedLinks(proposal: Proposal, skip: readonly number[]): TedLink[] {
  return proposal.rows.flatMap((r, i) => {
    const row = i + 1
    if (skip.includes(row)) return []
    return (r.addedBlockedBy ?? [])
      .filter((blocker) => !skip.includes(blocker))
      .map((blocker) => ({
        row,
        blocker,
        files: r.sharedFiles?.find((s) => s.row === blocker)?.files ?? [],
      }))
  })
}

export function tedLinksIntro(editable: boolean): string {
  const said = 'Ted linked rows that change the same file, so they run one after another.'
  return editable ? `${said} Remove a link with × if the two can run side by side.` : said
}

export function tedLinkLead(link: ProposalLink): string {
  return `Row ${link.row} after row ${link.blocker}: both change `
}

export function hasLink(links: readonly ProposalLink[], row: number, blocker: number): boolean {
  return links.some((l) => l.row === row && l.blocker === blocker)
}
