import type { CostKind, DashboardMetric, DashboardRange, StagePart } from '@ted/protocol'
import { dashboardRange } from '@ted/protocol/dashboard'

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

export function rememberedDashboard(storage: Pick<Storage, 'getItem'> = localStorage): Remembered {
  let stored: unknown
  try {
    stored = JSON.parse(storage.getItem(storageKey) ?? '{}')
  } catch {
    stored = {}
  }
  const value = (stored ?? {}) as Record<string, unknown>
  const range = dashboardRange(value.range) ?? '30d'
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

export const rangeLabels: Record<DashboardRange, string> = {
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

export function rangeComparison(range: DashboardRange): {
  earlier: string
  against: string
  versus: string
} {
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
