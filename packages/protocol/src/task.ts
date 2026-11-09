import type { ConversationTab } from './chat.ts'
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

export type ClarifyDepthChooser = 'human' | 'task-lead'

export interface SetClarifyDepthRequest {
  depth: ClarifyDepth
  why?: string
}

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type Effort = (typeof efforts)[number]

export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(value)
}

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

export const taskStatusKinds = [
  'failed',
  'partly-merged',
  'waiting-on-you',
  'paused',
  'working',
  'stopped',
  'blocked',
  'queued',
  'waiting-for-github',
] as const

export type TaskStatusKind = (typeof taskStatusKinds)[number]

export const createdByKinds = ['human', 'automation', 'planning', 'split', 'follow-up'] as const

export type CreatedBy = (typeof createdByKinds)[number]

export type TaskEnding =
  | { kind: 'never-started' }
  | { kind: 'merged'; at: string }
  | { kind: 'stopped'; stage: StageId }

export interface TaskArchive {
  at: string
  ended: TaskEnding
}

export type TaskStatus =
  | { kind: 'failed' }
  | { kind: 'partly-merged' }
  | { kind: 'waiting-on-you' }
  | { kind: 'paused'; reason: string }
  | { kind: 'working' }
  | { kind: 'stopped'; at?: string }
  | { kind: 'blocked'; by: string; ended?: BlockerEnded }
  | { kind: 'queued'; place: number }
  | { kind: 'queued'; hold: string }
  | { kind: 'waiting-for-github'; on: GitHubWait }

export type BlockerEnded = 'archived' | 'deleted'

export type TaskMarker =
  | { kind: 'blocked-by'; by: string; ended?: BlockerEnded }
  | { kind: 'needs-planning' }

export type TrackState = 'past' | 'current' | 'skipped' | 'future'

export interface TrackStage {
  stage: AgentStageId
  state: TrackState
}

export type CommentBox =
  | 'live'
  | 'paused'
  | 'no-run'
  | 'stopped'
  | 'failed'
  | 'done'
  | 'merge-pending'
  | 'archived'

export interface TaskRun {
  id: string
  agent: AgentKind
  role: 'lead' | 'sub-agent'
  name: string
  state: RunState
  paused?: string
  onSubAgents?: boolean
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
  clarifyDepthBy?: ClarifyDepthChooser
  lead?: TaskLead
  blockedBy: string[]
  attachments: Attachment[]
  source?: TaskSource
  stage: StageId
  branch?: string
  leadRunId?: string
  rank: number
  status?: TaskStatus
  statuses: TaskStatusKind[]
  markers: TaskMarker[]
  activity?: string
  track: TrackStage[]
  commentBox: CommentBox
  runs: TaskRun[]
  tabs: ConversationTab[]
  repos: TaskRepo[]
  chosenRepos: string[]
  createdBy: CreatedBy
  followUpOf?: TaskLink
  merged?: TaskMerged
  createdAt: string
  updatedAt: string
  archived?: TaskArchive
}

export interface TaskLink {
  id: string
  displayId: string
}

export interface TaskMerged {
  at: string
  pullRequests: number[]
}

export interface FollowUpRequest {
  comment?: string
}

export interface ArchiveDoneResult {
  archived: number
}

export interface MoveTaskRequest {
  after?: string
  before?: string
}

export type SetTaskReposRequest =
  | { set: string[]; confirm?: boolean }
  | { add: string[] }
  | { remove: string[]; confirm?: boolean }

export interface RepoToConfirm {
  name: string
  commits: number
}

export interface TaskReposResult {
  task: Task
  confirm?: RepoToConfirm[]
  repos: string[]
  added: string[]
  removed: string[]
}

export interface RepoSetupReport {
  name: string
  worktree?: string
  state: 'none' | 'running' | WorktreeCommandOutcome
  command?: string
  exitCode?: number
  output: string
}

export interface SetPriorityRequest {
  priority: Priority
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
  pushed?: TaskPush
  pushFailed?: { message: string; at: string }
  pullRequest?: TaskPullRequest
}

export const ciSignals = ['workflow-files', 'required-checks', 'recent-checks'] as const

export type CiSignal = (typeof ciSignals)[number]

export interface TaskPush {
  commit: string
  at: string
  ci: boolean
  ciSignals: CiSignal[]
}

export const mergeMethods = ['squash', 'merge', 'rebase'] as const

export type MergeMethod = (typeof mergeMethods)[number]

export interface TaskPullRequest {
  number: number
  url: string
  base: string
  state: 'draft' | 'ready' | 'merged' | 'closed'
  merged?: { at: string; method?: MergeMethod; noCi: boolean }
  autoMerge?: MergeMethod
  waiting?: GitHubWait
  signedOff?: string
}

export const blockedChoices = ['unblock', 'keep'] as const

export type BlockedChoice = (typeof blockedChoices)[number]

export interface ArchiveTaskRequest {
  closePullRequests?: boolean
  blocked?: BlockedChoice
}

export interface DeleteTaskRequest {
  blocked?: BlockedChoice
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

export interface ResumeTaskRequest {
  comment?: string
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

export interface RoundQuestion {
  question: string
  choices?: string[]
  recommended: string
}

export interface Round {
  number: number
  questions: RoundQuestion[]
}

export interface RoundInput {
  title: string
  summary?: string
  questions: RoundQuestion[]
}

export interface RoundAnswer {
  answer: string
  note?: string
  changed: boolean
}

export interface RoundAnswerInput {
  answer: string
  note?: string
}

export type CommentAnswer =
  | { kind: 'approved'; at: string; text?: string }
  | { kind: 'changes-requested'; at: string; text: string }
  | { kind: 'answered'; at: string; choice?: string; text?: string; answers?: RoundAnswer[] }
  | { kind: 'withdrawn'; at: string; movedTo: StageId }
  | { kind: 'withdrawn'; at: string; archived: true }
  | { kind: 'withdrawn'; at: string; runStopped: true }
  | { kind: 'withdrawn'; at: string; cancelled: true }
  | { kind: 'withdrawn'; at: string; ciReported: true }
  | { kind: 'denied'; at: string; text?: string }
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
  round?: Round
  gate?: CommentGate
  permission?: PermissionAsk
  answer?: CommentAnswer
  delivered?: { runId: string; at: string }
  readAt?: string
  failed?: { runId: string }
}

export interface CommentGate {
  approveLabel: string
  caption?: string
  pullRequests?: MergeRow[]
  changes?: SignOffChanges
}

export interface MergeRow {
  name: string
  repo: string
  number: number
  title: string
  url: string
  checks: { passed: number; failed: number; pending: number }
  mergeable: boolean
  method: MergeMethod
  reviewMissing: boolean
}

export interface SignOffChanges {
  since: string
  summary?: string
  repos: { name: string; files: ChangedFile[]; unavailable?: boolean }[]
}

export interface ChangedFile {
  path: string
  added: number
  removed: number
}

export interface CancelMergeRequest {
  comment: string
}

export interface PermissionAsk {
  command: string
  details?: string
  repo?: string
}

export type ThreadEventTone = 'edit' | 'done' | 'run' | 'failure' | 'quiet' | 'request'

export interface ThreadEvent {
  id: string
  taskId: string
  at: string
  tone: ThreadEventTone
  text: string
  findings?: string
  runId?: string
  checkRunId?: string
  judgments?: Judgment[]
  validate?: 'passed' | 'sent-back'
}

export interface Judgment {
  name: 'Review' | 'Visual'
  passed: boolean
  notes?: number
}

export interface ValidateJudgments {
  review?: { passed: boolean; notes?: number }
  visual?: { passed: boolean; notes?: number }
}

export interface InboxItem {
  request: Comment
  task: Task
}

export type AnswerRequest =
  | { action: 'approve'; text?: string }
  | { action: 'request-changes'; text: string }
  | { action: 'deny'; text?: string }
  | { action: 'answer'; choice?: string; text?: string }
  | { action: 'answer-round'; answers: RoundAnswerInput[] }
  | { action: 'accept-recommended' }

export interface PostCommentRequest {
  body?: string
  choices?: string[]
  round?: RoundInput
  supersedes?: string
}

export interface SetActivityRequest {
  text: string
}

export type ReportOutcomeRequest =
  | { outcome: 'advance'; skip?: boolean; judged?: ValidateJudgments; changes?: string }
  | { outcome: 'back'; to: AgentStageId; findings: string; judged?: ValidateJudgments }
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
