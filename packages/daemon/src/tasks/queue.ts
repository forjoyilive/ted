import { type Priority, priorities, type QueuedForSlot, type SlotHolder } from '@ted/protocol'

export const queueKinds = [
  'setup-task',
  'sub-agent',
  'planning',
  'coordinator',
  'side-chat',
  'automation-draft',
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
  handoffs?: ReadonlySet<string>
  heldForLoad?: boolean
}

export const loadMarks = { holdAt: 1, resumeBelow: 0.75 } as const

export function heldForLoad(held: boolean, ratio: number): boolean {
  if (!Number.isFinite(ratio)) return false
  if (ratio >= loadMarks.holdAt) return true
  if (ratio < loadMarks.resumeBelow) return false
  return held
}

export function queueOrder<T extends QueueEntry>(entries: readonly T[]): T[] {
  const priorityRank = (e: QueueEntry) =>
    e.kind === 'task' ? priorities.indexOf(e.priority ?? 'none') : 0
  return [...entries].sort(
    (a, b) =>
      queueKinds.indexOf(a.kind === 'coordinator' || a.kind === 'side-chat' ? 'planning' : a.kind) -
        queueKinds.indexOf(
          b.kind === 'coordinator' || b.kind === 'side-chat' ? 'planning' : b.kind,
        ) ||
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
    const factory = entry.factoryId
    if (
      entry.kind !== 'automation' &&
      entry.kind !== 'automation-draft' &&
      !use.handoffs?.has(entry.id)
    ) {
      if (working >= use.limit) continue
      if (use.heldForLoad && working > 0) continue
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
  holders(): SlotHolder[]
  describe(id: string, place: number): QueuedForSlot | undefined
}
