import type { Priority } from '@ted/protocol'

export interface Ranked {
  priority: Priority
  rank: number
}

export function placeBetween(
  current: Priority,
  neighbours: { after?: Ranked; before?: Ranked },
): Ranked {
  const { after, before } = neighbours
  const shared = [after?.priority, before?.priority].filter((p) => p !== undefined)
  const priority =
    shared.length === 2 && shared[0] !== shared[1] && shared.includes(current)
      ? current
      : (shared[0] ?? current)
  const low = after?.priority === priority ? after.rank : undefined
  const high = before?.priority === priority ? before.rank : undefined
  if (low !== undefined && high !== undefined) return { priority, rank: (low + high) / 2 }
  if (low !== undefined) return { priority, rank: low + 1 }
  if (high !== undefined) return { priority, rank: high - 1 }
  return { priority, rank: 0 }
}
