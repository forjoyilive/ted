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
  paused?: string
}

export interface TaskSource {
  url: string
  linear?: {
    identifier: string
    title: string
    branchName?: string
    description?: string
  }
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
  source?: TaskSource
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
  source?: string
  start?: boolean
}

export interface BlockTaskRequest {
  by: string
}

export const commentKinds = [
  'note',
  'question',
  'round',
  'review',
  'signoff',
  'permission',
  'proposal',
] as const

export type CommentKind = (typeof commentKinds)[number]

export type CommentAuthor = { kind: 'human' } | { kind: 'run'; runId: string } | { kind: 'ted' }

export type CommentAnswer =
  | { kind: 'approved'; at: string; text?: string }
  | { kind: 'changes-requested'; at: string; text: string }
  | { kind: 'answered'; at: string; choice?: string; text?: string }
  | { kind: 'withdrawn'; at: string; movedTo: StageId }
  | { kind: 'superseded'; at: string; by: string }

export interface Comment {
  id: string
  taskId: string
  kind: CommentKind
  body: string
  author: CommentAuthor
  createdAt: string
  stage?: StageId
  title?: string
  choices?: string[]
  gate?: { approveLabel: string; caption?: string }
  answer?: CommentAnswer
}

export interface InboxItem {
  request: Comment
  task: Task
}

export type AnswerRequest =
  | { action: 'approve'; text?: string }
  | { action: 'request-changes'; text: string }
  | { action: 'answer'; choice?: string; text?: string }

export interface PostCommentRequest {
  body: string
  choices?: string[]
  supersedes?: string
}

export interface SetActivityRequest {
  text: string
}

export type ReportOutcomeRequest =
  | { outcome: 'advance'; skip?: boolean }
  | { outcome: 'back'; to: AgentStageId; findings: string }
  | { outcome: 'ask'; question: string; choices?: string[] }

export type Outcome = ReportOutcomeRequest['outcome']

export interface OutcomeResult {
  task: Task
  message: string
  request?: Comment
}

export const briefHeadings = [
  'Goal',
  'Decisions so far',
  'Current state',
  'Open questions',
  'Next step',
] as const

export interface TaskBrief {
  taskId: string
  version: number
  text: string
  stage: StageId
  runId?: string
  createdAt: string
}

export interface WriteBriefRequest {
  text: string
}

export type SetTaskLeadRequest = TaskLead
