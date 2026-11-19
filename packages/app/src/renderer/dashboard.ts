import type {
  CostKind,
  DashboardCustomRange,
  DashboardMetric,
  DashboardPreset,
  DashboardRange,
  StagePart,
} from '@ted/protocol'
import {
  dashboardRange,
  isCalendarDate,
  isPreset,
  localCalendarDate,
  localDayStart,
  rangeDays,
} from '@ted/protocol/dashboard'

export type StageSelection = { period: 'current' | 'previous' } & (
  | { kind: 'stage'; stage: string; part?: StagePart }
  | { kind: 'incomplete' }
  | { kind: 'left-out' }
)

export type CostSelection =
  | { of: 'spend'; kind?: CostKind; model?: string; factoryId?: string | null }
  | { of: 'per-pull-request'; factoryId?: string; taskId?: string }

export interface DashboardSelection {
  metric: DashboardMetric | 'unavailable' | 'open' | 'waiting' | 'cost'
  period: 'current' | 'previous'
  bucket?: number
  missing?: boolean
  stage?: string
  requestId?: string
  cost?: CostSelection
  factoryId?: string
}

export interface DashboardViewState {
  panel?: DashboardPanel
  range: DashboardRange
  factoryIds?: readonly string[]
  sample?: DashboardSelection
  stageSample?: StageSelection
}

type Remembered = Pick<DashboardViewState, 'panel' | 'range' | 'factoryIds'>

const storageKey = 'ted.dashboard'
export const dashboardPanels = ['overview', 'stages', 'cost'] as const
export type DashboardPanel = (typeof dashboardPanels)[number]
const knownPanel = (value: unknown) => dashboardPanels.find((p) => p === value)

export function rememberedDashboard(
  storage: Pick<Storage, 'getItem'> = localStorage,
  now = Date.now(),
): Remembered {
  let stored: unknown
  try {
    stored = JSON.parse(storage.getItem(storageKey) ?? '{}')
  } catch {
    stored = {}
  }
  const value = (stored ?? {}) as Record<string, unknown>
  const restored = dashboardRange(value.range)
  const range =
    restored === undefined || (!isPreset(restored) && restored.to > localCalendarDate(now))
      ? '30d'
      : restored
  const panel = knownPanel(value.panel)
  const ids = Array.isArray(value.factoryIds)
    ? value.factoryIds.filter((id): id is string => typeof id === 'string')
    : undefined
  return {
    range,
    ...(panel && { panel }),
    ...(ids && ids.length > 0 && { factoryIds: ids }),
  }
}

export function rememberDashboard(
  state: DashboardViewState,
  storage: Pick<Storage, 'setItem'> = localStorage,
) {
  const { range, panel, factoryIds } = state
  storage.setItem(storageKey, JSON.stringify({ range, panel, factoryIds }))
}

export function shownFactoryIds(
  wanted: readonly string[] | undefined,
  factories: readonly { id: string }[],
): string[] | undefined {
  if (wanted === undefined) return undefined
  const shown = factories.flatMap((f) => (wanted.includes(f.id) ? [f.id] : []))
  return shown.length === 0 || shown.length === factories.length ? undefined : shown
}

export function pickFactories(
  shown: readonly string[] | undefined,
  ids: readonly string[],
  factories: readonly { id: string }[],
): string[] | undefined {
  if (shown === undefined) return shownFactoryIds(ids, factories)
  const all = ids.every((id) => shown.includes(id))
  const next = factories.flatMap((f) =>
    (ids.includes(f.id) ? !all : shown.includes(f.id)) ? [f.id] : [],
  )
  return shownFactoryIds(next, factories)
}

export function dashboardState(
  screen: Partial<DashboardViewState> | undefined,
  storage: Pick<Storage, 'getItem'> = localStorage,
): DashboardViewState {
  const { panel, ...rest } = screen ?? {}
  const known = knownPanel(panel)
  const shown = known ? { ...rest, panel: known } : rest
  if (screen?.range !== undefined) return { ...shown, range: screen.range }
  const { panel: remembered, ...stored } = rememberedDashboard(storage)
  return { ...stored, ...(panel === undefined && remembered && { panel: remembered }), ...shown }
}

export const rangeLabels: Record<DashboardPreset, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12m': 'Last 12 months',
  week: 'This week',
  month: 'This month',
  year: 'Year to date',
  all: 'All time',
}

export interface RangeComparison {
  earlier: string
  against: string
  versus: string
}

export function rangeComparison(range: DashboardRange): RangeComparison {
  if (!isPreset(range)) {
    const length = rangeDays(range)
    const days = length === 1 ? 'day' : `${length} days`
    return {
      earlier: `Previous ${days}`,
      against: `previous ${days}`,
      versus: `vs previous ${days}`,
    }
  }
  switch (range) {
    case 'today':
      return { earlier: 'Yesterday', against: 'yesterday', versus: 'vs yesterday to this time' }
    case 'week':
      return { earlier: 'Last week', against: 'last week', versus: 'vs last week to this time' }
    case 'month':
      return { earlier: 'Last month', against: 'last month', versus: 'vs last month to this day' }
    case 'year':
      return { earlier: 'Last year', against: 'last year', versus: 'vs last year to this date' }
    default:
      return { earlier: 'Previous', against: 'previous', versus: 'vs previous period' }
  }
}

export function customRangeLabel(range: DashboardCustomRange, now = new Date()): string {
  const from = new Date(localDayStart(range.from))
  const to = new Date(localDayStart(range.to))
  const year = now.getFullYear()
  const thisYear = from.getFullYear() === year && to.getFullYear() === year
  const date = (at: Date, withYear: boolean) =>
    new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(withYear && { year: 'numeric' }),
    }).format(at)
  if (range.from === range.to) return date(from, !thisYear)
  if (from.getFullYear() === to.getFullYear())
    return `${date(from, false)} – ${date(to, !thisYear)}`
  return `${date(from, true)} – ${date(to, true)}`
}

export function rangeLabel(range: DashboardRange, now = new Date()): string {
  return isPreset(range) ? rangeLabels[range] : customRangeLabel(range, now)
}

export function hourlyRange(range: DashboardRange): boolean {
  return isPreset(range) ? range === 'today' : range.from === range.to
}

export function customRangeProblem(from: string, to: string, today: string): string | undefined {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return 'Choose a start and an end date.'
  if (to > today) return 'End can’t be after today.'
  if (from > to) return 'Start must be on or before End.'
  return undefined
}

export function customStart(
  range: DashboardRange,
  current: { from: string | null; to: string } | undefined,
  now: number,
): DashboardCustomRange {
  if (!isPreset(range)) return range
  const today = localCalendarDate(now)
  if (!current?.from) return { from: localCalendarDate(now - 6 * 86_400_000), to: today }
  return {
    from: localCalendarDate(Date.parse(current.from)),
    to: localCalendarDate(Math.min(Date.parse(current.to) - 1, now)),
  }
}
