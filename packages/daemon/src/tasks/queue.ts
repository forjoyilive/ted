import { type Priority, priorities, type QueuedForSlot, type SlotHolder } from '@ted/protocol'

export const queueKinds = [
  'setup-task',
  'sub-agent',
  'planning',
  'coordinator',
  'automation',
  'task',
] as const

export type QueueKind = (typeof queueKinds)[number]

export interface QueueEntry {
  id: string
  kind: QueueKind
  rank: number
  priority?: Priority
  factoryId?: string
}

export interface SlotUse {
  limit: number
  working: number
  byFactory: Readonly<Record<string, number>>
  caps: Readonly<Record<string, number | undefined>>
}

export function queueOrder<T extends QueueEntry>(entries: readonly T[]): T[] {
  const priorityRank = (e: QueueEntry) =>
    e.kind === 'task' ? priorities.indexOf(e.priority ?? 'none') : 0
  return [...entries].sort(
    (a, b) =>
      queueKinds.indexOf(a.kind === 'coordinator' ? 'planning' : a.kind) -
        queueKinds.indexOf(b.kind === 'coordinator' ? 'planning' : b.kind) ||
      priorityRank(a) - priorityRank(b) ||
      a.rank - b.rank ||
      a.id.localeCompare(b.id),
  )
}

export function startsNow<T extends QueueEntry>(ordered: readonly T[], use: SlotUse): T[] {
  let working = use.working
  const byFactory = { ...use.byFactory }
  const started: T[] = []
  for (const entry of ordered) {
    if (working >= use.limit) break
    const factory = entry.factoryId
    const cap = factory === undefined ? undefined : use.caps[factory]
    if (factory !== undefined && cap !== undefined && (byFactory[factory] ?? 0) >= cap) continue
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
  holders(): SlotHolder[]
  describe(id: string, place: number): QueuedForSlot | undefined
}
