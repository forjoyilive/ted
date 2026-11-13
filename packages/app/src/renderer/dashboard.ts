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
  sample?: DashboardSelection
  flowSample?: FlowSelection
}
