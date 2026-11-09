import type { BoardStage, QueuedForSlot, StageId, Task } from '@ted/protocol'
import { priorities } from '@ted/protocol/task'
import { createdByLabels, manualOrder, stageOrder } from './list-view.ts'
import { ago } from './requests.ts'

export interface BoardColumn {
  stage: StageId
  gate: boolean
  turnedOff: boolean
  tasks: Task[]
}

export const builtInStages: readonly BoardStage[] = stageOrder.map((id) => ({
  id,
  enabled: true,
  gate: false,
}))

export type BoardDrop = 'reorder' | 'start' | 'unstart'

export interface Placement {
  index: number
  after?: string
  before?: string
}

const isQueued = (task: Task) => task.statuses.includes('queued')

const isBlocked = (task: Task) =>
  task.statuses.includes('blocked') || task.markers.some((m) => m.kind === 'blocked-by')

export function canStart(task: Task): boolean {
  return task.stage === 'backlog' && !task.archived && !isBlocked(task)
}

export function startStage(stages: readonly BoardStage[]): StageId | undefined {
  return stages.find((s) => s.enabled && s.id !== 'backlog' && s.id !== 'done')?.id
}

function columnOrder(stage: StageId, start: StageId | undefined) {
  return (a: Task, b: Task) =>
    (stage === start ? Number(isQueued(b)) - Number(isQueued(a)) : 0) || manualOrder(a, b)
}

export function boardColumns(stages: readonly BoardStage[], tasks: readonly Task[]): BoardColumn[] {
  const live = tasks.filter((t) => !t.archived)
  const start = startStage(stages)
  const builtIn = (id: StageId) => stageOrder.indexOf(id)
  const listed: BoardStage[] = [...stages]
  for (const id of new Set(live.map((t) => t.stage))) {
    if (listed.some((s) => s.id === id)) continue
    const at = listed.findIndex((s) => builtIn(s.id) > builtIn(id))
    listed.splice(at === -1 ? listed.length : at, 0, { id, enabled: false, gate: false })
  }
  return listed.flatMap(({ id, enabled, gate }) => {
    const inStage = live.filter((t) => t.stage === id).sort(columnOrder(id, start))
    if (!enabled && inStage.length === 0) return []
    return [{ stage: id, gate, turnedOff: !enabled, tasks: inStage }]
  })
}

export function boardDrop(
  task: Task,
  from: StageId,
  to: StageId,
  start: StageId | undefined,
): BoardDrop | undefined {
  if (task.archived) return undefined
  if (from === to) return to === 'done' ? undefined : 'reorder'
  if (from === 'backlog' && to === start && canStart(task)) return 'start'
  const neverRan = task.leadRunId === undefined && task.repos.length === 0
  if (from === start && to === 'backlog' && isQueued(task) && neverRan) return 'unstart'
  return undefined
}

export function placeCard(
  column: BoardColumn,
  moving: Task,
  drop: BoardDrop,
  index: number,
  start: StageId | undefined,
): Placement {
  const rest = column.tasks.filter((t) => t.id !== moving.id)
  let low = 0
  let high = rest.length
  if (column.stage === start) {
    const queuedCount = rest.filter(isQueued).length
    if (drop === 'start' || isQueued(moving)) high = queuedCount
    else low = queuedCount
  }
  const at = Math.min(Math.max(index, low), high)
  const after = at > low ? rest[at - 1] : undefined
  const before = at < high ? rest[at] : undefined
  return {
    index: at,
    ...(after && { after: after.id }),
    ...(before && { before: before.id }),
  }
}

export function startPlace(
  placement: Placement,
  moving: Task,
  slotQueue: readonly QueuedForSlot[],
): number {
  const queue = slotQueue.flatMap((q) => (q.kind === 'task' ? [q] : []))
  const placeOf = (id: string | undefined) => queue.find((q) => q.taskId === id)?.place
  const before = placeOf(placement.before)
  if (before !== undefined) return before
  const after = placeOf(placement.after)
  if (after !== undefined) return after + 1
  const own = priorities.indexOf(moving.priority)
  return queue.filter((q) => priorities.indexOf(q.priority) <= own).length + 1
}

export function cardActivity(task: Task, now: number): string | undefined {
  if (task.stage === 'backlog' && !task.markers.some((m) => m.kind === 'blocked-by')) {
    const by = createdByLabels[task.createdBy]
    return `Created by ${by.charAt(0).toLowerCase()}${by.slice(1)} · ${ago(task.createdAt, now)}`
  }
  if (task.activity !== undefined) return task.activity
  const status = task.status
  if (status?.kind === 'queued') {
    return 'place' in status ? 'Waiting for a free Run slot' : status.hold
  }
  return undefined
}
