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
  StageId,
  StatusFilter,
  Task,
} from '@ted/protocol'
import { allTasksScope } from '@ted/protocol/list-view'
import { priorities, taskStatusKinds } from '@ted/protocol/task'
import { emptyLayout, groupSections, groups } from './factory-layout.ts'
import { priorityLabels } from './task-fields.ts'

export const stageOrder: readonly StageId[] = [
  'backlog',
  'intake',
  'clarify',
  'design',
  'work',
  'validate',
  'review',
  'merge',
  'cleanup',
  'done',
]

export const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

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
  'follow-up': 'A Follow-up',
  setup: 'Factory setup',
  coordinator: 'The Coordinator',
}

export const sortLabels: Record<ListSort, string> = {
  manual: 'Manual',
  priority: 'Priority',
  updated: 'Updated',
  created: 'Created',
  stage: 'Stage',
  title: 'Title',
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
  stage: 'Stage',
  status: 'Status',
  updated: 'Updated',
  factory: 'Factory',
  'blocked-by': 'Blocked by',
  created: 'Created',
  'created-by': 'Created by',
  tokens: 'Tokens',
  started: 'Started',
}

const columnOrder: readonly ListColumn[] = [
  'priority',
  'id',
  'title',
  'factory',
  'stage',
  'status',
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
    columnsVersion: 2,
    columns: [
      'priority',
      'id',
      'title',
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
  return view.columnsVersion === 2
    ? view
    : { ...view, columnsVersion: 2, columns: [...view.columns, 'started'] }
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
const stageIndex = (task: Task) => {
  const i = stageOrder.indexOf(task.stage)
  return i === -1 ? stageOrder.length : i
}

export function manualOrder(a: Task, b: Task): number {
  return (
    priorityIndex(a) - priorityIndex(b) || a.rank - b.rank || a.createdAt.localeCompare(b.createdAt)
  )
}

const sorts: Record<ListSort, (a: Task, b: Task) => number> = {
  manual: manualOrder,
  priority: manualOrder,
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || manualOrder(a, b),
  created: (a, b) => b.createdAt.localeCompare(a.createdAt) || manualOrder(a, b),
  stage: (a, b) => stageIndex(a) - stageIndex(b) || manualOrder(a, b),
  title: (a, b) => a.title.localeCompare(b.title) || manualOrder(a, b),
}

export function sortTasks(tasks: readonly Task[], sort: ListSort): Task[] {
  return [...tasks].sort(sorts[sort])
}

export interface TaskGroup {
  key: string
  label: string
  tasks: Task[]
  collapsed: boolean
  turnedOff?: boolean
}

export function groupTasks(
  tasks: readonly Task[],
  view: ListView,
  factories: readonly Factory[],
  keep: readonly string[] = [],
  layout: FactoryLayout = emptyLayout,
): TaskGroup[] {
  const sorted = sortTasks(tasks, view.sort)
  const make = <K extends string>(
    keys: readonly K[],
    keyOf: (task: Task) => K,
    labelOf: (key: K) => string,
    collapsed: (key: K) => boolean = () => false,
  ): TaskGroup[] => {
    const extra = [...new Set(sorted.map(keyOf))].filter((k) => !keys.includes(k))
    return [...keys, ...extra].flatMap((key) => {
      const inGroup = sorted.filter((t) => keyOf(t) === key)
      return inGroup.length === 0 && !view.showEmptyGroups && !keep.includes(key)
        ? []
        : [{ key, label: labelOf(key), tasks: inGroup, collapsed: collapsed(key) }]
    })
  }
  switch (view.group) {
    case 'none':
      return sorted.length === 0
        ? []
        : [{ key: 'all', label: 'All', tasks: sorted, collapsed: false }]
    case 'stage':
      return make(
        stageOrder,
        (t) => t.stage,
        stageName,
        (key) => key === 'done' && view.filters.archived !== 'only',
      )
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
        (p: Priority) => (p === 'none' ? 'No Priority' : priorityLabels[p]),
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
  if (group === 'stage') return ['backlog', 'intake']
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
    if (from === 'backlog' && to === 'intake' && startable) return 'start'
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
  if (filters.stages?.length) add('stages', `Stage is ${joined(filters.stages.map(stageName))}`)
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
): NestedRow[] {
  const { tasks, context } = withAncestors(group, everyTask)
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
