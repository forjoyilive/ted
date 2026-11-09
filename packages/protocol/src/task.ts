import type { AgentKind, RunState } from './run.ts'

export const agentStageIds = [
  'intake',
  'clarify',
  'design',
  'work',
  'validate',
  'review',
  'merge',
] as const

export type AgentStageId = (typeof agentStageIds)[number]

export type StageId = 'backlog' | AgentStageId | 'done'

export type GitHubWait = 'ci' | 'review' | 'merge' | 'sign-in'

export type TaskStatus =
  | { kind: 'failed' }
  | { kind: 'partly-merged' }
  | { kind: 'waiting-on-you' }
  | { kind: 'paused'; reason: string }
  | { kind: 'working' }
  | { kind: 'stopped' }
  | { kind: 'blocked'; by: string }
  | { kind: 'queued'; place: number }
  | { kind: 'queued'; hold: string }
  | { kind: 'waiting-for-github'; on: GitHubWait }

export type TaskMarker = { kind: 'blocked-by'; by: string } | { kind: 'needs-planning' }

export type TrackState = 'past' | 'current' | 'skipped' | 'future'

export interface TrackStage {
  stage: AgentStageId
  state: TrackState
}

export interface TaskRun {
  id: string
  agent: AgentKind
  state: RunState
}

export interface Task {
  id: string
  factoryId: string
  number: number
  displayId: string
  title: string
  stage: StageId
  branch?: string
  leadRunId?: string
  status?: TaskStatus
  markers: TaskMarker[]
  activity?: string
  track: TrackStage[]
  runs: TaskRun[]
  createdAt: string
}

export interface CreateTaskRequest {
  title: string
  factory?: string
}

export type Outcome = 'advance'

export interface Comment {
  id: string
  taskId: string
  kind: 'note'
  body: string
  author: { kind: 'run'; runId: string }
  createdAt: string
}

export interface PostCommentRequest {
  body: string
}

export interface SetActivityRequest {
  text: string
}

export interface ReportOutcomeRequest {
  outcome: Outcome
}
