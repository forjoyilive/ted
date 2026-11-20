import type { Proposal, ProposalLink, ProposalRow } from './task.ts'

export interface ProposalPlanRow {
  row: number
  create: boolean
  blockedBy: number[]
  dropped: number[]
  unlinked: number[]
}

export interface ProposalPlan {
  rows: ProposalPlanRow[]
  creates: number
  unblocked: number[]
  order: number[]
}

export function planProposal(
  proposal: Proposal,
  skip: readonly number[],
  unlink: readonly ProposalLink[] = [],
): ProposalPlan {
  const kept = (row: number) => !skip.includes(row)
  const rows = proposal.rows.map((r, i) => {
    const row = i + 1
    const included = kept(row)
    const removed = (b: number) => unlink.some((l) => l.row === row && l.blocker === b)
    const linked = r.blockedBy.filter((b) => !removed(b))
    return {
      row,
      create: included,
      blockedBy: included ? linked.filter(kept) : [],
      dropped: included ? linked.filter((b) => !kept(b)) : [],
      unlinked: included ? r.blockedBy.filter((b) => removed(b) && kept(b)) : [],
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

export const sharedFileIgnoreList = ['GLOSSARY.md', 'AGENTS.md', 'CLAUDE.md'] as const

export const proposalFilesNote =
  'In `files`, list exact paths, not folders or wildcards; in a Factory with several repos, start each with the repo name. List only files the row will change substantially. Ted links rows that share a file so they run one after another, in row order, and the human can remove a link before approving. `GLOSSARY.md`, `AGENTS.md` and `CLAUDE.md` aren’t compared.'

function compared(path: string, repos: readonly string[]): boolean {
  return !sharedFileIgnoreList.some((name) =>
    repos.length > 1 ? repos.some((repo) => path === `${repo}/${name}`) : path === name,
  )
}

function agentOrder(rows: readonly ProposalRow[]): number[] {
  const order: number[] = []
  const placed = new Set<number>()
  while (order.length < rows.length) {
    const next = rows.findIndex(
      (r, i) => !placed.has(i + 1) && r.blockedBy.every((b) => placed.has(b)),
    )
    if (next === -1) break
    placed.add(next + 1)
    order.push(next + 1)
  }
  return order
}

export function linkSharedFiles(
  rows: readonly ProposalRow[],
  repos: readonly string[],
): ProposalRow[] {
  const blockedBy = rows.map((r) => [...r.blockedBy])
  const added = rows.map((): number[] => [])
  const waitsFor = (row: number, target: number): boolean => {
    const seen = new Set<number>()
    const visit = (r: number): boolean => {
      if (r === target) return true
      if (seen.has(r)) return false
      seen.add(r)
      return (blockedBy[r - 1] ?? []).some(visit)
    }
    return visit(row)
  }
  const order = agentOrder(rows)
  const filesOf = (row: number) =>
    (rows[row - 1]?.files ?? []).filter((path) => compared(path, repos))
  const paths = [...new Set(rows.flatMap((_, i) => filesOf(i + 1)))]
  for (const path of paths) {
    const sharing = order.filter((row) => filesOf(row).includes(path))
    for (const [i, row] of sharing.entries()) {
      const before = sharing[i - 1]
      if (before === undefined || waitsFor(row, before)) continue
      blockedBy[row - 1]?.push(before)
      added[row - 1]?.push(before)
    }
  }
  return rows.map((r, i) => {
    const row = i + 1
    const links = blockedBy[i] ?? []
    const shared = links.flatMap((blocker) => {
      const files = filesOf(row).filter((path) => filesOf(blocker).includes(path))
      return files.length === 0 ? [] : [{ row: blocker, files }]
    })
    return {
      ...r,
      blockedBy: links,
      ...((added[i] ?? []).length > 0 && { addedBlockedBy: added[i] }),
      ...(shared.length > 0 && { sharedFiles: shared }),
    }
  })
}

export function likelyFilesSection(files: readonly string[]): string {
  if (files.length === 0) return ''
  return `## Likely files\n\n${files.map((path) => `- \`${path}\``).join('\n')}`
}
