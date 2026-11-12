export type DashboardRange = '7d' | '30d' | 'all'
export type DashboardMetric = 'completed' | 'created' | 'intake'

export interface DashboardTask {
  id: string
  displayId: string
  title: string
  archived: boolean
  doneAt: string | null
  createdMs: number | null
  intakeMs: number | null
}

export interface DashboardSample {
  value: number | null
  taskIds: string[]
  missingIds: string[]
}

export interface DashboardBucket {
  from: string
  to: string
  taskIds: string[]
  created: DashboardSample
  intake: DashboardSample
}

export interface DashboardPeriod {
  from: string | null
  to: string
  taskIds: string[]
  created: DashboardSample
  intake: DashboardSample
  buckets: DashboardBucket[]
}

export interface DashboardChange {
  absolute: number | null
  percent: number | null
}

export interface FactoryDashboard {
  asOf: string
  range: DashboardRange
  tasks: DashboardTask[]
  unavailableIds: string[]
  current: DashboardPeriod
  previous: DashboardPeriod | null
  comparison: Record<DashboardMetric, DashboardChange> | null
}
