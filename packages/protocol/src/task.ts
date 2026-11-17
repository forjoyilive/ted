import type { SimulatorAsk } from './app.ts'
import type { AsanaSync } from './asana-sync.ts'
import type { LineComment } from './changes.ts'
import type { ChatDiff, ConversationTab } from './chat.ts'
import type { DeclaredSendBackCause, FindingSeverity } from './checks.ts'
import type { ValidationSnapshot } from './failures.ts'
import type { LinearTeam } from './linear.ts'
import type { AgentKind, RunState } from './run.ts'
import type { SetupAgentProposal } from './setup-agents.ts'
import type { BusyHold } from './slots.ts'
import type { AgentStageId, StageId } from './stage.ts'
import { RequestValidationError } from './validation.ts'

export {
  type AgentStageId,
  agentStageIds,
  type BuiltInAgentStageId,
  type BuiltInStageId,
  clarifyIsOver,
  isCustomStageId,
  type StageId,
  stageDisplayName,
} from './stage.ts'

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
  effortMode?: 'stage'
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

export type GitHubWait = 'ci' | 'review' | 'merge' | 'sign-in' | 'rerun' | 'required-check'

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
  'coordinator',
  'task-lead',
] as const

export type CreatedBy = (typeof createdByKinds)[number]

export type TaskEnding =
  | { kind: 'never-started' }
  | { kind: 'merged'; at: string }
  | { kind: 'pull-request-closed'; at: string }
  | { kind: 'stopped'; stage: StageId }

export interface ArchiveExpiry {
  due: number
  kept: number
}

export interface TaskArchive {
  at: string
  ended: TaskEnding
}

export type TaskStatus =
  | { kind: 'failed' }
  | { kind: 'partly-merged' }
  | { kind: 'waiting-on-you'; snoozedUntil?: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'working' }
  | { kind: 'stopped'; at?: string; prepared?: true }
  | { kind: 'blocked'; by: string; ended?: BlockerEnded }
  | { kind: 'queued'; place: number; after?: QueuedAfter }
  | { kind: 'queued'; hold: string; busy?: BusyHold }
  | { kind: 'waiting-for-github'; on: GitHubWait }

export type QueuedAfter = 'checks-passed' | 'checks-done' | 'answer'

export type BlockerEnded = 'archived' | 'deleted'

export type TaskMarker =
  | { kind: 'blocked-by'; by: string; ended?: BlockerEnded }
  | { kind: 'snoozed'; until: string }
  | { kind: 'needs-planning' }
  | { kind: 'preparing' }
  | {
      kind: 'test-activity'
      source: 'tests' | 'checks'
      phase: 'running' | 'waiting'
      label: string
      detail: string
    }

export type TrackState = 'past' | 'current' | 'skipped' | 'future'

export interface TrackStage {
  stage: AgentStageId
  name?: string
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

export type CommentDelivery = 'starting' | 'queued' | 'paused'

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
  asana?: TaskAsanaSource
  github?: import('./github-issue.ts').TaskGitHubSource
}

export interface TaskAsanaSource {
  gid: string
  title: string
  assignee?: import('./asana-import.ts').AsanaPerson
  completed: boolean
  importedAt: string
  context: string
  children: { gid: string; name: string; url: string; completed: boolean }[]
}

export interface SetTaskSnoozeRequest {
  snoozedUntil: string | null
}

export function parseSetTaskSnoozeRequest(value: unknown): SetTaskSnoozeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError(400, 'body must be a JSON object')
  }
  const until = (value as Record<string, unknown>).snoozedUntil
  if (until === null) return { snoozedUntil: null }
  if (
    typeof until !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until) ||
    !Number.isFinite(Date.parse(until)) ||
    new Date(until).toISOString() !== until
  ) {
    throw new RequestValidationError(400, 'snoozedUntil must be an ISO instant or null')
  }
  return { snoozedUntil: until }
}

export interface SnoozeRequestRequest {
  until: string | null
}

export function parseSnoozeRequestRequest(value: unknown): SnoozeRequestRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError(400, 'body must be a JSON object')
  }
  const until = (value as Record<string, unknown>).until
  if (until === null) return { until: null }
  if (
    typeof until !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until) ||
    !Number.isFinite(Date.parse(until)) ||
    new Date(until).toISOString() !== until
  ) {
    throw new RequestValidationError(400, 'until must be an ISO instant or null')
  }
  return { until }
}

export interface Task {
  snoozedUntil?: string
  autopilot?: import('./autopilot.ts').TaskAutopilot
  gateOverrides?: import('./task-gates.ts').TaskGateOverrides
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
  stageEffort?: Effort
  blockedBy: string[]
  parentId?: string
  childIds?: string[]
  attachments: Attachment[]
  source?: TaskSource
  linearSync?: 'on' | 'ask'
  asanaSync?: AsanaSync
  stage: StageId
  branch?: string
  leadRunId?: string
  rank: number
  status?: TaskStatus
  statusWithoutBlocker?: TaskStatus
  preparation?: 'preparing' | 'ready'
  statuses: TaskStatusKind[]
  markers: TaskMarker[]
  activity?: string
  track: TrackStage[]
  commentBox: CommentBox
  commentDelivery?: CommentDelivery
  canResume?: boolean
  wakesOnComment?: true
  checksActive?: true
  runs: TaskRun[]
  tokens?: number
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
  startedAt?: string
  updatedAt: string
  archived?: TaskArchive
}

export interface CreatedTask extends Task {
  reminder?: string
}

export type ResetRefusal = 'archived' | 'done' | 'merged' | 'not-started'

export function resetRefusal(
  task: Pick<Task, 'archived' | 'stage' | 'statuses' | 'merged' | 'repos' | 'runs'>,
): ResetRefusal | undefined {
  if (task.archived) return 'archived'
  if (task.stage === 'done') return 'done'
  if (
    task.merged ||
    task.statuses.includes('partly-merged') ||
    task.repos.some((r) => r.pullRequest?.state === 'merged')
  ) {
    return 'merged'
  }
  if (task.stage === 'backlog' && task.runs.length === 0 && task.repos.length === 0) {
    return 'not-started'
  }
  return undefined
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

export const ciSignals = [
  'workflow-files',
  'required-checks',
  'recent-pull-requests',
  'recent-checks',
] as const

export type CiSignal = (typeof ciSignals)[number]

export const pullRequestCiModes = ['auto', 'none', 'required'] as const

export type PullRequestCiMode = (typeof pullRequestCiModes)[number]

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

export interface TaskHierarchy {
  parentId: string | null
  childIds: string[]
  revision: string
}

export interface SetTaskParentRequest {
  parentId: string | null
  revision: string
}

export interface TaskHierarchyPreview {
  revision: string
  descendants: (TaskLink & { title: string })[]
  archivedWith: string[]
}

export interface UnarchiveTaskRequest {
  unlinkParent?: boolean
  children?: 'restore'
  hierarchyRevision?: string
}

export interface ArchiveTaskRequest {
  children?: 'archive' | 'detach'
  hierarchyRevision?: string
  closePullRequests?: boolean
}

export interface DeleteTaskRequest {
  children?: 'delete' | 'unparent'
  hierarchyRevision?: string
}

export interface NewTaskDraft {
  revision: string
  title: string
  description: string
  priority: Priority
  blockedBy: string[]
  parent?: string | undefined
  attachments: Attachment[]
  start: boolean
  startChosen?: boolean | undefined
  moreOpen: boolean
  clarifyDepth?: ClarifyDepth | undefined
  lead?: TaskLead | undefined
  source?: string | undefined
  dismissed: string[]
  filled: { title?: string; priority?: Priority }
}

export interface TaskDraftState {
  draft: NewTaskDraft | null
  clearedRevision?: string
  clearedRevisions?: string[]
}

export interface StartTaskRequest {
  prepare?: boolean
}

export interface CreateTaskRequest {
  draftRevision?: string
  title?: string
  description?: string
  factory?: string
  priority?: Priority
  clarifyDepth?: ClarifyDepth
  lead?: TaskLead
  blockedBy?: string[]
  parent?: string
  child?: boolean
  attachments?: AttachmentRef[]
  source?: string
  sentryId?: string
  followUp?: string
  start?: boolean
  startInBackground?: boolean
}

export interface ResumeTaskRequest {
  comment?: string
  attachments?: AttachmentRef[]
}

export interface TedStoppedTask {
  id: string
  displayId: string
  title: string
  stage: StageId
  factoryId: string
  stoppedAt: string
}

export const maxTedStopAnswers = 1000

export interface AnswerTedStopsRequest {
  restart: string[]
  leave: string[]
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
  multiple?: true
  recommendedChoices?: string[]
}

export const noChoicesPicked = 'None of these'

export const joinChoices = (choices: readonly string[]): string =>
  choices.length === 0 ? noChoicesPicked : choices.join('; ')

export const sameChoices = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((c) => b.includes(c))

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
  // Kept under its stored name: the Task that becomes the parent of every row.
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
  outside: 'Plan it outside Ted',
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
  choices?: string[]
  note?: string
  changed: boolean
}

export interface TalkThroughRequest {
  confirmResume?: boolean
}

export type TalkThroughResult = Comment | { resumeRequired: true }

export interface RoundTalk {
  runId: string
  startedAt: string
  notifiedAt?: string
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
  choices?: string[]
  note?: string
}

export type CommentAnswer =
  | {
      kind: 'approved'
      at: string
      text?: string
      created?: ProposalCreated
      shutDown?: string
      removedAgents?: string[]
    }
  | { kind: 'changes-requested'; at: string; text: string }
  | {
      kind: 'answered'
      at: string
      choice?: string
      choices?: string[]
      text?: string
      answers?: RoundAnswer[]
      talkedThrough?: TalkedThrough
      planId?: string
    }
  | { kind: 'withdrawn'; at: string; movedTo: StageId }
  | { kind: 'withdrawn'; at: string; archived: true }
  | { kind: 'withdrawn'; at: string; movedToFactory: string }
  | { kind: 'withdrawn'; at: string; runStopped: true }
  | { kind: 'withdrawn'; at: string; cancelled: true }
  | { kind: 'withdrawn'; at: string; ciReported: true }
  | { kind: 'withdrawn'; at: string; slotFreed: true }
  | { kind: 'withdrawn'; at: string; appGone: true }
  | { kind: 'withdrawn'; at: string; linear: 'reopened' | 'done' }
  | { kind: 'withdrawn'; at: string; tracker: 'reopened' | 'done' }
  | { kind: 'withdrawn'; at: string; asanaReread: true }
  | { kind: 'denied'; at: string; text?: string }
  | { kind: 'superseded'; at: string; by: string }

export interface TrackerGroup {
  key: string
  name: string
}

export type RequestPurpose =
  | { kind: 'model'; runId: string }
  | { kind: 'tracker-closed'; tracker: string }
  | { kind: 'tracker-group'; tracker: string; group: TrackerGroup }
  | {
      kind:
        | 'question'
        | 'round'
        | 'proposal'
        | 'gate'
        | 'permission'
        | 'simulator'
        | 'size-check'
        | 'send-back'
        | 'failure'
        | 'failed-run'
        | 'linear-closed'
        | 'linear-team'
        | 'asana-missing'
        | 'asana-unfinished'
        | 'cleanup-failure'
        | 'memory-kill'
        | 'archive'
        | 'move'
        | 'idle-run'
        | 'ci-stuck'
    }

const trackerNames: Readonly<Record<string, string>> = {
  linear: 'Linear',
  asana: 'Asana',
  github: 'GitHub',
}

export function trackerName(tracker: string): string {
  return trackerNames[tracker] ?? tracker
}

export function isTrackerGroupAsk(comment: Pick<Comment, 'linearTeam' | 'purpose'>): boolean {
  return comment.linearTeam !== undefined || comment.purpose?.kind === 'tracker-group'
}

export function isTrackerClosedQuestion(comment: Pick<Comment, 'purpose'>): boolean {
  return comment.purpose?.kind === 'linear-closed' || comment.purpose?.kind === 'tracker-closed'
}

export interface Comment {
  autopilotAnswered?: boolean
  held?: true
  peer?: { sender?: string; text: string }
  purpose?: RequestPurpose
  id: string
  taskId: string
  kind: CommentKind
  body: string
  author: CommentAuthor
  createdAt: string
  stage?: StageId
  title?: string
  choices?: string[]
  multiple?: true
  round?: Round
  talkRequested?: true
  talk?: RoundTalk
  proposal?: Proposal
  sizeCheck?: SizeCheck
  gate?: CommentGate
  permission?: PermissionAsk
  simulator?: SimulatorAsk
  answer?: CommentAnswer
  answerDelivery?: { queuedAt: string; sent?: { runId: string; at: string } }
  delivered?: { runId: string; at: string }
  readAt?: string
  failed?: { runId: string }
  attachments?: Attachment[]
  lineComments?: LineComment[]
  design?: DesignReview
  linearTeam?: LinearTeam
  asanaMissing?: import('./asana-import.ts').AsanaMissing
  asanaUnfinished?: import('./asana-import.ts').AsanaUnfinished
  archive?: ArchiveAsk
  move?: import('./task-move.ts').MoveAsk
  cleanupFailure?: CleanupFailureAsk
  memoryKill?: MemoryKillAsk
}

export const memoryRetryChoice = 'Try again'
export const memoryFailedChoice = 'Count it as failed'

export interface MemoryKillAsk {
  checkRunId: string
  position: number
}

export const cleanupRetryChoice = 'Try again'
export const cleanupFinishChoice = 'Finish anyway'

export interface CleanupFailureAsk {
  steps: string[]
}

export const cleanupStepResults = ['done', 'skipped', 'failed'] as const

export type CleanupStepResult = (typeof cleanupStepResults)[number]

export interface SetPullRequestTitleRequest {
  title: string
  body?: string
}

export interface ReportCleanupStepRequest {
  step: string
  result: CleanupStepResult
  text: string
}

export interface CleanupStepReport extends ReportCleanupStepRequest {
  runId: string
  at: string
}

export const archiveChoice = 'Archive'
export const keepArchiveChoice = 'Keep it'

export interface PullRequestAdvice {
  recommend: 'close' | 'keep'
  why: string
}

export interface ArchiveAsk {
  reason: string
  pullRequests?: PullRequestAdvice
}

export type RequestArchiveRequest = ArchiveAsk

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
  agents?: SetupAgentProposal[]
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
  noCi?: string[]
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

export type MarkDoneRequest = Record<string, never>

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
  validation?: ValidationSnapshot
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
  | {
      action: 'approve'
      text?: string
      proposal?: ProposalChoice
      simulator?: string
      removeAgents?: string[]
    }
  | { action: 'request-changes'; text: string }
  | { action: 'deny'; text?: string }
  | {
      action: 'answer'
      choice?: string
      choices?: string[]
      text?: string
      archive?: ArchiveTaskRequest
      move?: import('./task-move.ts').MoveAnswer
    }
  | { action: 'answer-round'; answers: RoundAnswerInput[] }
  | { action: 'accept-recommended' }

export type AttachmentRef = Pick<Attachment, 'hash' | 'name' | 'mediaType'>

export interface PostCommentRequest {
  body?: string
  choices?: string[]
  multiple?: true
  round?: RoundInput
  proposal?: ProposalInput
  sizeCheck?: SizeCheckInput
  supersedes?: string
  attachments?: AttachmentRef[]
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
  | {
      outcome: 'back'
      to: AgentStageId
      findings: string
      judged?: ValidateJudgments
      cause?: DeclaredSendBackCause
      severity?: FindingSeverity
    }
  | { outcome: 'ask'; question: string; choices?: string[]; multiple?: true }

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

export type SaveTaskDraftRequest = Omit<NewTaskDraft, 'attachments'> & {
  attachments: AttachmentRef[]
}

export interface DesignFileSpec {
  path: string
  caption?: string
}

export interface LocalDesignReviewInput
  extends Omit<DesignReviewInput, 'screenshots' | 'video' | 'prototype'> {
  screenshots?: DesignFileSpec[]
  video?: DesignFileSpec
  prototype?: DesignFileSpec
}
