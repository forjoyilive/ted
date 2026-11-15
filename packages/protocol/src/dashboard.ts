export type DashboardRange = 'today' | '7d' | '30d' | 'all'
export type DashboardMetric = 'completed' | 'created' | 'intake'

export interface DashboardTask {
  id: string
  factoryId: string
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

export interface DashboardFactoryPeriod {
  factoryId: string
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
  byFactory: DashboardFactoryPeriod[]
}

export interface DashboardChange {
  absolute: number | null
  percent: number | null
}

export interface DashboardReport {
  asOf: string
  range: DashboardRange
  factoryIds: string[]
  tasks: DashboardTask[]
  unavailableIds: string[]
  current: DashboardPeriod
  previous: DashboardPeriod | null
  comparison: Record<DashboardMetric, DashboardChange> | null
  flow: DashboardFlow
}

export interface FlowTask {
  id: string
  factoryId: string
  displayId: string
  title: string
  archived: boolean
  endedAt: string | null
  endReason: 'done' | 'archived' | 'open' | 'unknown'
}

export interface FlowInterval {
  from: string
  to: string
}

export interface FlowStageSample {
  taskId: string
  elapsedMs: number
  intervals: FlowInterval[]
}

export interface FlowStage {
  stage: string
  factoryIds: string[]
  totalMs: number
  medianMs: number | null
  p25Ms: number | null
  p75Ms: number | null
  samples: FlowStageSample[]
}

export interface FlowSendBack {
  id: string
  taskId: string
  from: string
  to: string
  at: string
  counted: boolean
  cause: string | null
  sequence?: number
}

export interface FlowSendBackGroup {
  from: string
  to: string
  counted: number
  taskIds: string[]
  transitions: FlowSendBack[]
}

export type FlowValidateOutcome = 'passed' | 'failed' | 'skipped' | 'unknown' | 'no-visit'

export interface FlowValidateSample {
  taskId: string
  outcome: FlowValidateOutcome
  enteredAt: string | null
  exitedAt: string | null
  checkRunIds: string[]
  failureIds: string[]
  reasons: string[]
}

export interface FlowPeriod {
  from: string | null
  to: string
  taskIds: string[]
  incomplete: { taskId: string; reasons: string[] }[]
  stages: FlowStage[]
  reasons: FlowReason[]
  sendBacks: FlowSendBackGroup[]
  firstPass: {
    passed: number
    denominator: number
    percent: number | null
    samples: FlowValidateSample[]
  }
}

export interface DashboardFlow {
  tasks: FlowTask[]
  current: FlowPeriod
  previous: FlowPeriod | null
}

export type FlowReasonId =
  | import('./task-intervals.ts').TaskIntervalReason
  | 'check-slot'
  | 'test-lock'
  | 'running-check'

export interface FlowMeasuredInterval extends FlowInterval {
  contributors: import('./task-intervals.ts').TaskIntervalContributor[]
}

export interface FlowTestEvidence {
  id: string
  runId?: string
  checkRunId?: string
  position?: number
  registeredAt: string
  coverage: 'reported' | 'unreported' | 'unsupported' | 'incomplete'
  openWaitStartedAt?: string
  checkCommand?: FlowInterval & { overlapMs: number }
  outcome?: string
}

export interface FlowReasonSample {
  taskId: string
  elapsedMs: number | null
  eligibleMs: number
  coveredMs: number | null
  coverage: 'full' | 'partial' | 'unavailable'
  intervals: FlowMeasuredInterval[]
  coverageIntervals: import('./task-intervals.ts').TaskIntervalCoverage[]
  notices: string[]
  invocations: FlowTestEvidence[]
}

export interface FlowReason {
  reason: FlowReasonId
  totalMs: number
  medianMs: number | null
  p25Ms: number | null
  p75Ms: number | null
  samples: FlowReasonSample[]
}
