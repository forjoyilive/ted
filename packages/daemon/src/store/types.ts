import type {
  AgentKind,
  AgentStageId,
  ArchiveAsk,
  AsanaMissing,
  AsanaUnfinished,
  Attachment,
  BacklogWait,
  Banner,
  BlockerEnded,
  CheckResult,
  ClarifyDepth,
  CleanupFailureAsk,
  Comment,
  CommentAnswer,
  CommentAuthor,
  CommentKind,
  CopySkip,
  DeclaredSendBackCause,
  DesignReview,
  DiffRow,
  Effort,
  Factory,
  FailureCase,
  LayerKind,
  LinearTeam,
  LineSide,
  MemoryKillAsk,
  Priority,
  Proposal,
  QueuedAfter,
  RequestPurpose,
  Round,
  RunEnding,
  RunProblem,
  RunState,
  SizeCheck,
  StageEntry,
  StageId,
  Task,
  TaskAsanaSource,
  TaskGitHubSource,
  TaskLead,
  TaskSource,
} from '@ted/protocol'
import type { MoveAsk } from '@ted/protocol/task-move'
import type { QueueEntry } from '../tasks/queue.ts'
import type { AgentsArea } from './agents.ts'
import type { AppsArea } from './apps.ts'
import type { ChecksArea } from './checks.ts'
import type { linearSteps } from './context.ts'
import type { FactoriesArea } from './factories.ts'
import type { MachineArea } from './machine.ts'
import type { MergeArea } from './merge.ts'
import type { PhonesArea } from './phones.ts'
import type { RequestsArea } from './requests.ts'
import type { RunsArea } from './runs.ts'
import type { runs } from './schema.ts'
import type { TaskHistory } from './task-history.ts'
import type { TaskTreeArea } from './task-tree.ts'
import type { TasksArea } from './tasks.ts'
import type { TrackersArea } from './trackers.ts'

export type LinearStep = (typeof linearSteps)[number]

export interface LinearSeen {
  stateType: string
  state: string
  team: string
}

export interface LinearSyncRecord {
  seen?: LinearSeen
  step?: LinearStep
  linked: Set<string>
  allowed: boolean
  allowedTeams: Set<string>
}

export interface TrackerSeen {
  closed: boolean
  state: string
  group?: string
}

export interface TrackerSyncRecord {
  seen?: TrackerSeen
  step?: string
  moved?: { state?: string; at: string }
  linked: Set<string>
  allowed: boolean
  allowedAccount?: string
  declined?: boolean
  allowedGroups: Map<string, string | undefined>
  groups?: readonly string[]
}

export interface GitHubNoticeRecord {
  key: string
  sig: string
  kind: string
  where: string
}

export interface RunOutput {
  toOffset: number
  output?: { lastAt?: string }
  state?: RunState
  sessionId?: string
  problem?: RunProblem
  permissionPrompts?: NewPermissionPrompt[]
  closedPermissions?: string[]
  autoModeUnavailable?: boolean
  agentRestarted?: boolean
  ending?: RunEnding
  memoryKilled?: { lowestMemory: number }
  retrying?: boolean
}

export interface LeadFailure {
  taskId: string
  runId: string
  reason: string
  recovery: 'resume' | 'fresh' | 'failed'
  resumeFailed: boolean
  ask?: { title: string; body: string }
  mergeAnyway?: boolean
}

export interface LeadMessage {
  id: string
  text: string
  waitForSlot?: true
  after?: QueuedAfter
  heldAt?: string
}

export interface CheckWork {
  running: string[]
  waiting: ReadonlyMap<string, number>
  scheduled: { running: number; waiting: number }
}

export interface QueueActivity {
  taskPlaces?: readonly { id: string; place: number; skipsBusy?: true }[]
  backlogWaits?: ReadonlyMap<string, BacklogWait>
  startHolds?: ReadonlyMap<string, string>
  queuedTasks: readonly string[]
  queuedRuns: readonly string[]
  startingRuns: readonly string[]
  startingTasks: readonly string[]
}

export interface NewPermissionPrompt {
  requestId: string
  generation: number
  details?: string
  cwd?: string
  title: string
  command: string
  reason?: string
  input?: unknown
}

export interface PermissionTarget {
  runId: string
  requestId: string
  generation: number
  command: string
  input?: unknown
}

export interface RunFlags {
  model?: string
  effort?: Effort
  usesDefaultModel?: boolean
}

export interface StoredFactoryRepo {
  repo: string
  name: string
  cloneUrl: string
}

export interface StoredFactory extends Omit<Factory, 'repos' | 'cloned' | 'setup' | 'localFolder'> {
  autoStartBacklog: boolean
  cloneUrl: string
  repos: StoredFactoryRepo[]
  clonedAt?: string
}

export interface NewFactory {
  key: string
  name: string
  repos: StoredFactoryRepo[]
  defaultBranch: string
}

export interface StoredTask extends Task {
  pendingLeadMessages: LeadMessage[]
  leadRestartPending: boolean
  forcedGates: AgentStageId[]
  changesSettings: boolean
  worktree?: string
  startRequested: boolean
  waitsForBlockers: boolean
  stopped: boolean
  createdByTaskId?: string
}

export interface SeenStageFile {
  hash: string
  layer: LayerKind
  stage: AgentStageId
  text: string
  tedVersion: string
}

export type StopReason = 'human' | 'blockers-removed' | 'repair-incorporation' | 'prepared'

export interface BlockerLink {
  kind?: 'child' | 'asana'
  satisfied?: boolean
  blockerId: string
  displayId: string
  merged: boolean
  ended?: BlockerEnded
  setByRunId?: string
  at: string
}

export type AfterBlocking = 'backlog' | 'wait'

export type BlockersCleared = 'merged' | 'removed'

export type StartCause =
  | {
      cause:
        | 'factory-setting'
        | 'snooze'
        | 'coordinator'
        | 'automation'
        | 'blockers-removed'
        | 'task-lead-child'
    }
  | { cause: 'blockers-merged'; blockers: readonly string[] }

export interface RepairApproval {
  drafts?: readonly string[]
  startStage?: StageId
  failure: FailureCase
  request: import('@ted/protocol').ResolveFailureRequest
  brief: string
}

export type TreeRef = { key: string } | { taskId: string }

export interface NewTreeTask {
  key: string
  parent?: TreeRef
  title: string
  description: string
  priority: Priority
  lead?: TaskLead
  startRequested: boolean
  attachments: Attachment[]
  sourceUrl: string
  asana?: TaskAsanaSource
  github?: TaskGitHubSource
  automation?: { automationId: string; firingId: string }
  syncAccount?: string
  syncDeclined?: boolean
  projects?: readonly string[]
}

export interface NewTaskTree {
  factoryId: string
  tasks: readonly NewTreeTask[]
  links: readonly { taskId: string; parent: TreeRef }[]
  comments: readonly (Omit<NewComment, 'taskId'> & { task: TreeRef })[]
  closings?: readonly { commentId: string; answer: CommentAnswer }[]
  draftRevision?: string
}

export interface NewTask {
  draftRevision?: string
  repairApproval?: RepairApproval
  title: string
  factoryId?: string
  description?: string
  priority?: Priority
  clarifyDepth?: ClarifyDepth
  lead?: TaskLead
  startRequested?: boolean
  blockedBy?: string[]
  parentId?: string
  attachments?: Attachment[]
  source?: TaskSource
  followUpOf?: string
  forcedGates?: AgentStageId[]
  changesSettings?: boolean
  splitFrom?: string
  automation?: { automationId: string; firingId: string }
  checkFailure?: string
  plan?: { planId: string; row: number }
  setup?: boolean
  coordinatorOperation?: string
  phoneCreate?: { phoneId: string; createId: string }
  taskLead?: { creatorId: string; runId: string; child: boolean }
  linearConsent?: boolean
  children?: readonly NewTreeTask[]
  notes?: readonly { task?: TreeRef; body: string }[]
}

export interface PlannedStage {
  stage: AgentStageId
  enabled: boolean
  name?: string
}

export type NewStageEntry = Pick<StageEntry, 'stageFile' | 'layers'> & {
  order: PlannedStage[]
  effort?: Effort
}

export interface NewWorktree {
  name: string
  repo: string
  copied: string[]
  skipped: CopySkip[]
}

export interface SubAgentRequest {
  id: string
  taskId: string
  parentRunId: string
  name: string
  agent: AgentKind
  model?: string
  effort?: Effort
  prompt: string
  ownWorktree: boolean
  at: string
}

export type ReviewerPurpose = 'review' | 'loop-check' | 'instruction-check' | 'run-now-check'

export interface Reviewer {
  runId: string
  taskId: string
  stage: StageId
  purpose: ReviewerPurpose
  agent: AgentKind
  unavailable?: AgentKind
  at: string
}

export interface RepoCommit {
  name: string
  commit: string
}

export interface ReviewScope {
  runId: string
  taskId: string
  scope: 'full' | 'fixes' | 'conflict'
  round: number
  commits: RepoCommit[]
  since?: RepoCommit[]
  at: string
}

export interface FoundConflict {
  stage: StageId
  repo: string
  base: string
  tip: string
  fileCount: number
  files: readonly string[]
}

export type LoopVerdict = 'converging' | 'looping' | 'failed'

export interface LoopCheck {
  runId: string
  taskId: string
  to: AgentStageId
  findings: string
  checkRunId?: string
  round: number
  limit?: number
  verdict?: LoopVerdict
  cause?: DeclaredSendBackCause
  at: string
}

export interface SendBackAsk {
  commentId: string
  taskId: string
  from: AgentStageId
  to: AgentStageId
  findings: string
  checkRunId?: string
  loop: boolean
  cause?: DeclaredSendBackCause
  at: string
}

export interface QueuedTask extends QueueEntry {
  kind: 'task' | 'setup-task'
  priority: Priority
  factoryId: string
}

export interface RecordedSetup {
  command: string
  timeoutMs: number
  env: Record<string, string>
}

export interface AcceptedLayer {
  files: Record<string, string | null>
  version: string
  acceptedAt: string
}

export interface MoveTaskInput {
  moves: { taskId: string; factoryId: string; started: boolean }[]
  unlink: { taskId: string; blockerId: string }[]
  leaveParent?: string
  notes: { taskId: string; body: string }[]
  by: 'human' | 'coordinator'
}

export interface NewComment {
  purpose?: RequestPurpose
  taskId: string
  body: string
  author: CommentAuthor
  kind?: CommentKind
  title?: string
  choices?: string[]
  multiple?: true
  round?: Round
  proposal?: Proposal
  sizeCheck?: SizeCheck
  gate?: NonNullable<Comment['gate']>
  attachments?: readonly Attachment[]
  lineComments?: readonly string[]
  design?: DesignReview
  linearTeam?: LinearTeam
  asanaMissing?: AsanaMissing
  asanaUnfinished?: AsanaUnfinished
  archive?: ArchiveAsk
  move?: MoveAsk
  cleanupFailure?: CleanupFailureAsk
  memoryKill?: MemoryKillAsk
}

export interface NewLineComment {
  taskId: string
  repo: string
  path: string
  side: LineSide
  start: number
  end: number
  commit: string
  quoted: readonly DiffRow[]
  body: string
}

export interface CleanupCommandResult {
  step: string
  state: 'passed' | 'failed' | 'timed-out'
  exitCode?: number
  timeout: string
  durationMs: number
  output: string
}

export type PlannedCheck = Omit<CheckResult, 'exitCode' | 'durationMs' | 'noReport'>

export interface LoggedEvent {
  id: string
  name: string
  data: Record<string, unknown>
  at: string
}

export interface RunSteeringRelease {
  messageIds: string[]
  first?: string
  holdId?: string
}

export interface RunInterrupt {
  id: string
  runId: string
  hold: boolean
  at: string
}

export interface HeldRun {
  taskId: string
  agent: AgentKind
  sessionId?: string
  pickUp?: string
  carried?: CarriedMessages
}

export interface CarriedMessages {
  runId: string
  messageIds: readonly string[]
}

export type RunRow = Omit<typeof runs.Type, 'prompt' | 'promptParts'>

// LiveStore keeps every query result in memory, so lists leave the long text columns out.

export type NewBanner = Omit<Banner, 'raisedAt' | 'dismissedUntil' | 'dismissed'>

export interface OpenProgress {
  done: number
  total: number
}

export interface StoredPermission {
  requestId: string
  generation?: number
  command: string
  details?: string
  repo?: string
  input?: string
}

export interface TedStore
  extends TaskHistory,
    AgentsArea,
    AppsArea,
    ChecksArea,
    FactoriesArea,
    MachineArea,
    MergeArea,
    PhonesArea,
    RequestsArea,
    RunsArea,
    TaskTreeArea,
    TasksArea,
    TrackersArea {}
