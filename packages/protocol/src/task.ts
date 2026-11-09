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

export const priorities = ['urgent', 'high', 'medium', 'low', 'none'] as const

export type Priority = (typeof priorities)[number]

export const clarifyDepths = ['auto', 'none', 'few', 'grilling'] as const

export type ClarifyDepth = (typeof clarifyDepths)[number]

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type Effort = (typeof efforts)[number]

export interface TaskLead {
  agent: AgentKind
  model?: string
  effort?: Effort
}

export interface Attachment {
  hash: string
  name: string
  size: number
  mediaType: string
}

export interface TaskDefaults {
  lead: TaskLead
  clarifyDepth: ClarifyDepth
}

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
  description: string
  priority: Priority
  clarifyDepth: ClarifyDepth
  lead?: TaskLead
  blockedBy: string[]
  attachments: Attachment[]
  stage: StageId
  branch?: string
  leadRunId?: string
  status?: TaskStatus
  markers: TaskMarker[]
  activity?: string
  track: TrackStage[]
  runs: TaskRun[]
  repos: TaskRepo[]
  createdAt: string
}

export type WorktreeCommandOutcome = 'passed' | 'failed' | 'timed-out'

export interface CopySkip {
  path: string
  reason: 'no-local-folder' | 'local-folder-missing' | 'missing' | 'outside' | 'not-a-file'
}

export interface TaskRepo {
  name: string
  repo: string
  branch: string
  worktree: string
  copied: string[]
  skipped: CopySkip[]
  setup?: {
    command: string
    state: 'running' | WorktreeCommandOutcome
    exitCode?: number
  }
  removed?: {
    at: string
    teardown?: { command: string; outcome: WorktreeCommandOutcome }
  }
}

export interface CreateTaskRequest {
  title?: string
  description?: string
  factory?: string
  priority?: Priority
  clarifyDepth?: ClarifyDepth
  lead?: TaskLead
  blockedBy?: string[]
  attachments?: Pick<Attachment, 'hash' | 'name' | 'mediaType'>[]
  start?: boolean
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
