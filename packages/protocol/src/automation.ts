import type { RunChat } from './chat.ts'
import type { AgentKind } from './run.ts'
import type { AutomationSchedule } from './schedule.ts'
import type { Attachment, Effort, StageId } from './task.ts'

export const automationTemplateIds = [
  'linear',
  'sentry',
  'github',
  'architecture',
  'audit',
] as const

export type AutomationTemplateId = (typeof automationTemplateIds)[number]

export interface AutomationTemplate {
  id: AutomationTemplateId
  name: string
  summary: string
  prompt: string
  schedule: AutomationSchedule
  checkout?: true
}

export type AutomationTrigger = 'scheduled' | 'made-up' | 'run-now' | 'retry'

export type AutomationNow =
  | { kind: 'working' }
  | { kind: 'waiting' }
  | { kind: 'queued'; place: number }
  | { kind: 'paused'; reason: string }

export interface AutomationTaskLink {
  id: string
  displayId: string
  title: string
  stage: StageId
  source?: string
}

export interface AutomationCheck {
  command: string
  timeout: string
  runBy?: string
}

export interface AutomationCheckInput {
  command: string
  timeout?: string
  runBy?: string | null
}

export type AutomationCheckState = 'passed' | 'failed' | 'timed-out' | 'setup-failed'

export interface AutomationCheckRun {
  state: AutomationCheckState
  exitCode?: number
  durationMs: number
  ranWhileBusy?: true
  skipped?: string[]
  failing: string[]
  updated?: AutomationTaskLink[]
}

export interface AutomationRunOutput {
  text: string
  log: string
}

export type AutomationResult =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'passed' }
  | { kind: 'check-failed'; tasks: AutomationTaskLink[] }
  | { kind: 'created'; tasks: AutomationTaskLink[] }
  | { kind: 'no-new-tasks' }
  | { kind: 'failed'; error: string }
  | { kind: 'skipped' }
  | { kind: 'stopped' }
  | { kind: 'dropped' }

export interface AutomationRun {
  id: string
  automationId: string
  trigger: AutomationTrigger
  slotAt?: string
  retryOf?: string
  retriedAt?: string
  at: string
  startedAt?: string
  finishedAt?: string
  result: AutomationResult
  created?: AutomationTaskLink[]
  message?: string
  runId?: string
  check?: AutomationCheckRun
  screenshots?: Attachment[]
}

export interface AutomationRequest {
  id: string
  automationId: string
  automationName: string
  factoryId: string
  runId: string
  kind: 'note' | 'question'
  body: string
  choices?: string[]
  answer?: { text: string; at: string }
  createdAt: string
}

export interface Automation {
  id: string
  factoryId: string
  factoryKey: string
  name: string
  prompt: string
  schedule: AutomationSchedule
  timeZone: string
  scheduleText: string
  agent: AgentKind
  model?: string
  effort?: Effort
  on: boolean
  checkout?: true
  template?: AutomationTemplateId
  check?: AutomationCheck
  createdAt: string
  nextFirings: string[]
  now?: AutomationNow
  last?: AutomationRun
  failuresInARow: number
  totals: { runs: number; tasksCreated: number }
}

export interface AutomationDetail {
  automation: Automation
  history: AutomationRun[]
  requests: AutomationRequest[]
}

export interface AutomationInput {
  name: string
  prompt: string
  schedule: AutomationSchedule
  agent?: AgentKind
  model?: string
  effort?: Effort
  on?: boolean
  checkout?: boolean
  template?: AutomationTemplateId
  check?: AutomationCheckInput
}

export interface CreateAutomationRequest extends AutomationInput {
  factory?: string
  runNow?: boolean
}

export type EditAutomationRequest = Partial<
  Omit<AutomationInput, 'template' | 'model' | 'effort'>
> & {
  model?: string | null
  effort?: Effort | null
}

export interface SchedulePreview {
  text: string
  nextFirings: string[]
  error?: string
}

export interface AnswerAutomationRequest {
  choice?: string
  text?: string
}

export interface DraftAutomationPromptRequest {
  factory: string
  request: string
  name?: string
  prompt?: string
  agent?: AgentKind
  model?: string
  effort?: Effort
}

export interface AutomationPromptDraft {
  chat?: RunChat
  id: string
  factoryId: string
  state: 'queued' | 'working' | 'ready' | 'failed' | 'canceled'
  prompt?: string
  error?: string
  paused?: string
}

export interface SchedulePreviewRequest {
  schedule: AutomationSchedule
}
export interface AutomationCommentRequest {
  body: string
  choices?: string[]
}
