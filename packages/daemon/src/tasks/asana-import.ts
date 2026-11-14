import {
  type AsanaImportPreview,
  type AsanaImportRow,
  type AsanaMissing,
  maxAsanaImportTasks,
  type Task,
  type TaskAsanaSource,
} from '@ted/protocol'
import type { AsanaNode, AsanaTree } from '../asana/tree.ts'
import { clashMessage, sourceClash } from './sources.ts'

export type ParentRef = { gid: string } | { taskId: string }

export interface PlannedCreate {
  node: AsanaNode
  parent?: ParentRef
}

export interface AsanaPlan {
  preview: AsanaImportPreview
  creates: PlannedCreate[]
  links: { taskId: string; parent: ParentRef }[]
  holds: { parent: ParentRef; items: AsanaMissing['items'] }[]
}

export function asanaTaskUrl(gid: string): string {
  return `https://app.asana.com/0/0/${gid}/f`
}

export function planAsanaImport(input: {
  tree: AsanaTree
  tasks: readonly Task[]
  factoryId: string
  userGid: string | undefined
  app: boolean
  parentRefusal: (taskId: string) => string | undefined
  blockersOf: (taskId: string) => readonly string[]
  doneParent?: string
}): AsanaPlan {
  const { tree, tasks, factoryId } = input
  const root = tree.nodes.get(tree.rootGid)
  if (!root) throw new Error('the Asana tree has no root')
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const clashOf = (gid: string) => sourceClash(tasks, factoryId, asanaTaskUrl(gid))
  const rows: AsanaImportRow[] = []
  const creates: PlannedCreate[] = []
  const links: AsanaPlan['links'] = []
  const holds = new Map<string, { parent: ParentRef; items: AsanaMissing['items'] }>()
  const adopting = new Set<string>()
  const refKey = (ref: ParentRef) => ('gid' in ref ? `gid:${ref.gid}` : `task:${ref.taskId}`)
  const planned = new Map<string, string[]>()
  const plan = (parent: ParentRef, child: string) =>
    planned.set(refKey(parent), [...(planned.get(refKey(parent)) ?? []), child])
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>()
    const walk = (key: string): boolean => {
      if (key === target) return true
      if (seen.has(key)) return false
      seen.add(key)
      const existing = key.startsWith('task:')
        ? input.blockersOf(key.slice('task:'.length)).map((id) => `task:${id}`)
        : []
      return [...(planned.get(key) ?? []), ...existing].some(walk)
    }
    return walk(from)
  }
  const hold = (parent: ParentRef, item: AsanaMissing['items'][number]) => {
    const key = refKey(parent)
    const entry = holds.get(key) ?? { parent, items: [] }
    entry.items.push(item)
    holds.set(key, entry)
  }
  const person = (node: AsanaNode) =>
    node.assignee && {
      name: node.assignee.name,
      you: input.userGid !== undefined && node.assignee.gid === input.userGid,
    }
  const row = (node: AsanaNode, action: AsanaImportRow['action']): AsanaImportRow => {
    const assignee = person(node)
    const problems = problemsOf(node)
    return {
      gid: node.gid,
      name: node.name,
      url: node.url,
      depth: node.depth,
      ...(node.parentGid !== undefined && { parentGid: node.parentGid }),
      ...(assignee && { assignee }),
      completed: node.completed,
      action,
      ...(problems.length > 0 && { problems }),
    }
  }
  let refusal: string | undefined
  let tracked: AsanaImportPreview['tracked']
  const rootClash = clashOf(root.gid)
  let rootRef: ParentRef = { gid: root.gid }
  if (
    rootClash?.kind === 'open' ||
    (rootClash?.kind === 'done' && rootClash.task.id === input.doneParent)
  ) {
    tracked = {
      taskId: rootClash.task.id,
      displayId: rootClash.task.displayId,
      stage: rootClash.task.stage,
    }
    rootRef = { taskId: rootClash.task.id }
    rows.push(
      row(root, { kind: 'kept', taskId: rootClash.task.id, displayId: rootClash.task.displayId }),
    )
    if (!input.app) refusal = clashMessage(rootClash)
  } else {
    if (rootClash && !input.app) refusal = clashMessage(rootClash)
    rows.push(row(root, { kind: 'new' }))
    creates.push({ node: root })
  }
  const listFailed = (node: AsanaNode, at: ParentRef) => {
    if (node.childrenUnreadable === undefined || node.unreadable !== undefined) return
    hold(at, {
      gid: node.gid,
      name: `Subtasks of ${node.name}`,
      url: node.url,
      reason: node.childrenUnreadable,
    })
  }
  listFailed(root, rootRef)
  const adopt = (taskId: string) => adopting.add(taskId)

  const visit = (node: AsanaNode, anchor: ParentRef) => {
    const anchorTask = 'taskId' in anchor ? anchor.taskId : undefined
    const clash = clashOf(node.gid)
    let childAnchor = anchor
    if (clash?.kind === 'open') {
      const task = clash.task
      const ref = { taskId: task.id, displayId: task.displayId }
      if (anchorTask !== undefined && task.parentId === anchorTask) {
        rows.push(row(node, { kind: 'kept', ...ref }))
        childAnchor = { taskId: task.id }
      } else if (task.parentId === undefined && !cycles(task.id, anchor)) {
        rows.push(row(node, { kind: 'linked', ...ref }))
        links.push({ taskId: task.id, parent: anchor })
        plan(anchor, `task:${task.id}`)
        if (anchorTask !== undefined) adopt(anchorTask)
        childAnchor = { taskId: task.id }
      } else {
        const parent = task.parentId === undefined ? undefined : byId.get(task.parentId)
        const parentDisplayId = parent?.displayId ?? 'another Task'
        rows.push(row(node, { kind: 'conflict', ...ref, parentDisplayId }))
        hold(anchor, {
          gid: node.gid,
          name: node.name,
          url: node.url,
          reason:
            task.parentId === undefined
              ? `it’s already ${task.displayId}, which can’t go under this Task without a loop`
              : `it’s already ${task.displayId}, under ${parentDisplayId}; TED left it there`,
        })
        childAnchor = { taskId: task.id }
      }
    } else if (clash?.kind === 'done') {
      rows.push(row(node, { kind: 'done', taskId: clash.task.id, displayId: clash.task.displayId }))
    } else if (clash?.kind === 'archived') {
      rows.push(
        row(node, { kind: 'archived', taskId: clash.task.id, displayId: clash.task.displayId }),
      )
    } else if (node.unreadable !== undefined) {
      rows.push(row(node, { kind: 'unreadable', reason: node.unreadable }))
      hold(anchor, { gid: node.gid, name: node.name, url: node.url, reason: node.unreadable })
    } else if (node.completed) {
      rows.push(row(node, { kind: 'complete' }))
    } else {
      rows.push(row(node, { kind: 'new' }))
      creates.push({ node, parent: anchor })
      plan(anchor, `gid:${node.gid}`)
      if (anchorTask !== undefined) adopt(anchorTask)
      childAnchor = { gid: node.gid }
    }
    listFailed(node, childAnchor)
    for (const gid of node.children) {
      const child = tree.nodes.get(gid)
      if (child) visit(child, childAnchor)
    }
  }
  const cycles = (taskId: string, anchor: ParentRef) => reaches(`task:${taskId}`, refKey(anchor))
  for (const gid of root.children) {
    const child = tree.nodes.get(gid)
    if (child) visit(child, rootRef)
  }
  for (const taskId of adopting) {
    const why = input.parentRefusal(taskId)
    if (why !== undefined && refusal === undefined) refusal = why
  }
  if (tree.tooBig !== undefined) refusal = tree.tooBig
  else if (creates.length > maxAsanaImportTasks)
    refusal = `This import would create ${creates.length} Tasks. TED imports at most ${maxAsanaImportTasks} at a time.`
  const ownership = { you: 0, others: 0, unassigned: 0 }
  for (const { node } of creates) {
    const who = person(node)
    if (!who) ownership.unassigned++
    else if (who.you) ownership.you++
    else ownership.others++
  }
  const held = [...holds.values()].filter(
    (h) => !('taskId' in h.parent && h.parent.taskId === input.doneParent),
  )
  return {
    preview: {
      root: { gid: root.gid, name: root.name, url: root.url, completed: root.completed },
      rows,
      create: creates.length,
      ownership,
      ...(tracked && { tracked }),
      ...(refusal !== undefined && { refusal }),
      missing: held.reduce((sum, h) => sum + h.items.length, 0),
    },
    creates,
    links,
    holds: held,
  }
}

function problemsOf(node: AsanaNode): string[] {
  const problems: string[] = [...(node.partial ?? []).map((line) => `${line}.`)]
  if (node.cut) problems.push('TED copies only the start of a very long description or comment.')
  if (node.commentsWarning !== undefined) problems.push(node.commentsWarning)
  const missing = node.unfetched?.length ?? 0
  if (missing > 0) {
    const total = missing + (node.files?.length ?? 0)
    problems.push(
      `TED could fetch ${total - missing} of ${total} files. The other ${missing === 1 ? 'one stays' : `${missing} stay`} as links in a TED note.`,
    )
  }
  return problems
}

export function asanaSource(
  node: AsanaNode,
  tree: AsanaTree,
  userGid: string | undefined,
  importedAt: string,
): TaskAsanaSource {
  const children = node.children.flatMap((gid) => {
    const child = tree.nodes.get(gid)
    return child ? [{ gid, name: child.name, url: child.url, completed: child.completed }] : []
  })
  const assignee = node.assignee && {
    name: node.assignee.name,
    you: userGid !== undefined && node.assignee.gid === userGid,
  }
  const context = [
    `Title: ${node.name}`,
    `Assigned in Asana to: ${assignee ? assignee.name : 'nobody'}`,
    ...(node.completed ? ['Complete in Asana: yes'] : []),
    '',
    node.notes?.trim() || '(no description)',
    ...(children.length > 0
      ? [
          '',
          'Subtasks in Asana:',
          ...children.map(
            (child) => `- ${child.name}${child.completed ? ' (complete)' : ''}: ${child.url}`,
          ),
        ]
      : []),
    ...(node.comments && node.comments.length > 0
      ? [
          '',
          'Comments copied from Asana:',
          ...node.comments.flatMap((comment) => [
            '',
            `${comment.author}, ${comment.at}:`,
            comment.text,
          ]),
        ]
      : []),
  ].join('\n')
  return {
    gid: node.gid,
    title: node.name,
    ...(assignee && { assignee }),
    completed: node.completed,
    importedAt,
    context,
    children,
  }
}

export function asanaNotes(node: AsanaNode): string[] {
  const notes: string[] = (node.partial ?? []).map(
    (line) => `${line}. Read them in Asana: ${node.url}`,
  )
  if (node.cut) {
    notes.push(
      `This item’s description or a comment was longer than TED copies, so the Task has only the start of it. Read the rest in Asana: ${node.url}`,
    )
  }
  if (node.commentsWarning !== undefined) {
    notes.push(`${node.commentsWarning}\n\nRead the full discussion in Asana: ${node.url}`)
  }
  const missing = node.unfetched ?? []
  if (missing.length > 0) {
    notes.push(
      [
        `TED couldn’t fetch ${missing.length} ${missing.length === 1 ? 'file' : 'files'} from Asana. Their links:`,
        ...missing.map((file) => `- ${file.name}: ${file.reason}. ${file.url}`),
      ].join('\n'),
    )
  }
  return notes
}

export const asanaRetryChoice = 'Retry'
export const asanaGoAheadChoice = 'Go ahead without them'
export const missingWorkTitle = 'Some work under this Task didn’t come across from Asana'

export function missingWorkText(items: AsanaMissing['items']): string {
  return [
    'This Task won’t start until you choose.',
    items.map((item) => `- ${item.name}: ${item.reason}. ${item.url}`).join('\n'),
    `**${asanaRetryChoice}** reads Asana again and adds what it can. **${asanaGoAheadChoice}** lets this Task start; its Task Lead is told these items aren’t its work.`,
  ].join('\n\n')
}

export function goAheadText(items: AsanaMissing['items']): string {
  return [
    'The user chose to go ahead without these Asana items. They aren’t this Task’s work:',
    items.map((item) => `- ${item.name}: ${item.url}`).join('\n'),
  ].join('\n\n')
}
