import type { DashboardMetric, DashboardRange, FlowValidateOutcome } from '@ted/protocol'

export type FlowSelection = { period: 'current' | 'previous' } & (
  | { kind: 'stage'; stage: string }
  | { kind: 'send-back'; from: string; to: string }
  | { kind: 'affected' }
  | { kind: 'incomplete' }
  | { kind: 'validate'; outcome: FlowValidateOutcome }
)

export interface DashboardSelection {
  metric: DashboardMetric | 'unavailable'
  period: 'current' | 'previous'
  bucket?: number
  missing?: boolean
}

export interface DashboardViewState {
  range: DashboardRange
  sample?: DashboardSelection
  flowSample?: FlowSelection
}
