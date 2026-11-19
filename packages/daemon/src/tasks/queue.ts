import {
  isChat,
  type Priority,
  priorities,
  type QueuedForSlot,
  type SlotHolder,
} from '@ted/protocol'
import { defaultStagePriority, skipsBusyHoldByDefault } from '@ted/protocol/stage'
import type { WorkflowSettings } from '../workflow/check.ts'

export const queueKinds = [
  'setup-task',
  'sub-agent',
  'planning',
  'coordinator',
  'side-chat',
  'automation-draft',
  'automation',
  'continuation',
  'task',
] as const

export type QueueKind = (typeof queueKinds)[number]

export interface QueueEntry {
  id: string
  kind: QueueKind
  rank: number
  priority?: Priority
  factoryId?: string
  skipsBusy?: true
  recent?: true
  stageRank?: number
  pastLimits?: true
}

export interface StageQueue {
  rank: number
  skipsBusy: boolean
}

export function stageQueue(stages: WorkflowSettings['stages'], stage: string): StageQueue {
  const settings = stages[stage]
  return {
    rank: settings?.priority ?? defaultStagePriority(stage),
    skipsBusy: settings?.skip_busy_hold ?? skipsBusyHoldByDefault(stage),
  }
}

export const recentContinuationMs = 10 * 60_000

export function continuationFlags(
  heldAt: string,
  now: number,
): Pick<QueueEntry, 'skipsBusy' | 'recent'> {
  return {
    skipsBusy: true,
    ...(now - Date.parse(heldAt) < recentContinuationMs && { recent: true }),
  }
}

export interface SlotUse {
  limit: number
  working: number
  byFactory: Readonly<Record<string, number>>
  caps: Readonly<Record<string, number | undefined>>
  handoffs?: ReadonlySet<string>
  busy?: boolean
}

function sortKind(e: QueueEntry): QueueKind {
  if (e.kind === 'coordinator' || e.kind === 'side-chat') return 'planning'
  return e.kind
}

const takesTurnWithTasks = (e: QueueEntry) =>
  e.kind === 'task' || e.kind === 'continuation' || e.kind === 'automation'

function sortGroup(e: QueueEntry): number {
  return queueKinds.indexOf(takesTurnWithTasks(e) ? 'continuation' : sortKind(e))
}

function turnKind(e: QueueEntry): number {
  if (e.kind === 'continuation') return 0
  if (takesTurnWithTasks(e)) return 1
  return queueKinds.indexOf(sortKind(e))
}

export function queueOrder<T extends QueueEntry>(entries: readonly T[]): T[] {
  const priorityRank = (e: QueueEntry) =>
    takesTurnWithTasks(e) ? priorities.indexOf(e.priority ?? 'none') : 0
  const stageRank = (e: QueueEntry) =>
    e.kind === 'task' || e.kind === 'continuation' ? (e.stageRank ?? 0) : 0
  const taskAfterAutomation = (e: QueueEntry) => Number(e.kind === 'task')
  return [...entries].sort(
    (a, b) =>
      sortGroup(a) - sortGroup(b) ||
      stageRank(b) - stageRank(a) ||
      turnKind(a) - turnKind(b) ||
      Number(b.recent === true) - Number(a.recent === true) ||
      priorityRank(a) - priorityRank(b) ||
      taskAfterAutomation(a) - taskAfterAutomation(b) ||
      a.rank - b.rank ||
      a.id.localeCompare(b.id),
  )
}

export function startsNow<T extends QueueEntry>(ordered: readonly T[], use: SlotUse): T[] {
  let working = use.working
  const byFactory = { ...use.byFactory }
  const started: T[] = []
  for (const entry of ordered) {
    if (isChat(entry.kind)) {
      started.push(entry)
      continue
    }
    const factory = entry.factoryId
    if (
      entry.kind !== 'automation-draft' &&
      entry.pastLimits !== true &&
      !use.handoffs?.has(entry.id)
    ) {
      if (working >= use.limit) continue
      if (use.busy && working > 0 && !entry.skipsBusy) continue
      const cap = factory === undefined ? undefined : use.caps[factory]
      if (factory !== undefined && cap !== undefined && (byFactory[factory] ?? 0) >= cap) continue
    }
    started.push(entry)
    working++
    if (factory !== undefined) byFactory[factory] = (byFactory[factory] ?? 0) + 1
  }
  return started
}

export interface QueueSource {
  queued(): QueueEntry[]
  runnable(id: string): boolean
  begin(id: string): void
  starting?(): readonly string[]
  holders(): SlotHolder[]
  describe(id: string, place: number): QueuedForSlot | undefined
}
