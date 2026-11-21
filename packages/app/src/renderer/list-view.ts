import type {
  CreatedBy,
  Factory,
  FactoryLayout,
  ListColumn,
  ListFilters,
  ListGroup,
  ListSort,
  ListView,
  Priority,
  StatusFilter,
  Task,
} from '@ted/protocol'
import { allTasksScope } from '@ted/protocol/list-view'
import { stageWith } from '@ted/protocol/stage'
import { priorities, taskStatusKinds } from '@ted/protocol/task'
import { emptyLayout, groupSections, groups } from './factory-layout.ts'
import { defaultStages, type Stages } from './stage-names.ts'
import { priorityLabels } from './task-fields.ts'

export const statusFilterLabels: Record<StatusFilter, string> = {
  failed: 'Failed',
  'partly-merged': 'Partly merged',
  'waiting-on-you': 'Waiting on you',
  paused: 'Paused',
  working: 'Working',
  stopped: 'Stopped',
  blocked: 'Blocked',
  queued: 'Queued',
  'waiting-for-github': 'Waiting for GitHub',
  none: 'No status',
}

export const statusFilterOrder: readonly StatusFilter[] = [...taskStatusKinds, 'none']

export const createdByLabels: Record<CreatedBy, string> = {
  human: 'You',
  automation: 'An Automation',
  planning: 'A planning chat',
  split: 'A split',
  'follow-up': 'A follow-up',
  setup: 'Factory setup',
  coordinator: 'The Coordinator',
  'task-lead': 'A Task Lead',
}

export const sortLabels: Record<ListSort, string> = {
  manual: 'Manual',
  priority: 'Priority',
  updated: 'Updated',
  created: 'Created',
  stage: 'Stage',
  title: 'Title',
  tokens: 'Tokens',
}

export const groupLabels: Record<ListGroup, string> = {
  stage: 'Stage',
  factory: 'Factory',
  'factory-group': 'Factory group',
  status: 'Status',
  priority: 'Priority',
  none: 'None',
}

export const columnLabels: Record<ListColumn, string> = {
  priority: 'Priority',
  id: 'ID',
  title: 'Title',
  children: 'Children',
  parent: 'Parent',
  stage: 'Stage',
  status: 'Status',
  updated: 'Updated',
  factory: 'Factory',
  'blocked-by': 'Blocked by',
  created: 'Created',
  'created-by': 'Created by',
  provider: 'Provider',
  tokens: 'Tokens',
  started: 'Started',
}

const columnOrder: readonly ListColumn[] = [
  'priority',
  'id',
  'title',
  'children',
  'parent',
  'factory',
  'stage',
  'status',
  'provider',
  'blocked-by',
  'created-by',
  'tokens',
  'created',
  'updated',
  'started',
]

export function isAllTasks(scope: string): boolean {
  return scope === allTasksScope
}

export function defaultView(scope: string): ListView {
  const all = isAllTasks(scope)
  return {
    sort: 'manual',
    group: 'stage',
    ...(!all && { nested: true }),
    columnsVersion: 3,
    columns: [
      'priority',
      'id',
      'title',
      'children',
      'parent',
      ...(all ? (['factory'] as const) : []),
      'stage',
      'status',
      'updated',
      'started',
    ],
    filters: {},
  }
}

export function viewFor(
  views: Readonly<Record<string, ListView>> | undefined,
  scope: string,
): ListView {
  const view = views?.[scope]
  if (!view) return defaultView(scope)
  if (view.columnsVersion === 3) return view
  const added: ListColumn[] = view.columnsVersion === 2 ? [] : ['started']
  return {
    ...view,
    columnsVersion: 3,
    columns: [...view.columns, ...added, 'children', 'parent'],
  }
}

export function viewKey(view: ListView): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return [...value].map(sorted).sort()
    if (typeof value !== 'object' || value === null) return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => !(Array.isArray(v) && v.length === 0))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    )
  }
  return JSON.stringify(sorted(view))
}

export function shownColumns(view: ListView): ListColumn[] {
  return columnOrder.filter((c) => c === 'title' || view.columns.includes(c))
}

export function isQueueMode(view: ListView): boolean {
  const statuses = view.filters.statuses ?? []
  return (
    statuses.length === 1 &&
    statuses[0] === 'queued' &&
    view.sort === 'manual' &&
    view.group === 'none'
  )
}

export function queueView(scope: string, views?: Readonly<Record<string, ListView>>): ListView {
  const view = viewFor(views, scope)
  return { ...view, sort: 'manual', group: 'none', filters: { statuses: ['queued'] } }
}

export function doneView(scope: string, views?: Readonly<Record<string, ListView>>): ListView {
  const view = viewFor(views, scope)
  return { ...view, sort: 'updated', group: 'none', filters: { stages: ['done'] } }
}

export function failedView(scope: string, views?: Readonly<Record<string, ListView>>): ListView {
  const view = viewFor(views, scope)
  return { ...view, filters: { statuses: ['failed'] } }
}

function matchesStatus(task: Task, wanted: readonly StatusFilter[]): boolean {
  return wanted.some((filter) =>
    filter === 'none'
      ? task.status === undefined
      : filter === 'blocked'
        ? task.statuses.includes('blocked') || task.markers.some((m) => m.kind === 'blocked-by')
        : task.statuses.includes(filter),
  )
}

function inList<T>(wanted: readonly T[] | undefined, value: T): boolean {
  return wanted === undefined || wanted.length === 0 || wanted.includes(value)
}

export function pickedGroups(filters: ListFilters, layout: FactoryLayout) {
  const picked = filters.factoryGroups ?? []
  return groups(layout).filter((group) => picked.includes(group.id))
}

function factoryFilter(filters: ListFilters, layout: FactoryLayout): Set<string> | undefined {
  const live = pickedGroups(filters, layout)
  const factories = filters.factories ?? []
  if (live.length === 0 && factories.length === 0) return undefined
  return new Set([...factories, ...live.flatMap((group) => group.factoryIds)])
}

export function filterTasks(
  tasks: readonly Task[],
  filters: ListFilters,
  text = '',
  layout: FactoryLayout = emptyLayout,
): Task[] {
  const archived = filters.archived ?? 'hidden'
  const needle = text.trim().toLowerCase()
  const inFactories = factoryFilter(filters, layout)
  return tasks.filter((task) => {
    if (archived === 'hidden' && task.archived) return false
    if (archived === 'only' && !task.archived) return false
    if (inFactories && !inFactories.has(task.factoryId)) return false
    if (!inList(filters.stages, task.stage)) return false
    if (!inList(filters.priorities, task.priority)) return false
    if (!inList(filters.createdBy, task.createdBy)) return false
    if (filters.statuses && filters.statuses.length > 0 && !matchesStatus(task, filters.statuses)) {
      return false
    }
    if (filters.needsPlanning && !task.markers.some((m) => m.kind === 'needs-planning')) {
      return false
    }
    if (needle === '') return true
    return (
      task.displayId.toLowerCase().includes(needle) || task.title.toLowerCase().includes(needle)
    )
  })
}

const priorityIndex = (task: Task) => priorities.indexOf(task.priority)
export function manualOrder(a: Task, b: Task): number {
  return (
    priorityIndex(a) - priorityIndex(b) || a.rank - b.rank || a.createdAt.localeCompare(b.createdAt)
  )
}

const sorts = (stages: Stages): Record<ListSort, (a: Task, b: Task) => number> => ({
  manual: manualOrder,
  priority: manualOrder,
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || manualOrder(a, b),
  created: (a, b) => b.createdAt.localeCompare(a.createdAt) || manualOrder(a, b),
  stage: (a, b) => stages.index(a.stage) - stages.index(b.stage) || manualOrder(a, b),
  title: (a, b) => a.title.localeCompare(b.title) || manualOrder(a, b),
  tokens: (a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || manualOrder(a, b),
})

export function sortTasks(
  tasks: readonly Task[],
  sort: ListSort,
  stages: Stages = defaultStages,
): Task[] {
  return [...tasks].sort(sorts(stages)[sort])
}

export interface TaskGroup {
  key: string
  label: string
  tasks: Task[]
  collapsed: boolean
  removed?: boolean
}

export function groupTasks(
  tasks: readonly Task[],
  view: ListView,
  factories: readonly Factory[],
  keep: readonly string[] = [],
  layout: FactoryLayout = emptyLayout,
  stages: Stages = defaultStages,
): TaskGroup[] {
  const sorted = sortTasks(tasks, view.sort, stages)
  const make = <K extends string>(
    keys: readonly K[],
    keyOf: (task: Task) => K,
    labelOf: (key: K) => string,
    collapsed: (key: K) => boolean = () => false,
    removed: (key: K) => boolean = () => false,
  ): TaskGroup[] => {
    const extra = [...new Set(sorted.map(keyOf))].filter((k) => !keys.includes(k))
    return [...keys, ...extra].flatMap((key) => {
      const inGroup = sorted.filter((t) => keyOf(t) === key)
      if (inGroup.length === 0 && (removed(key) || (!view.showEmptyGroups && !keep.includes(key))))
        return []
      return [
        {
          key,
          label: labelOf(key),
          tasks: inGroup,
          collapsed: collapsed(key),
          ...(removed(key) && { removed: true }),
        },
      ]
    })
  }
  switch (view.group) {
    case 'none':
      return sorted.length === 0
        ? []
        : [{ key: 'all', label: 'All', tasks: sorted, collapsed: false }]
    case 'stage': {
      const listed = stages.merged.filter((s) => !s.removed || sorted.some((t) => t.stage === s.id))
      const ordered = [...new Set(sorted.map((t) => t.stage))].filter(
        (id) => !listed.some((s) => s.id === id),
      )
      const removed = (id: string) =>
        listed.find((s) => s.id === id)?.removed === true || ordered.includes(id)
      return make(
        listed.map((s) => s.id),
        (t) => t.stage,
        (id) => stages.name(id),
        (key) => key === 'done' && view.filters.archived !== 'only',
        removed,
      )
    }
    case 'factory':
      return make(
        factories.map((f) => f.id),
        (t) => t.factoryId,
        (id) => factories.find((f) => f.id === id)?.name ?? 'No Factory',
      )
    case 'factory-group': {
      const sections = groupSections(layout)
      return make(sections.keys, (t) => sections.keyOf(t.factoryId), sections.labelOf)
    }
    case 'priority':
      return make(
        priorities,
        (t) => t.priority,
        (p: Priority) => (p === 'none' ? 'No priority' : priorityLabels[p]),
      )
    case 'status':
      return make(
        statusFilterOrder,
        (t) => t.status?.kind ?? 'none',
        (s) => statusFilterLabels[s],
      )
  }
}

export function neighbours(
  ordered: readonly Task[],
  movingId: string,
  index: number,
): { after?: string; before?: string } {
  const rest = ordered.filter((t) => t.id !== movingId)
  const after = rest[index - 1]
  const before = rest[index]
  return {
    ...(after && { after: after.id }),
    ...(before && { before: before.id }),
  }
}

export function rankMove(
  ordered: readonly Task[],
  taskId: string,
  direction: 'up' | 'down',
): { after?: string; before?: string } | undefined {
  const at = ordered.findIndex((t) => t.id === taskId)
  const step = direction === 'up' ? -1 : 1
  const task = ordered[at]
  const past = ordered[at + step]
  if (!task || !past || past.priority !== task.priority) return undefined
  return neighbours(ordered, taskId, at + step)
}

export function dropTargets(group: ListGroup): readonly string[] {
  if (group === 'stage') return ['backlog', stageWith('entry')]
  if (group === 'status') return ['none', 'queued']
  if (group === 'priority') return priorities
  return []
}

export type DropAction = 'reorder' | 'start' | 'unstart'

const isQueued = (task: Task) => task.status?.kind === 'queued' || task.statuses.includes('queued')

export function dropAction(
  task: Task,
  group: ListGroup,
  from: string,
  to: string,
): DropAction | undefined {
  if (task.archived) return undefined
  if (from === to) return 'reorder'
  if (group === 'priority') return 'reorder'
  const startable = task.stage === 'backlog' && !task.statuses.includes('blocked')
  if (group === 'stage') {
    if (from === 'backlog' && to === stageWith('entry') && startable) return 'start'
    if (to === 'backlog' && isQueued(task)) return 'unstart'
    return undefined
  }
  if (group === 'status') {
    if (from === 'none' && to === 'queued' && startable) return 'start'
    if (from === 'queued' && to === 'none' && isQueued(task)) return 'unstart'
  }
  return undefined
}

export function activeFilterCount(
  filters: ListFilters,
  layout: FactoryLayout = emptyLayout,
): number {
  return (
    (filters.factories?.length ?? 0) +
    pickedGroups(filters, layout).length +
    (filters.stages?.length ?? 0) +
    (filters.statuses?.length ?? 0) +
    (filters.priorities?.length ?? 0) +
    (filters.createdBy?.length ?? 0) +
    (filters.needsPlanning ? 1 : 0) +
    (filters.archived !== undefined && filters.archived !== 'hidden' ? 1 : 0)
  )
}

export interface FilterChip {
  key: string
  label: string
  clear: (filters: ListFilters) => ListFilters
}

function joined(names: readonly string[]): string {
  return names.length <= 2 ? names.join(' or ') : `${names.length} values`
}

export function filterChips(
  filters: ListFilters,
  factories: readonly Factory[],
  layout: FactoryLayout = emptyLayout,
  stages: Stages = defaultStages,
): FilterChip[] {
  const without =
    (name: keyof ListFilters) =>
    (current: ListFilters): ListFilters => {
      const { [name]: _, ...rest } = current
      return rest
    }
  const chips: FilterChip[] = []
  const add = (name: keyof ListFilters, label: string) =>
    chips.push({ key: name, label, clear: without(name) })
  const live = pickedGroups(filters, layout)
  if (live.length) add('factoryGroups', `Factory group is ${joined(live.map((g) => g.name))}`)
  if (filters.factories?.length) {
    add(
      'factories',
      `Factory is ${joined(filters.factories.map((id) => factories.find((f) => f.id === id)?.name ?? 'No Factory'))}`,
    )
  }
  if (filters.stages?.length)
    add('stages', `Stage is ${joined(filters.stages.map((id) => stages.name(id)))}`)
  if (filters.statuses?.length) {
    add('statuses', `Status is ${joined(filters.statuses.map((s) => statusFilterLabels[s]))}`)
  }
  if (filters.priorities?.length) {
    add('priorities', `Priority is ${joined(filters.priorities.map((p) => priorityLabels[p]))}`)
  }
  if (filters.createdBy?.length) {
    add('createdBy', `Created by ${joined(filters.createdBy.map((c) => createdByLabels[c]))}`)
  }
  if (filters.needsPlanning) add('needsPlanning', 'Needs planning')
  if (filters.archived === 'included') add('archived', 'Archived: included')
  if (filters.archived === 'only') add('archived', 'Archived: only')
  return chips
}

export function toggled<T>(list: readonly T[] | undefined, value: T): T[] {
  const current = list ?? []
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
}

export function summaryLine(
  tasks: readonly Task[],
  shown: readonly Task[],
  view: ListView,
  scope: string,
  factories: readonly Factory[],
): string {
  if (isQueueMode(view)) {
    return `${shown.length} ${shown.length === 1 ? 'Task' : 'Tasks'} · machine-wide queue, in start order`
  }
  if (view.filters.archived === 'only') {
    const count = shown.length
    return `${count} archived ${count === 1 ? 'Task' : 'Tasks'} · Grouped by ${groupLabels[view.group]}`
  }
  const live = tasks.filter((t) => !t.archived)
  const open = live.filter((t) => t.stage !== 'done').length
  const done = live.length - open
  const where = isAllTasks(scope)
    ? ` in ${factories.length} ${factories.length === 1 ? 'Factory' : 'Factories'}`
    : ''
  const counts =
    isAllTasks(scope) || done === 0
      ? `${open} open ${open === 1 ? 'Task' : 'Tasks'}${where}`
      : `${open} open ${open === 1 ? 'Task' : 'Tasks'} · ${done} Done`
  const order = view.sort === 'manual' ? 'Sorted Manual' : `Sorted by ${sortLabels[view.sort]}`
  return `${counts} · ${order}`
}

export function selectionRange(
  ordered: readonly Task[],
  anchor: string | undefined,
  target: string,
): string[] {
  const end = ordered.findIndex((t) => t.id === target)
  const start = anchor === undefined ? -1 : ordered.findIndex((t) => t.id === anchor)
  if (start === -1 || end === -1) return [target]
  const [from, to] = start < end ? [start, end] : [end, start]
  return ordered.slice(from, to + 1).map((t) => t.id)
}

export function columnSelection(
  selected: readonly string[],
  column: readonly Task[],
  anchor: string | undefined,
  target: string,
): string[] {
  if (anchor === undefined || !column.some((t) => t.id === anchor)) return toggled(selected, target)
  const inColumn = new Set(column.map((t) => t.id))
  return [...selected.filter((id) => !inColumn.has(id)), ...selectionRange(column, anchor, target)]
}

export interface NestedRow {
  task: Task
  depth: number
  hasChildren: boolean
  context?: true
}

function withAncestors(group: readonly Task[], everyTask: readonly Task[]) {
  const byId = new Map(everyTask.map((t) => [t.id, t]))
  const inGroup = new Set(group.map((t) => t.id))
  const added = new Set<string>()
  const tasks: Task[] = []
  for (const task of group) {
    const missing: Task[] = []
    const seen = new Set([task.id])
    for (let id = task.parentId; id !== undefined && !seen.has(id); ) {
      seen.add(id)
      const parent = byId.get(id)
      if (!parent || inGroup.has(id)) break
      if (!added.has(id)) missing.unshift(parent)
      id = parent.parentId
    }
    for (const parent of missing) {
      added.add(parent.id)
      tasks.push(parent)
    }
    tasks.push(task)
  }
  return { tasks, context: added }
}

export function nestedRows(
  group: readonly Task[],
  collapsed: ReadonlySet<string>,
  everyTask: readonly Task[] = group,
  order?: (a: Task, b: Task) => number,
): NestedRow[] {
  const found = withAncestors(group, everyTask)
  const tasks = order ? [...found.tasks].sort(order) : found.tasks
  const context = found.context
  const inGroup = new Map(tasks.map((t) => [t.id, t]))
  const parentIn = (task: Task) =>
    task.parentId !== undefined && task.parentId !== task.id && inGroup.has(task.parentId)
      ? task.parentId
      : undefined
  const children = new Map<string, Task[]>()
  for (const task of tasks) {
    const parent = parentIn(task)
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), task])
  }
  const onCycle = (task: Task) => {
    const seen = new Set<string>()
    for (let id = parentIn(task); id !== undefined; ) {
      if (id === task.id) return true
      if (seen.has(id)) return false
      seen.add(id)
      const up = inGroup.get(id)
      id = up ? parentIn(up) : undefined
    }
    return false
  }
  const visited = new Set<string>()
  const rows: NestedRow[] = []
  const hide = (task: Task) => {
    for (const child of children.get(task.id) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      hide(child)
    }
  }
  const walk = (task: Task, depth: number) => {
    visited.add(task.id)
    const below = (children.get(task.id) ?? []).filter((c) => !visited.has(c.id))
    rows.push({
      task,
      depth,
      hasChildren: below.length > 0,
      ...(context.has(task.id) && { context: true as const }),
    })
    if (collapsed.has(task.id)) {
      hide(task)
      return
    }
    for (const child of below) if (!visited.has(child.id)) walk(child, depth + 1)
  }
  for (const task of tasks) {
    if (visited.has(task.id)) continue
    if (parentIn(task) === undefined || onCycle(task)) walk(task, 0)
  }
  for (const task of tasks) if (!visited.has(task.id)) walk(task, 0)
  return rows
}

export interface NestedSlot {
  row: number
  after?: string
  before?: string
}

const subtreeEnd = (rows: readonly NestedRow[], at: number) => {
  let end = at + 1
  while (end < rows.length && (rows[end]?.depth ?? 0) > (rows[at]?.depth ?? 0)) end++
  return end
}

export function nestedSlots(rows: readonly NestedRow[], movingId: string): NestedSlot[] {
  const from = rows.findIndex((r) => r.task.id === movingId)
  const depth = from === -1 ? 0 : (rows[from]?.depth ?? 0)
  let start = 0
  let end = rows.length
  if (depth > 0) {
    for (start = from; start > 0 && (rows[start - 1]?.depth ?? 0) >= depth; ) start--
    end = start === 0 ? rows.length : subtreeEnd(rows, start - 1)
  }
  const siblings: number[] = []
  for (let i = start; i < end; i++) {
    if (rows[i]?.depth === depth && rows[i]?.task.id !== movingId) siblings.push(i)
  }
  const last = siblings.at(-1)
  return [...siblings, undefined].map((at, k) => {
    const after = rows[siblings[k - 1] ?? -1]?.task.id
    const before = at === undefined ? undefined : rows[at]?.task.id
    return {
      row: at ?? (last === undefined ? start : subtreeEnd(rows, last)),
      ...(after !== undefined && { after }),
      ...(before !== undefined && { before }),
    }
  })
}

export function nearestSlot(slots: readonly NestedSlot[], boundary: number): number {
  let best = 0
  slots.forEach((slot, i) => {
    const current = slots[best]
    if (current && Math.abs(slot.row - boundary) < Math.abs(current.row - boundary)) best = i
  })
  return best
}
