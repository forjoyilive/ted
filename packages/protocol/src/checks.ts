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

export type CheckRunTrigger = 'validate' | 'agent' | 'merge' | 'hand-off'

export type CheckRunOutcome = 'passed' | 'failed' | 'interrupted'

export interface CheckRun {
  id: string
  taskId: string
  trigger: CheckRunTrigger
  stage: StageId
  checks: CheckResult[]
  startedAt: string
  finishedAt?: string
  outcome?: CheckRunOutcome
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

export const declaredSendBackCauses = ['base-conflict'] as const
export type DeclaredSendBackCause = (typeof declaredSendBackCauses)[number]
export type SendBackCause = 'review' | 'check' | 'human' | DeclaredSendBackCause

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
  cause?: SendBackCause
  at: string
}

export interface BaseConflictFound {
  id: string
  taskId: string
  stage: StageId
  repo: string
  base: string
  tip: string
  fileCount: number
  files: string[]
  sendBackId?: string
  at: string
}

export const checkFailed = (state: CheckState): boolean =>
  state === 'failed' || state === 'timed-out'

export function checkLabel(check: Pick<CheckResult, 'name' | 'repo'>): string {
  return check.repo === undefined ? check.name : `${check.name} (${check.repo})`
}
