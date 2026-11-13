import type { Task } from '@ted/protocol'

export interface MapCard {
  task: Task
  column: number
  row: number
  done: boolean
  other: boolean
}

export interface MapLink {
  blocker: string
  blocked: string
  muted: boolean
}

export interface BlockerMap {
  cards: MapCard[]
  links: MapLink[]
  unlinked: Task[]
  columns: number
  rows: number
}

const chainGap = 0.5

function inOrder(a: Task, b: Task): number {
  return a.rank - b.rank || a.displayId.localeCompare(b.displayId, undefined, { numeric: true })
}

export function blockerMap(tasks: readonly Task[], factoryId: string): BlockerMap {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const own = tasks.filter((t) => t.factoryId === factoryId && !t.archived).sort(inOrder)
  const links: MapLink[] = []
  for (const blocked of own) {
    if (blocked.stage === 'done') continue
    for (const id of blocked.blockedBy) {
      const blocker = byId.get(id)
      if (!blocker || blocker.archived) continue
      links.push({ blocker: blocker.id, blocked: blocked.id, muted: blocker.stage === 'done' })
    }
  }

  const blockersOf = new Map<string, string[]>()
  const blocks = new Map<string, string[]>()
  for (const { blocker, blocked } of links) {
    blockersOf.set(blocked, [...(blockersOf.get(blocked) ?? []), blocker])
    blocks.set(blocker, [...(blocks.get(blocker) ?? []), blocked])
  }
  const linked = [...new Set(links.flatMap((l) => [l.blocker, l.blocked]))]
    .flatMap((id) => byId.get(id) ?? [])
    .sort(inOrder)

  const column = new Map<string, number>()
  const columnOf = (id: string, path: ReadonlySet<string>): number => {
    const known = column.get(id)
    if (known !== undefined) return known
    if (path.has(id)) return 0
    const inside = new Set(path).add(id)
    const at = Math.max(-1, ...(blockersOf.get(id) ?? []).map((b) => columnOf(b, inside))) + 1
    column.set(id, at)
    return at
  }
  for (const task of linked) columnOf(task.id, new Set())
  for (const task of linked) {
    if (blockersOf.has(task.id)) continue
    const first = Math.min(...(blocks.get(task.id) ?? []).map((id) => column.get(id) ?? 1))
    column.set(task.id, Math.max(0, first - 1))
  }

  const chain = new Map(linked.map((t) => [t.id, t.id]))
  const chainOf = (id: string): string => {
    const parent = chain.get(id) ?? id
    if (parent === id) return id
    const root = chainOf(parent)
    chain.set(id, root)
    return root
  }
  for (const { blocker, blocked } of links) chain.set(chainOf(blocker), chainOf(blocked))
  const chains = new Map<string, Task[]>()
  for (const task of linked) {
    const root = chainOf(task.id)
    chains.set(root, [...(chains.get(root) ?? []), task])
  }

  const cards: MapCard[] = []
  let top = 0
  for (const members of chains.values()) {
    const row = new Map<string, number>()
    const wanted = (task: Task, index: number): number => {
      const placed = (blockersOf.get(task.id) ?? []).flatMap((b) => row.get(b) ?? [])
      if (placed.length === 0) return index + 0.25
      return placed.reduce((sum, r) => sum + r, 0) / placed.length
    }
    let height = 0
    const columns = [...new Set(members.map((t) => column.get(t.id) ?? 0))].sort((a, b) => a - b)
    for (const at of columns) {
      const here = members
        .filter((t) => column.get(t.id) === at)
        .map((task, index) => ({ task, wants: wanted(task, index) }))
        .sort((a, b) => a.wants - b.wants)
      let last = -1
      for (const { task, wants } of here) {
        last = Math.max(Math.round(wants), last + 1)
        row.set(task.id, last)
      }
      height = Math.max(height, last + 1)
    }
    for (const task of members) {
      cards.push({
        task,
        column: column.get(task.id) ?? 0,
        row: top + (row.get(task.id) ?? 0),
        done: task.stage === 'done',
        other: task.factoryId !== factoryId,
      })
    }
    top += height + chainGap
  }

  const onMap = new Set(linked.map((t) => t.id))
  return {
    cards,
    links,
    unlinked: own.filter((t) => t.stage !== 'done' && !onMap.has(t.id)),
    columns: Math.max(0, ...cards.map((c) => c.column + 1)),
    rows: Math.max(0, top - chainGap),
  }
}

export function linkRefusal(
  tasks: readonly Task[],
  blockerId: string,
  blockedId: string,
): string | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const blocker = byId.get(blockerId)
  const blocked = byId.get(blockedId)
  if (!blocker || !blocked) return 'That Task is gone'
  if (blocker.id === blocked.id) return `${blocked.displayId} can’t block itself`
  if (blocked.stage === 'done') return `${blocked.displayId} is done`
  if (blocked.blockedBy.includes(blocker.id)) {
    return `${blocked.displayId} already waits for ${blocker.displayId}`
  }
  const seen = new Set<string>()
  const walk = (id: string): string[] | undefined => {
    if (id === blocked.id) return [id]
    if (seen.has(id)) return undefined
    seen.add(id)
    for (const next of byId.get(id)?.blockedBy ?? []) {
      const rest = walk(next)
      if (rest) return [id, ...rest]
    }
    return undefined
  }
  const cycle = walk(blocker.id)
  if (!cycle) return undefined
  const [first, ...rest] = cycle.map((id) => byId.get(id)?.displayId ?? id)
  return `${blocker.displayId} can’t block ${blocked.displayId}: ${first} waits for ${rest.join(', which waits for ')}`
}
