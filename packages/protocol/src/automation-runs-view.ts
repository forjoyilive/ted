import type { AutomationRunRow } from './automation.ts'
import { type SortDirection, sortDirections } from './diagnostics-sort.ts'
import { type Fail, isOneOf, isString, reader, type Untyped } from './parse.ts'
import type { RunSlots } from './slots.ts'
import { type Priority, priorities } from './task.ts'

export const automationRunSorts = ['start', 'priority', 'automation', 'factory', 'time'] as const

export type AutomationRunSort = (typeof automationRunSorts)[number]

export const automationRunStatuses = [
  'running',
  'queued',
  'finished',
  'failed',
  'stopped',
  'skipped',
] as const

export type AutomationRunStatus = (typeof automationRunStatuses)[number]

export const automationRunKinds = ['agent', 'check'] as const

export type AutomationRunKind = (typeof automationRunKinds)[number]

export interface AutomationRunFilters {
  factories?: string[]
  automations?: string[]
  statuses?: AutomationRunStatus[]
  priorities?: Priority[]
  kinds?: AutomationRunKind[]
}

export interface AutomationRunsView {
  filters: AutomationRunFilters
  sort: AutomationRunSort
  direction: SortDirection
}

export const defaultAutomationRunsView: AutomationRunsView = {
  filters: {},
  sort: 'start',
  direction: 'ascending',
}

export function parseAutomationRunsView(value: Untyped, fail?: Fail): AutomationRunsView {
  const read = reader(fail)
  const view = read.object(value, 'automationRunsView')
  const filters = read.object(view.filters, 'filters')
  const texts = (field: string) => read.optional(filters, field, read.list)?.filter(isString)
  const chosen = <const T extends string>(field: string, values: readonly T[]) =>
    read.optional(filters, field, read.list)?.filter((v): v is T => isOneOf(v, values))
  const parsed: AutomationRunFilters = {}
  const set = <K extends keyof AutomationRunFilters>(
    key: K,
    list: AutomationRunFilters[K] | undefined,
  ) => {
    if (list !== undefined && list.length > 0) parsed[key] = list
  }
  set('factories', texts('factories'))
  set('automations', texts('automations'))
  set('statuses', chosen('statuses', automationRunStatuses))
  set('priorities', chosen('priorities', priorities))
  set('kinds', chosen('kinds', automationRunKinds))
  return {
    filters: parsed,
    sort: read.oneOf(view, 'sort', automationRunSorts),
    direction: read.oneOf(view, 'direction', sortDirections),
  }
}

export type AutomationRunGroup = 'running' | 'queued' | 'recent'

export const automationRunGroups: readonly AutomationRunGroup[] = ['running', 'queued', 'recent']

export function runGroup(row: AutomationRunRow): AutomationRunGroup {
  if (row.state === 'queued') return 'queued'
  return row.state === 'ended' ? 'recent' : 'running'
}

export function runStatus(row: AutomationRunRow): AutomationRunStatus {
  const group = runGroup(row)
  if (group !== 'recent') return group
  const { kind } = row.run.result
  if (kind === 'failed' || kind === 'check-failed') return 'failed'
  if (kind === 'stopped' || kind === 'dropped') return 'stopped'
  if (kind === 'skipped') return 'skipped'
  return 'finished'
}

export const runKind = (row: AutomationRunRow): AutomationRunKind =>
  row.scheduledCheck === true ? 'check' : 'agent'

export function filterRuns(
  rows: readonly AutomationRunRow[],
  filters: AutomationRunFilters,
): AutomationRunRow[] {
  const allows = <T>(chosen: readonly T[] | undefined, value: T) =>
    chosen === undefined || chosen.length === 0 || chosen.includes(value)
  return rows.filter(
    (row) =>
      allows(filters.factories, row.factoryId) &&
      allows(filters.automations, row.run.automationId) &&
      allows(filters.statuses, runStatus(row)) &&
      allows(filters.priorities, row.priority) &&
      allows(filters.kinds, runKind(row)),
  )
}

export const runTime = (row: AutomationRunRow): string =>
  runGroup(row) === 'recent'
    ? (row.run.finishedAt ?? row.run.at)
    : runGroup(row) === 'running'
      ? (row.run.startedAt ?? row.run.at)
      : row.run.at

function startOrder(a: AutomationRunRow, b: AutomationRunRow): number {
  if (runGroup(a) === 'queued' && runGroup(b) === 'queued') {
    const place = (row: AutomationRunRow) => row.place ?? Number.MAX_SAFE_INTEGER
    return place(a) - place(b) || a.run.at.localeCompare(b.run.at)
  }
  return runTime(b).localeCompare(runTime(a))
}

export function sortRuns(
  rows: readonly AutomationRunRow[],
  sort: AutomationRunSort,
  direction: SortDirection,
  factoryName: (factoryId: string) => string,
): AutomationRunRow[] {
  const by = (a: AutomationRunRow, b: AutomationRunRow): number => {
    switch (sort) {
      case 'priority':
        return priorities.indexOf(b.priority) - priorities.indexOf(a.priority)
      case 'automation':
        return a.automationName.localeCompare(b.automationName)
      case 'factory':
        return factoryName(a.factoryId).localeCompare(factoryName(b.factoryId))
      case 'time':
        return runTime(a).localeCompare(runTime(b))
      case 'start':
        return startOrder(a, b)
    }
  }
  const sign = direction === 'ascending' ? 1 : -1
  return [...rows].sort(
    (a, b) => sign * by(a, b) || startOrder(a, b) || a.run.id.localeCompare(b.run.id),
  )
}

export function nextRunsSort(
  view: AutomationRunsView,
  sort: AutomationRunSort,
): AutomationRunsView {
  if (view.sort !== sort) return { ...view, sort, direction: 'ascending' }
  return { ...view, direction: view.direction === 'ascending' ? 'descending' : 'ascending' }
}

export function activeRunFilters(filters: AutomationRunFilters): number {
  return Object.values(filters).reduce((count, chosen) => count + (chosen?.length ?? 0), 0)
}

export const automationRunCount = (slots: Pick<RunSlots, 'holders' | 'queue'>): number =>
  slots.holders.filter((h) => h.kind === 'automation').length +
  slots.queue.filter((q) => q.kind === 'automation').length
