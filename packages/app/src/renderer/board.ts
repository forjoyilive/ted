import type { BoardStage, BoardView, QueuedForSlot, StageId, Task } from '@ted/protocol'
import { defaultBoardView } from '@ted/protocol/board-view'
import { compareStages, isCleanup, stageDisplayName } from '@ted/protocol/stage'
import { priorities } from '@ted/protocol/task'
import { createdByLabels, manualOrder } from './list-view.ts'
import { ago } from './requests.ts'

export interface BoardColumn {
  stage: StageId
  name: string
  removed?: boolean
  gate: boolean
  turnedOff: boolean
  tasks: Task[]
  allDone?: number
}

export const doneDays = 7

const dayMs = 24 * 60 * 60 * 1000

const doneAt = (task: Task) => task.merged?.at ?? task.updatedAt

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

export function boardColumns(
  stages: readonly BoardStage[],
  tasks: readonly Task[],
  now: number = Date.now(),
): BoardColumn[] {
  const live = tasks.filter((t) => !t.archived)
  const start = startStage(stages)
  const order = stages.map((s) => s.id)
  const listed: BoardStage[] = [...stages]
  for (const id of new Set(live.map((t) => t.stage))) {
    if (listed.some((s) => s.id === id)) continue
    const at = listed.findIndex((s) => compareStages(s.id, id, order) > 0)
    listed.splice(at === -1 ? listed.length : at, 0, {
      id,
      removed: true,
      enabled: false,
      gate: false,
    })
  }
  return listed.flatMap(({ id, name, removed, enabled, gate }): BoardColumn[] => {
    const shared = {
      stage: id,
      name: name ?? stageDisplayName(id),
      ...(removed && { removed: true }),
      gate,
      turnedOff: !enabled,
    }
    if (id === 'done') {
      const done = live.filter((t) => t.stage === 'done')
      const recent = done
        .filter((t) => now - Date.parse(doneAt(t)) <= doneDays * dayMs)
        .sort((a, b) => doneAt(b).localeCompare(doneAt(a)))
      return [{ ...shared, tasks: recent, allDone: done.length }]
    }
    const inStage = live.filter((t) => t.stage === id).sort(columnOrder(id, start))
    if (!enabled && inStage.length === 0 && !isCleanup(id)) return []
    return [{ ...shared, tasks: inStage }]
  })
}

export interface HiddenColumn {
  stage: StageId
  name: string
  count: number
  needsYou: number
}

export interface BoardLayout {
  columns: BoardColumn[]
  hidden: HiddenColumn[]
}

export function boardViewFor(
  views: Readonly<Record<string, BoardView>> | undefined,
  factoryId: string,
): BoardView {
  return views?.[factoryId] ?? defaultBoardView
}

export function withoutGoneStages(
  view: BoardView,
  stages: readonly BoardStage[],
): BoardView | undefined {
  const kept = view.hiddenStages.filter((id) => stages.some((s) => s.id === id))
  return kept.length === view.hiddenStages.length ? undefined : { ...view, hiddenStages: kept }
}

const needsYou = (task: Task) =>
  task.statuses.includes('waiting-on-you') || task.statuses.includes('failed')

const isEmpty = (column: BoardColumn) => column.tasks.length === 0 && (column.allDone ?? 0) === 0

export function boardLayout(
  columns: readonly BoardColumn[],
  view: BoardView,
  takesDrop: (stage: StageId) => boolean = () => false,
): BoardLayout {
  const hidden = columns.filter((c) => view.hiddenStages.includes(c.stage))
  return {
    columns: columns.filter(
      (c) => !hidden.includes(c) && !(view.hideEmpty && isEmpty(c) && !takesDrop(c.stage)),
    ),
    hidden: hidden.map((c) => ({
      stage: c.stage,
      name: c.name,
      count: c.tasks.length,
      needsYou: c.tasks.filter(needsYou).length,
    })),
  }
}

export function withoutBlockers(task: Task): Task {
  const { status, statusWithoutBlocker, ...rest } = task
  return {
    ...(status?.kind === 'blocked'
      ? { ...rest, ...(statusWithoutBlocker && { status: statusWithoutBlocker }) }
      : task),
    markers: task.markers.filter((m) => m.kind !== 'blocked-by'),
  }
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

export function mergedLine(task: Task, now: number): string | undefined {
  if (task.stage !== 'done' || !task.merged) return undefined
  const { at, pullRequests } = task.merged
  const numbers = pullRequests.map((n) => `#${n}`).join(', ')
  return `Merged ${ago(at, now)}${numbers === '' ? '' : ` · PR ${numbers}`}`
}

export function doneCardLine(task: Task, now: number): string {
  return `${task.displayId} · Merged ${ago(doneAt(task), now)}`
}
