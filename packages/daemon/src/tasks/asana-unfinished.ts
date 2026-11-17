import {
  type AsanaUnfinishedItem,
  asanaAddChoice,
  asanaCompleteChoice,
  asanaImportable,
  asanaLeaveOpenChoice,
  type Comment,
  maxAsanaImportDepth,
  maxAsanaImportTasks,
} from '@ted/protocol'
import { AsanaReadError } from '../asana/asana.ts'
import { nodeFrom, reasonOf } from '../asana/tree.ts'

export interface SubtreeNode {
  gid: string
  name: string
  url: string
  completed: boolean
  depth: number
  parentGid?: string
  hasChildren: boolean
}

export interface Subtree {
  nodes: SubtreeNode[]
  unreadable: AsanaUnfinishedItem[]
  overLimit: boolean
}

export interface TrackedItem {
  state: 'open' | 'done' | 'archived'
  displayId: string
  childGids: readonly string[]
}

export type ListSubtasks = (
  gid: string,
) => Promise<{ rows: Record<string, unknown>[]; complete: boolean }>

export const maxSubtreeRequests = 40

export async function readSubtree(input: {
  root: { gid: string; name: string; url: string }
  list: ListSubtasks
  spent: () => number
  tracked: (gid: string) => TrackedItem | undefined
}): Promise<Subtree> {
  const nodes: SubtreeNode[] = []
  const unreadable: AsanaUnfinishedItem[] = []
  const seen = new Set([input.root.gid])
  let overLimit = false
  const unread = (node: { gid: string; name: string; url: string }, detail: string) =>
    unreadable.push({
      key: `children:${node.gid}`,
      gid: node.gid,
      name: `Items under ${node.name}`,
      url: node.url,
      reason: 'unreadable',
      detail,
    })
  let level: { gid: string; name: string; url: string; depth: number }[] = [
    { ...input.root, depth: 0 },
  ]
  while (level.length > 0 && !overLimit) {
    const next: SubtreeNode[] = []
    for (const node of level) {
      if (input.spent() >= maxSubtreeRequests) {
        overLimit = true
        break
      }
      let listed: Awaited<ReturnType<ListSubtasks>>
      try {
        listed = await input.list(node.gid)
      } catch (error) {
        if (!(error instanceof AsanaReadError)) throw error
        unread(node, reasonOf(error))
        continue
      }
      const capped = !listed.complete && input.spent() >= maxSubtreeRequests
      if (!listed.complete && !capped) unread(node, 'Asana listed more items than Ted reads')
      for (const row of listed.rows) {
        const parsed = nodeFrom(row, node.depth + 1, node.gid)
        if (!parsed || seen.has(parsed.gid)) continue
        if (parsed.depth > maxAsanaImportDepth || nodes.length >= maxAsanaImportTasks) {
          overLimit = true
          break
        }
        seen.add(parsed.gid)
        const child: SubtreeNode = {
          gid: parsed.gid,
          name: parsed.name,
          url: parsed.url,
          completed: parsed.completed,
          depth: parsed.depth,
          parentGid: node.gid,
          hasChildren: typeof row.num_subtasks !== 'number' || row.num_subtasks > 0,
        }
        nodes.push(child)
        const owner = input.tracked(child.gid)
        if (
          child.hasChildren &&
          (owner === undefined || owner.state === 'archived' || child.completed)
        )
          next.push(child)
      }
      if (capped) overLimit = true
      if (overLimit) break
    }
    level = next
  }
  return { nodes, unreadable, overLimit }
}

export interface UnfinishedPlan {
  waiting: number
  items: AsanaUnfinishedItem[]
}

export function planUnfinished(
  root: { gid: string; name: string; url: string },
  tree: Subtree,
  tracked: (gid: string) => TrackedItem | undefined,
): UnfinishedPlan {
  let waiting = 0
  const items: AsanaUnfinishedItem[] = []
  for (const node of tree.nodes) {
    if (node.completed) continue
    const owner = tracked(node.gid)
    const item = { key: node.gid, gid: node.gid, name: node.name, url: node.url }
    if (owner && owner.state !== 'archived') waiting++
    else if (owner) items.push({ ...item, reason: 'archived', detail: owner.displayId })
    else {
      const parent = node.parentGid === undefined ? undefined : tracked(node.parentGid)
      items.push({ ...item, reason: parent?.childGids.includes(node.gid) ? 'skipped' : 'new' })
    }
  }
  if (tree.overLimit)
    return { waiting, items: [{ key: `limit:${root.gid}`, ...root, reason: 'over-limit' }] }
  return { waiting, items: [...items, ...tree.unreadable] }
}

export type Covered = ReadonlyMap<string, 'complete' | 'leave'>

export function coveredBy(questions: readonly Comment[]): Covered {
  const covered = new Map<string, 'complete' | 'leave'>()
  const answered = questions
    .filter((c) => c.asanaUnfinished && c.answer?.kind === 'answered')
    .sort((a, b) => (a.answer?.at ?? '').localeCompare(b.answer?.at ?? ''))
  for (const question of answered) {
    const choice = question.answer?.kind === 'answered' ? question.answer.choice : undefined
    const decision =
      choice === asanaCompleteChoice
        ? 'complete'
        : choice === asanaLeaveOpenChoice
          ? 'leave'
          : undefined
    if (decision === undefined) continue
    for (const item of question.asanaUnfinished?.items ?? []) covered.set(item.key, decision)
  }
  return covered
}

export type ParentStep =
  | { kind: 'ask'; items: AsanaUnfinishedItem[] }
  | { kind: 'wait'; waiting: number }
  | { kind: 'leave' }
  | { kind: 'complete' }

export function parentStep(plan: UnfinishedPlan, covered: Covered): ParentStep {
  const uncovered = plan.items.filter((item) => !covered.has(item.key))
  if (uncovered.length > 0) return { kind: 'ask', items: uncovered }
  if (plan.waiting > 0) return { kind: 'wait', waiting: plan.waiting }
  if (plan.items.some((item) => covered.get(item.key) === 'leave')) return { kind: 'leave' }
  return { kind: 'complete' }
}

export function stillAsked(open: Comment, items: readonly AsanaUnfinishedItem[]): boolean {
  const asked = new Set(open.asanaUnfinished?.items.map((item) => item.key))
  return items.every((item) => asked.has(item.key))
}

export const unfinishedTitle = 'Items under this Task are still open in Asana'

export function unfinishedChoices(items: readonly AsanaUnfinishedItem[]): string[] {
  return [
    ...(items.some(asanaImportable) ? [asanaAddChoice] : []),
    asanaCompleteChoice,
    asanaLeaveOpenChoice,
  ]
}

function reasonText(item: AsanaUnfinishedItem): string {
  switch (item.reason) {
    case 'new':
      return 'added in Asana after the import'
    case 'skipped':
      return 'Ted didn’t import it'
    case 'archived':
      return `its Task ${item.detail ?? ''} was archived without merging`
    case 'unreadable':
      return item.detail ?? 'Ted couldn’t read it from Asana'
    case 'over-limit':
      return `the items under it go past ${maxAsanaImportTasks} items or ${maxAsanaImportDepth} levels, so Ted couldn’t check them all`
  }
}

export function unfinishedText(items: readonly AsanaUnfinishedItem[]): string {
  const choices = unfinishedChoices(items)
  return [
    'This Task merged, but its Asana task has unfinished items under it that no Ted Task is working on, so Ted hasn’t completed it in Asana.',
    items.map((item) => `- ${item.name}: ${reasonText(item)}. ${item.url}`).join('\n'),
    [
      ...(choices.includes(asanaAddChoice)
        ? [
            `**${asanaAddChoice}** imports the new items as Tasks under this one; each completes its own Asana task when it merges.`,
          ]
        : []),
      `**${asanaCompleteChoice}** completes this Task’s Asana task once no other Ted Task under it is still open.`,
      `**${asanaLeaveOpenChoice}** leaves it open.`,
    ].join(' '),
    'Ted never completes the items under it. If another unfinished item appears, Ted asks again.',
  ].join('\n\n')
}
