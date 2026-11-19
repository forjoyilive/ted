import { isObject, isOneOf, isString, type Untyped } from './parse.ts'

export const dashboardRanges = [
  'today',
  '7d',
  '30d',
  '90d',
  '12m',
  'week',
  'month',
  'year',
  'all',
] as const
export type DashboardPreset = (typeof dashboardRanges)[number]

export interface DashboardCustomRange {
  from: string
  to: string
}

export type DashboardRange = DashboardPreset | DashboardCustomRange

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0))
  return date.toISOString().slice(0, 10) === value
}

export function localCalendarDate(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localDayStart(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

export function customRange(from: string, to: string): DashboardCustomRange | undefined {
  return isCalendarDate(from) && isCalendarDate(to) && from <= to ? { from, to } : undefined
}

export function dashboardRange(value: Untyped): DashboardRange | undefined {
  if (isOneOf(value, dashboardRanges)) return value
  if (!isObject(value) || !isString(value.from) || !isString(value.to)) return undefined
  return customRange(value.from, value.to)
}

export function isPreset(range: DashboardRange): range is DashboardPreset {
  return isString(range)
}

export function rangeDays(range: DashboardCustomRange): number {
  return Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1
}
export type DashboardMetric = 'completed' | 'merged' | 'created' | 'backlog' | 'intake'
export type DashboardDuration = 'created' | 'backlog' | 'intake'

export interface DashboardTask {
  id: string
  factoryId: string
  displayId: string
  title: string
  archived: boolean
  doneAt: string | null
  createdMs: number | null
  backlogMs: number | null
  intakeMs: number | null
  merges: number
}

export interface DashboardSample {
  value: number | null
  taskIds: string[]
  missingIds: string[]
}

export interface DashboardMerged {
  count: number
  taskIds: string[]
}

export interface DashboardBucket {
  from: string
  to: string
  taskIds: string[]
  merged: DashboardMerged
  created: DashboardSample
  backlog: DashboardSample
  intake: DashboardSample
}

export interface DashboardFactoryPeriod {
  factoryId: string
  taskIds: string[]
  merged: DashboardMerged
  created: DashboardSample
  backlog: DashboardSample
  intake: DashboardSample
}

export interface DashboardPeriod {
  from: string | null
  to: string
  taskIds: string[]
  merged: DashboardMerged
  created: DashboardSample
  backlog: DashboardSample
  intake: DashboardSample
  buckets: DashboardBucket[]
  byFactory: DashboardFactoryPeriod[]
}

export interface DashboardChange {
  absolute: number | null
  percent: number | null
}

export type DashboardOpenState = 'working' | 'waiting-on-you' | 'blocked' | 'backlog' | 'other'

export interface DashboardOpenTask {
  id: string
  factoryId: string
  displayId: string
  title: string
  stage: string
  state: DashboardOpenState
}

export interface DashboardReport {
  asOf: string
  range: DashboardRange
  factoryIds: string[]
  tasks: DashboardTask[]
  unavailableIds: string[]
  open: DashboardOpenTask[]
  current: DashboardPeriod
  previous: DashboardPeriod | null
  comparison: Record<DashboardMetric, DashboardChange> | null
  flow: DashboardFlow
  waiting: {
    current: DashboardWaiting
    previous: DashboardWaiting | null
    change: DashboardChange | null
  }
  cost: DashboardCost
}

export interface DashboardWait {
  taskId: string
  requestId: string
  kind: string
  stage: string | null
  waitedMs: number
}

export interface DashboardWaitSample {
  taskId: string
  waitedMs: number
}

export interface DashboardWaitStage {
  stage: string
  totalMs: number
  kinds: string[]
  samples: DashboardWaitSample[]
}

export interface DashboardWaiting {
  totalMs: number
  medianMs: number | null
  samples: DashboardWaitSample[]
  stages: DashboardWaitStage[]
  waits: DashboardWait[]
  byFactory: { factoryId: string; totalMs: number; taskIds: string[] }[]
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
  parts: import('./stage-parts.ts').StageParts
}

export interface FlowStage {
  stage: string
  factoryIds: string[]
  totalMs: number
  medianMs: number | null
  p25Ms: number | null
  p75Ms: number | null
  parts: import('./stage-parts.ts').StageParts
  samples: FlowStageSample[]
}

export interface FlowPeriod {
  from: string | null
  to: string
  taskIds: string[]
  incomplete: { taskId: string; reasons: string[] }[]
  stages: FlowStage[]
  reasons: FlowReason[]
}

export interface DashboardFlow {
  tasks: FlowTask[]
  current: FlowPeriod
  previous: FlowPeriod | null
  stageNames: Record<string, string>
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

export type CostKind =
  | 'lead'
  | 'reviewer'
  | 'sub-agent'
  | 'coordinator'
  | 'automation'
  | 'planning'
  | 'other'

export interface CostTask {
  id: string
  factoryId: string
  displayId: string
  title: string
  runs: number
  sendBacks: number
}

export interface CostTaskSpend {
  taskId: string
  cost: number
}

export interface CostShare {
  key: string
  agent?: string
  model?: string | null
  cost: number
  runs: number
  tasks: CostTaskSpend[]
}

export interface CostBucket {
  from: string
  to: string
  cost: number
  kinds: CostShare[]
  models: CostShare[]
  tasks: CostTaskSpend[]
}

export interface CostPullRequestSample {
  taskId: string
  cost: number
  pullRequests: number
  perPullRequest: number
}

export interface CostPerPullRequest {
  median: number | null
  p25: number | null
  p75: number | null
  pullRequests: number
  samples: CostPullRequestSample[]
}

export interface CostFactory {
  factoryId: string | null
  cost: number
  runs: number
  kinds: CostShare[]
  tasks: CostTaskSpend[]
  perPullRequest: CostPerPullRequest
}

export interface CostPeriod {
  from: string | null
  to: string
  cost: number
  input: number
  output: number
  runs: number
  unpricedRuns: number
  kinds: CostShare[]
  models: CostShare[]
  tasks: CostTaskSpend[]
  buckets: CostBucket[]
  perPullRequest: CostPerPullRequest
  byFactory: CostFactory[]
}

export interface DashboardCost {
  tasks: CostTask[]
  current: CostPeriod
  previous: CostPeriod | null
  change: { spend: DashboardChange; perPullRequest: DashboardChange } | null
}
