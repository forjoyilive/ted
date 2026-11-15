import type {
  DashboardMetric,
  DashboardRange,
  FlowReasonId,
  FlowValidateOutcome,
} from '@ted/protocol'

export type FlowSelection = { period: 'current' | 'previous' } & (
  | { kind: 'stage'; stage: string }
  | { kind: 'reason'; reason: FlowReasonId }
  | { kind: 'guide' }
  | { kind: 'send-back'; from: string; to: string }
  | { kind: 'affected' }
  | { kind: 'incomplete' }
  | { kind: 'left-out' }
  | { kind: 'validate'; outcome: FlowValidateOutcome }
)

export interface DashboardSelection {
  metric: DashboardMetric | 'unavailable'
  period: 'current' | 'previous'
  bucket?: number
  missing?: boolean
}

export interface DashboardViewState {
  panel?: 'overview' | 'flow' | 'stages'
  range: DashboardRange
  factoryIds?: readonly string[]
  sample?: DashboardSelection
  flowSample?: FlowSelection
}

type Remembered = Pick<DashboardViewState, 'panel' | 'range' | 'factoryIds'>

const storageKey = 'ted.dashboard'
const ranges: readonly DashboardRange[] = ['today', '7d', '30d', 'all']
const panels = ['overview', 'flow', 'stages'] as const

export function rememberedDashboard(storage: Pick<Storage, 'getItem'> = localStorage): Remembered {
  let stored: unknown
  try {
    stored = JSON.parse(storage.getItem(storageKey) ?? '{}')
  } catch {
    stored = {}
  }
  const value = (stored ?? {}) as Record<string, unknown>
  const range = ranges.find((r) => r === value.range) ?? '30d'
  const panel = panels.find((p) => p === value.panel)
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
  if (screen?.range !== undefined) return { ...screen, range: screen.range }
  return { ...rememberedDashboard(storage), ...screen }
}
