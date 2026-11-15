import type { CostKind, DashboardMetric, DashboardRange, StagePart } from '@ted/protocol'

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
const ranges: readonly DashboardRange[] = ['today', '7d', '30d', 'all']
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
  const range = ranges.find((r) => r === value.range) ?? '30d'
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
  const shown = factories.filter((f) => wanted.includes(f.id)).map((f) => f.id)
  return shown.length === 0 || shown.length === factories.length ? undefined : shown
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
