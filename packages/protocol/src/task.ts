import type { SimulatorAsk } from './app.ts'
import type { LineComment } from './changes.ts'
import type { ChatDiff, ConversationTab } from './chat.ts'
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

export function clarifyIsOver(stage: StageId): boolean {
  return stage !== 'backlog' && stage !== 'intake' && stage !== 'clarify'
}

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
  planner: TaskLead
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

export const createdByKinds = [
  'human',
  'automation',
  'planning',
  'split',
  'follow-up',
  'setup',
] as const

export type CreatedBy = (typeof createdByKinds)[number]

export type TaskEnding =
  | { kind: 'never-started' }
  | { kind: 'merged'; at: string }
  | { kind: 'pull-request-closed'; at: string }
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
  sentry?: { shortId: string }
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
  setup?: true
  followUpOf?: TaskLink
  splitFrom?: TaskLink
  fromPlan?: { id: string; title: string; deleted?: boolean }
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
  attachments?: AttachmentRef[]
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

export interface EditTaskRequest {
  title?: string
  description?: string
}

export interface DescriptionVersion {
  version: number
  text: string
  at: string
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
  closedOnGitHub?: string
  preview?: PullRequestPreview
}

export interface PullRequestPreview {
  url: string
  source: 'deployment' | 'status'
  label: string
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
  attachments?: AttachmentRef[]
  source?: string
  sentryId?: string
  followUp?: string
  start?: boolean
}

export interface ResumeTaskRequest {
  comment?: string
  attachments?: AttachmentRef[]
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

export interface ProposalRow {
  title: string
  scope: string
  description?: string
  priority: Priority
  blockedBy: number[]
}

export interface Proposal {
  rows: ProposalRow[]
  firstPiece?: TaskLink
}

export interface ProposalRowInput {
  title: string
  scope: string
  description?: string
  priority?: Priority
  blockedBy?: number[]
}

export interface ProposalInput {
  title: string
  summary?: string
  tasks: ProposalRowInput[]
}

export interface ProposalChoice {
  skip?: number[]
  startUnblocked?: boolean
}

export interface ProposalCreated {
  tasks: { row: number; id: string; displayId: string }[]
  skipped: number[]
  startUnblocked: boolean
}

export const sizeChoices = {
  chat: 'Plan in chat',
  split: 'Split it',
  outside: 'Plan it outside TED',
  grill: 'Grill anyway',
} as const

export interface SizeCheck {
  settle: string[]
}

export interface SizeCheckInput {
  why: string
  settle: string[]
}

export interface RoundAnswer {
  answer: string
  note?: string
  changed: boolean
}

export interface RoundTalk {
  runId: string
  startedAt: string
  doneAt?: string
}

export interface TalkedThrough {
  runId: string
  summaryId: string
  messages: number
}

export interface CloseRoundRequest {
  summary: string
}

export interface RoundAnswerInput {
  answer: string
  note?: string
}

export type CommentAnswer =
  | { kind: 'approved'; at: string; text?: string; created?: ProposalCreated; shutDown?: string }
  | { kind: 'changes-requested'; at: string; text: string }
  | {
      kind: 'answered'
      at: string
      choice?: string
      text?: string
      answers?: RoundAnswer[]
      talkedThrough?: TalkedThrough
      planId?: string
    }
  | { kind: 'withdrawn'; at: string; movedTo: StageId }
  | { kind: 'withdrawn'; at: string; archived: true }
  | { kind: 'withdrawn'; at: string; runStopped: true }
  | { kind: 'withdrawn'; at: string; cancelled: true }
  | { kind: 'withdrawn'; at: string; ciReported: true }
  | { kind: 'withdrawn'; at: string; slotFreed: true }
  | { kind: 'withdrawn'; at: string; appGone: true }
  | { kind: 'withdrawn'; at: string; linear: 'reopened' | 'done' }
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
  talk?: RoundTalk
  proposal?: Proposal
  sizeCheck?: SizeCheck
  gate?: CommentGate
  permission?: PermissionAsk
  simulator?: SimulatorAsk
  answer?: CommentAnswer
  delivered?: { runId: string; at: string }
  readAt?: string
  failed?: { runId: string }
  attachments?: Attachment[]
  lineComments?: LineComment[]
  design?: DesignReview
  tutorial?: true
}

export interface DesignFile {
  hash: string
  name: string
  caption?: string
}

export interface DesignReview {
  summary?: string
  screenshots?: DesignFile[]
  video?: DesignFile
  prototype?: DesignFile
  figma?: { url: string; label?: string }
  worthYourEye?: string[]
  setup?: SetupProposal
}

export interface SetupProposal {
  workflow: SetupStageLine[]
  checks: SetupCheckTried[]
  apps: SetupAppTried[]
  files: SetupFileLine[]
  defaults?: string
}

export interface SetupStageLine {
  stage: StageId
  setting?: string
}

export interface SetupCheckTried {
  name: string
  command: string
  repo?: string
  passed: boolean
  durationMs: number
  reason?: string
}

export interface SetupAppTried {
  name: string
  repo?: string
  kind: string
  run?: string
  ready: string
  passed: boolean
  reason?: string
}

export interface SetupFileLine {
  path: string
  about: string
}

export type DesignFileInput = AttachmentRef & { caption?: string }

export interface DesignReviewInput {
  title?: string
  summary?: string
  screenshots?: DesignFileInput[]
  video?: DesignFileInput
  prototype?: DesignFileInput
  figma?: { url: string; label?: string }
  worthYourEye?: string[]
  setup?: SetupProposal
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
  attachments?: AttachmentRef[]
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
  changes?: ChatDiff
  planId?: string
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
  | { action: 'approve'; text?: string; proposal?: ProposalChoice; simulator?: string }
  | { action: 'request-changes'; text: string }
  | { action: 'deny'; text?: string }
  | { action: 'answer'; choice?: string; text?: string }
  | { action: 'answer-round'; answers: RoundAnswerInput[] }
  | { action: 'accept-recommended' }

export type AttachmentRef = Pick<Attachment, 'hash' | 'name' | 'mediaType'>

export interface PostCommentRequest {
  body?: string
  choices?: string[]
  round?: RoundInput
  proposal?: ProposalInput
  sizeCheck?: SizeCheckInput
  supersedes?: string
  attachments?: AttachmentRef[]
  tutorial?: boolean
}

export interface AttachmentBytes {
  data: string
}

export interface SetActivityRequest {
  text: string
}

export type ReportOutcomeRequest =
  | {
      outcome: 'advance'
      skip?: boolean
      judged?: ValidateJudgments
      changes?: string
      design?: DesignReviewInput
    }
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
