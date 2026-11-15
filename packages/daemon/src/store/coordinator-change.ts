import { isDeepStrictEqual } from 'node:util'

export const receiptsKept = 100

export interface CoordinatorChange {
  set: string
  unset: readonly string[]
  lists: string | null
}

type Fields = Record<string, unknown>
type ListChange = { put: unknown[]; keep: number }

const listFields: Record<string, (item: unknown) => unknown> = {
  receipts: (item) => (item as { id: string }).id,
  taskIds: (item) => item,
}

const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function withList(name: string, old: unknown, { put, keep }: ListChange): unknown[] {
  const key = listFields[name] as (item: unknown) => unknown
  const list = [...items(old)]
  for (const item of put) {
    const at = list.findIndex((existing) => key(existing) === key(item))
    if (at === -1) list.push(item)
    else list[at] = item
  }
  return list.slice(-keep)
}

export function applyCoordinatorChange(
  before: Fields | undefined,
  change: CoordinatorChange,
): Fields {
  const data: Fields = { ...before, ...(JSON.parse(change.set) as Fields) }
  for (const name of change.unset) delete data[name]
  const lists =
    change.lists === null ? {} : (JSON.parse(change.lists) as Record<string, ListChange>)
  for (const [name, list] of Object.entries(lists))
    data[name] = withList(name, before?.[name], list)
  return data
}

export function coordinatorChange(
  before: Fields | undefined,
  after: Fields,
): CoordinatorChange | undefined {
  const old: Fields = before ?? {}
  const next = JSON.parse(JSON.stringify(after)) as Fields
  const set: Fields = {}
  const lists: Record<string, ListChange> = {}
  for (const [name, value] of Object.entries(next)) {
    if (isDeepStrictEqual(old[name], value)) continue
    const key = listFields[name]
    if (before && key && Array.isArray(value) && name in old) {
      const kept = new Map(items(old[name]).map((item) => [key(item), item]))
      const list = {
        put: value.filter((item) => !isDeepStrictEqual(kept.get(key(item)), item)),
        keep: value.length,
      }
      if (isDeepStrictEqual(withList(name, old[name], list), value)) {
        lists[name] = list
        continue
      }
    }
    set[name] = value
  }
  const unset = Object.keys(old).filter((name) => !(name in next))
  const listText = Object.keys(lists).length > 0 ? JSON.stringify(lists) : null
  if (Object.keys(set).length === 0 && unset.length === 0 && listText === null) return undefined
  return { set: JSON.stringify(set), unset, lists: listText }
}
