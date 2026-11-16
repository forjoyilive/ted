import type { Factory, FactoryGroup, FactoryLayout, FactoryLayoutItem } from '@ted/protocol'

export type SidebarEntry =
  | { kind: 'factory'; factory: Factory }
  | { kind: 'group'; group: FactoryGroup; factories: Factory[] }

export type LayoutKey = { factoryId: string } | { groupId: string }

export type DropTarget = { before: LayoutKey } | { after: LayoutKey } | { into: string }

export const emptyLayout: FactoryLayout = { items: [] }

export function arrange(
  factories: readonly Factory[],
  layout: FactoryLayout = emptyLayout,
): SidebarEntry[] {
  const byId = new Map(factories.map((f) => [f.id, f]))
  const placed = new Set<string>()
  const take = (id: string) => {
    const factory = byId.get(id)
    if (!factory || placed.has(id)) return []
    placed.add(id)
    return [factory]
  }
  const entries: SidebarEntry[] = layout.items.flatMap((item): SidebarEntry[] =>
    'group' in item
      ? [{ kind: 'group', group: item.group, factories: item.group.factoryIds.flatMap(take) }]
      : take(item.factoryId).map((factory) => ({ kind: 'factory', factory })),
  )
  for (const factory of factories) {
    if (!placed.has(factory.id)) entries.push({ kind: 'factory', factory })
  }
  return entries
}

export function layoutOf(entries: readonly SidebarEntry[]): FactoryLayout {
  return {
    items: entries.map((entry) =>
      entry.kind === 'factory'
        ? { factoryId: entry.factory.id }
        : { group: { ...entry.group, factoryIds: entry.factories.map((f) => f.id) } },
    ),
  }
}

export function inSidebarOrder(entries: readonly SidebarEntry[]): Factory[] {
  return entries.flatMap((entry) => (entry.kind === 'factory' ? [entry.factory] : entry.factories))
}

export function groupOf(layout: FactoryLayout, factoryId: string): FactoryGroup | undefined {
  for (const item of layout.items) {
    if ('group' in item && item.group.factoryIds.includes(factoryId)) return item.group
  }
  return undefined
}

export function groups(layout: FactoryLayout): FactoryGroup[] {
  return layout.items.flatMap((item) => ('group' in item ? [item.group] : []))
}

const isKey = (item: FactoryLayoutItem, key: LayoutKey) =>
  'groupId' in key
    ? 'group' in item && item.group.id === key.groupId
    : 'factoryId' in item && item.factoryId === key.factoryId

const copy = (layout: FactoryLayout): FactoryLayoutItem[] =>
  layout.items.map((item) =>
    'group' in item ? { group: { ...item.group, factoryIds: [...item.group.factoryIds] } } : item,
  )

function remove(items: FactoryLayoutItem[], key: LayoutKey): FactoryLayoutItem | undefined {
  if ('factoryId' in key) {
    for (const item of items) {
      if ('group' in item && item.group.factoryIds.includes(key.factoryId)) {
        item.group.factoryIds = item.group.factoryIds.filter((id) => id !== key.factoryId)
        return { factoryId: key.factoryId }
      }
    }
  }
  const at = items.findIndex((item) => isKey(item, key))
  return at < 0 ? undefined : items.splice(at, 1)[0]
}

const same = (a: FactoryLayout, b: FactoryLayout) => JSON.stringify(a) === JSON.stringify(b)

function changed(before: FactoryLayout, items: FactoryLayoutItem[]): FactoryLayout | undefined {
  const after = { items }
  return same(before, after) ? undefined : after
}

const keyOf = (target: DropTarget): LayoutKey | undefined =>
  'before' in target ? target.before : 'after' in target ? target.after : undefined

export function moveTo(
  layout: FactoryLayout,
  key: LayoutKey,
  target: DropTarget,
): FactoryLayout | undefined {
  const near = keyOf(target)
  if (near && JSON.stringify(near) === JSON.stringify(key)) return undefined
  if ('groupId' in key && 'into' in target) return undefined
  const items = copy(layout)
  const moved = remove(items, key)
  if (!moved) return undefined
  if ('into' in target) {
    const group = items.find((item) => isKey(item, { groupId: target.into }))
    if (!group || !('group' in group) || !('factoryId' in moved)) return undefined
    group.group.factoryIds.push(moved.factoryId)
    return changed(layout, items)
  }
  const after = 'after' in target
  if (near && 'factoryId' in near) {
    const holder = items.find(
      (item) => 'group' in item && item.group.factoryIds.includes(near.factoryId),
    )
    if (holder && 'group' in holder) {
      if ('factoryId' in moved) {
        const list = holder.group.factoryIds
        list.splice(list.indexOf(near.factoryId) + (after ? 1 : 0), 0, moved.factoryId)
        return changed(layout, items)
      }
      items.splice(items.indexOf(holder) + (after ? 1 : 0), 0, moved)
      return changed(layout, items)
    }
  }
  const at = near ? items.findIndex((item) => isKey(item, near)) : -1
  if (at < 0) return undefined
  items.splice(at + (after ? 1 : 0), 0, moved)
  return changed(layout, items)
}

export function moveStep(
  layout: FactoryLayout,
  key: LayoutKey,
  step: -1 | 1,
): FactoryLayout | undefined {
  const items = copy(layout)
  if ('factoryId' in key) {
    const holder = items.find(
      (item) => 'group' in item && item.group.factoryIds.includes(key.factoryId),
    )
    if (holder && 'group' in holder) {
      const list = holder.group.factoryIds
      const at = list.indexOf(key.factoryId)
      const to = at + step
      if (to < 0 || to >= list.length) return undefined
      list.splice(at, 1)
      list.splice(to, 0, key.factoryId)
      return changed(layout, items)
    }
  }
  const at = items.findIndex((item) => isKey(item, key))
  const to = at + step
  if (at < 0 || to < 0 || to >= items.length) return undefined
  const [moved] = items.splice(at, 1)
  if (!moved) return undefined
  items.splice(to, 0, moved)
  return changed(layout, items)
}

export function putInGroup(
  layout: FactoryLayout,
  factoryId: string,
  groupId: string | undefined,
): FactoryLayout | undefined {
  if (groupId !== undefined) return moveTo(layout, { factoryId }, { into: groupId })
  const from = groupOf(layout, factoryId)
  if (!from) return undefined
  return moveTo(layout, { factoryId }, { after: { groupId: from.id } })
}

export function addGroup(
  layout: FactoryLayout,
  group: { id: string; name: string },
  factoryId?: string,
): FactoryLayout {
  const items = copy(layout)
  const added: FactoryLayoutItem = {
    group: { ...group, factoryIds: factoryId === undefined ? [] : [factoryId] },
  }
  if (factoryId === undefined) return { items: [added, ...items] }
  const holder = groupOf(layout, factoryId)
  const anchor: LayoutKey = holder ? { groupId: holder.id } : { factoryId }
  const at = items.findIndex((item) => isKey(item, anchor))
  remove(items, { factoryId })
  const place = holder ? at + 1 : at
  items.splice(place < 0 ? items.length : place, 0, added)
  return { items }
}

export function renameGroup(layout: FactoryLayout, groupId: string, name: string): FactoryLayout {
  return {
    items: layout.items.map((item) =>
      'group' in item && item.group.id === groupId ? { group: { ...item.group, name } } : item,
    ),
  }
}

export function ungroup(layout: FactoryLayout, groupId: string): FactoryLayout {
  return {
    items: layout.items.flatMap((item) =>
      'group' in item && item.group.id === groupId
        ? item.group.factoryIds.map((factoryId) => ({ factoryId }))
        : [item],
    ),
  }
}

export interface Marks {
  waiting?: number
  uncounted?: boolean
  failed?: boolean
  stopsWork?: boolean
}

export function rollUp(
  marks: Readonly<Record<string, Marks>>,
  factoryIds: readonly string[],
): Required<Marks> {
  const each = factoryIds.map((id) => marks[id] ?? {})
  const waiting = each.filter((m) => (m.waiting ?? 0) > 0)
  return {
    waiting: waiting.reduce((sum, m) => sum + (m.waiting ?? 0), 0),
    uncounted: waiting.length > 0 && waiting.every((m) => m.uncounted === true),
    failed: each.some((m) => m.failed === true),
    stopsWork: each.some((m) => m.stopsWork === true),
  }
}

export function factoryScope(
  layout: FactoryLayout,
  scope: { factoryId?: string; groupId?: string },
): ((factoryId: string) => boolean) | undefined {
  if (scope.groupId !== undefined) {
    const ids = new Set(groups(layout).find((g) => g.id === scope.groupId)?.factoryIds ?? [])
    return (factoryId) => ids.has(factoryId)
  }
  if (scope.factoryId !== undefined) return (factoryId) => factoryId === scope.factoryId
  return undefined
}

export const noGroupKey = 'none'

export function groupSections(layout: FactoryLayout): {
  keys: string[]
  keyOf: (factoryId: string) => string
  labelOf: (key: string) => string
} {
  const all = groups(layout)
  return {
    keys: [...all.map((group) => group.id), noGroupKey],
    keyOf: (factoryId) => groupOf(layout, factoryId)?.id ?? noGroupKey,
    labelOf: (key) => all.find((group) => group.id === key)?.name ?? 'No Factory group',
  }
}
