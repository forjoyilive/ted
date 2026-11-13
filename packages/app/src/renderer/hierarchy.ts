import type { Task } from '@ted/protocol'

export const newChildTaskEvent = 'ted:new-child-task'
export const pickParentEvent = 'ted:pick-parent'
export const pickChildEvent = 'ted:pick-child'

export function newChildTask(parent: Task): void {
  window.dispatchEvent(
    new CustomEvent(newChildTaskEvent, {
      detail: { parentId: parent.id, factoryId: parent.factoryId },
    }),
  )
}

export interface TreeNode {
  task: Task
  children: TreeNode[]
}

export interface ChildProgress {
  merged: number
  total: number
  holding: Task[]
  archived: Task[]
}

function byId(tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id, t]))
}

export function isMerged(task: Task): boolean {
  return task.merged !== undefined
}

export function childrenOf(task: Task, tasks: readonly Task[]): Task[] {
  const found = byId(tasks)
  return (task.childIds ?? []).flatMap((id) => {
    const child = found.get(id)
    return child ? [child] : []
  })
}

export function parentOf(task: Task, tasks: readonly Task[]): Task | undefined {
  return task.parentId === undefined ? undefined : tasks.find((t) => t.id === task.parentId)
}

export function childTree(task: Task, tasks: readonly Task[]): TreeNode[] {
  const seen = new Set([task.id])
  const walk = (parent: Task): TreeNode[] =>
    childrenOf(parent, tasks)
      .filter((child) => !child.archived || isMerged(child))
      .flatMap((child) => {
        if (seen.has(child.id)) return []
        seen.add(child.id)
        return [{ task: child, children: walk(child) }]
      })
  return walk(task)
}

export function childProgress(task: Task, tasks: readonly Task[]): ChildProgress {
  const children = childrenOf(task, tasks)
  const archived = children.filter((c) => c.archived && !isMerged(c))
  const counted = children.filter((c) => !archived.includes(c))
  const holding = counted.filter((c) => !isMerged(c))
  return { merged: counted.length - holding.length, total: counted.length, holding, archived }
}

export function descendantIds(task: Task, tasks: readonly Task[]): Set<string> {
  const found = new Set<string>()
  const walk = (parent: Task) => {
    for (const child of childrenOf(parent, tasks)) {
      if (found.has(child.id) || child.id === task.id) continue
      found.add(child.id)
      walk(child)
    }
  }
  walk(task)
  return found
}

function open(t: Task): boolean {
  return !t.archived && t.stage !== 'done'
}

export function parentChoices(task: Task, tasks: readonly Task[]): Task[] {
  const below = descendantIds(task, tasks)
  return tasks.filter(
    (t) =>
      t.factoryId === task.factoryId &&
      t.id !== task.id &&
      t.id !== task.parentId &&
      !below.has(t.id) &&
      open(t),
  )
}

export function childChoices(task: Task, tasks: readonly Task[]): Task[] {
  const above = new Set<string>()
  for (let up = parentOf(task, tasks); up && !above.has(up.id); up = parentOf(up, tasks))
    above.add(up.id)
  return tasks.filter(
    (t) =>
      t.factoryId === task.factoryId &&
      t.id !== task.id &&
      t.parentId !== task.id &&
      !above.has(t.id) &&
      open(t),
  )
}

export function progressText({ merged, total }: ChildProgress): string {
  return `${merged} of ${total} merged`
}

export function waitingText(task: Task, progress: ChildProgress, stage: (t: Task) => string) {
  const count = progress.holding.length
  if (count === 0 || task.archived || task.stage === 'done') return undefined
  return {
    lead: `Waiting for ${count} ${count === 1 ? 'child' : 'children'}:`,
    tasks: progress.holding.map((t) => ({ task: t, stage: stage(t) })),
    tail: `${task.displayId} does its own remaining work when they merge.`,
  }
}
