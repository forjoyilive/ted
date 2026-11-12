export const taskIntervalReasons = [
  'run-working',
  'user-request',
  'run-slot',
  'github',
  'agent-paused',
  'blocker',
  'stopped',
] as const

export type TaskIntervalReason = (typeof taskIntervalReasons)[number]

export interface TaskIntervalContributor {
  id: string
  detail?: string
  start: string
  end: string
  startSource: string
  endSource: string
}

export interface TaskInterval {
  reason: TaskIntervalReason
  start: string
  end: string
  contributors: TaskIntervalContributor[]
}

export interface TaskIntervalCoverage {
  reason: TaskIntervalReason
  start: string
  end: string
  state: 'known' | 'unknown'
  source: 'durable-history' | 'observation' | 'not-recorded' | 'daemon-gap' | 'unreconciled'
}

/** Half-open wall-clock intervals; observed working state is not productive effort. */
export interface TaskIntervalHistory {
  taskId: string
  asOf: string
  intervals: TaskInterval[]
  coverage: TaskIntervalCoverage[]
  lifecycle: { at: string; event: string }[]
}
