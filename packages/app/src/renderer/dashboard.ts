import type { DashboardMetric, DashboardRange } from '@ted/protocol'

export interface DashboardSelection {
  metric: DashboardMetric | 'unavailable'
  period: 'current' | 'previous'
  bucket?: number
  missing?: boolean
}

export interface DashboardViewState {
  range: DashboardRange
  sample?: DashboardSelection
}
