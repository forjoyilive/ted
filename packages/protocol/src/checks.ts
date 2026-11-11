import type { StageId } from './task.ts'

export type CheckState =
  | 'waiting'
  | 'running'
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'skipped'
  | 'not-run'

export interface CheckResult {
  name: string
  repo?: string
  command: string
  timeout: string
  state: CheckState
  exitCode?: number
  durationMs?: number
  builtIn?: 'ted-settings'
}

export type CheckRunTrigger = 'validate' | 'agent' | 'merge'

export type CheckRunOutcome = 'passed' | 'failed' | 'interrupted'

export type CheckTimingInterval =
  | { status: 'unavailable' }
  | { status: 'ongoing'; startedAt: string }
  | { status: 'interrupted'; startedAt: string; detectedAt: string }
  | {
      status: 'complete' | 'canceled' | 'interrupted'
      startedAt: string
      endedAt: string
      durationMs: number
    }

export interface CheckRunTiming {
  checkRunId: string
  taskId: string
  trigger: CheckRunTrigger
  stage: StageId
  queue: CheckTimingInterval
  execution: (CheckTimingInterval & { position: number })[]
}

export interface CheckRun {
  id: string
  taskId: string
  trigger: CheckRunTrigger
  stage: StageId
  checks: CheckResult[]
  startedAt: string
  finishedAt?: string
  outcome?: CheckRunOutcome
  timing?: CheckRunTiming
  waiting?: boolean
}

export interface CheckRunReport {
  checkRun: CheckRun
  report?: string
}

export interface RunChecksRequest {
  name?: string
}

export interface CheckOutput {
  text: string
  log: string
}

export interface SendBack {
  id: string
  taskId: string
  from: StageId
  to: StageId
  findings: string
  counted: boolean
  round?: number
  limit?: number
  checkRunId?: string
  at: string
}

export const checkFailed = (state: CheckState): boolean =>
  state === 'failed' || state === 'timed-out'

export function checkLabel(check: Pick<CheckResult, 'name' | 'repo'>): string {
  return check.repo === undefined ? check.name : `${check.name} (${check.repo})`
}
