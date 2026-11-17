import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb, StoreInternalsSymbol } from '@livestore/livestore'
import type {
  AgentApiCost,
  ApiCostReport,
  DashboardRange,
  DashboardReport,
  FactoryGroup,
  FactoryGuide,
  FactoryIcon,
  FactoryLayout,
  FactoryLayoutItem,
  GuideEnding,
  MessageBox,
  MessageDraft,
  NewTaskDraft,
  PeerMessage,
  QueuedAfter,
  TaskDraftState,
  TaskGateOverrides,
  TaskIntervalHistory,
} from '@ted/protocol'
import {
  type Activity,
  type AgentKind,
  type AgentStageId,
  type Appearance,
  type AppStarter,
  type ArchiveAsk,
  type AsanaMissing,
  type AsanaSync,
  type AsanaUnfinished,
  type Attachment,
  type AutopilotChoice,
  agentStageIds,
  asanaSyncOf,
  automationCardHeadline,
  autopilotEnabled,
  type Banner,
  type BannerAction,
  type BannerSeverity,
  type BaseConflictFound,
  type BlockerEnded,
  type BusyHold,
  bannerOrder,
  busyHold,
  type CheckResult,
  type CheckRun,
  type CheckRunOutcome,
  type CheckRunTiming,
  type CheckRunTrigger,
  type CheckState,
  type CiSignal,
  type ClarifyDepth,
  type ClarifyDepthChooser,
  type CleanupFailureAsk,
  type CleanupStepReport,
  type CleanupStepResult,
  type Comment,
  type CommentAnswer,
  type CommentAuthor,
  type CommentKind,
  type ConversationTab,
  type CopySkip,
  type CreatedBy,
  chatRequestKinds,
  checkLabel,
  type DaemonEvent,
  type DescriptionVersion,
  type DesignReview,
  type DiffRow,
  defaultMachineSettings,
  defaultWorkingRuns,
  type Effort,
  emptyMessageDraft,
  type Factory,
  type FailureCase,
  type FindingSeverity,
  factoryNotifications,
  failureChoices,
  firstFactoryNotifications,
  type GitHubWait,
  type LayerKind,
  type LayerUse,
  type LinearTeam,
  type LineComment,
  type LineSide,
  type MachineSettings,
  type MemoryKillAsk,
  type MergeMethod,
  type PermissionMode,
  type Priority,
  type Proposal,
  type PullRequestPreview,
  parseAsanaTaskUrl,
  parseLinearUrl,
  type ReportCleanupStepRequest,
  type RequestPurpose,
  type Round,
  type Run,
  type RunEnding,
  type RunMessage,
  type RunProblem,
  type RunState,
  type SendBack,
  type SendBackCause,
  type SimulatorAsk,
  type SizeCheck,
  type SnoozedRequest,
  type StageEntry,
  type StageId,
  type Task,
  type TaskAsanaSource,
  type TaskBrief,
  type TaskEnding,
  type TaskGitHubSource,
  type TaskLead,
  type TaskPullRequest,
  type TaskRepo,
  type TaskSource,
  type TedStoppedTask,
  type TrackStage,
  validateFailureChoices,
  type WaitingRequest,
  type WorktreeCommandOutcome,
} from '@ted/protocol'
import { isOneOf } from '@ted/protocol/parse'
import { planTitle as titleFromMessage } from '@ted/protocol/plan'
import {
  compareStages,
  hasClarifyRounds,
  isCleanup,
  mergesHere,
  validates,
} from '@ted/protocol/stage'
import { Effect } from 'effect'
import { totalMemory } from '../busy.ts'
import { isDiskFullError } from '../disk.ts'
import { redactSecrets } from '../redact.ts'
import { type QueueEntry, queueOrder } from '../tasks/queue.ts'
import {
  commentBox,
  commentDelivery,
  statusWithoutBlocker,
  type TaskFacts,
  taskActivity,
  taskCanResume,
  taskIsMerged,
  taskMarkers,
  taskPauses,
  taskStatus,
  taskStatuses,
  taskWaitReasons,
  taskWakesOnComment,
} from '../tasks/status.ts'
import type { OvernightGuard } from '../workflow/resolve.ts'
import { type AutomationDraftStore, createAutomationDraftStore } from './automation-drafts.ts'
import { type AutomationStore, createAutomationStore } from './automations.ts'
import { type ChatStore, createChatStore } from './chats.ts'
import { checkRunTiming } from './check-timing.ts'
import {
  type CoordinatorStore,
  confirmationHeadline,
  createCoordinatorStore,
  type StoredCoordinator,
} from './coordinators.ts'
import { readDashboard, sendBackSeverities } from './dashboard.ts'
import { createExecutionStore, type ExecutionStore } from './execution.ts'
import { createOperationStore, type OperationStore } from './execution-operations.ts'
import { createPairingStore, type PairingStore } from './execution-pairing.ts'
import { createFailureStore, type FailureStore } from './failures.ts'
import { eventCount, eventlogFile, storeId } from './files.ts'
import { intervalBoundaries, isSubAgentRequested } from './interval-schema.ts'
import { createPlanStore, type PlanStore } from './plans.ts'
import { countMaterialized } from './progress.ts'
import { joinPrompt, type PromptPart, splitPrompt } from './prompt-parts.ts'
import { legacyPurpose, structuralPurpose } from './request-purpose.ts'
import {
  agentPauses,
  archiveUnblocks,
  automationComments,
  automations,
  automationTasks,
  banners,
  baseConflicts,
  chatRequests as chatRequestRows,
  checkBoundaries,
  checkResults,
  checkRuns,
  cleanupReports,
  commentAttachments,
  comments,
  conversationTabs,
  coordinatorChats as coordinatorRows,
  deletedTasks,
  events,
  factories,
  factoryLayout as factoryLayoutRows,
  factoryOrder,
  factoryRepos,
  heldRuns,
  lineComments,
  localFolders,
  loopChecks,
  machineSettings,
  machineSettingValues,
  messageDraftKey,
  messageDrafts,
  p1OnlyReviews,
  peerMessages,
  planRequests,
  plans,
  planTasks,
  promptTexts,
  pullRequests,
  requestSnoozes,
  reviewers,
  reviewScopes,
  runBrowserCaptures,
  runInterrupts,
  runMessages,
  runs,
  runUsage,
  schema,
  sendBackAsks,
  sendBackResets,
  sendBacks,
  severityDeclarations,
  stageEntries,
  stageFileTexts,
  subAgentInstructions,
  subAgentRequests,
  taskAttachments,
  taskBlockers,
  taskBriefs,
  taskBrowserCaptures,
  taskDescriptions,
  taskDraftConsumptions,
  taskDrafts,
  taskLog,
  taskMoves,
  taskParents,
  taskQueue,
  taskRepos,
  taskSources,
  tasks,
  taskTreeArchives,
  workflowLayers,
} from './schema.ts'
import { createSideChatStore, type SideChatStore } from './side-chats.ts'
import { markEventsSynced } from './sync-head.ts'
import { createTaskHistory, type TaskHistory } from './task-history.ts'
import { blockerTransitions, taskIntervalHistory } from './task-intervals.ts'
import { taskTokens } from './task-tokens.ts'
import { createTestInvocationStore, type TestInvocationStore } from './test-invocations.ts'

export const placeholderFactory = { id: 'dev', key: 'DEV' }

export const linearSteps = ['started', 'review', 'done'] as const

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
  taskPlaces?: readonly { id: string; place: number }[]
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
  cloneUrl: string
  repos: StoredFactoryRepo[]
  clonedAt?: string
}

export function basicFactory({ cloneUrl: _, clonedAt, repos, ...factory }: StoredFactory): Factory {
  return {
    ...factory,
    repos: repos.map(({ repo, name }) => ({ repo, name })),
    cloned: clonedAt !== undefined,
  }
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

export type StartCause =
  | { cause: 'factory-setting' | 'snooze' | 'coordinator' | 'automation' }
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

export type ReviewerPurpose = 'review' | 'loop-check'

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

export type PlannedCheck = Omit<CheckResult, 'exitCode' | 'durationMs'>

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
}

export interface TedStore extends TaskHistory {
  execution: ExecutionStore
  operations: OperationStore
  pairing: PairingStore
  addFactory(
    input: Pick<StoredFactory, 'key' | 'name' | 'repo' | 'cloneUrl' | 'defaultBranch'>,
  ): StoredFactory
  createFactory(input: NewFactory): StoredFactory
  guides(): FactoryGuide[]
  hideGuide(factoryId: string): boolean
  factoryCloned(factoryId: string): StoredFactory
  listFactories(): StoredFactory[]
  getFactory(id: string): StoredFactory | undefined
  createTask(input: NewTask): Promise<Task>
  createTaskTree(input: NewTaskTree): { created: Map<string, Task>; linked: Task[] }
  listTasks(): Task[]
  getTask(ref: string): StoredTask | undefined
  coordinatorCreated(factoryId: string, operation: string): StoredTask | undefined
  leadCreatedTasks(creatorId: string): readonly { taskId: string; runId: string }[]
  startTask(input: {
    taskId: string
    stage: StageId
    branch: string
    worktree: string
    entry: NewStageEntry
    repo: NewWorktree
  }): Task
  setTaskRepos(
    taskId: string,
    input: { repos: string[]; names: string[]; by: 'human' | 'task-lead'; runId?: string },
  ): Task
  worktreeSetupStarted(taskId: string, name: string, setup: RecordedSetup): void
  recordedSetup(taskId: string, name: string): RecordedSetup | undefined
  worktreeSetupFinished(
    taskId: string,
    name: string,
    result: { outcome: WorktreeCommandOutcome; exitCode?: number },
  ): void
  worktreeRemoved(
    taskId: string,
    name: string,
    teardown?: { command: string; outcome: WorktreeCommandOutcome },
  ): void
  branchPushed(
    taskId: string,
    name: string,
    push: { commit: string; ci: boolean; ciSignals: CiSignal[] },
  ): void
  branchPushFailed(taskId: string, name: string, message: string): void
  pushRecordReconciled(
    taskId: string,
    name: string,
    found: { recorded: string; remote: string },
  ): void
  pullRequestOpened(
    taskId: string,
    name: string,
    pullRequest: { number: number; url: string; base: string },
  ): void
  pullRequestMarkedReady(taskId: string, name: string): void
  pullRequestClosed(taskId: string, name: string): void
  pullRequestReopened(taskId: string, name: string, state: 'draft' | 'ready'): void
  pullRequestClosedOnGitHub(taskId: string, name: string): void
  pullRequestPreviewFound(taskId: string, name: string, preview: PullRequestPreview): void
  gitHubActivitySent(taskId: string, runId: string, notices: readonly GitHubNoticeRecord[]): void
  gitHubActivityQueued(taskId: string, notices: readonly GitHubNoticeRecord[]): Task
  gitHubActivityHeld(taskId: string, notices: readonly GitHubNoticeRecord[]): void
  gitHubSeen(taskId: string): Map<string, string>
  linearIssueSeen(taskId: string, identifier: string, seen: LinearSeen): void
  linearIssueMoved(
    taskId: string,
    identifier: string,
    step: LinearStep,
    state: string | undefined,
  ): void
  linearPullRequestsLinked(taskId: string, identifier: string, urls: readonly string[]): void
  linearSync(taskId: string): LinearSyncRecord
  trackerItemSeen(taskId: string, tracker: string, item: string, seen: TrackerSeen): void
  trackerItemMoved(
    taskId: string,
    tracker: string,
    item: string,
    step: string,
    state: string | undefined,
  ): void
  trackerPullRequestsLinked(
    taskId: string,
    tracker: string,
    item: string,
    urls: readonly string[],
  ): void
  trackerSync(taskId: string, tracker: string): TrackerSyncRecord
  trackerSyncAllowed(
    taskId: string,
    tracker: string,
    item: string,
    account?: string,
    by?: 'menu' | 'import',
  ): Task
  allowTrackerGroup(
    tracker: string,
    factoryId: string,
    group: string,
    consents: readonly { taskId: string; item: string }[],
    account?: string,
  ): MachineSettings
  declineTrackerGroup(tracker: string, factoryId: string, group: string): void
  forgetTrackerGroup(
    tracker: string,
    factoryId: string,
    group: string,
    list: 'allowed' | 'declined',
    consents: readonly { taskId: string; item: string }[],
    account?: string,
  ): MachineSettings
  trackerItemGroupsSeen(
    taskId: string,
    tracker: string,
    item: string,
    groups: readonly string[],
  ): void
  linearSyncAllowed(taskId: string, identifier: string): Task
  allowLinearTeam(
    factoryId: string,
    team: string,
    consents: readonly { taskId: string; identifier: string }[],
  ): MachineSettings
  worktreeCreated(
    taskId: string,
    repo: {
      name: string
      repo: string
      branch: string
      worktree: string
      copied: string[]
      skipped: CopySkip[]
    },
  ): void
  pullRequestWaiting(taskId: string, name: string, on: GitHubWait | undefined): void
  autoMergeEnabled(
    taskId: string,
    name: string,
    input: { method: MergeMethod; requested: MergeMethod },
  ): void
  pullRequestMerged(
    taskId: string,
    name: string,
    input: { method?: MergeMethod; requested?: MergeMethod; noCi: boolean; byTed: boolean },
  ): void
  branchRebased(taskId: string, name: string, input: { commit: string; onto: string }): void
  mergeStoppedPartway(taskId: string, input: { merged: string[]; open: string[] }): void
  pullRequestSignedOff(taskId: string, name: string, commit: string | undefined): void
  autoMergeDisabled(taskId: string, name: string): void
  mergeStarted(taskId: string): void
  mergeLeadAdvanced(taskId: string, by: 'lead' | 'human'): void
  pullRequestTitleSet(taskId: string, input: { title: string; body?: string }): void
  gateSkippedOvernight(taskId: string, stage: AgentStageId): void
  gateApprovalBound(taskId: string, commentId: string, name: string, commit: string): void
  gateRequestedFor(taskId: string, commentId: string, name: string, commit: string): void
  gateKeptOvernight(taskId: string, stage: AgentStageId, reason: OvernightGuard): void
  createdByAutomation(taskId: string): boolean
  mergeCanceled(taskId: string, commentId: string): void
  taskMarkedDone(taskId: string, by: 'human' | 'lead' | 'coordinator'): void
  mergePending(taskId: string): boolean
  isMerged(taskId: string): boolean
  setLocalFolder(repo: string, path: string): void
  clearLocalFolder(repo: string): void
  setFactoryAutoStartBacklog(factoryId: string, enabled: boolean): StoredFactory
  renameFactory(factoryId: string, name: string): StoredFactory
  setFactoryIcon(factoryId: string, icon: FactoryIcon | null): StoredFactory
  factoryLayout(): FactoryLayout
  saveFactoryLayout(layout: FactoryLayout): StoredFactory[] | undefined
  removeFactory(factoryId: string): void
  changeFactoryRepos(factoryId: string, repos: StoredFactoryRepo[]): StoredFactory
  localFolder(repo: string): string | undefined
  queueTask(
    taskId: string,
    stage: StageId,
    options?: { prepare?: boolean; keepRank?: boolean; cause?: StartCause | undefined },
  ): Task
  moveToBacklog(taskId: string): Task
  needsPlanning(taskId: string, runId: string): Task
  startAfterPlanning(
    taskId: string,
    stage: StageId,
    entry: NewStageEntry,
    options?: { prepare?: boolean; cause?: StartCause | undefined },
  ): Task
  taskSplit(
    taskId: string,
    input: { pieceIds: string[]; narrowedTo: string; description: string },
  ): void
  childTasksCreated(
    taskId: string,
    childIds: readonly string[],
    from: 'split' | 'plan' | 'plan-task' | 'chat',
  ): void
  madeParent(taskId: string): boolean
  parentFinishedWithChildren(taskId: string): void
  taskPlanEnded(
    taskId: string,
    planId: string,
    outcome: 'approved' | 'stopped' | 'failed' | 'deleted' | 'archived',
  ): void
  rankTask(taskId: string, rank: number, priority: Priority): Task
  setPriority(taskId: string, priority: Priority): Task
  editTask(taskId: string, edit: { title?: string; description?: string }): Task
  descriptionVersions(taskId: string): DescriptionVersion[]
  archiveTask(taskId: string, record?: { closing: string[]; branches: number; why?: string }): Task
  unarchiveTask(
    taskId: string,
    input: { queue: boolean; waitForBlockers: boolean; reblocked?: readonly string[] },
  ): Task
  deleteTask(taskId: string): void
  resetTask(taskId: string): Task
  moveTask(input: MoveTaskInput): { id: string; from: string; to: string }[]
  nextTaskNumber(factoryId: string): number
  blockedBy(blockerId: string): string[]
  openBlockedTasks(): string[]
  queue(): QueuedTask[]
  dequeue(taskId: string): Task
  parentOf(taskId: string): string | undefined
  childrenOf(taskId: string): string[]
  setTaskParent(taskId: string, parentId: string | null): Task
  recordTreeArchive(rootId: string, taskIds: readonly string[]): void
  recordArchiveUnblocks(blockerId: string, taskIds: readonly string[]): void
  archiveUnblocked(blockerId: string): string[]
  archivedWith(rootId: string): string[]
  blockers(taskId: string): BlockerLink[]
  addBlocker(
    taskId: string,
    blockerId: string,
    options?: { runId?: string; then?: AfterBlocking },
  ): Task
  removeBlocker(taskId: string, blockerId: string, runId?: string): Task
  setTaskSnooze(taskId: string, until: string | null): Task
  setStartRequested(taskId: string, startRequested: boolean): Task
  waitForBlockers(taskId: string): Task
  requeueAfterBlockers(taskId: string): Task
  taskStoppedByHuman(taskId: string): boolean
  stopTask(taskId: string, input: { runs: number; why: StopReason }): Task
  resumeTask(
    taskId: string,
    options: { waitForBlockers: boolean; overnight?: boolean; talkCommentId?: string },
  ): Task
  taskStoppedByTed(
    taskId: string,
    runId: string,
    cause: 'quit' | 'ended-outside',
    at?: string,
  ): void
  tedStopPending(taskId: string): boolean
  answerTedStop(taskId: string, choice: 'restart' | 'leave'): void
  tedStops(): TedStoppedTask[]
  leadNudged(taskId: string, runId: string): void
  appStarted(input: {
    taskId: string
    repo: string
    name: string
    port?: number
    url?: string
    by: AppStarter
    runId?: string
    restart: boolean
  }): void
  appStopped(input: { taskId: string; repo: string; name: string }): void
  appExited(input: {
    taskId: string
    repo: string
    name: string
    code?: number
    signal?: string
  }): void
  appStartFailed(input: { taskId: string; repo: string; name: string; problem: string }): void
  simulatorShutDown(input: {
    taskId: string
    repo: string
    name: string
    forTask?: string
    idle: boolean
  }): void
  emulatorShutDown(input: {
    taskId: string
    repo: string
    name: string
    forTask?: string
    idle: boolean
  }): void
  requestSimulator(input: {
    taskId: string
    runId: string
    title: string
    body: string
    simulator: SimulatorAsk
  }): Comment
  leadFailed(failure: LeadFailure): Task
  retryTask(taskId: string, options: { waitForBlockers: boolean }): Task
  changeStage(
    taskId: string,
    stage: StageId,
    entry?: NewStageEntry,
    options?: { prepare?: boolean },
  ): Task
  dashboard(factoryIds: readonly string[], range: DashboardRange, asOf?: number): DashboardReport
  listStageEntries(taskId: string): StageEntry[]
  recordedStages(taskId: string): PlannedStage[] | undefined
  acceptWorkflowLayer(layer: string, accepted: Omit<AcceptedLayer, 'acceptedAt'>): void
  lastValidWorkflowLayer(layer: string): AcceptedLayer | undefined
  rememberStageFileText(seen: SeenStageFile): void
  seenStageFileText(hash: string): SeenStageFile | undefined
  setTaskLead(taskId: string, lead: TaskLead): Task
  setLeadRestartPending(taskId: string, pending: boolean): void
  tasksWithQueuedContinuations(): string[]
  holdLeadMessage(taskId: string, text: string, waitForSlot?: boolean, after?: QueuedAfter): void
  deliveredLeadMessages(taskId: string, ids: readonly string[]): void
  setTaskAutopilot(taskId: string, choice: AutopilotChoice): Task
  setTaskGates(taskId: string, overrides: TaskGateOverrides): Task
  setClarifyDepth(
    taskId: string,
    input: { depth: ClarifyDepth; by: ClarifyDepthChooser; runId?: string; why?: string },
  ): Task
  setActivity(taskId: string, text: string, runId?: string): Task
  postComment(input: NewComment): Comment
  postAutomationNote(input: NewComment, link: { automationId: string; firingId: string }): Comment
  heldRequests(): { id: string; runId: string; createdAt: string }[]
  releaseRequests(ids: readonly string[]): void
  listComments(taskId: string): Comment[]
  commentTexts(): {
    id: string
    taskId: string
    title?: string
    body: string
    author: Comment['author']
    createdAt: string
  }[]
  permissionComments(runId: string): Comment[]
  taskFiles(taskId: string): Attachment[]
  recordBrowserCapture(taskId: string, attachment: Attachment): void
  browserCaptures(taskId: string): Attachment[]
  taskDraft(factoryId: string): TaskDraftState
  saveTaskDraft(factoryId: string, draft: NewTaskDraft): TaskDraftState
  removeTaskDraft(factoryId: string): void
  messageDraft(box: MessageBox): MessageDraft | null
  saveMessageDraft(
    box: MessageBox,
    owner: { factoryId?: string; taskId?: string; planId?: string },
    draft: MessageDraft,
  ): MessageDraft | null
  messageDraftFiles(taskId: string): Attachment[]
  filesInUse(): Set<string>
  getComment(id: string): Comment | undefined
  answerComment(
    id: string,
    answer: CommentAnswer,
    lineComments?: readonly string[],
    autopilot?: boolean,
    queueAnswer?: boolean,
  ): Comment
  draftLineComment(input: NewLineComment): LineComment
  editLineComment(id: string, body: string): LineComment
  deleteLineComments(taskId: string, ids: readonly string[]): void
  getLineComment(id: string): LineComment | undefined
  lineCommentDrafts(taskId: string): LineComment[]
  taskLineComments(taskId: string): LineComment[]
  commentsDelivered(ids: readonly string[], runId: string): void
  commentsRead(ids: readonly string[]): void
  holdAnswer(id: string): void
  requestRoundTalk(id: string): Comment
  startRoundTalk(id: string, runId: string, text: string): Comment
  roundTalkMessageIds(runId: string): string[]
  pendingRoundTalks(runId: string): { messageId: string; round: Comment }[]
  roundTalkNotified(id: string, runId: string, messageId: string): void
  roundTalkDone(id: string): Comment
  heldAnswers(taskId: string): Comment[]
  answersDelivered(ids: readonly string[], runId: string): void
  taskIntervalHistory(taskId: string, asOf?: string): TaskIntervalHistory
  taskLog(taskId: string): LoggedEvent[]
  supersedeComment(id: string, input: NewComment): Comment
  listOpenRequests(): Comment[]
  listAnsweredRequests(since: string, kinds?: ReadonlySet<CommentAnswer['kind']>): Comment[]
  writeBrief(input: { taskId: string; text: string; runId?: string }): TaskBrief
  listBriefs(taskId: string): TaskBrief[]
  latestBrief(taskId: string): TaskBrief | undefined
  recordSendBack(input: {
    taskId: string
    from: StageId
    to: StageId
    findings: string
    counted: boolean
    round?: number
    limit?: number
    checkRunId?: string
    cause?: SendBackCause
    conflict?: FoundConflict
  }): SendBack
  listSendBacks(taskId: string): SendBack[]
  recordBaseConflict(taskId: string, conflict: FoundConflict): BaseConflictFound
  baseConflicts(taskId?: string): BaseConflictFound[]
  reportCleanupStep(taskId: string, runId: string, report: ReportCleanupStepRequest): void
  cleanupReports(taskId: string): CleanupStepReport[]
  recordCleanupCommand(taskId: string, result: CleanupCommandResult): void
  retryCleanup(taskId: string, steps: readonly string[]): void
  finishCleanupAnyway(taskId: string, steps: readonly string[]): void
  baseAdopted(
    taskId: string,
    moved: readonly { repo: string; base: string; from: string; to: string }[],
  ): void
  declareSeverity(input: {
    taskId: string
    runId: string
    round: number
    severity: FindingSeverity
  }): void
  recordP1OnlyReview(input: { runId: string; taskId: string; round: number; from: number }): void
  p1OnlyReview(runId: string): boolean
  startChecks(input: {
    taskId: string
    trigger: CheckRunTrigger
    stage: StageId
    checks: PlannedCheck[]
  }): CheckRun
  checkSlotBoundary(
    checkRunId: string,
    boundary: 'entered' | 'acquired' | 'canceled' | 'interrupted' | 'recovered',
    at: string,
  ): void
  checkTiming(checkRunId: string): CheckRunTiming | undefined
  listCheckTimings(taskId: string): CheckRunTiming[]
  checkInterrupted(checkRunId: string, position: number): void
  checkKilledForMemory(
    checkRunId: string,
    position: number,
    killed: { lowestMemory: number; durationMs: number },
  ): CheckRun
  checkStarted(checkRunId: string, position: number): CheckRun
  checkFinished(
    checkRunId: string,
    position: number,
    result: { state: CheckState; exitCode?: number; durationMs: number },
  ): CheckRun
  finishChecks(checkRunId: string, outcome: CheckRunOutcome): CheckRun
  getCheckRun(id: string): CheckRun | undefined
  listCheckRuns(taskId?: string): CheckRun[]
  resetSendBacks(taskId: string, stage: StageId): void
  sendBackCount(taskId: string, stage: StageId): number
  subscribe(listener: (event: DaemonEvent) => void): () => void
  startRun(input: {
    id: string
    agent: AgentKind
    sessionId?: string
    prompt: string
    cwd: string
    taskId?: string
    model?: string
    effort?: Effort
    parentRunId?: string
    name?: string
    permissions?: PermissionMode
    shared?: readonly string[]
  }): Run
  runPrompt(runId: string): string
  failRun(runId: string, error: string): void
  requestSubAgent(request: Omit<SubAgentRequest, 'at'>): SubAgentRequest
  subAgentRequests(taskId?: string): SubAgentRequest[]
  dropSubAgentRequest(id: string): void
  chooseReviewer(reviewer: Omit<Reviewer, 'at'>): Reviewer
  reviewerOf(runId: string): Reviewer | undefined
  reviewers(taskId: string): Reviewer[]
  recordReviewScope(scope: Omit<ReviewScope, 'at'>): ReviewScope
  reviewScopes(taskId: string): ReviewScope[]
  judgeValidate(input: {
    taskId: string
    outcome: 'passed' | 'sent-back'
    checkRunId?: string
    review?: { passed: boolean; notes?: number }
    visual?: { passed: boolean; notes?: number }
    reviewer?: { agent: AgentKind; unavailable?: AgentKind }
  }): void
  startLoopCheck(check: Omit<LoopCheck, 'at' | 'verdict'>): LoopCheck
  finishLoopCheck(runId: string, verdict: LoopVerdict, reason: string): void
  loopChecks(taskId?: string): LoopCheck[]
  askAboutSendBack(ask: Omit<SendBackAsk, 'at'>): SendBackAsk
  sendBackAsk(commentId: string): SendBackAsk | undefined
  sendBackAsks(taskId: string): SendBackAsk[]
  setOnSubAgents(runId: string, on: boolean): void
  onSubAgents(runId: string): boolean
  reconcileRunState(runId: string): void
  recordRunOutput(runId: string, output: RunOutput): boolean
  holdRunOutput(
    runId: string,
    read: { from: number; toOffset: number; lastOutputAt?: string },
  ): void
  savedReadOffset(id: string): number
  permissionTarget(commentId: string): PermissionTarget | undefined
  answerPermission(commentId: string, answer: CommentAnswer): Comment
  setRunPermissions(runId: string, permissions: PermissionMode): void
  setRunAsleep(runId: string, asleep: boolean): void
  setLiveTokens(runId: string, tokens: number | undefined): void
  restartRun(runId: string, flags: RunFlags): Run
  reviveRun(runId: string, flags?: RunFlags): Run
  lastOutputAt(runId: string): string | undefined
  getRun(id: string): Run | undefined
  runProblemAt(runId: string): string | undefined
  listRuns(): Run[]
  liveRuns(): Run[]
  busyTaskIds(): string[]
  tasksIn(ids: ReadonlySet<string>): Task[]
  preparedTasks(): string[]
  backlogTasks(): { id: string; snoozed: boolean }[]
  unarchivedTaskRepos(): { id: string; stage: StageId; repos: TaskRepo[] }[]
  taskOutlines(): {
    id: string
    factoryId: string
    stage: StageId
    archived: boolean
    setup: boolean
  }[]
  factoryOfTask(taskId: string): string | undefined
  taskVersion(): number
  taskBuilds(): number
  sourcedTaskIds(): string[]
  taskSourceUrls(): { taskId: string; url: string }[]
  taskPullRequestUrls(taskId: string): string[]
  runReadOffset(id: string): number
  recordRunUsage(usage: {
    runId: string
    agent: AgentKind
    model?: string
    input: number
    output: number
    cost?: number
  }): void
  apiCost(days: number, now?: Date): ApiCostReport
  taskRunList(taskId: string): Run[]
  recordRunMessage(input: { runId: string; text: string; lead: boolean }): RunMessage
  queueRunMessage(input: { runId: string; text: string; from?: 'ted' }): RunMessage
  deliverRunMessages(runId: string, ids: readonly string[], lead: boolean): void
  deleteRunMessage(runId: string, id: string): RunMessage | undefined
  releaseRunSteering(runId: string, release: RunSteeringRelease): void
  runSteeringRelease(runId: string): RunSteeringRelease | undefined
  recordTurnInterrupted(runId: string, hold: boolean): RunInterrupt
  runMessages(runId: string): RunMessage[]
  runInterrupts(runId: string): RunInterrupt[]
  openTab(taskId: string, runId: string): Task
  closeTab(taskId: string, runId: string): Task
  settings(): MachineSettings
  activity(): Activity
  waiting(): WaitingRequest[]
  snoozed(): SnoozedRequest[]
  snoozeRequest(
    requestId: string,
    until: string | null,
  ): SnoozedRequest | WaitingRequest | undefined
  returnDueRequests(now: number): string[]
  requestSnoozesPending(): boolean
  setQueueActivity(activity: QueueActivity): void
  setShellsRunning(count: number): void
  setScheduledChecks(counts: { running: number; waiting: number }): void
  checkWork(): CheckWork
  setAsanaConnection(account: string | undefined): void
  asanaAccount(): string | undefined
  setAsanaOpenChildren(taskId: string, count: number | undefined): void
  setAsanaLeftOpen(taskId: string, leftOpen: boolean): void
  updateSettings(changes: Partial<MachineSettings>): MachineSettings
  raiseBanner(input: NewBanner): Banner
  dismissBanner(id: string, until: string): Banner | undefined
  clearBanner(id: string): void
  getBanner(id: string): Banner | undefined
  listBanners(): Banner[]
  pauseAgent(agent: AgentKind, reason: string | undefined): void
  agentPauses(): Partial<Record<AgentKind, string>>
  holdTaskRun(held: HeldRun): void
  releaseTaskRun(taskId: string): void
  heldRuns(): HeldRun[]
  pausedRunCount(agent: AgentKind): number
  exportEventlog(): { fileName: string; data: Uint8Array }
  persisted(): Promise<void>
  holdNewWork(reason: string | undefined): void
  newWorkHold(): string | undefined
  holdWhenBusy(held: BusyHold | undefined): void
  setTaskChecking(taskId: string, on: boolean): void
  setRunsStopping(taskId: string, runIds: readonly string[], on: boolean): void
  setTaskMovingAfterChecks(taskId: string, on: boolean): void
  setChecksWaiting(places: ReadonlyMap<string, number>): void
  onWriteResult(listener: (error?: unknown) => void): () => void
  automationDrafts: AutomationDraftStore
  automations: AutomationStore
  isPeerMessage(id: string): boolean
  peerMessages(): PeerMessage[]
  recordPeerMessage(
    input: Omit<PeerMessage, 'id' | 'createdAt' | 'delivered'>,
    body: string,
  ): PeerMessage
  sideChats: SideChatStore
  coordinators: CoordinatorStore
  chats: ChatStore
  testInvocations: TestInvocationStore
  failures: FailureStore
  invalidateFailure(value: FailureCase, note: { title: string; body: string }): void
  postFailureDecision(
    value: FailureCase,
    body: string,
    canAccept?: boolean,
    askedBy?: string,
    closable?: boolean,
  ): FailureCase
  resolveFailure(
    value: FailureCase,
    commentId: string,
    answer: CommentAnswer,
    drafts: readonly string[],
  ): FailureCase
  approveRepair(
    approval: RepairApproval,
    repair: Pick<Task, 'id' | 'displayId' | 'title'>,
  ): FailureCase
  plans: PlanStore
  close(): Promise<void>
}

function pick(values: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.includes(name)))
}

const persistTimeoutMs = 10_000

const runFields = [
  'id',
  'agent',
  'sessionId',
  'model',
  'effort',
  'usesDefaultModel',
  'problem',
  'problemAt',
  'permissions',
  'manualPermissions',
  'cwd',
  'taskId',
  'parentRunId',
  'name',
  'failure',
  'state',
  'readOffset',
  'lastOutputAt',
  'startedAt',
  'revivedAt',
  'ended',
  'retrying',
  'steeringRelease',
] as const

type RunRow = Omit<typeof runs.Type, 'prompt' | 'promptParts'>

// LiveStore keeps every query result in memory, so lists leave the long text columns out.
const runRows = runs.select(...runFields)
const briefTimes = taskBriefs.select('taskId', 'version', 'createdAt')

export type NewBanner = Omit<Banner, 'raisedAt' | 'dismissedUntil'>

export interface OpenProgress {
  done: number
  total: number
}

let tasksBuiltHere = 0

export function tasksBuiltInProcess(): number {
  return tasksBuiltHere
}

export async function openStore({
  directory,
  onProgress,
}: {
  directory: string
  onProgress?: (progress: OpenProgress) => void
}): Promise<TedStore> {
  const total = onProgress ? await eventCount(directory) : 0
  let done = 0
  const marked = await markEventsSynced(directory)
  if (marked.kind === 'failed') {
    console.error(
      redactSecrets(
        `marking the event log as synced failed, so LiveStore keeps every event in memory: ${marked.reason}`,
      ),
    )
  }
  countMaterialized(onProgress && (() => onProgress({ done: Math.min(++done, total), total })))
  const store = await createStorePromise({
    schema,
    storeId,
    adapter: makeAdapter({ storage: { type: 'fs', baseDirectory: directory } }),
    disableDevtools: true,
  })
    .catch((error: unknown) => {
      throw new Error(describeOpenError(error), { cause: error })
    })
    .finally(() => countMaterialized(undefined))
  const eventlogName = path.basename((await eventlogFile(directory)) ?? 'eventlog.db')

  const writeListeners = new Set<(error?: unknown) => void>()
  let writeFailing = false
  let newWorkHeld: string | undefined
  let heldBusy: BusyHold | undefined
  const waitingOnSubAgents = new Set<string>()
  const asleepRuns = new Set<string>()
  const liveTokens = new Map<string, number>()
  const checkingTasks = new Set<string>()
  const movingAfterChecks = new Set<string>()
  const stoppingRuns = new Set<string>()
  let checksWaiting: ReadonlyMap<string, number> = new Map()
  const tellWriters = (error?: unknown) => {
    for (const listener of writeListeners) listener(error)
  }
  let noteWaiting = () => {}
  let waitingUnchanged = false
  let shutDown = false
  let stateCommits = 0
  let observingWait = false
  const commit = ((...args: unknown[]) => {
    if (observingWait) observingWait = false
    else stateCommits += 1
    try {
      const result = (store.commit as (...a: unknown[]) => unknown)(...args)
      if (!waitingUnchanged) noteWaiting()
      if (writeFailing) {
        writeFailing = false
        tellWriters()
      }
      return result
    } catch (error) {
      if (isDiskFullError(error)) {
        writeFailing = true
        tellWriters(error)
      }
      throw error
    }
  }) as typeof store.commit

  const commitDraft: typeof store.commit = (...args: unknown[]) => {
    waitingUnchanged = true
    try {
      return (commit as (...a: unknown[]) => unknown)(...args)
    } finally {
      waitingUnchanged = false
    }
  }

  const internals = store[StoreInternalsSymbol]
  const persisted = async () => {
    const committed = Effect.runSync(internals.syncProcessor.syncState.get).localHead
    let deadline = Date.now() + persistTimeoutMs
    let last: typeof committed | undefined
    for (;;) {
      const written = Effect.runSync(internals.clientSession.leaderThread.syncState.get).localHead
      if (
        written.global > committed.global ||
        (written.global === committed.global && written.client >= committed.client)
      ) {
        return
      }
      if (last && (written.global !== last.global || written.client !== last.client)) {
        deadline = Date.now() + persistTimeoutMs
      }
      last = written
      if (Date.now() > deadline) throw new Error('the event log did not save in time')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  const allFactories = queryDb(factories.orderBy('createdAt', 'asc'))
  const allTasks = queryDb(tasks.orderBy('number', 'asc'))
  const allRuns = queryDb(runRows.orderBy('startedAt', 'asc'))
  const liveRuns = queryDb(
    runRows.where({ state: { op: '!=', value: 'finished' } }).orderBy('startedAt', 'asc'),
  )

  const allFactoryRepos = queryDb(factoryRepos.orderBy('position', 'asc'))
  const taskDraft = (factoryId: string): TaskDraftState => {
    const row = store.query(queryDb(taskDrafts.where({ factoryId })))[0]
    const clearedRevisions = store
      .query(queryDb(taskDraftConsumptions.where({ factoryId })))
      .map((entry) => entry.revision)
    return {
      draft: row?.draft ? (JSON.parse(row.draft) as NewTaskDraft) : null,
      ...(row?.clearedRevision ? { clearedRevision: row.clearedRevision } : {}),
      ...(clearedRevisions.length > 0 && { clearedRevisions }),
    }
  }

  const messageDraft = (box: MessageBox): MessageDraft | null => {
    const row = store.query(
      queryDb(messageDrafts.where({ key: messageDraftKey(box.kind, box.id) })),
    )[0]
    return row ? (JSON.parse(row.draft) as MessageDraft) : null
  }

  const allFactoryOrder = queryDb(factoryOrder.orderBy('position', 'asc'))
  const listFactories = (): StoredFactory[] => {
    const repos = store.query(allFactoryRepos)
    const placed = new Map(store.query(allFactoryOrder).map((r) => [r.factoryId, r.position]))
    const rows = store.query(allFactories)
    const after = Math.max(-1, ...placed.values()) + 1
    const rank = (id: string, index: number) => placed.get(id) ?? after + index
    return rows
      .map((row, index) => ({ row, rank: rank(row.id, index) }))
      .sort((a, b) => a.rank - b.rank)
      .map(
        (
          { row: { clonedAt, icon, guide: _guide, showTutorial: _tutorial, ...row } },
          position,
        ) => ({
          ...row,
          position,
          ...(icon !== null && { icon: JSON.parse(icon) as FactoryIcon }),
          repos: repos
            .filter((r) => r.factoryId === row.id)
            .map(({ repo, name, cloneUrl }) => ({ repo, name, cloneUrl })),
          ...(clonedAt !== null && { clonedAt }),
        }),
      )
  }
  const allFactoryLayout = queryDb(factoryLayoutRows.orderBy('position', 'asc'))
  const readFactoryLayout = (): FactoryLayout => {
    const existing = listFactories()
    const known = new Set(existing.map((f) => f.id))
    const placed = new Set<string>()
    const groups = new Map<string, { group: FactoryGroup }>()
    const items: FactoryLayoutItem[] = []
    for (const row of store.query(allFactoryLayout)) {
      if (row.factoryId === null) {
        if (row.groupId === null || row.name === null) continue
        const item = { group: { id: row.groupId, name: row.name, factoryIds: [] } }
        groups.set(row.groupId, item)
        items.push(item)
        continue
      }
      if (!known.has(row.factoryId) || placed.has(row.factoryId)) continue
      placed.add(row.factoryId)
      const group = row.groupId === null ? undefined : groups.get(row.groupId)
      if (group) group.group.factoryIds.push(row.factoryId)
      else items.push({ factoryId: row.factoryId })
    }
    for (const factory of existing) {
      if (!placed.has(factory.id)) items.push({ factoryId: factory.id })
    }
    return { items }
  }
  const sentSetUp = new Map<string, boolean>()
  const guides = (): FactoryGuide[] =>
    store
      .query(queryDb(factories.where({ guide: 'live' }).orderBy('createdAt', 'asc')))
      .map((row) => {
        const setUp = setUpDone(row.id)
        sentSetUp.set(row.id, setUp)
        return { factoryId: row.id, addedAt: row.createdAt, setUp }
      })
  const setUpChanged = (event: DaemonEvent) =>
    (event.type === 'task-created' || event.type === 'task-updated') &&
    event.task.setup === true &&
    store.query(queryDb(factories.where({ id: event.task.factoryId, guide: 'live' }))).length > 0 &&
    sentSetUp.get(event.task.factoryId) !== setUpDone(event.task.factoryId)
  const emitGuides = () => emit({ type: 'guides-changed', guides: guides() })
  const guideEnding = (factoryId: string, reason: GuideEnding) =>
    store.query(queryDb(factories.where({ id: factoryId, guide: 'live' }))).length > 0
      ? [events.factoryGuideEnded({ factoryId, reason, at: new Date().toISOString() })]
      : []
  const setUpDone = (factoryId: string) => {
    const queued = new Set(store.query(queryDb(taskQueue.select())).map((row) => row.taskId))
    return store
      .query(queryDb(tasks.where({ factoryId, setup: true, archivedAt: null })))
      .some(
        (row) =>
          row.stage === 'done' ||
          isCleanup(row.stage) ||
          (row.stage === 'backlog' &&
            !row.startRequested &&
            !queued.has(row.id) &&
            taskRuns(row.id).length === 0),
      )
  }
  const requireFactory = (id: string) => {
    const found = listFactories().find((f) => f.id === id)
    if (!found) throw new Error(`no Factory ${id}`)
    return found
  }
  const keyAmong = (list: readonly StoredFactory[], factoryId: string) =>
    factoryId === placeholderFactory.id
      ? placeholderFactory.key
      : (list.find((f) => f.id === factoryId)?.key ?? '?')
  const factoryKey = (factoryId: string) => keyAmong(listFactories(), factoryId)

  const runName = (run: RunRow) =>
    run.name ?? (run.taskId !== null && run.parentRunId === null ? 'Task Lead' : 'Run')

  const toReviewer = ({ unavailable, ...row }: typeof reviewers.Type): Reviewer => ({
    ...row,
    stage: row.stage as StageId,
    purpose: row.purpose as ReviewerPurpose,
    agent: row.agent as AgentKind,
    ...(unavailable !== null && { unavailable: unavailable as AgentKind }),
  })

  const toLoopCheck = ({
    toStage,
    checkRunId,
    limit,
    verdict,
    ...row
  }: typeof loopChecks.Type): LoopCheck => ({
    ...row,
    to: toStage as AgentStageId,
    ...(checkRunId !== null && { checkRunId }),
    ...(limit !== null && { limit }),
    ...(verdict !== null && { verdict: verdict as LoopVerdict }),
  })

  const toSendBackAsk = ({
    fromStage,
    toStage,
    checkRunId,
    ...row
  }: typeof sendBackAsks.Type): SendBackAsk => ({
    ...row,
    from: fromStage as AgentStageId,
    to: toStage as AgentStageId,
    ...(checkRunId !== null && { checkRunId }),
  })

  const toSubAgentRequest = ({
    model,
    effort,
    ...row
  }: typeof subAgentRequests.Type): SubAgentRequest => ({
    ...row,
    agent: row.agent as AgentKind,
    ...(model !== null && { model }),
    ...(effort !== null && { effort: effort as Effort }),
  })

  const taskRuns = (taskId: string) =>
    store.query(queryDb(runRows.where({ taskId }).orderBy('startedAt', 'desc')))

  const pullRequestFields = (row: typeof pullRequests.Type | undefined): Partial<TaskRepo> => {
    if (!row) return {}
    return {
      ...(row.pushedCommit !== null &&
        row.pushedAt !== null && {
          pushed: {
            commit: row.pushedCommit,
            at: row.pushedAt,
            ci: row.hasCi === true,
            ciSignals: JSON.parse(row.ciSignals ?? '[]') as CiSignal[],
          },
        }),
      ...(row.pushError !== null &&
        row.pushErrorAt !== null && {
          pushFailed: { message: row.pushError, at: row.pushErrorAt },
        }),
      ...(row.number !== null &&
        row.url !== null &&
        row.base !== null &&
        row.state !== null && {
          pullRequest: {
            number: row.number,
            url: row.url,
            base: row.base,
            state: row.state as TaskPullRequest['state'],
            ...(row.mergedAt !== null && {
              merged: {
                at: row.mergedAt,
                ...(row.mergeMethod !== null && { method: row.mergeMethod as MergeMethod }),
                noCi: row.mergedWithoutCi === true,
              },
            }),
            ...(row.autoMerge !== null && { autoMerge: row.autoMerge as MergeMethod }),
            ...(row.waitingOn !== null && { waiting: row.waitingOn as GitHubWait }),
            ...(row.signedOffCommit !== null && { signedOff: row.signedOffCommit }),
            ...(row.closedOnGitHubAt !== null && { closedOnGitHub: row.closedOnGitHubAt }),
            ...(row.previewUrl !== null && {
              preview: {
                url: row.previewUrl,
                source: row.previewSource === 'status' ? 'status' : 'deployment',
                label: row.previewLabel ?? '',
              },
            }),
          },
        }),
    }
  }

  const toTaskRepo = (
    row: typeof taskRepos.Type,
    pullRequest: typeof pullRequests.Type | undefined,
  ): TaskRepo => ({
    ...pullRequestFields(pullRequest),
    name: row.name,
    repo: row.repo,
    branch: row.branch,
    worktree: row.worktree,
    copied: JSON.parse(row.copied) as string[],
    skipped: JSON.parse(row.skipped) as CopySkip[],
    ...(row.setupCommand !== null &&
      row.setupState !== null && {
        setup: {
          command: row.setupCommand,
          state: row.setupState as NonNullable<TaskRepo['setup']>['state'],
          ...(row.setupExitCode !== null && { exitCode: row.setupExitCode }),
        },
      }),
    ...(row.removedAt !== null && {
      removed: {
        at: row.removedAt,
        ...(row.teardownCommand !== null &&
          row.teardownOutcome !== null && {
            teardown: {
              command: row.teardownCommand,
              outcome: row.teardownOutcome as WorktreeCommandOutcome,
            },
          }),
      },
    }),
  })

  const queue = (): QueuedTask[] => {
    const rows = store.query(queryDb(taskQueue.select()))
    return queueOrder(
      rows.flatMap(({ taskId, rank }) => {
        const task = taskRow(taskId)
        return task
          ? [
              {
                id: taskId,
                kind: task.setup ? ('setup-task' as const) : ('task' as const),
                rank,
                priority: task.priority as Priority,
                factoryId: task.factoryId,
              },
            ]
          : []
      }),
    )
  }

  const repoRows = (taskId: string) =>
    store.query(queryDb(taskRepos.where({ taskId }).orderBy('createdAt', 'asc')))

  const pullRequestRows = (id: string) => store.query(queryDb(pullRequests.where({ id })))

  const reposOf = (taskId: string) =>
    repoRows(taskId).map((row) => toTaskRepo(row, pullRequestRows(row.id).at(0)))

  const readTaskLog = (taskId: string): LoggedEvent[] =>
    store
      .query(queryDb(taskLog.where({ taskId })))
      .map(({ id, name, data, at }) => ({
        id,
        name,
        data: JSON.parse(data) as Record<string, unknown>,
        at,
      }))
      .sort((a, b) => sequence(a.id) - sequence(b.id))

  const history = createTaskHistory(
    readTaskLog,
    (taskId) => entryRows(taskId).findLast((e) => mergesHere(e.stage))?.at ?? '',
  )

  const mergePendingFor = (taskId: string, repos: readonly TaskRepo[]): boolean =>
    repos.some((r) => !r.removed && r.pullRequest && r.pullRequest.state !== 'merged') &&
    history.mergeHistory(taskId).latest === 'started'

  const taskPullRequests = (taskId: string) => store.query(queryDb(pullRequests.where({ taskId })))

  const isMerged = (taskId: string): boolean =>
    taskIsMerged(taskRow(taskId)?.stage as StageId, taskPullRequests(taskId))

  const blockerRows = (taskId: string) =>
    store.query(queryDb(taskBlockers.where({ taskId }).orderBy('at', 'asc')))

  const parentRow = (taskId: string) => store.query(queryDb(taskParents.where({ taskId }))).at(0)
  const childRows = (parentId: string) =>
    store.query(queryDb(taskParents.where({ parentId }).orderBy('taskId', 'asc')))

  const deletedRows = (id: string) => store.query(queryDb(deletedTasks.where({ id })))

  const blockerOf = (id: string, reads: TaskReads = perTask) => {
    const blocker = reads.task(id).at(0)
    if (blocker) {
      return {
        displayId: `${reads.factoryKey(blocker.factoryId)}-${blocker.number}`,
        merged: taskIsMerged(blocker.stage as StageId, reads.pullRequests(id)),
        ...(blocker.archivedAt !== null && { ended: 'archived' as const }),
      }
    }
    const deleted = reads.deleted(id).at(0)
    return {
      displayId: deleted ? `${reads.factoryKey(deleted.factoryId)}-${deleted.number}` : id,
      merged: false,
      ended: 'deleted' as const,
    }
  }

  const asanaHolds = (taskId: string, reads: TaskReads): BlockerLink[] =>
    reads
      .comments(taskId)
      .filter((row) => row.asanaMissing !== null && row.answer === null)
      .map((row) => ({
        blockerId: row.id,
        kind: 'asana' as const,
        displayId: 'your answer about missing Asana work',
        merged: false,
        at: row.createdAt,
      }))

  const blockerLinks = (taskId: string, reads: TaskReads = perTask): BlockerLink[] => [
    ...childAndTaskLinks(taskId, reads),
    ...asanaHolds(taskId, reads),
  ]

  const childAndTaskLinks = (taskId: string, reads: TaskReads): BlockerLink[] =>
    [
      ...reads.blockers(taskId),
      ...reads.children(taskId).map((row) => ({
        ...row,
        blockerId: row.taskId,
        setByRunId: null,
        kind: 'child' as const,
      })),
    ].map((row) => {
      const { displayId, merged, ended } = blockerOf(row.blockerId, reads)
      return {
        blockerId: row.blockerId,
        ...('kind' in row && { kind: row.kind, satisfied: ended === 'archived' }),
        displayId,
        merged,
        ...(ended !== undefined && { ended }),
        ...(row.setByRunId !== null && { setByRunId: row.setByRunId }),
        at: row.at,
      }
    })

  const startRequestUsed = (taskId: string, at: string) =>
    taskRow(taskId)?.startRequested
      ? [events.taskStartRequestChanged({ taskId, startRequested: false, at })]
      : []

  const startCause = (taskId: string, cause: StartCause | undefined, at: string) =>
    cause
      ? [
          events.taskStartCause({
            taskId,
            cause: cause.cause,
            blockers: cause.cause === 'blockers-merged' ? [...cause.blockers] : [],
            at,
          }),
        ]
      : []

  const commentFiles = (commentId: string): Attachment[] =>
    store
      .query(queryDb(commentAttachments.where({ commentId }).orderBy('position', 'asc')))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const attachmentRows = (taskId: string) =>
    store.query(queryDb(taskAttachments.where({ taskId }).orderBy('at', 'asc')))

  const toAttachment = ({
    hash,
    name,
    size,
    mediaType,
  }: typeof taskAttachments.Type): Attachment => ({ hash, name, size, mediaType })

  const attachmentsOf = (taskId: string): Attachment[] => attachmentRows(taskId).map(toAttachment)

  const browserCapturesOf = (taskId: string): Attachment[] =>
    store
      .query(queryDb(taskBrowserCaptures.where({ taskId })))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const toSource = (row: typeof taskSources.Type | undefined): TaskSource | undefined => {
    if (!row) return undefined
    return {
      url: row.url,
      ...(row.linearIdentifier !== null &&
        row.linearTitle !== null && {
          linear: {
            identifier: row.linearIdentifier,
            title: row.linearTitle,
            ...(row.linearBranchName !== null && { branchName: row.linearBranchName }),
            ...(row.linearDescription !== null && { description: row.linearDescription }),
          },
        }),
      ...(row.sentryShortId !== null && { sentry: { shortId: row.sentryShortId } }),
      ...(row.asana !== null && { asana: JSON.parse(row.asana) as TaskAsanaSource }),
      ...(row.github !== null && { github: JSON.parse(row.github) as TaskGitHubSource }),
    }
  }

  const entryRows = (taskId: string) =>
    store.query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc')))

  const pauses = (): Partial<Record<AgentKind, string>> =>
    Object.fromEntries(store.query(queryDb(agentPauses)).map((row) => [row.agent, row.reason]))

  const heldRows = (taskId: string) => store.query(queryDb(heldRuns.where({ taskId })))

  const heldRow = (taskId: string) => heldRows(taskId).at(0)

  const planningFrom = (taskId: string) =>
    store
      .query(queryDb(plans.where({ fromTaskId: taskId })))
      .some((p) => p.state !== 'ended' && p.fromTaskGone === null)

  const taskReads = (everyTask: boolean, oneBuild = false) => {
    const rows = <Row>(
      one: (id: string) => readonly Row[],
      all: () => readonly Row[],
      key: (row: Row) => string | null,
    ): ((id: string) => readonly Row[]) => {
      if (!everyTask) return one
      let groups: Map<string | null, Row[]> | undefined
      return (id) => {
        groups ??= Map.groupBy(all(), key)
        return groups.get(id) ?? []
      }
    }
    const once = <Value>(read: () => Value): (() => Value) => {
      if (!everyTask && !oneBuild) return read
      let held: { value: Value } | undefined
      return () => {
        held ??= { value: read() }
        return held.value
      }
    }
    const everyParent = once(() => store.query(queryDb(taskParents.orderBy('taskId', 'asc'))))
    const everyPullRequest = once(() => store.query(queryDb(pullRequests)))
    const everyUsage = once(
      () => new Map(store.query(queryDb(runUsage)).map((row) => [row.id, row] as const)),
    )
    const factories = once(listFactories)
    return {
      factories,
      factoryKey: (factoryId: string) => keyAmong(factories(), factoryId),
      runs: rows(
        taskRuns,
        () => store.query(queryDb(runRows.orderBy('startedAt', 'desc'))),
        (r) => r.taskId,
      ),
      entries: rows(
        entryRows,
        () => store.query(queryDb(stageEntries.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      parents: rows(
        (taskId) => store.query(queryDb(taskParents.where({ taskId }))),
        everyParent,
        (r) => r.taskId,
      ),
      children: rows(childRows, everyParent, (r) => r.parentId),
      blockers: rows(
        blockerRows,
        () => store.query(queryDb(taskBlockers.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      repos: rows(
        repoRows,
        () => store.query(queryDb(taskRepos.orderBy('createdAt', 'asc'))),
        (r) => r.taskId,
      ),
      usage: (runIds: readonly string[]): (typeof runUsage.Type)[] => {
        if (runIds.length === 0) return []
        if (!everyTask)
          return store.query(queryDb(runUsage.where({ id: { op: 'IN', value: runIds } })))
        const all = everyUsage()
        return runIds.flatMap((id) => all.get(id) ?? [])
      },
      pullRequest: rows(pullRequestRows, everyPullRequest, (r) => r.id),
      pullRequests: rows(taskPullRequests, everyPullRequest, (r) => r.taskId),
      task: rows(
        (id) => store.query(queryDb(tasks.where({ id }))),
        () => store.query(allTasks),
        (r) => r.id,
      ),
      deleted: rows(
        deletedRows,
        () => store.query(queryDb(deletedTasks)),
        (r) => r.id,
      ),
      unfinishedChecks: rows(
        (taskId) =>
          store.query(
            queryDb(checkRuns.where({ taskId, finishedAt: null }).orderBy('startedAt', 'asc')),
          ),
        () =>
          store.query(queryDb(checkRuns.where({ finishedAt: null }).orderBy('startedAt', 'asc'))),
        (r) => r.taskId,
      ),
      queued: rows(
        (taskId) => store.query(queryDb(taskQueue.where({ taskId }))),
        () => store.query(queryDb(taskQueue)),
        (r) => r.taskId,
      ),
      held: rows(
        heldRows,
        () => store.query(queryDb(heldRuns)),
        (r) => r.taskId,
      ),
      log: rows(
        (taskId) => logRows(taskId),
        () => store.query(queryDb(taskLog.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      subAgentRequests: rows(
        (taskId) => store.query(queryDb(subAgentRequests.where({ taskId }))),
        () => store.query(queryDb(subAgentRequests)),
        (r) => r.taskId,
      ),
      comments: rows(
        (taskId) => commentRows(taskId),
        () => commentRows(),
        (r) => r.taskId,
      ),
      tabs: rows(
        (taskId) =>
          store.query(queryDb(conversationTabs.where({ taskId }).orderBy('openedAt', 'asc'))),
        () => store.query(queryDb(conversationTabs.orderBy('openedAt', 'asc'))),
        (r) => r.taskId,
      ),
      briefs: rows(
        (taskId) => store.query(queryDb(briefTimes.where({ taskId }).orderBy('version', 'asc'))),
        () => store.query(queryDb(briefTimes.orderBy('version', 'asc'))),
        (r) => r.taskId,
      ),
      sources: rows(
        (taskId) => store.query(queryDb(taskSources.where({ taskId }))),
        () => store.query(queryDb(taskSources)),
        (r) => r.taskId,
      ),
      planLinks: rows(
        (taskId) => store.query(queryDb(planTasks.where({ taskId }))),
        () => store.query(queryDb(planTasks)),
        (r) => r.taskId,
      ),
      plan: rows(
        (id) => store.query(queryDb(plans.where({ id }))),
        () => store.query(queryDb(plans)),
        (r) => r.id,
      ),
      automationLinks: rows(
        (taskId) => store.query(queryDb(automationTasks.where({ taskId }))),
        () => store.query(queryDb(automationTasks)),
        (r) => r.taskId,
      ),
      attachments: rows(
        attachmentRows,
        () => store.query(queryDb(taskAttachments.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      pauses: once(() => pauses()),
      queue: once(() => queue()),
      settings: once(() => settings()),
    }
  }
  type TaskReads = ReturnType<typeof taskReads>
  const planParent = (log: readonly (typeof taskLog.Type)[]) =>
    log.some(
      (e) =>
        e.name === 'v1.ChildTasksCreated' &&
        (JSON.parse(e.data) as { from?: unknown }).from === 'plan',
    )
  const perTask = taskReads(false)
  // Reading every table once costs about as much as reading 10 Tasks one by one.
  const readEveryTaskFrom = 10
  const sharedReads = (count: number) => {
    const reads = count > readEveryTaskFrom ? taskReads(true) : undefined
    const at = stateCommits
    return () => (stateCommits === at ? reads : undefined)
  }

  let noteTaskWait = (_taskId: string, _facts: TaskFacts) => {}
  let taskBuilds = 0
  const toTask = (
    {
      snoozedUntil,
      clarifyDepthBy,
      branch,
      worktree,
      chosenRepos,
      activity,
      activityEntries,
      leadAgent,
      leadModel,
      leadEffort,
      leadEffortMode,
      stageEffort,
      pendingLeadMessage,
      pendingLeadDeliveries,
      rank,
      changedAt,
      archivedAt,
      waitsForBlockers,
      stoppedAt,
      stoppedRuns,
      stoppedWhy,
      preparation,
      failedAt,
      followUpOf,
      forcedGates,
      gateOverrides,
      autopilotChoice,
      changesSettings,
      splitFrom,
      needsPlanningAt,
      partlyMergedAt,
      setup,
      coordinatorOperation,
      createdByTask,
      createdByRun: _createdByRun,
      ...row
    }: typeof tasks.Type,
    observe = false,
    reads: TaskReads = taskReads(false, true),
  ): StoredTask => {
    taskBuilds += 1
    tasksBuiltHere += 1
    const stage = row.stage as StageId
    const pendingMessages: LeadMessage[] =
      pendingLeadDeliveries !== null
        ? JSON.parse(pendingLeadDeliveries)
        : pendingLeadMessage !== null
          ? [{ id: `stage-legacy-${row.id}`, text: pendingLeadMessage }]
          : []
    const all = reads.runs(row.id)
    const lead = all.find((r) => r.parentRunId === null)
    const live = all.filter((r) => r.state !== 'finished')
    const tokens = taskTokens(all, reads.usage(all.map((r) => r.id)), liveTokens)
    const entries = reads.entries(row.id)
    const parentId = reads.parents(row.id).at(0)?.parentId
    const blockedBy = reads.blockers(row.id).map((b) => b.blockerId)
    const repos = reads
      .repos(row.id)
      .map((repo) => toTaskRepo(repo, reads.pullRequest(repo.id).at(0)))
    const unmerged = blockerLinks(row.id, reads).filter(
      (b) => !b.merged && !b.satisfied && b.kind !== 'asana',
    )
    const waitingOn = unmerged.map((b) => b.displayId)
    const firstEnded = unmerged[0]?.ended
    const visit = mergesHere(stage) ? history.mergeHistory(row.id) : undefined
    const leadWorks = visit?.awaitsLead === true && visit.leadAdvanced === undefined
    const waitingFor = mergesHere(stage)
      ? repos.find((r) => !r.removed && r.pullRequest?.waiting !== undefined)?.pullRequest?.waiting
      : undefined
    const github = leadWorks && waitingFor !== 'sign-in' ? undefined : waitingFor
    const openPullRequest = repos.some(
      (r) => !r.removed && r.pullRequest && r.pullRequest.state !== 'merged',
    )
    const merging = mergesHere(stage) && openPullRequest ? history.mergeHistory(row.id) : undefined
    const mergeWaits = merging?.latest === 'started'
    const autoMergeLeft =
      merging !== undefined &&
      !mergeWaits &&
      repos.some(
        (r) =>
          !r.removed && r.pullRequest?.autoMerge !== undefined && r.pullRequest.state !== 'merged',
      ) &&
      merging.canceledAt !== undefined
    const checking = reads.unfinishedChecks(row.id).at(0)
    const checkingNow = checking && checkProgress(checking.id)
    const queued = reads.queued(row.id).at(0)
    const paused = reads.pauses()
    const held = reads.held(row.id).at(0)
    const taskComments = reads.comments(row.id)
    const heldAnswer = taskComments.some(
      (comment) => comment.answerHeld && comment.answerQueuedAt !== null,
    )
    const queuedContinuation = pendingMessages.some((message) => message.waitForSlot) || heldAnswer
    const queuedAfter =
      pendingMessages.find((message) => message.waitForSlot && message.after !== undefined)
        ?.after ?? (heldAnswer ? 'answer' : undefined)
    const place =
      queued || queuedContinuation
        ? (queueActivity.taskPlaces?.find((entry) => entry.id === row.id)?.place ??
          (queued ? reads.queue().findIndex((q) => q.id === row.id) + 1 : 0))
        : 0
    const pausedRuns = taskPauses({
      taskId: row.id,
      heldAgent: held?.agent,
      liveRuns: live,
      queuedAgent: place > 0 && leadAgent !== null ? leadAgent : undefined,
      pauses: paused,
    })
    const pausedReason = pausedRuns[0]?.reason
    const leadLive =
      lead !== undefined && lead.state !== 'finished' && stage !== 'backlog' && stage !== 'done'
    const leadStopped =
      lead?.state === 'finished' &&
      lead.ended !== null &&
      (JSON.parse(lead.ended) as RunEnding).how === 'stopped'
    const lastFailure = leadStopped
      ? reads
          .log(row.id)
          .filter((entry) => entry.name === 'v1.TaskLeadFailed')
          .toSorted((a, b) => sequence(a.id) - sequence(b.id))
          .at(-1)
      : undefined
    const failure = lastFailure && (JSON.parse(lastFailure.data) as Record<string, unknown>)
    const recovering =
      lastFailure !== undefined &&
      failure?.runId === lead?.id &&
      failure?.recovery === 'resume' &&
      (lead?.revivedAt === null || (lead?.revivedAt ?? '') < lastFailure.at)
    const opened = repos.filter((r) => !r.removed && r.pullRequest !== undefined)
    const mergedRepos = opened.filter((r) => r.pullRequest?.state === 'merged')
    const openRepos = opened.filter((r) => r.pullRequest?.state !== 'merged')
    const partlyMerged =
      partlyMergedAt !== null && mergedRepos.length > 0 && openRepos.length > 0
        ? { merged: mergedRepos.map((r) => r.name), open: openRepos.map((r) => r.name) }
        : undefined
    const requests = taskComments.filter((row) => isOpenRequest(row) && row.heldFor === null)
    const facts: TaskFacts = {
      ...(preparation === 'preparing' && { preparing: true }),
      ...(snoozedUntil !== null && { snoozedUntil }),
      ...(archivedAt !== null && { archived: true }),
      ...(failedAt !== null && { failed: true }),
      ...(isCleanup(stage) &&
        requests.some((row) => row.cleanupFailure !== null) && { cleanupFailed: true }),
      ...(isCleanup(stage) && checkingTasks.has(row.id) && { cleanupCommandsRunning: true }),
      ...(partlyMerged && { partlyMerged }),
      ...(stoppedAt !== null && {
        stopped: {
          at: stoppedAt,
          runs: stoppedRuns ?? 0,
          why:
            stoppedWhy === 'blockers-removed' ||
            stoppedWhy === 'repair-incorporation' ||
            stoppedWhy === 'prepared'
              ? stoppedWhy
              : 'human',
        },
      }),
      stage,
      ...(leadWorks && { mergeLeadWorks: true }),
      ...(leadLive && { leadLive }),
      ...(leadStopped &&
        !held &&
        !recovering &&
        !waitsForBlockers &&
        repos.some((r) => !r.removed) && { interrupted: true }),
      ...((place > 0 || held) && {
        queue:
          (leadAgent ?? held?.agent) &&
          !reads.settings().enabledAgents.includes((leadAgent ?? held?.agent) as AgentKind) &&
          (!leadLive || lead?.agent !== (leadAgent ?? held?.agent))
            ? { hold: `${leadAgent ?? held?.agent} is off. Enable it in Settings → Providers.` }
            : place > 0
              ? newWorkHeld === undefined
                ? { place, ...(queuedAfter !== undefined && { after: queuedAfter }) }
                : { hold: newWorkHeld }
              : { hold: 'Waiting for a Provider' },
      }),
      ...(place > 0 && heldBusy && { busy: heldBusy }),
      queuedSubAgents: reads.subAgentRequests(row.id).map((r) => ({
        id: r.id,
        ...(paused[r.agent as AgentKind] !== undefined && {
          paused: paused[r.agent as AgentKind],
        }),
        ...(!reads.settings().enabledAgents.includes(r.agent as AgentKind)
          ? { hold: `${r.agent} is off. Enable it in Settings → Providers.` }
          : newWorkHeld !== undefined
            ? { hold: newWorkHeld }
            : heldBusy
              ? { hold: busyHold }
              : {}),
      })),
      pausedRuns,
      runs: live.filter((r) => !stoppingRuns.has(r.id)).map((r) => r.state as RunState),
      openRequests: requests.filter((r) => !groupAskRow(r)).length,
      ...requestsSnoozed(
        row.id,
        requests.filter((r) => !groupAskRow(r)),
      ),
      ...permissionWait(requests, lead?.id),
      ...(pausedReason !== undefined && { paused: pausedReason }),
      ...(waitingOn.length > 0 && { blockedBy: waitingOn }),
      ...(firstEnded !== undefined && { blockerEnded: firstEnded }),
      ...(row.startRequested && { startsAfterBlockers: true }),
      ...(github !== undefined && { github }),
      ...(mergeWaits && { mergePending: true }),
      ...(autoMergeLeft && { autoMergeLeft: true }),
      ...(stoppedAt === null &&
        place === 0 &&
        repos.some((r) => !r.removed && r.setup?.state === 'running') && { settingUp: true }),
      ...((checking || checkingTasks.has(row.id)) && { checksActive: true }),
      ...(checkingNow && { checking: checkingNow }),
      ...(movingAfterChecks.has(row.id) && { movingAfterChecks: true }),
      testActivity: testInvocationStore.active(row.id),
      ...(checksWaiting.has(row.id) && {
        checksWaiting: { place: checksWaiting.get(row.id) ?? 1 },
      }),
      ...(activity !== null && activityEntries === entries.length && { agentActivity: activity }),
      ...(live.some((r) => r.retrying) && { retrying: true }),
      ...(needsPlanningAt !== null && { needsPlanning: true }),
      ...(hasClarifyRounds(stage) && planningFrom(row.id) && { planningInChat: true }),
    }
    if (observe) noteTaskWait(row.id, facts)
    const status = taskStatus(facts)
    const delivery = commentDelivery(facts)
    const unblocked = statusWithoutBlocker(facts, status)
    const shown = taskActivity(facts)
    const tabs: ConversationTab[] = reads.tabs(row.id).flatMap((tab) => {
      const run = all.find((r) => r.id === tab.runId)
      return run
        ? [
            {
              runId: run.id,
              name: runName(run),
              agent: run.agent as AgentKind,
              state: run.state as RunState,
            },
          ]
        : []
    })
    const updatedAt = [
      row.createdAt,
      changedAt,
      queued?.queuedAt,
      entries.at(-1)?.at,
      ...all.map((r) => r.startedAt),
      lastCommentAt(taskComments),
      reads.briefs(row.id).at(-1)?.createdAt,
    ].reduce<string>((a, b) => (b && b > a ? b : a), row.createdAt)
    const ended = (): TaskEnding => {
      if (all.length === 0 && repos.length === 0) return { kind: 'never-started' }
      if (stage === 'done') {
        return {
          kind: 'merged',
          at: entries.findLast((e) => e.stage === 'done')?.at ?? row.createdAt,
        }
      }
      const closedOnGitHub = repos
        .flatMap((r) =>
          r.pullRequest?.state === 'closed' && r.pullRequest.closedOnGitHub !== undefined
            ? [r.pullRequest.closedOnGitHub]
            : [],
        )
        .sort()
        .at(-1)
      if (closedOnGitHub !== undefined) return { kind: 'pull-request-closed', at: closedOnGitHub }
      return { kind: 'stopped', stage }
    }
    const source = toSource(reads.sources(row.id).at(0))
    const taskOrDeleted = (id: string) => reads.task(id).at(0) ?? reads.deleted(id).at(0)
    const original = followUpOf === null ? undefined : taskOrDeleted(followUpOf)
    const splitOriginal = splitFrom === null ? undefined : taskOrDeleted(splitFrom)
    const planLink = reads.planLinks(row.id).at(0)
    const planTitle = planLink && reads.plan(planLink.planId).at(0)?.title
    const merged =
      stage === 'done' || isCleanup(stage)
        ? {
            at:
              entries.findLast((e) => isCleanup(e.stage))?.at ??
              entries.findLast((e) => e.stage === 'done')?.at ??
              row.createdAt,
            pullRequests: repos.flatMap((r) =>
              r.pullRequest?.state === 'merged' ? [r.pullRequest.number] : [],
            ),
          }
        : undefined
    const createdBy: CreatedBy = setup
      ? 'setup'
      : coordinatorOperation !== null
        ? 'coordinator'
        : createdByTask !== null
          ? 'task-lead'
          : followUpOf !== null
            ? 'follow-up'
            : splitFrom !== null
              ? 'split'
              : reads.automationLinks(row.id).length > 0
                ? 'automation'
                : planLink || planParent(reads.log(row.id))
                  ? 'planning'
                  : 'human'
    const linearSync = linearSyncOf(row, source, reads)
    const asanaSync = asanaSyncFor(
      { id: row.id, factoryId: row.factoryId, archived: archivedAt !== null },
      source,
      stage,
      reads,
    )
    return {
      ...row,
      ...(entries[0] && { startedAt: entries[0].at }),
      ...(snoozedUntil !== null && { snoozedUntil }),
      priority: row.priority as Priority,
      clarifyDepth: row.clarifyDepth as ClarifyDepth,
      ...(clarifyDepthBy !== null
        ? { clarifyDepthBy: clarifyDepthBy as ClarifyDepthChooser }
        : row.clarifyDepth !== 'auto' && { clarifyDepthBy: 'human' as const }),
      ...(leadAgent !== null && {
        lead: {
          agent: leadAgent as AgentKind,
          ...(leadEffortMode === 'stage' && { effortMode: 'stage' as const }),
          ...(leadModel !== null && { model: leadModel }),
          ...(leadEffort !== null && { effort: leadEffort as Effort }),
        },
      }),
      ...(stageEffort !== null && { stageEffort: stageEffort as Effort }),
      pendingLeadMessages: pendingMessages,
      blockedBy,
      ...(parentId !== undefined && { parentId }),
      childIds: reads.children(row.id).map((child) => child.taskId),
      waitsForBlockers,
      stopped: stoppedAt !== null,
      ...((preparation === 'preparing' || preparation === 'ready') && { preparation }),
      autopilot: {
        choice: (autopilotChoice ?? 'inherit') as AutopilotChoice,
        enabled: autopilotEnabled(
          (autopilotChoice ?? 'inherit') as AutopilotChoice,
          reads.settings().overnightMode,
        ),
      },
      gateOverrides: gateOverrides === null ? {} : (JSON.parse(gateOverrides) as TaskGateOverrides),
      forcedGates: forcedGates === null ? [] : (JSON.parse(forcedGates) as AgentStageId[]),
      changesSettings,
      repos,
      chosenRepos:
        chosenRepos !== null
          ? (JSON.parse(chosenRepos) as string[])
          : reads
              .factories()
              .filter((f) => f.id === row.factoryId)
              .map((f) => f.repo),
      attachments: reads.attachments(row.id).map(toAttachment),
      ...(source && { source }),
      stage,
      rank: rank ?? row.number,
      displayId: `${reads.factoryKey(row.factoryId)}-${row.number}`,
      ...(branch !== null && { branch }),
      ...(worktree !== null && { worktree }),
      ...(lead !== undefined && { leadRunId: lead.id }),
      ...(status !== undefined && { status }),
      ...(unblocked !== undefined && { statusWithoutBlocker: unblocked }),
      statuses: taskStatuses(facts),
      markers: taskMarkers(facts, status),
      ...(shown !== undefined && { activity: shown }),
      track: track(stage, entries),
      commentBox: commentBox(facts, status),
      ...(delivery !== undefined && { commentDelivery: delivery }),
      ...(taskCanResume(facts) && { canResume: true }),
      ...(taskWakesOnComment(facts) && { wakesOnComment: true as const }),
      ...(facts.checksActive && { checksActive: true }),
      tabs,
      ...(tokens > 0 && { tokens }),
      runs: live
        .sort(
          (a, b) =>
            Number(b.id === lead?.id) - Number(a.id === lead?.id) ||
            a.startedAt.localeCompare(b.startedAt),
        )
        .map((r) => {
          const reason = paused[r.agent as AgentKind]
          return {
            id: r.id,
            agent: r.agent as AgentKind,
            role: r.parentRunId === null ? ('lead' as const) : ('sub-agent' as const),
            name: runName(r),
            state: r.state as RunState,
            ...(reason !== undefined && { paused: reason }),
            ...(waitingOnSubAgents.has(r.id) && { onSubAgents: true }),
          }
        }),
      ...(setup && { setup: true as const }),
      createdBy,
      ...(linearSync !== undefined && { linearSync }),
      ...(asanaSync !== undefined && { asanaSync }),
      ...(planLink && {
        fromPlan: {
          id: planLink.planId,
          title: planTitle ?? '',
          ...(planTitle === undefined && { deleted: true }),
        },
      }),
      ...(followUpOf !== null && {
        followUpOf: {
          id: followUpOf,
          displayId: original
            ? `${reads.factoryKey(original.factoryId)}-${original.number}`
            : followUpOf,
        },
      }),
      ...(splitFrom !== null && {
        splitFrom: {
          id: splitFrom,
          displayId: splitOriginal
            ? `${reads.factoryKey(splitOriginal.factoryId)}-${splitOriginal.number}`
            : splitFrom,
        },
      }),
      ...(merged && { merged }),
      updatedAt,
      ...(archivedAt !== null && { archived: { at: archivedAt, ended: ended() } }),
    }
  }

  const toPublicTask = ({
    pendingLeadMessages: _______,
    leadRestartPending: ________,
    forcedGates: _____,
    changesSettings: ______,
    worktree: _,
    startRequested: __,
    waitsForBlockers: ___,
    stopped: ____,
    ...task
  }: StoredTask): Task => task

  const promptTextCache = new Map<string, string>()
  const promptText = (hash: string): string | undefined => {
    const cached = promptTextCache.get(hash)
    if (cached !== undefined) return cached
    const text = store.query(queryDb(promptTexts.select('text').where({ hash }))).at(0)
    if (text !== undefined) promptTextCache.set(hash, text)
    return text
  }

  const toRun = ({
    readOffset: _,
    lastOutputAt: _lastOutputAt,
    taskId,
    sessionId,
    model,
    effort,
    usesDefaultModel,
    problem,
    problemAt: _problemAt,
    parentRunId,
    name,
    failure,
    permissions,
    manualPermissions,
    revivedAt,
    ended,
    retrying: _retrying,
    steeringRelease: _steeringRelease,
    ...row
  }: RunRow): Run => ({
    ...row,
    ...(parentRunId !== null && { parentRunId }),
    ...(name !== null && { name }),
    ...(failure !== null && { failure }),
    permissions: permissions === 'bypass' ? 'bypass' : 'auto',
    ...(manualPermissions && { manualPermissions }),
    agent: row.agent as AgentKind,
    state: row.state as RunState,
    ...(sessionId !== '' && { sessionId }),
    ...(model !== null && { model }),
    ...(effort !== null && { effort: effort as Effort }),
    ...(usesDefaultModel && { usesDefaultModel }),
    ...(problem !== null && { problem: problem as RunProblem }),
    ...(taskId !== null && { taskId }),
    ...(revivedAt !== null && { revivedAt }),
    ...(ended !== null && { ended: JSON.parse(ended) as RunEnding }),
    ...(asleepRuns.has(row.id) && { asleep: true as const }),
  })

  const withPurpose = (comment: Comment, stored: string | null): Comment => {
    if (comment.kind === 'note') return comment
    if (stored !== null) return { ...comment, purpose: JSON.parse(stored) as RequestPurpose }
    const structural = structuralPurpose(comment)
    if (structural && structural.kind !== 'question') return { ...comment, purpose: structural }
    const sendBack = store.query(queryDb(sendBackAsks.where({ commentId: comment.id }))).length > 0
    const failure = failureStore
      .list(comment.taskId)
      .some((f) => f.decisions.some((d) => d.commentId === comment.id))
    const purpose = sendBack
      ? { kind: 'send-back' as const }
      : failure
        ? { kind: 'failure' as const }
        : legacyPurpose(comment, () => {
            const modelRun = store
              .query(queryDb(runRows.where({ taskId: comment.taskId }).orderBy('startedAt', 'asc')))
              .filter((r) => r.parentRunId === null && r.startedAt <= comment.createdAt)
              .at(-1)
            return modelRun?.id
          })
    return purpose ? { ...comment, purpose } : comment
  }

  const commentPeer = (id: string): Pick<Comment, 'peer'> => {
    const peer = store.query(queryDb(peerMessages.where({ id }))).at(0)
    if (!peer) return {}
    const sender = taskRow(peer.senderTaskId) ?? deletedRows(peer.senderTaskId).at(0)
    return {
      peer: {
        ...(sender && { sender: `${factoryKey(sender.factoryId)}-${sender.number}` }),
        text: peer.text,
      },
    }
  }

  const toComment = ({
    authorKind,
    authorRunId,
    stage,
    title,
    choices,
    round,
    proposal,
    sizeCheck,
    gate,
    answer,
    deliveredRunId,
    deliveredAt,
    readAt,
    permission,
    simulator,
    answerHeld: _,
    answerQueuedAt,
    answerSentRunId,
    answerSentAt,
    failedRunId,
    talkRequested,
    talkMessageId: _talkMessageId,
    talkNotifiedAt,
    talkRunId,
    talkStartedAt,
    talkDoneAt,
    design,
    tutorial: _tutorial,
    linearTeam,
    asanaMissing,
    asanaUnfinished,
    archive,
    cleanupFailure,
    memoryKill,
    multiple,
    purpose,
    heldFor,
    ...row
  }: typeof comments.Type): Comment =>
    withPurpose(
      {
        ...row,
        kind: row.kind as CommentKind,
        author:
          authorKind === 'run' && authorRunId !== null
            ? { kind: 'run', runId: authorRunId }
            : { kind: authorKind === 'ted' ? 'ted' : 'human' },
        ...(heldFor !== null && { held: true as const }),
        ...(stage !== null && { stage: stage as StageId }),
        ...(title !== null && { title }),
        ...(choices !== null && { choices: JSON.parse(choices) as string[] }),
        ...(multiple && { multiple: true as const }),
        ...(round !== null && { round: JSON.parse(round) as Round }),
        ...(talkRequested && { talkRequested: true as const }),
        ...(talkRunId !== null &&
          talkStartedAt !== null && {
            talk: {
              runId: talkRunId,
              startedAt: talkStartedAt,
              ...(talkNotifiedAt !== null && { notifiedAt: talkNotifiedAt }),
              ...(talkDoneAt !== null && { doneAt: talkDoneAt }),
            },
          }),
        ...(proposal !== null && { proposal: JSON.parse(proposal) as Proposal }),
        ...(sizeCheck !== null && { sizeCheck: JSON.parse(sizeCheck) as SizeCheck }),
        ...(gate !== null && { gate: JSON.parse(gate) as NonNullable<Comment['gate']> }),
        ...(permission !== null && { permission: publicPermission(permission) }),
        ...(simulator !== null && { simulator: JSON.parse(simulator) as SimulatorAsk }),
        ...(answer !== null && { answer: JSON.parse(answer) as CommentAnswer }),
        ...(deliveredRunId !== null &&
          deliveredAt !== null && { delivered: { runId: deliveredRunId, at: deliveredAt } }),
        ...(answerQueuedAt !== null && {
          answerDelivery: {
            queuedAt: answerQueuedAt,
            ...(answerSentRunId !== null &&
              answerSentAt !== null && {
                sent: { runId: answerSentRunId, at: answerSentAt },
              }),
          },
        }),
        ...(readAt !== null && { readAt }),
        ...(failedRunId !== null && { failed: { runId: failedRunId } }),
        ...(linearTeam !== null && { linearTeam: JSON.parse(linearTeam) as LinearTeam }),
        ...(asanaMissing !== null && { asanaMissing: JSON.parse(asanaMissing) as AsanaMissing }),
        ...(asanaUnfinished !== null && {
          asanaUnfinished: JSON.parse(asanaUnfinished) as AsanaUnfinished,
        }),
        ...(archive !== null && { archive: JSON.parse(archive) as ArchiveAsk }),
        ...(cleanupFailure !== null && {
          cleanupFailure: JSON.parse(cleanupFailure) as CleanupFailureAsk,
        }),
        ...(memoryKill !== null && { memoryKill: JSON.parse(memoryKill) as MemoryKillAsk }),
        ...(design !== null && { design: JSON.parse(design) as DesignReview }),
        ...withFiles(row.id),
        ...withLineComments(row.id),
        ...commentPeer(row.id),
      },
      purpose,
    )

  const toLineComment = ({
    side,
    quoted,
    editedAt,
    commentId,
    sentAt,
    deleted: _,
    ...row
  }: typeof lineComments.Type): LineComment => ({
    ...row,
    side: side as LineSide,
    quoted: JSON.parse(quoted) as DiffRow[],
    ...(editedAt !== null && { editedAt }),
    ...(commentId !== null && sentAt !== null && { sent: { commentId, at: sentAt } }),
  })

  const withLineComments = (commentId: string): { lineComments?: LineComment[] } => {
    const sent = store
      .query(queryDb(lineComments.where({ commentId }).orderBy('createdAt', 'asc')))
      .map(toLineComment)
    return sent.length > 0 ? { lineComments: sent } : {}
  }

  const lineCommentDrafts = (taskId: string) =>
    store
      .query(
        queryDb(
          lineComments
            .where({ taskId, commentId: null, deleted: false })
            .orderBy('createdAt', 'asc'),
        ),
      )
      .map(toLineComment)

  const lineCommentsSent = (ids: readonly string[] | undefined, commentId: string, at: string) =>
    ids === undefined || ids.length === 0
      ? []
      : [events.lineCommentsSent({ ids: [...ids], commentId, at })]

  const withFiles = (commentId: string): { attachments?: Attachment[] } => {
    const files = commentFiles(commentId)
    return files.length > 0 ? { attachments: files } : {}
  }

  const openPermissionRows = (runId: string, requestId?: string) =>
    store
      .query(queryDb(comments.where({ authorRunId: runId, kind: 'permission' })))
      .filter(
        (row) =>
          row.answer === null &&
          (requestId === undefined
            ? row.permission !== null || row.simulator !== null
            : row.permission !== null && storedPermission(row.permission).requestId === requestId),
      )

  const permissionWait = (
    requests: readonly (typeof comments.Type)[],
    leadId: string | undefined,
  ) => {
    const asking = requests.filter((r) => r.kind === 'permission')
    if (asking.length === 0) return {}
    return {
      ...(asking.some((r) => r.simulator !== null && !androidAsk(r.simulator)) && {
        waitingOnSimulator: true,
      }),
      ...(asking.some((r) => r.simulator !== null && androidAsk(r.simulator)) && {
        waitingOnEmulator: true,
      }),
      waitingOnPermission: asking.some((r) => r.authorRunId === leadId)
        ? ('lead' as const)
        : ('sub-agent' as const),
    }
  }

  const commentRows = (taskId?: string) =>
    store.query(
      queryDb(
        comments
          .where(taskId === undefined ? { tutorial: false } : { taskId, tutorial: false })
          .orderBy('createdAt', 'asc'),
      ),
    )

  const isOpenRequest = (row: typeof comments.Type) => row.kind !== 'note' && row.answer === null

  const requestsSnoozed = (
    taskId: string,
    open: readonly { id: string }[],
  ): { requestsSnoozedUntil?: string } => {
    if (open.length === 0) return {}
    const until = new Map(
      store
        .query(queryDb(requestSnoozes.where({ ownerId: taskId })))
        .map((row) => [row.requestId, row.until]),
    )
    const times = open.flatMap((request) => until.get(request.id) ?? [])
    const first = times.sort()[0]
    return times.length < open.length || first === undefined ? {} : { requestsSnoozedUntil: first }
  }

  const openRequestRows = (taskId?: string) => commentRows(taskId).filter(isOpenRequest)
  const shownRequestRows = () => openRequestRows().filter((row) => row.heldFor === null)

  const toBrief = ({ runId, stage, id: _, ...row }: typeof taskBriefs.Type): TaskBrief => ({
    ...row,
    stage: stage as StageId,
    ...(runId !== null && { runId }),
  })
  const descriptionRows = (taskId: string) =>
    store.query(queryDb(taskDescriptions.where({ taskId }).orderBy('version', 'asc')))

  const briefRows = (taskId: string) =>
    store.query(queryDb(taskBriefs.where({ taskId }).orderBy('version', 'asc')))

  const stageEntered = (taskId: string, stage: StageId, entry: NewStageEntry, at: string) =>
    events.taskStageEnteredV4({
      id: randomUUID(),
      taskId,
      stage,
      effort: entry.effort ?? null,
      stageFileLayer: entry.stageFile?.layer ?? null,
      stageFilePath: entry.stageFile?.path ?? null,
      layers: JSON.stringify(entry.layers),
      order: JSON.stringify(entry.order.map(({ stage, enabled }) => ({ stage, enabled }))),
      names: JSON.stringify(
        Object.fromEntries(
          entry.order.flatMap((p) => (p.name === undefined ? [] : [[p.stage, p.name]])),
        ),
      ),
      at,
    })

  const toStageEntry = (row: typeof stageEntries.Type): StageEntry => ({
    taskId: row.taskId,
    stage: row.stage as StageId,
    ...(row.stageFileLayer !== null &&
      row.stageFilePath !== null && {
        stageFile: { layer: row.stageFileLayer as LayerKind, path: row.stageFilePath },
      }),
    layers: JSON.parse(row.layers) as LayerUse[],
    at: row.at,
  })

  const checkRunRows = (taskId?: string) =>
    store.query(
      queryDb(
        (taskId === undefined ? checkRuns : checkRuns.where({ taskId })).orderBy(
          'startedAt',
          'asc',
        ),
      ),
    )
  const checkResultRows = (checkRunId: string) =>
    store.query(queryDb(checkResults.where({ checkRunId }).orderBy('position', 'asc')))
  const toCheckResult = (row: typeof checkResults.Type): CheckResult => ({
    name: row.name,
    ...(row.repo !== null && { repo: row.repo }),
    command: row.command,
    timeout: row.timeout,
    state: row.state as CheckState,
    ...(row.exitCode !== null && { exitCode: row.exitCode }),
    ...(row.durationMs !== null && { durationMs: row.durationMs }),
    ...(row.builtIn === 'ted-settings' && { builtIn: 'ted-settings' as const }),
  })
  const toCheckRun = (row: typeof checkRuns.Type): CheckRun => {
    const run: CheckRun = {
      id: row.id,
      taskId: row.taskId,
      trigger: row.trigger as CheckRunTrigger,
      stage: row.stage as StageId,
      checks: checkResultRows(row.id).map(toCheckResult),
      startedAt: row.startedAt,
      ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
      ...(row.outcome !== null && { outcome: row.outcome as CheckRunOutcome }),
      ...(row.finishedAt === null && checksWaiting.has(row.taskId) && { waiting: true }),
    }
    return {
      ...run,
      timing: checkRunTiming(
        run,
        store.query(queryDb(checkBoundaries.where({ checkRunId: row.id }))),
      ),
    }
  }
  const checkProgress = (checkRunId: string) => {
    const rows = checkResultRows(checkRunId)
    const index = rows.findIndex((r) => r.state === 'running')
    const current = rows[index]
    if (!current) return undefined
    return {
      name: current.repo === null ? current.name : `${current.name} (${current.repo})`,
      index: index + 1,
      total: rows.length,
    }
  }
  const requireCheckRun = (id: string) => {
    const row = store.query(queryDb(checkRuns.where({ id }))).at(0)
    if (!row) throw new Error(`no Check run ${id}`)
    return toCheckRun(row)
  }
  const updatedCheckRun = (id: string): CheckRun => {
    const checkRun = requireCheckRun(id)
    emit({ type: 'check-run-updated', checkRun })
    noteActivity()
    updatedTask(checkRun.taskId)
    return checkRun
  }
  const conflictFound = (
    taskId: string,
    conflict: FoundConflict,
    at: string,
    sendBackId: string | null,
  ) =>
    events.baseConflictFound({
      id: randomUUID(),
      taskId,
      stage: conflict.stage,
      repo: conflict.repo,
      base: conflict.base,
      tip: conflict.tip,
      fileCount: conflict.fileCount,
      files: [...conflict.files],
      sendBackId,
      at,
    })
  const toBaseConflict = ({
    files,
    sendBackId,
    ...row
  }: typeof baseConflicts.Type): BaseConflictFound => ({
    ...row,
    stage: row.stage as StageId,
    files: JSON.parse(files) as string[],
    ...(sendBackId !== null && { sendBackId }),
  })
  const toSendBack = (row: typeof sendBacks.Type): SendBack => ({
    id: row.id,
    taskId: row.taskId,
    from: row.fromStage as StageId,
    to: row.toStage as StageId,
    findings: row.findings,
    counted: row.counted,
    ...(row.round !== null && { round: row.round }),
    ...(row.limit !== null && { limit: row.limit }),
    ...(row.checkRunId !== null && { checkRunId: row.checkRunId }),
    ...(row.cause !== null && { cause: row.cause as SendBackCause }),
    at: row.at,
  })

  const taskRow = (id: string) => store.query(queryDb(tasks.where({ id }))).at(0)
  const taskRowByDisplayId = (ref: string) => {
    const dash = ref.lastIndexOf('-')
    const digits = ref.slice(dash + 1)
    if (dash < 0 || !/^(0|[1-9]\d*)$/.test(digits)) return undefined
    const key = ref.slice(0, dash)
    const number = Number(digits)
    const row = store
      .query(queryDb(tasks.where({ number })))
      .find((row) => factoryKey(row.factoryId) === key)
    if (row) return row
    const moved = store
      .query(queryDb(taskMoves.where({ number })))
      .find((row) => factoryKey(row.factoryId) === key)
    return moved ? taskRow(moved.taskId) : undefined
  }
  const nextNumber = (factoryId: string) => {
    const awaitingSetup =
      listFactories().find((f) => f.id === factoryId)?.clonedAt === undefined &&
      factoryId !== placeholderFactory.id
    return Math.max(awaitingSetup ? 1 : 0, ...usedNumbers(factoryId)) + 1
  }
  const usedNumbers = (factoryId: string) => [
    ...store.query(queryDb(tasks.select('number').where({ factoryId }))),
    ...store.query(queryDb(deletedTasks.select('number').where({ factoryId }))),
    ...store.query(queryDb(taskMoves.select('number').where({ factoryId }))),
  ]
  const lastCommentAt = (rows: readonly (typeof comments.Type)[]) =>
    rows
      .flatMap((c) => [
        c.createdAt,
        ...(c.answer === null ? [] : [(JSON.parse(c.answer) as CommentAnswer).at]),
      ])
      .reduce<string | undefined>((a, b) => (a === undefined || b > a ? b : a), undefined)
  const requireTaskRow = (taskId: string) => {
    const row = taskRow(taskId)
    if (!row) throw new Error(`no Task ${taskId}`)
    return row
  }

  const taskEdited = (
    taskId: string,
    edit: { title?: string; description?: string },
    at: string,
  ) => {
    const row = requireTaskRow(taskId)
    const title = edit.title !== undefined && edit.title !== row.title ? edit.title : null
    const description =
      edit.description !== undefined && edit.description !== row.description
        ? edit.description
        : null
    if (title === null && description === null) return undefined
    const latest = descriptionRows(taskId).at(-1)
    return events.taskEdited({
      taskId,
      title,
      description,
      version: description === null ? null : (latest?.version ?? 1) + 1,
      previous: description === null || latest ? null : row.description,
      previousAt: description === null || latest ? null : row.createdAt,
      at,
    })
  }

  const nextRank = () =>
    store
      .query(queryDb(tasks.select('rank', 'number')))
      .reduce((highest, t) => Math.max(highest, t.rank ?? t.number), 0) + 1
  const runRow = (id: string) => store.query(queryDb(runRows.where({ id }))).at(0)
  const heldOutput = new Map<string, { toOffset: number; lastOutputAt?: string }>()
  const listTasks = () => {
    const reads = taskReads(true)
    return store.query(allTasks).map((row) => toTask(row, false, reads))
  }
  const taskIdOfRun = (runId: string) => runRow(runId)?.taskId ?? undefined

  const listeners = new Set<(event: DaemonEvent) => void>()
  const emitting: DaemonEvent[] = []
  const emit = (event: DaemonEvent) => {
    emitting.push(event)
    if (emitting.length > 1) return
    let failure: { error: unknown } | undefined
    for (let next = emitting[0]; next; next = emitting[0]) {
      try {
        for (const listener of listeners) listener(next)
        if (setUpChanged(next)) emitting.push({ type: 'guides-changed', guides: guides() })
      } catch (error) {
        failure ??= { error }
      }
      emitting.shift()
    }
    if (failure) throw failure.error
  }

  const getComment = (id: string) => {
    const row = store.query(queryDb(comments.where({ id }))).at(0)
    return row && toComment(row)
  }
  const lineCommentRow = (id: string) => {
    const row = store.query(queryDb(lineComments.where({ id, deleted: false }))).at(0)
    return row && toLineComment(row)
  }
  const requireLineComment = (id: string) => {
    const found = lineCommentRow(id)
    if (!found) throw new Error(`no line comment ${id}`)
    return found
  }
  const requireComment = (id: string) => {
    const comment = getComment(id)
    if (!comment) throw new Error(`no Comment ${id}`)
    return comment
  }
  const treeTaskEvents = (
    task: NewTreeTask,
    {
      id,
      factoryId,
      number,
      rank,
      parentId,
      at,
    }: {
      id: string
      factoryId: string
      number: number
      rank: number
      parentId?: string
      at: string
    },
  ) => [
    events.taskCreatedV2({
      id,
      factoryId,
      number,
      title: task.title,
      description: task.description,
      priority: task.priority,
      clarifyDepth: 'auto',
      leadAgent: task.lead?.agent ?? null,
      leadModel: task.lead?.model ?? null,
      leadEffort: task.lead?.effort ?? null,
      startRequested: task.startRequested,
      createdAt: at,
    }),
    ...(task.lead?.effortMode === 'stage'
      ? [events.taskLeadEffortModeSet({ taskId: id, mode: 'stage', at })]
      : []),
    events.taskRanked({ taskId: id, rank, at }),
    ...(parentId !== undefined ? [events.taskParentChanged({ taskId: id, parentId, at })] : []),
    ...task.attachments.map((attachment) =>
      events.taskAttachmentAdded({ taskId: id, ...attachment, at }),
    ),
    events.taskSourceSet({
      taskId: id,
      url: task.sourceUrl,
      linearIdentifier: null,
      linearTitle: null,
      linearBranchName: null,
      linearDescription: null,
      at,
    }),
    ...(task.asana
      ? [events.taskSourceAsanaSet({ taskId: id, asana: JSON.stringify(task.asana), at })]
      : []),
    ...(task.github
      ? [events.taskSourceGitHubSet({ taskId: id, github: JSON.stringify(task.github), at })]
      : []),
    ...(task.asana && task.projects !== undefined
      ? [
          events.trackerItemGroupsSeen({
            taskId: id,
            tracker: 'asana',
            item: task.asana.gid,
            groups: [...task.projects],
            at,
          }),
        ]
      : []),
    ...(task.asana && task.syncAccount !== undefined
      ? [
          events.trackerSyncAllowed({
            taskId: id,
            tracker: 'asana',
            item: task.asana.gid,
            by: 'import',
            account: task.syncAccount,
            at,
          }),
        ]
      : []),
    ...(task.asana && task.syncDeclined
      ? [
          events.trackerSyncDeclined({
            taskId: id,
            tracker: 'asana',
            item: task.asana.gid,
            at,
          }),
        ]
      : []),
    ...(task.automation
      ? [events.automationTaskCreated({ ...task.automation, taskId: id, at })]
      : []),
  ]
  const commentPosted = (
    {
      taskId,
      body,
      author,
      kind = 'note',
      title,
      choices,
      multiple,
      round,
      proposal,
      sizeCheck,
      gate,
      attachments = [],
      design,
      linearTeam,
      asanaMissing,
      asanaUnfinished,
      archive,
      cleanupFailure,
      memoryKill,
      purpose,
    }: NewComment,
    createdAt: string,
    askedBy = author.kind === 'run' ? author.runId : undefined,
  ) => {
    const id = randomUUID()
    const fields = {
      id,
      taskId,
      kind,
      body,
      authorKind: author.kind,
      authorRunId: author.kind === 'run' ? author.runId : null,
      stage: taskRow(taskId)?.stage ?? null,
      title: title ?? null,
      choices: choices ?? null,
      gate: gate === undefined ? null : JSON.stringify(gate),
      createdAt,
    }
    const event =
      proposal !== undefined || sizeCheck !== undefined
        ? events.commentPostedV4({
            ...fields,
            round: round === undefined ? null : JSON.stringify(round),
            proposal: proposal === undefined ? null : JSON.stringify(proposal),
            sizeCheck: sizeCheck === undefined ? null : JSON.stringify(sizeCheck),
          })
        : round === undefined
          ? events.commentPostedV2(fields)
          : events.commentPostedV3({ ...fields, round: JSON.stringify(round) })
    const files = attachments.map(({ hash, name, size, mediaType }, position) =>
      events.commentAttachmentAdded({
        commentId: id,
        taskId,
        hash,
        name,
        size,
        mediaType,
        position,
      }),
    )
    const recordedPurpose =
      purpose ??
      structuralPurpose({
        kind,
        ...(gate && { gate }),
        ...(sizeCheck && { sizeCheck }),
        ...(linearTeam && { linearTeam }),
        ...(asanaMissing && { asanaMissing }),
        ...(asanaUnfinished && { asanaUnfinished }),
        ...(archive && { archive }),
        ...(cleanupFailure && { cleanupFailure }),
        ...(memoryKill && { memoryKill }),
      })
    const heldFor =
      askedBy !== undefined &&
      kind !== 'note' &&
      kind !== 'permission' &&
      runRow(askedBy)?.state === 'working'
        ? askedBy
        : undefined
    const attached = [
      ...(heldFor === undefined ? [] : [events.requestHeld({ commentId: id, runId: heldFor })]),
      ...(recordedPurpose
        ? [
            events.commentPurposeRecorded({
              commentId: id,
              purpose: JSON.stringify(recordedPurpose),
            }),
          ]
        : []),
      ...files,
      ...(design === undefined
        ? []
        : [events.commentDesignAttached({ commentId: id, design: JSON.stringify(design) })]),
      ...(linearTeam ? [events.commentLinearTeamAsked({ commentId: id, ...linearTeam })] : []),
      ...(asanaMissing
        ? [
            events.commentAsanaMissingAsked({
              commentId: id,
              missing: JSON.stringify(asanaMissing),
            }),
          ]
        : []),
      ...(asanaUnfinished
        ? [
            events.commentAsanaUnfinishedAsked({
              commentId: id,
              unfinished: JSON.stringify(asanaUnfinished),
            }),
          ]
        : []),
      ...(archive
        ? [events.commentArchiveAsked({ commentId: id, archive: JSON.stringify(archive) })]
        : []),
      ...(multiple && choices?.length
        ? [events.commentMultipleChoiceAsked({ commentId: id })]
        : []),
      ...(cleanupFailure
        ? [
            events.commentCleanupFailureAsked({
              commentId: id,
              failure: JSON.stringify(cleanupFailure),
            }),
          ]
        : []),
      ...(memoryKill
        ? [
            events.commentMemoryKillAsked({
              commentId: id,
              memoryKill: JSON.stringify(memoryKill),
            }),
          ]
        : []),
    ]
    return { id, event, attached }
  }
  const repoAt = (taskId: string, cwd: string) => {
    if (!path.isAbsolute(cwd)) return undefined
    const real = realPath(cwd)
    return reposOf(taskId).find((r) => {
      const inside = path.relative(realPath(r.worktree), real)
      return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))
    })?.name
  }
  const askedEvent = (taskId: string, runId: string, prompt: NewPermissionPrompt, at: string) => {
    const id = randomUUID()
    const task = taskRow(taskId)
    const run = runRow(runId)
    const repo = task && run ? repoAt(taskId, prompt.cwd ?? run.cwd) : undefined
    return {
      id,
      event: events.permissionRequested({
        id,
        taskId,
        runId,
        requestId: prompt.requestId,
        stage: task?.stage ?? null,
        title: prompt.title,
        body: prompt.reason ?? '',
        command: prompt.command,
        details: prompt.details ?? null,
        generation: prompt.generation,
        repo: repo ?? null,
        input: prompt.input === undefined ? null : JSON.stringify(prompt.input),
        createdAt: at,
      }),
    }
  }
  const emitComment = (id: string) => {
    const comment = requireComment(id)
    if (!comment.held) emit({ type: 'comment-updated', comment })
    return comment
  }

  const updatedTask = (taskId: string): Task => {
    const row = taskRow(taskId)
    if (!row) throw new Error(`no Task ${taskId}`)
    const task = toPublicTask(toTask(row, true))
    emit({ type: 'task-updated', task })
    return task
  }

  const updatedTasks = (ids: readonly string[]) => {
    const reads = sharedReads(ids.length)
    for (const id of ids) {
      const row = taskRow(id)
      if (!row) continue
      emit({ type: 'task-updated', task: toPublicTask(toTask(row, true, reads())) })
    }
  }

  const tasksWaitingForSlots = (): string[] => [
    ...new Set([
      ...queue().map(({ id }) => id),
      ...(queueActivity.taskPlaces ?? []).map(({ id }) => id),
      ...store.query(queryDb(subAgentRequests.select('taskId'))),
    ]),
  ]

  const updatedQueue = (except?: string) => {
    updatedTasks(queue().flatMap(({ id }) => (id === except ? [] : [id])))
    noteActivity()
  }

  const updatedDependents = (blockerId: string) => {
    const parent = parentRow(blockerId)?.parentId
    if (parent && taskRow(parent)) updatedTask(parent)
    for (const { taskId } of store.query(queryDb(taskBlockers.where({ blockerId })))) {
      if (taskRow(taskId)) updatedTask(taskId)
    }
  }

  const logRows = (taskId: string) =>
    store.query(queryDb(taskLog.where({ taskId }).orderBy('at', 'asc')))

  const pendingTedStop = (taskId: string, leadRunId: string | undefined): string | undefined => {
    const last = logRows(taskId)
      .filter((entry) => tedStopEntries.has(entry.name))
      .toSorted((a, b) => sequence(a.id) - sequence(b.id))
      .at(-1)
    if (last?.name !== 'v1.TaskStoppedByTed' || leadRunId === undefined) return undefined
    return (JSON.parse(last.data) as { runId?: string }).runId === leadRunId ? last.at : undefined
  }

  const linearRecord = (taskId: string): LinearSyncRecord => linearRecordFrom(logRows(taskId))

  const linearRecordFrom = (log: readonly (typeof taskLog.Type)[]): LinearSyncRecord => {
    const record: LinearSyncRecord = { linked: new Set(), allowed: false, allowedTeams: new Set() }
    for (const row of log.filter((entry) => entry.name.startsWith('v1.Linear'))) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      if (row.name === 'v1.LinearIssueSeen') {
        record.seen = {
          stateType: String(data.stateType),
          state: String(data.state),
          team: String(data.team),
        }
      } else if (row.name === 'v1.LinearSyncAllowed') {
        record.allowed = true
      } else if (row.name === 'v1.LinearTeamSyncAllowed') {
        record.allowedTeams.add(String(data.team))
      } else if (row.name === 'v1.LinearIssueMoved') {
        const step = linearSteps.find((s) => s === data.step)
        const before = record.step === undefined ? -1 : linearSteps.indexOf(record.step)
        if (step && linearSteps.indexOf(step) > before) record.step = step
      } else if (row.name === 'v1.LinearPullRequestsLinked' && Array.isArray(data.urls)) {
        for (const url of data.urls) record.linked.add(String(url))
      }
    }
    return record
  }

  const groupAskRow = (row: { linearTeam: string | null; purpose: string | null }): boolean =>
    row.linearTeam !== null ||
    (row.purpose !== null &&
      (JSON.parse(row.purpose) as { kind?: unknown }).kind === 'tracker-group')

  const trackerRecord = (taskId: string, tracker: string): TrackerSyncRecord =>
    trackerRecordFrom(logRows(taskId), tracker)

  const trackerRecordFrom = (
    log: readonly (typeof taskLog.Type)[],
    tracker: string,
  ): TrackerSyncRecord => {
    const record: TrackerSyncRecord = {
      linked: new Set(),
      allowed: false,
      allowedGroups: new Map(),
    }
    for (const row of log.filter((entry) => entry.name.startsWith('v1.Tracker'))) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      if (data.tracker !== tracker) continue
      if (row.name === 'v1.TrackerItemSeen') {
        record.seen = {
          closed: data.closed === true,
          state: String(data.state),
          ...(typeof data.group === 'string' && { group: data.group }),
        }
      } else if (row.name === 'v1.TrackerSyncDeclined') {
        record.declined = true
      } else if (row.name === 'v1.TrackerSyncAllowed') {
        delete record.declined
        record.allowed = true
        if (typeof data.account === 'string') record.allowedAccount = data.account
        else delete record.allowedAccount
      } else if (row.name === 'v1.TrackerGroupSyncAllowed') {
        record.allowedGroups.set(
          String(data.group),
          typeof data.account === 'string' ? data.account : undefined,
        )
      } else if (row.name === 'v1.TrackerItemGroupsSeen' && Array.isArray(data.groups)) {
        record.groups = data.groups.map(String)
      } else if (row.name === 'v1.TrackerItemMoved') {
        record.step = String(data.step)
        record.moved = {
          ...(typeof data.state === 'string' && { state: data.state }),
          at: String(data.at),
        }
      } else if (row.name === 'v1.TrackerPullRequestsLinked' && Array.isArray(data.urls)) {
        for (const url of data.urls) record.linked.add(String(url))
      }
    }
    return record
  }

  let asanaConnection: { known: false } | { known: true; account?: string } = { known: false }
  const asanaOpenChildren = new Map<string, number>()
  const asanaLeftOpen = new Set<string>()

  const asanaSyncFor = (
    row: { id: string; factoryId: string; archived: boolean },
    source: TaskSource | undefined,
    stage: StageId,
    reads: TaskReads,
  ): AsanaSync | undefined => {
    if (!source?.asana || !parseAsanaTaskUrl(source.url)) return undefined
    const record = trackerRecordFrom(reads.log(row.id), 'asana')
    const merged = stage === 'done' && isMerged(row.id)
    const openChildren = asanaOpenChildren.get(row.id)
    const unfinishedAsked =
      merged &&
      reads
        .comments(row.id)
        .some((c) => c.asanaUnfinished !== null && c.answer === null && c.heldFor === null)
    const settings = reads.settings()
    const listed = settings.trackerSyncGroups.asana?.[row.factoryId] ?? []
    const listedAccounts = settings.trackerSyncGroupAccounts.asana?.[row.factoryId] ?? {}
    const projectAccounts = (record.declined ? [] : (record.groups ?? [])).flatMap((project) => [
      ...(listed.includes(project) && listedAccounts[project] !== undefined
        ? [listedAccounts[project]]
        : []),
      ...(record.allowedGroups.get(project) !== undefined
        ? [record.allowedGroups.get(project) as string]
        : []),
    ])
    return asanaSyncOf({
      allowed: record.allowed,
      projectAccounts: [...new Set(projectAccounts)],
      ...(record.allowedAccount !== undefined && { allowedAccount: record.allowedAccount }),
      switchOn: settings.asanaSync,
      connection: asanaConnection,
      archivedUnmerged: row.archived && !merged,
      ...(record.step === 'completed' &&
        record.moved?.state !== undefined && { completedByTed: record.moved.at }),
      completeInAsana: record.seen?.closed === true,
      merged,
      ...(openChildren !== undefined && { openChildren }),
      ...(unfinishedAsked && { unfinishedAsked }),
      ...(asanaLeftOpen.has(row.id) && { leftOpen: true }),
      linked: record.linked.size,
    })
  }

  const asanaTaskIds = (): string[] =>
    store
      .query(queryDb(taskSources))
      .flatMap(({ taskId, url }) => (parseAsanaTaskUrl(url) ? [taskId] : []))

  const linearSyncOf = (
    row: { id: string; factoryId: string },
    source: TaskSource | undefined,
    reads: TaskReads,
  ): 'on' | 'ask' | undefined => {
    if (!source || !parseLinearUrl(source.url)) return undefined
    const record = linearRecordFrom(reads.log(row.id))
    if (record.allowed) return 'on'
    const teams = reads.settings().linearSyncTeams[row.factoryId] ?? []
    const team = record.seen?.team
    return team !== undefined && (teams.includes(team) || record.allowedTeams.has(team))
      ? 'on'
      : 'ask'
  }

  const machineDefaults: MachineSettings = {
    ...defaultMachineSettings,
    maxWorkingRuns: defaultWorkingRuns(totalMemory()),
  }
  const settings = (): MachineSettings => {
    const legacy = store.query(queryDb(machineSettings.where({ id: 'machine' }))).at(0)
    const values = Object.fromEntries(
      store
        .query(queryDb(machineSettingValues.select()))
        .map(({ name, value }) => [name, JSON.parse(value) as unknown]),
    )
    return {
      ...machineDefaults,
      ...(legacy && { appearance: legacy.appearance as Appearance }),
      ...pick(values, Object.keys(defaultMachineSettings)),
      billing: {
        ...defaultMachineSettings.billing,
        ...(values.billing as Partial<MachineSettings['billing']> | undefined),
      },
    }
  }

  let queueActivity: QueueActivity = {
    queuedTasks: [],
    queuedRuns: [],
    startingRuns: [],
    startingTasks: [],
  }
  let shellsRunning = 0
  let scheduledChecks = { running: 0, waiting: 0 }
  const checkWork = (): CheckWork => ({
    running: [
      ...new Set([
        ...checkingTasks,
        ...store.query(queryDb(checkRuns.where({ finishedAt: null }))).map((r) => r.taskId),
      ]),
    ].filter((taskId) => !checksWaiting.has(taskId)),
    waiting: checksWaiting,
    scheduled: scheduledChecks,
  })
  const activity = (): Activity => {
    const work = checkWork()
    const active = store.query(liveRuns)
    const runIds = new Set(active.map((run) => run.id))
    const taskIds = new Set(
      active.filter((run) => run.parentRunId === null).flatMap((run) => run.taskId ?? []),
    )
    const startingTasks = new Set(queueActivity.startingTasks.filter((id) => !taskIds.has(id)))
    const startingRuns = new Set(queueActivity.startingRuns.filter((id) => !runIds.has(id)))
    const queuedTasks = new Set(
      [
        ...queueActivity.queuedTasks,
        ...queue().map((entry) => entry.id),
        ...store.query(queryDb(heldRuns)).map((held) => held.taskId),
      ].filter((id) => !taskIds.has(id) && !startingTasks.has(id)),
    )
    const queuedRuns = new Set(queueActivity.queuedRuns.filter((id) => !startingRuns.has(id)))
    const startingWork = startingTasks.size + startingRuns.size
    const factoryIds = new Set(store.query(allFactories).map((f) => f.id))
    const liveAutomations = store
      .query(queryDb(automations.select()))
      .filter((a) => factoryIds.has(a.factoryId))
    return {
      runs: {
        working: active.filter(
          (run) =>
            run.state === 'working' &&
            pauses()[run.agent as AgentKind] === undefined &&
            !waitingOnSubAgents.has(run.id),
        ).length,
        active: active.length,
        queued: queuedTasks.size + queuedRuns.size,
      },
      ...(startingWork > 0 && { startingWork }),
      scheduledTasks: store
        .query(allTasks)
        .filter(
          (task) =>
            task.stage === 'backlog' && task.archivedAt === null && task.snoozedUntil !== null,
        ).length,
      automationsOn: liveAutomations.filter((a) => a.on).length,
      factoriesSettingUp: store.query(allFactories).filter((f) => f.clonedAt === null).length,
      checksRunning: work.running.length + work.scheduled.running,
      checksWaiting: work.waiting.size + work.scheduled.waiting,
      shellsRunning,
    }
  }
  const openRequests = (): WaitingRequest[] => {
    const factoryIds = new Set(store.query(allFactories).map((f) => f.id))
    const requestRows = shownRequestRows()
    const liveTasks = new Map(
      (requestRows.length === 0
        ? []
        : store.query(queryDb(tasks.select('id', 'factoryId', 'number', 'title', 'archivedAt')))
      )
        .filter((t) => t.archivedAt === null)
        .map((t) => [t.id, t]),
    )
    const fromTasks = requestRows.flatMap((row): WaitingRequest[] => {
      const task = liveTasks.get(row.taskId)
      if (!task) return []
      return [
        {
          source: 'task',
          id: row.id,
          factoryId: task.factoryId,
          createdAt: row.createdAt,
          headline: headlineOf(row.title, row.body),
          kind: row.kind as CommentKind,
          failed: row.failedRunId !== null,
          taskId: task.id,
          displayId: `${factoryKey(task.factoryId)}-${task.number}`,
          taskTitle: task.title,
        },
      ]
    })
    const liveAutomations = new Map(
      store
        .query(queryDb(automations.select()))
        .filter((a) => factoryIds.has(a.factoryId))
        .map((a) => [a.id, a]),
    )
    const fromAutomations = store
      .query(queryDb(automationComments.where({ kind: 'question', answer: null })))
      .flatMap((row): WaitingRequest[] => {
        const automation = liveAutomations.get(row.automationId)
        if (!automation) return []
        return [
          {
            source: 'automation',
            id: row.id,
            factoryId: automation.factoryId,
            createdAt: row.createdAt,
            headline: headlineOf(null, row.body),
            automationId: automation.id,
            automationName: automation.name,
          },
        ]
      })
    const livePlans = new Map(
      store
        .query(queryDb(plans.select()))
        .filter((p) => factoryIds.has(p.factoryId))
        .map((p) => [p.id, p]),
    )
    const fromPlans = store
      .query(queryDb(planRequests.where({ answer: null })))
      .flatMap((row): WaitingRequest[] => {
        const plan = livePlans.get(row.planId)
        if (!plan || row.kind === 'note') return []
        return [
          {
            source: 'plan',
            id: row.id,
            factoryId: plan.factoryId,
            createdAt: row.createdAt,
            headline: headlineOf(row.title, row.body),
            kind: row.kind as CommentKind,
            planId: plan.id,
            planTitle: plan.title,
          },
        ]
      })
    const chatRows = store.query(queryDb(chatRequestRows.where({ answer: null })))
    const askedIn = Map.groupBy(chatRows, (row) => row.chatId)
    const fromCoordinators = store
      .query(queryDb(coordinatorRows.where({ endedAt: null })))
      .flatMap((row): WaitingRequest[] => {
        if (!factoryIds.has(row.factoryId)) return []
        const chat = JSON.parse(row.data) as StoredCoordinator
        const chatTitle = row.title ?? titleFromMessage(chat.opening)
        const agentName = chatStore.agent(row.id)?.name ?? 'Coordinator'
        const confirmations = (chat.confirmations ?? [])
          .filter((c) => c.answer === undefined)
          .map(
            (c): WaitingRequest => ({
              source: 'coordinator',
              id: c.id,
              chatId: row.id,
              chatTitle,
              agentName,
              factoryId: row.factoryId,
              createdAt: c.askedAt,
              headline: confirmationHeadline(c),
              confirmationKind: c.kind,
            }),
          )
        const asked = (askedIn.get(row.id) ?? []).map(
          (r): WaitingRequest => ({
            source: 'coordinator',
            id: r.id,
            chatId: row.id,
            chatTitle,
            agentName,
            factoryId: row.factoryId,
            createdAt: r.createdAt,
            headline: headlineOf(r.title, r.body),
            requestKind: isOneOf(r.kind, chatRequestKinds) ? r.kind : 'question',
          }),
        )
        const cards = (chat.automationCards ?? [])
          .filter((c) => c.answer === undefined)
          .map(
            (c): WaitingRequest => ({
              source: 'coordinator',
              id: c.id,
              chatId: row.id,
              chatTitle,
              agentName,
              factoryId: row.factoryId,
              createdAt: c.askedAt,
              headline: automationCardHeadline(c),
              automationCard: c.kind,
            }),
          )
        return [...confirmations, ...cards, ...asked]
      })
    const current = settings()
    return [...fromTasks, ...fromAutomations, ...fromPlans, ...fromCoordinators]
      .map(
        (request): WaitingRequest =>
          factoryNotifications(current, request.factoryId).inboxItems
            ? request
            : { ...request, uncounted: true },
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  if (
    store.query(queryDb(machineSettingValues.where({ name: 'factoryNotifications' }))).length === 0
  ) {
    commit(
      events.machineSettingsChanged({
        changes: JSON.stringify({
          factoryNotifications: firstFactoryNotifications(
            store.query(allFactories).map((f) => f.id),
            settings().notifyTaskMerged,
          ),
        }),
        at: new Date().toISOString(),
      }),
    )
  }
  const inbox = (): { waiting: WaitingRequest[]; snoozed: SnoozedRequest[] } => {
    const until = new Map(
      store.query(queryDb(requestSnoozes.select())).map((row) => [row.requestId, row.until]),
    )
    const open = openRequests()
    return {
      waiting: open.filter((request) => !until.has(request.id)),
      snoozed: open
        .flatMap((request): SnoozedRequest[] => {
          const snoozedUntil = until.get(request.id)
          return snoozedUntil === undefined ? [] : [{ ...request, snoozedUntil }]
        })
        .sort((a, b) => a.snoozedUntil.localeCompare(b.snoozedUntil)),
    }
  }
  const waiting = (): WaitingRequest[] => inbox().waiting
  const snoozed = (): SnoozedRequest[] => inbox().snoozed
  let lastWaiting: { waiting: WaitingRequest[]; snoozed: SnoozedRequest[] } | undefined
  let waitingNoted = false
  noteWaiting = () => {
    if (waitingNoted) return
    waitingNoted = true
    queueMicrotask(() => {
      waitingNoted = false
      if (shutDown) return
      const next = inbox()
      if (lastWaiting !== undefined && isDeepStrictEqual(next, lastWaiting)) return
      lastWaiting = next
      emit({ type: 'inbox-changed', ...next })
    })
  }

  let lastActivity = activity()
  const noteActivity = () => {
    const next = activity()
    if (isDeepStrictEqual(next, lastActivity)) return
    lastActivity = next
    emit({ type: 'activity-changed', activity: next })
  }

  const toBanner = (row: typeof banners.Type): Banner => ({
    id: row.id,
    problem: row.problem,
    severity: row.severity as BannerSeverity,
    ...(row.factoryId !== null && { factoryId: row.factoryId }),
    text: row.text,
    ...(row.action !== null && { action: JSON.parse(row.action) as BannerAction }),
    raisedAt: row.raisedAt,
    ...(row.dismissedUntil !== null && { dismissedUntil: row.dismissedUntil }),
  })
  const bannerRow = (id: string) => store.query(queryDb(banners.where({ id }))).at(0)
  const getBanner = (id: string) => {
    const row = bannerRow(id)
    return row && toBanner(row)
  }
  const requireBanner = (id: string) => {
    const banner = getBanner(id)
    if (!banner) throw new Error(`no banner ${id}`)
    return banner
  }

  const automationStore = createAutomationStore({
    store,
    commit,
    emit,
    changed: () => noteActivity(),
    factoryKey,
  })

  const testInvocationStore = createTestInvocationStore({
    store,
    changed: (id) => {
      if (taskRow(id)) updatedTask(id)
    },
    commit,
    checks: (taskId) =>
      checkRunRows(taskId).map((row) => {
        const starts = new Set(
          store
            .query(queryDb(checkBoundaries.where({ checkRunId: row.id, kind: 'start' })))
            .map((boundary) => boundary.position),
        )
        return {
          id: row.id,
          checks: checkResultRows(row.id).map((result) => ({
            state: result.state,
            started: starts.has(result.position),
          })),
        }
      }),
    run: (id) => {
      const row = runRow(id)
      return row && toRun(row)
    },
    check: (id) => {
      const row = store.query(queryDb(checkRuns.where({ id })))[0]
      return row && toCheckRun(row)
    },
  })

  const failureStore = createFailureStore({
    store,
    commit,
    changed: (id) => {
      updatedTask(id)
    },
  })

  const planStore = createPlanStore({
    store,
    commit,
    emit,
    changed: () => noteActivity(),
    taskChanged: (taskId) => {
      if (taskRow(taskId)) updatedTask(taskId)
    },
  })

  const coordinatorStore = createCoordinatorStore({
    store,
    commit,
    changed(factoryId, chatId) {
      emit({ type: 'coordinator-changed', factoryId, chatId })
      noteActivity()
    },
  })

  const chatStore = createChatStore({
    store,
    commit,
    changed(chatId) {
      const chat = coordinatorStore.find(chatId)
      if (chat) emit({ type: 'coordinator-changed', factoryId: chat.factoryId, chatId })
      noteActivity()
    },
    runChanged(runId) {
      emit({ type: 'run-output', runId })
    },
  })
  lastWaiting = inbox()

  const execution = createExecutionStore({
    store,
    commit,
    task(id) {
      const row = taskRow(id)
      return (
        row && {
          started:
            row.branch !== null ||
            row.worktree !== null ||
            taskRuns(id).length > 0 ||
            store.query(queryDb(taskRepos.where({ taskId: id }))).length > 0,
        }
      )
    },
  })
  const observedRuns = new Set<string>()
  const observationSessionId = randomUUID()
  const previousBoundary = store.query(
    queryDb(intervalBoundaries.orderBy('sequence', 'desc').limit(1)),
  )[0]
  commit(
    events.intervalObservationStarted({
      sessionId: observationSessionId,
      previousObservedAt: previousBoundary?.at ?? null,
      at: new Date().toISOString(),
    }),
  )
  const lastTaskWaits = new Map<string, string>()
  noteTaskWait = (taskId, facts) => {
    const reasons = JSON.stringify(
      taskWaitReasons(taskId, facts).filter((r) => r.reason === 'run-slot'),
    )
    if ((lastTaskWaits.get(taskId) ?? '[]') === reasons) return
    observingWait = true
    commit(events.taskWaitObserved({ taskId, reasons, at: new Date().toISOString() }))
    lastTaskWaits.set(taskId, reasons)
  }
  const startRows = store.query(allTasks)
  const startReads = sharedReads(startRows.length)
  for (const row of startRows) toTask(row, true, startReads())
  await persisted()

  function repairApproved(
    approval: RepairApproval,
    repair: Pick<Task, 'id' | 'displayId' | 'title'>,
  ) {
    const { failure, request, brief } = approval
    const assessment = failure.assessments.at(-1)
    if (!assessment) throw new Error('a repair approval needs an assessment')
    const at = new Date().toISOString()
    const next: FailureCase = {
      ...failure,
      resolutions: [
        ...failure.resolutions,
        {
          ...request,
          resolution: 'repair',
          assessmentId: assessment.id,
          at,
          ...(assessment.contextId && { contextId: assessment.contextId }),
          repairTask: { id: repair.id, displayId: repair.displayId, title: repair.title },
        },
      ],
    }
    const row = taskRow(failure.taskId)
    if (!row) throw new Error('no affected Task')
    return {
      next,
      events: [
        failureStore.event(next, 'resolved'),
        events.commentAnswered({
          id: request.requestId,
          answer: JSON.stringify({
            kind: 'answered',
            choice: 'Wait for a repair Task',
            text: [`Waiting for ${repair.displayId}: ${repair.title}`, request.reason]
              .filter(Boolean)
              .join('\n\n'),
            at,
          }),
          at,
        }),
        events.commentAnswerHeld({ id: request.requestId, at }),
        ...lineCommentsSent(approval.drafts, request.requestId, at),
        events.taskBlockerAddedV2({
          taskId: failure.taskId,
          blockerId: repair.id,
          runId: null,
          at,
        }),
        events.taskWaitingForBlockers({ taskId: failure.taskId, at }),
        events.taskBriefWritten({
          id: randomUUID(),
          taskId: failure.taskId,
          version: (briefRows(failure.taskId).at(-1)?.version ?? 0) + 1,
          text: brief.replace('REPAIR_TASK_REFERENCE', `${repair.displayId} (“${repair.title}”)`),
          stage: row.stage,
          runId: null,
          at,
        }),
      ],
    }
  }

  return {
    execution,
    operations: createOperationStore(store, commit, (id) => taskRow(id) !== undefined),
    pairing: createPairingStore(store, commit),
    sideChats: createSideChatStore({
      store,
      commit,
      changed(sourceRunId) {
        emit({ type: 'side-chat-changed', sourceRunId })
        noteActivity()
      },
    }),
    automationDrafts: createAutomationDraftStore({ store, commit }),
    isPeerMessage: (id) => store.query(queryDb(peerMessages.where({ id }))).length > 0,
    peerMessages() {
      return store.query(queryDb(peerMessages)).map((row) => {
        const delivered = getComment(row.id)?.delivered
        return { ...row, ...(delivered && { delivered }) }
      })
    },
    recordPeerMessage(input, body) {
      const createdAt = new Date().toISOString()
      const { id, event } = commentPosted(
        {
          taskId: input.recipientTaskId,
          body,
          author: { kind: 'run', runId: input.senderRunId },
        },
        createdAt,
      )
      const row = { ...input, id, createdAt }
      commit(event, events.peerMessageSent(row))
      emit({ type: 'comment-posted', comment: requireComment(id) })
      return row
    },
    coordinators: coordinatorStore,
    chats: chatStore,
    automations: automationStore,
    plans: planStore,
    testInvocations: testInvocationStore,
    failures: failureStore,
    invalidateFailure(value, note) {
      const { id, event, attached } = commentPosted(
        {
          taskId: value.taskId,
          kind: 'note',
          author: { kind: 'ted' },
          ...note,
        },
        new Date().toISOString(),
      )
      commit(failureStore.event(value, 'invalidated'), event, ...attached)
      emit({ type: 'comment-posted', comment: requireComment(id) })
      updatedTask(value.taskId)
    },
    approveRepair(approval, repair) {
      const { next, events: repairEvents } = repairApproved(approval, repair)
      commit(...repairEvents)
      emitComment(approval.request.requestId)
      updatedTask(approval.failure.taskId)
      updatedQueue(approval.failure.taskId)
      return next
    },
    postFailureDecision(value, body, canAccept = true, askedBy, closable = false) {
      const at = new Date().toISOString()
      const assessment = value.assessments.at(-1)
      if (!assessment) throw new Error('a failure decision needs an assessment')
      const { id, event, attached } = commentPosted(
        {
          taskId: value.taskId,
          kind: 'question',
          body,
          ...(value.validation && {
            title: `How should we handle the ${value.originalCheck?.name ?? (value.source.kind === 'github-ci' ? 'CI' : 'validation')} failure?`,
          }),
          choices: [
            ...Object.values(value.validation ? validateFailureChoices : failureChoices),
            ...(value.validation && closable
              ? [failureChoices.fixed, failureChoices['no-longer-applicable']]
              : []),
          ].filter(
            (choice) =>
              (canAccept || choice !== failureChoices.accepted) &&
              (choice !== 'Wait for a repair Task' ||
                validates(taskRow(value.taskId)?.stage ?? '') ||
                mergesHere(taskRow(value.taskId)?.stage ?? '')),
          ),
          purpose: { kind: 'failure' },
          author: { kind: 'ted' },
        },
        at,
        askedBy,
      )
      const next = {
        ...value,
        decisions: [
          ...value.decisions,
          {
            commentId: id,
            assessmentId: assessment.id,
            ...(assessment.contextId && { contextId: assessment.contextId }),
          },
        ],
      }
      commit(event, ...attached, failureStore.event(next, 'requested'))
      const comment = requireComment(id)
      if (!comment.held) emit({ type: 'comment-posted', comment })
      updatedTask(value.taskId)
      return next
    },
    resolveFailure(value, commentId, answer, drafts) {
      commit(
        failureStore.event(value, 'resolved'),
        events.commentAnswered({ id: commentId, answer: JSON.stringify(answer), at: answer.at }),
        ...lineCommentsSent(drafts, commentId, answer.at),
      )
      emitComment(commentId)
      updatedTask(value.taskId)
      if (drafts.length > 0) emit({ type: 'line-comments-changed', taskId: value.taskId })
      return value
    },
    addFactory(input) {
      const row = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
      commit(events.factoryAdded(row))
      const added = requireFactory(row.id)
      emit({ type: 'factory-added', factory: basicFactory(added) })
      return added
    },
    createFactory({ repos, ...input }) {
      const id = randomUUID()
      const at = new Date().toISOString()
      const next = settings().guideNextFactory
      const guided = next || store.query(allFactories).length === 0
      commit(
        events.factoryAddedV2({ ...input, id, repos, showTutorial: false, createdAt: at }),
        ...(guided ? [events.factoryGuideStarted({ factoryId: id, at })] : []),
        ...(next
          ? [
              events.machineSettingsChanged({
                changes: JSON.stringify({ guideNextFactory: false }),
                at,
              }),
            ]
          : []),
      )
      const added = requireFactory(id)
      emit({ type: 'factory-added', factory: basicFactory(added) })
      if (next) emit({ type: 'settings-changed', settings: settings() })
      if (guided) emitGuides()
      noteActivity()
      return added
    },
    guides,
    hideGuide(factoryId) {
      const ending = guideEnding(factoryId, 'hidden')
      if (ending.length === 0) return false
      commit(...ending)
      emitGuides()
      return true
    },
    factoryCloned(factoryId) {
      commit(events.factoryCloned({ factoryId, at: new Date().toISOString() }))
      noteActivity()
      return requireFactory(factoryId)
    },
    listFactories,
    getFactory: (id) => listFactories().find((f) => f.id === id),
    async createTask({
      draftRevision,
      repairApproval,
      title,
      linearConsent = false,
      factoryId = placeholderFactory.id,
      description = '',
      priority = 'none',
      clarifyDepth = 'auto',
      lead,
      startRequested = false,
      blockedBy = [],
      parentId,
      attachments = [],
      source,
      followUpOf,
      forcedGates = [],
      changesSettings = false,
      splitFrom,
      automation,
      checkFailure,
      plan,
      setup = false,
      coordinatorOperation,
      taskLead,
      children = [],
      notes = [],
    }) {
      const used = usedNumbers(factoryId)
      const awaitingSetup =
        !setup &&
        listFactories().find((f) => f.id === factoryId)?.clonedAt === undefined &&
        factoryId !== placeholderFactory.id
      const currentDraft = draftRevision ? taskDraft(factoryId).draft : null
      const number = setup && !used.includes(1) ? 1 : Math.max(awaitingSetup ? 1 : 0, ...used) + 1
      const id = randomUUID()
      const at = new Date().toISOString()
      const rootRank = nextRank()
      const childIds = new Map(children.map((child) => [child.key, randomUUID()]))
      const childId = (ref: TreeRef | undefined) => {
        if (ref === undefined) return id
        const found = 'key' in ref ? childIds.get(ref.key) : ref.taskId
        if (found === undefined) throw new Error('a child Task points at a missing parent')
        return found
      }
      let childNumber = Math.max(number, ...used) + 1
      let childRank = rootRank + 1
      const childEvents = children.flatMap((child) =>
        treeTaskEvents(child, {
          id: childId({ key: child.key }),
          factoryId,
          number: childNumber++,
          rank: childRank++,
          parentId: childId(child.parent),
          at,
        }),
      )
      const notePosts = notes.map(({ task, body }) =>
        commentPosted({ taskId: childId(task), kind: 'note', author: { kind: 'ted' }, body }, at),
      )
      const repair = repairApproval
        ? repairApproved(repairApproval, {
            id,
            displayId: `${listFactories().find((f) => f.id === factoryId)?.key ?? 'TASK'}-${number}`,
            title,
          })
        : undefined
      const byUser =
        !setup &&
        coordinatorOperation === undefined &&
        taskLead === undefined &&
        followUpOf === undefined &&
        splitFrom === undefined &&
        automation === undefined &&
        plan === undefined
      const ending = byUser ? guideEnding(factoryId, 'task-created') : []
      const guideEnd = ending.length > 0 && setUpDone(factoryId) ? ending : []
      commit(
        ...guideEnd,
        ...(draftRevision && factoryId !== placeholderFactory.id
          ? [
              events.taskDraftConsumed({
                factoryId,
                revision: draftRevision,
                draft:
                  currentDraft && currentDraft.revision !== draftRevision
                    ? JSON.stringify(currentDraft)
                    : null,
                at,
              }),
            ]
          : []),
        events.taskCreatedV2({
          id,
          factoryId,
          number,
          title,
          description,
          priority,
          clarifyDepth,
          leadAgent: lead?.agent ?? null,
          leadModel: lead?.model ?? null,
          leadEffort: lead?.effort ?? null,
          startRequested,
          createdAt: at,
        }),
        ...(lead?.effortMode === 'stage'
          ? [events.taskLeadEffortModeSet({ taskId: id, mode: 'stage', at })]
          : []),
        ...(repair?.events ?? []),
        ...(repairApproval?.startStage
          ? [
              events.taskQueued({
                taskId: id,
                stage: repairApproval.startStage,
                rank: nextRank(),
                at,
              }),
            ]
          : []),
        events.taskRanked({ taskId: id, rank: rootRank, at }),
        ...blockedBy.map((blockerId) =>
          events.taskBlockerAddedV2({ taskId: id, blockerId, runId: null, at }),
        ),
        ...(parentId ? [events.taskParentChanged({ taskId: id, parentId, at })] : []),
        ...attachments.map((attachment) =>
          events.taskAttachmentAdded({ taskId: id, ...attachment, at }),
        ),
        ...(source
          ? [
              events.taskSourceSet({
                taskId: id,
                url: source.url,
                linearIdentifier: source.linear?.identifier ?? null,
                linearTitle: source.linear?.title ?? null,
                linearBranchName: source.linear?.branchName ?? null,
                linearDescription: source.linear?.description ?? null,
                at,
              }),
              ...(source.sentry
                ? [events.taskSourceSentrySet({ taskId: id, shortId: source.sentry.shortId, at })]
                : []),
              ...(source.github
                ? [
                    events.taskSourceGitHubSet({
                      taskId: id,
                      github: JSON.stringify(source.github),
                      at,
                    }),
                  ]
                : []),
              ...(linearConsent && parseLinearUrl(source.url)
                ? [
                    events.linearSyncAllowed({
                      taskId: id,
                      identifier: parseLinearUrl(source.url)?.identifier ?? '',
                      by: 'created',
                      at,
                    }),
                  ]
                : []),
            ]
          : []),
        ...(forcedGates.length > 0
          ? [events.taskGatesForced({ taskId: id, stages: forcedGates, at })]
          : []),
        ...(changesSettings ? [events.taskChangesSettings({ taskId: id, at })] : []),
        ...(followUpOf !== undefined
          ? [
              events.taskFollowsUp({ taskId: id, originalId: followUpOf, at }),
              events.taskFollowedUp({ taskId: followUpOf, followUpId: id, at }),
            ]
          : []),
        ...(splitFrom !== undefined
          ? [events.taskSplitFrom({ taskId: id, originalId: splitFrom, at })]
          : []),
        ...(automation ? [events.automationTaskCreated({ ...automation, taskId: id, at })] : []),
        ...(automation && checkFailure !== undefined
          ? [
              events.automationCheckTaskCreated({
                taskId: id,
                automationId: automation.automationId,
                key: checkFailure,
                at,
              }),
            ]
          : []),
        ...(plan ? [events.planTaskCreated({ ...plan, taskId: id, at })] : []),
        ...(setup ? [events.setupTaskCreated({ taskId: id, factoryId, at })] : []),
        ...(coordinatorOperation !== undefined
          ? [
              events.taskCreatedByCoordinator({
                taskId: id,
                factoryId,
                operation: coordinatorOperation,
                at,
              }),
            ]
          : []),
        ...(taskLead
          ? [
              events.taskCreatedByTaskLead({ taskId: id, ...taskLead, at }),
              events.taskLeadCreatedTask({
                taskId: taskLead.creatorId,
                createdId: id,
                runId: taskLead.runId,
                child: taskLead.child,
                at,
              }),
            ]
          : []),
        ...childEvents,
        ...notePosts.flatMap(({ event, attached }) => [event, ...attached]),
      )
      const row = taskRow(id)
      if (!row) throw new Error(`no Task ${id}`)
      const task = toPublicTask(toTask(row, true))
      emit({ type: 'task-created', task })
      for (const child of children) {
        const childRow = taskRow(childId({ key: child.key }))
        if (childRow) emit({ type: 'task-created', task: toPublicTask(toTask(childRow, true)) })
      }
      for (const { id: commentId } of notePosts)
        emit({ type: 'comment-posted', comment: requireComment(commentId) })
      if (repairApproval) {
        emitComment(repairApproval.request.requestId)
        updatedTask(repairApproval.failure.taskId)
        updatedQueue(repairApproval.failure.taskId)
      }
      if (automation) emit({ type: 'automation-updated', automationId: automation.automationId })
      if (followUpOf !== undefined && taskRow(followUpOf)) updatedTask(followUpOf)
      if (parentId !== undefined && taskRow(parentId)) updatedTask(parentId)
      if (taskLead && taskLead.creatorId !== parentId && taskRow(taskLead.creatorId))
        updatedTask(taskLead.creatorId)
      if (guideEnd.length > 0) emitGuides()
      return task
    },
    createTaskTree({
      factoryId,
      tasks: planned,
      links,
      comments: posted,
      closings = [],
      draftRevision,
    }) {
      const currentDraft = draftRevision ? taskDraft(factoryId).draft : null
      const used = usedNumbers(factoryId)
      const awaitingSetup = listFactories().find((f) => f.id === factoryId)?.clonedAt === undefined
      let number = Math.max(awaitingSetup ? 1 : 0, ...used) + 1
      let rank = nextRank()
      const at = new Date().toISOString()
      const ids = new Map(planned.map((t) => [t.key, randomUUID()]))
      const idOf = (ref: TreeRef) => {
        const id = 'key' in ref ? ids.get(ref.key) : ref.taskId
        if (id === undefined) throw new Error('a Task in the tree points at a missing parent')
        return id
      }
      const created = planned.flatMap((task) =>
        treeTaskEvents(task, {
          id: idOf({ key: task.key }),
          factoryId,
          number: number++,
          rank: rank++,
          ...(task.parent && { parentId: idOf(task.parent) }),
          at,
        }),
      )
      const linked = links.map((link) =>
        events.taskParentChanged({ taskId: link.taskId, parentId: idOf(link.parent), at }),
      )
      const comments = posted.map(({ task, ...comment }) =>
        commentPosted({ ...comment, taskId: idOf(task) }, at),
      )
      const byUser = planned.length > 0 && planned.every((task) => task.automation === undefined)
      const ending = byUser ? guideEnding(factoryId, 'task-created') : []
      const guideEnd = ending.length > 0 && setUpDone(factoryId) ? ending : []
      commit(
        ...guideEnd,
        ...(draftRevision
          ? [
              events.taskDraftConsumed({
                factoryId,
                revision: draftRevision,
                draft:
                  currentDraft && currentDraft.revision !== draftRevision
                    ? JSON.stringify(currentDraft)
                    : null,
                at,
              }),
            ]
          : []),
        ...created,
        ...linked,
        ...comments.flatMap(({ event, attached }) => [event, ...attached]),
        ...closings.map((closing) =>
          events.commentAnswered({
            id: closing.commentId,
            answer: JSON.stringify(closing.answer),
            at: closing.answer.at,
          }),
        ),
      )
      const made = new Map<string, Task>()
      for (const task of planned) {
        const row = taskRow(idOf({ key: task.key }))
        if (!row) throw new Error(`no Task ${task.key}`)
        const public_ = toPublicTask(toTask(row, true))
        made.set(task.key, public_)
        emit({ type: 'task-created', task: public_ })
      }
      const touched = new Set([
        ...links.flatMap((link) => [link.taskId, idOf(link.parent)]),
        ...planned.flatMap((task) =>
          task.parent && 'taskId' in task.parent ? [task.parent.taskId] : [],
        ),
        ...posted.flatMap(({ task }) => ('taskId' in task ? [task.taskId] : [])),
      ])
      const linkedTasks = links.map((link) => updatedTask(link.taskId))
      for (const id of touched) if (!links.some((l) => l.taskId === id)) updatedTask(id)
      for (const { id } of comments) emit({ type: 'comment-posted', comment: requireComment(id) })
      for (const closing of closings) updatedTask(emitComment(closing.commentId).taskId)
      if (guideEnd.length > 0) emitGuides()
      return { created: made, linked: linkedTasks }
    },
    listTasks: () => listTasks().map(toPublicTask),
    getTask(ref) {
      const row = taskRow(ref)
      const found = row ?? taskRowByDisplayId(ref)
      return found && toTask(found)
    },
    coordinatorCreated(factoryId, operation) {
      const row = store
        .query(queryDb(tasks.where({ factoryId, coordinatorOperation: operation })))
        .at(0)
      return row && toTask(row)
    },
    leadCreatedTasks(creatorId) {
      return store
        .query(queryDb(tasks.select('id', 'createdByRun').where({ createdByTask: creatorId })))
        .map((row) => ({ taskId: row.id, runId: row.createdByRun ?? '' }))
    },
    startTask({ taskId, stage, branch, worktree, entry, repo }) {
      const at = new Date().toISOString()
      const queued = queue().some((q) => q.id === taskId)
      commit(
        ...(queued ? [events.taskDequeued({ taskId, at })] : []),
        events.taskStarted({ taskId, stage, branch, worktree, at }),
        events.taskWorktreeCreated({ taskId, ...repo, branch, worktree, at }),
        stageEntered(taskId, stage, entry, at),
      )
      const task = updatedTask(taskId)
      if (queued) updatedQueue(taskId)
      return task
    },
    queueTask(taskId, stage, options) {
      const kept = options?.keepRank ? taskRow(taskId)?.rank : null
      const rank = kept ?? nextRank()
      const at = new Date().toISOString()
      commit(
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        ...(taskRow(taskId)?.stoppedAt !== null ? [events.taskResumed({ taskId, rank, at })] : []),
        ...startRequestUsed(taskId, at),
        ...(kept == null ? [events.taskRanked({ taskId, rank, at })] : []),
        events.taskQueued({ taskId, stage, rank, at }),
        ...startCause(taskId, options?.cause, at),
        ...(options?.prepare || taskRow(taskId)?.preparation !== null
          ? [
              events.taskPreparationChanged({
                taskId,
                state: options?.prepare ? 'preparing' : null,
                at,
              }),
            ]
          : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    moveToBacklog(taskId) {
      const at = new Date().toISOString()
      commit(
        events.taskMovedToBacklog({ taskId, at }),
        ...(taskRow(taskId)?.preparation !== null
          ? [events.taskPreparationChanged({ taskId, state: null, at })]
          : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    needsPlanning(taskId, runId) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, movedTo: 'backlog' }
      commit(
        events.taskNeedsPlanning({ taskId, runId, at }),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    startAfterPlanning(taskId, stage, entry, options) {
      const at = new Date().toISOString()
      const rank = nextRank()
      commit(
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        ...startRequestUsed(taskId, at),
        events.taskRanked({ taskId, rank, at }),
        events.taskStartedAfterPlanning({ taskId, stage, rank, at }),
        ...startCause(taskId, options?.cause, at),
        ...(options?.prepare || taskRow(taskId)?.preparation !== null
          ? [
              events.taskPreparationChanged({
                taskId,
                state: options?.prepare ? 'preparing' : null,
                at,
              }),
            ]
          : []),
        stageEntered(taskId, stage, entry, at),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    taskSplit(taskId, { pieceIds, narrowedTo, description }) {
      const at = new Date().toISOString()
      const edited = taskEdited(taskId, { title: narrowedTo, description }, at)
      commit(...(edited ? [edited] : []), events.taskSplit({ taskId, pieceIds, narrowedTo, at }))
      updatedTask(taskId)
    },
    childTasksCreated(taskId, childIds, from) {
      const at = new Date().toISOString()
      commit(events.childTasksCreated({ taskId, childIds: [...childIds], from, at }))
      updatedTask(taskId)
    },
    madeParent: (taskId) =>
      store.query(queryDb(taskLog.where({ taskId, name: 'v1.ChildTasksCreated' }))).length > 0,
    parentFinishedWithChildren(taskId) {
      commit(events.parentFinishedWithChildren({ taskId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    taskPlanEnded(taskId, planId, outcome) {
      if (!taskRow(taskId)) return
      commit(events.taskPlanEnded({ taskId, planId, outcome, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    rankTask(taskId, rank, priority) {
      const at = new Date().toISOString()
      const changed = taskRow(taskId)?.priority !== priority
      commit(
        events.taskRanked({ taskId, rank, at }),
        ...(changed ? [events.taskPriorityChanged({ taskId, priority, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    editTask(taskId, edit) {
      const event = taskEdited(taskId, edit, new Date().toISOString())
      if (!event) return toPublicTask(toTask(requireTaskRow(taskId)))
      commit(event)
      return updatedTask(taskId)
    },
    descriptionVersions(taskId) {
      const rows = descriptionRows(taskId)
      if (rows.length > 0) return rows.map(({ version, text, at }) => ({ version, text, at }))
      const row = taskRow(taskId)
      return row ? [{ version: 1, text: row.description, at: row.createdAt }] : []
    },
    setPriority(taskId, priority) {
      commit(events.taskPriorityChanged({ taskId, priority, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    archiveTask(taskId, { closing, branches, why } = { closing: [], branches: 0 }) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, archived: true }
      const archived = taskRow(taskId)
      const guideEnd = archived?.setup ? guideEnding(archived.factoryId, 'setup-archived') : []
      commit(
        ...guideEnd,
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        why === undefined
          ? events.taskArchivedV2({ taskId, closing, branches, at })
          : events.taskArchivedV3({ taskId, closing, branches, why, at }),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      updatedDependents(taskId)
      if (guideEnd.length > 0) emitGuides()
      return task
    },
    unarchiveTask(taskId, { queue: queued, waitForBlockers, reblocked = [] }) {
      const at = new Date().toISOString()
      const rank = queued ? Math.max(0, ...queue().map((q) => q.rank)) + 1 : null
      commit(
        events.taskUnarchivedV2({ taskId, rank, reblocked: [...reblocked], at }),
        ...(taskRow(taskId)?.preparation === 'ready'
          ? [events.taskStopped({ taskId, runs: 0, why: 'prepared', at })]
          : []),
        ...(queued && waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      updatedDependents(taskId)
      return task
    },
    deleteTask(taskId) {
      const oldParent = parentRow(taskId)?.parentId
      const oldChildren = childRows(taskId).map((row) => row.taskId)
      const row = taskRow(taskId)
      if (!row) return
      checkingTasks.delete(taskId)
      movingAfterChecks.delete(taskId)
      const at = new Date().toISOString()
      const guideEnd = row.setup ? guideEnding(row.factoryId, 'setup-deleted') : []
      commit(
        ...guideEnd,
        ...[
          ...childRows(taskId).map((row) => row.taskId),
          ...(parentRow(taskId) ? [taskId] : []),
        ].map((id) => events.taskParentChanged({ taskId: id, parentId: null, at })),
        events.taskExecutionForgotten({ taskId, at }),
        events.executionOperationsForgotten({ taskId, at }),
        events.taskDeleted({
          taskId,
          factoryId: row.factoryId,
          number: row.number,
          runIds: taskRuns(taskId).map((r) => r.id),
          checkRunIds: checkRunRows(taskId).map((r) => r.id),
          at,
        }),
      )
      if (oldParent && taskRow(oldParent)) updatedTask(oldParent)
      for (const id of oldChildren) if (taskRow(id)) updatedTask(id)
      emit({ type: 'task-deleted', taskId })
      updatedQueue()
      updatedDependents(taskId)
      if (guideEnd.length > 0) emitGuides()
    },
    resetTask(taskId) {
      const row = requireTaskRow(taskId)
      checkingTasks.delete(taskId)
      movingAfterChecks.delete(taskId)
      const runIds = taskRuns(taskId).map((r) => r.id)
      const human = history.humanClarifyDepth(taskId)
      const byLead = row.clarifyDepthBy === 'task-lead'
      commit(
        events.taskReset({
          taskId,
          description: descriptionRows(taskId).at(0)?.text ?? row.description,
          clarifyDepth: byLead ? (human ?? 'auto') : row.clarifyDepth,
          clarifyDepthBy: byLead ? (human === undefined ? null : 'human') : row.clarifyDepthBy,
          runIds,
          checkRunIds: checkRunRows(taskId).map((r) => r.id),
          at: new Date().toISOString(),
        }),
      )
      emit({ type: 'task-reset', taskId })
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      updatedDependents(taskId)
      return task
    },
    nextTaskNumber: (factoryId) => nextNumber(factoryId),
    moveTask({ moves, unlink, leaveParent, notes, by }) {
      const at = new Date().toISOString()
      const next = new Map<string, number>()
      const numberIn = (factoryId: string) => {
        const number = next.get(factoryId) ?? nextNumber(factoryId)
        next.set(factoryId, number + 1)
        return number
      }
      const planned = moves.map(({ taskId, factoryId, started }) => {
        const row = requireTaskRow(taskId)
        checkingTasks.delete(taskId)
        movingAfterChecks.delete(taskId)
        return {
          row,
          started,
          factoryId,
          number: numberIn(factoryId),
          from: `${factoryKey(row.factoryId)}-${row.number}`,
        }
      })
      const withdrawn = planned.flatMap(({ row, factoryId }) =>
        openRequestRows(row.id).map((request) => ({ request, factoryId })),
      )
      const oldParent = leaveParent === undefined ? undefined : parentRow(leaveParent)?.parentId
      const posts = notes.map(({ taskId, body }) =>
        commentPosted({ taskId, kind: 'note', author: { kind: 'ted' }, body }, at),
      )
      commit(
        ...unlink.map(({ taskId, blockerId }) =>
          events.taskBlockerRemoved({ taskId, blockerId, runId: null, at }),
        ),
        ...(leaveParent !== undefined && oldParent !== undefined
          ? [events.taskParentChanged({ taskId: leaveParent, parentId: null, at })]
          : []),
        ...withdrawn.map(({ request, factoryId }) => {
          const answer: CommentAnswer = { kind: 'withdrawn', at, movedToFactory: factoryId }
          return events.commentAnswered({ id: request.id, answer: JSON.stringify(answer), at })
        }),
        ...planned.flatMap(({ row, started, factoryId, number, from }) => [
          ...(row.snoozedUntil ? [events.taskSnoozeCleared({ taskId: row.id, at })] : []),
          events.taskMovedToFactory({
            taskId: row.id,
            fromFactoryId: row.factoryId,
            fromNumber: row.number,
            fromDisplayId: from,
            factoryId,
            number,
            by,
            started,
            checkRunIds: checkRunRows(row.id).map((r) => r.id),
            at,
          }),
        ]),
        ...posts.flatMap(({ event, attached }) => [event, ...attached]),
      )
      for (const { request } of withdrawn) emitComment(request.id)
      for (const { id } of posts) emitComment(id)
      for (const { row } of planned) updatedTask(row.id)
      if (oldParent !== undefined && taskRow(oldParent)) updatedTask(oldParent)
      for (const { taskId, blockerId } of unlink) {
        if (taskRow(taskId)) updatedTask(taskId)
        if (taskRow(blockerId)) updatedTask(blockerId)
      }
      updatedQueue()
      for (const { row } of planned) updatedDependents(row.id)
      return planned.map(({ row, factoryId, number, from }) => ({
        id: row.id,
        from,
        to: `${factoryKey(factoryId)}-${number}`,
      }))
    },
    blockedBy: (blockerId) =>
      store.query(queryDb(taskBlockers.where({ blockerId }))).map((row) => row.taskId),
    openBlockedTasks: () =>
      [
        ...new Set([
          ...store.query(queryDb(taskBlockers.orderBy('at', 'asc'))).map((row) => row.taskId),
          ...store.query(queryDb(taskParents.orderBy('taskId', 'asc'))).map((row) => row.parentId),
          ...store
            .query(queryDb(comments.where({ answer: null })))
            .filter((row) => row.asanaMissing !== null)
            .map((row) => row.taskId),
        ]),
      ]
        .flatMap((id) => taskRow(id) ?? [])
        .filter((row) => row.stage !== 'done' && row.archivedAt === null)
        .sort((a, b) => a.number - b.number)
        .map((row) => row.id),
    queue,
    dequeue(taskId) {
      commit(events.taskDequeued({ taskId, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    parentOf: (taskId) => parentRow(taskId)?.parentId,
    childrenOf: (taskId) => childRows(taskId).map((row) => row.taskId),
    setTaskParent(taskId, parentId) {
      const old = parentRow(taskId)?.parentId
      commit(events.taskParentChanged({ taskId, parentId, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      for (const id of new Set([old, parentId])) if (id && taskRow(id)) updatedTask(id)
      return task
    },
    recordTreeArchive(rootId, taskIds) {
      commit(
        events.taskTreeArchived({ rootId, taskIds: [...taskIds], at: new Date().toISOString() }),
      )
    },
    recordArchiveUnblocks(blockerId, taskIds) {
      if (taskIds.length === 0) return
      commit(
        events.archiveUnblocked({ blockerId, taskIds: [...taskIds], at: new Date().toISOString() }),
      )
    },
    archiveUnblocked: (blockerId) =>
      store
        .query(queryDb(archiveUnblocks.where({ blockerId }).orderBy('taskId', 'asc')))
        .map((row) => row.taskId),
    archivedWith: (rootId) =>
      store
        .query(queryDb(taskTreeArchives.where({ rootId }).orderBy('taskId', 'asc')))
        .map((row) => row.taskId),
    blockers: blockerLinks,
    addBlocker(taskId, blockerId, { runId, then } = {}) {
      const at = new Date().toISOString()
      commit(
        events.taskBlockerAddedV2({ taskId, blockerId, runId: runId ?? null, at }),
        ...(then === 'backlog'
          ? [
              events.taskMovedToBacklog({ taskId, at }),
              events.taskStartRequestChanged({ taskId, startRequested: true, at }),
            ]
          : []),
        ...(then === 'wait' ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      if (then !== undefined) updatedQueue(taskId)
      return task
    },
    removeBlocker(taskId, blockerId, runId) {
      commit(
        events.taskBlockerRemoved({
          taskId,
          blockerId,
          runId: runId ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setTaskSnooze(taskId, until) {
      const at = new Date().toISOString()
      commit(
        until === null
          ? events.taskSnoozeCleared({ taskId, at })
          : events.taskSnoozed({ taskId, until, at }),
      )
      return updatedTask(taskId)
    },
    setStartRequested(taskId, startRequested) {
      const row = taskRow(taskId)
      const at = new Date().toISOString()
      commit(
        ...(startRequested && row?.stage === 'backlog' && row.stoppedAt !== null
          ? [
              events.taskResumed({ taskId, rank: row.rank ?? row.number, at }),
              events.taskDequeued({ taskId, at }),
            ]
          : []),
        ...(startRequested && taskRow(taskId)?.snoozedUntil
          ? [events.taskSnoozeCleared({ taskId, at: new Date().toISOString() })]
          : []),
        events.taskStartRequestChanged({ taskId, startRequested, at: new Date().toISOString() }),
      )
      return updatedTask(taskId)
    },
    waitForBlockers(taskId) {
      commit(events.taskWaitingForBlockers({ taskId, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    requeueAfterBlockers(taskId) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      commit(events.taskRequeuedAfterBlockers({ taskId, rank, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    taskStoppedByHuman(taskId) {
      const row = requireTaskRow(taskId)
      return row.stoppedAt !== null && (row.stoppedWhy === 'human' || row.stoppedWhy === null)
    },
    stopTask(taskId, { runs, why }) {
      const pendingTalks = store.query(queryDb(comments.where({ taskId, talkRequested: true })))
      const at = new Date().toISOString()
      commit(
        events.taskStopped({ taskId, runs, why, at }),
        ...((why === 'human' || why === 'blockers-removed') &&
        taskRow(taskId)?.preparation === 'ready'
          ? [events.taskPreparationChanged({ taskId, state: null, at })]
          : []),
      )
      for (const { id } of pendingTalks) emitComment(id)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    resumeTask(taskId, { waitForBlockers, overnight, talkCommentId }) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      const at = new Date().toISOString()
      commit(
        ...(talkCommentId ? [events.roundTalkRequested({ id: talkCommentId, at })] : []),
        (overnight ? events.taskResumedOvernight : events.taskResumed)({ taskId, rank, at }),
        ...(taskRow(taskId)?.preparation === 'ready'
          ? [events.taskPreparationChanged({ taskId, state: null, at })]
          : []),
        ...(waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      if (talkCommentId) emitComment(talkCommentId)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    taskStoppedByTed(taskId, runId, cause, at = new Date().toISOString()) {
      commit(events.taskStoppedByTed({ taskId, runId, cause, at }))
      emit({ type: 'ted-stops-changed' })
    },
    tedStopPending(taskId) {
      const lead = taskRuns(taskId).find((run) => run.parentRunId === null)
      return pendingTedStop(taskId, lead?.id) !== undefined
    },
    answerTedStop(taskId, choice) {
      commit(events.tedStopAnswered({ taskId, choice, at: new Date().toISOString() }))
      emit({ type: 'ted-stops-changed' })
    },
    tedStops() {
      return listTasks().flatMap((task) => {
        if (!task.canResume) return []
        const stoppedAt = pendingTedStop(task.id, task.leadRunId)
        if (stoppedAt === undefined) return []
        return [
          {
            id: task.id,
            displayId: task.displayId,
            title: task.title,
            stage: task.stage,
            factoryId: task.factoryId,
            stoppedAt,
          },
        ]
      })
    },
    leadNudged(taskId, runId) {
      commit(events.taskLeadNudged({ taskId, runId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    appStarted({ taskId, repo, name, port, url, by, runId, restart }) {
      commit(
        events.appStarted({
          taskId,
          repo,
          name,
          port: port ?? null,
          url: url ?? null,
          by,
          runId: runId ?? null,
          restart,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    appStopped({ taskId, repo, name }) {
      commit(events.appStopped({ taskId, repo, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    appExited({ taskId, repo, name, code, signal }) {
      commit(
        events.appExited({
          taskId,
          repo,
          name,
          code: code ?? null,
          signal: signal ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    appStartFailed({ taskId, repo, name, problem }) {
      commit(events.appStartFailed({ taskId, repo, name, problem, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    simulatorShutDown({ taskId, repo, name, forTask, idle }) {
      commit(
        events.simulatorShutDown({
          taskId,
          repo,
          name,
          forTask: forTask ?? null,
          idle,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    emulatorShutDown({ taskId, repo, name, forTask, idle }) {
      commit(
        events.emulatorShutDown({
          taskId,
          repo,
          name,
          forTask: forTask ?? null,
          idle,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    requestSimulator({ taskId, runId, title, body, simulator }) {
      const id = randomUUID()
      const at = new Date().toISOString()
      const run = runRow(runId)
      const pause = run !== undefined && run.state === 'working'
      commit(
        events.simulatorRequested({
          id,
          taskId,
          runId,
          stage: taskRow(taskId)?.stage ?? null,
          title,
          body,
          simulator: JSON.stringify(simulator),
          createdAt: at,
        }),
        events.commentPurposeRecorded({
          commentId: id,
          purpose: JSON.stringify({ kind: 'simulator' }),
        }),
        ...(pause ? [events.runStateChanged({ runId, state: 'waiting', at })] : []),
      )
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
      if (pause) {
        const updated = runRow(runId)
        if (updated) emit({ type: 'run-updated', run: toRun(updated) })
        noteActivity()
      }
      updatedTask(taskId)
      return comment
    },
    leadFailed({ taskId, runId, reason, recovery, resumeFailed, ask, mergeAnyway }) {
      const at = new Date().toISOString()
      const id = ask && randomUUID()
      commit(
        events.taskLeadFailed({
          taskId,
          runId,
          reason,
          recovery,
          resumeFailed,
          rank: recovery === 'fresh' ? Math.max(0, ...queue().map((q) => q.rank)) + 1 : null,
          ask: ask && id ? { id, ...ask } : null,
          at,
        }),
        ...(id
          ? [
              events.commentPurposeRecorded({
                commentId: id,
                purpose: JSON.stringify({ kind: 'failed-run' }),
              }),
              ...(mergeAnyway
                ? [
                    events.failedRunMergeAnywayOffered({
                      commentId: id,
                      choices: JSON.stringify(['Retry', 'Merge anyway']),
                    }),
                  ]
                : []),
            ]
          : []),
      )
      if (id) emit({ type: 'comment-posted', comment: requireComment(id) })
      const task = updatedTask(taskId)
      if (recovery === 'fresh') updatedQueue(taskId)
      return task
    },
    retryTask(taskId, { waitForBlockers }) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      const at = new Date().toISOString()
      commit(
        events.taskRetried({ taskId, rank, at }),
        ...(waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    setTaskRepos(taskId, { repos, names, by, runId }) {
      commit(
        events.taskReposSet({
          taskId,
          repos,
          names,
          by,
          runId: runId ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    worktreeSetupStarted(taskId, name, { command, timeoutMs, env }) {
      commit(
        events.taskWorktreeSetupStarted({
          taskId,
          name,
          command,
          timeoutMs,
          env: JSON.stringify(env),
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    recordedSetup(taskId, name) {
      const row = store.query(queryDb(taskRepos.where({ id: `${taskId}:${name}` }))).at(0)
      if (!row?.setupCommand || row.setupTimeoutMs === null || row.setupEnv === null)
        return undefined
      return {
        command: row.setupCommand,
        timeoutMs: row.setupTimeoutMs,
        env: JSON.parse(row.setupEnv) as Record<string, string>,
      }
    },
    worktreeSetupFinished(taskId, name, { outcome, exitCode }) {
      commit(
        events.taskWorktreeSetupFinished({
          taskId,
          name,
          outcome,
          exitCode: exitCode ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    worktreeRemoved(taskId, name, teardown) {
      commit(
        events.taskWorktreeRemoved({
          taskId,
          name,
          teardownCommand: teardown?.command ?? null,
          teardownOutcome: teardown?.outcome ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    branchPushed(taskId, name, { commit: pushed, ci, ciSignals }) {
      commit(
        events.taskBranchPushed({
          taskId,
          name,
          commit: pushed,
          ci,
          ciSignals,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    branchPushFailed(taskId, name, message) {
      commit(events.taskBranchPushFailed({ taskId, name, message, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pushRecordReconciled(taskId, name, { recorded, remote }) {
      commit(
        events.taskPushRecordReconciled({
          taskId,
          name,
          recorded,
          remote,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    pullRequestOpened(taskId, name, { number, url, base }) {
      commit(
        events.pullRequestOpened({
          taskId,
          name,
          number,
          url,
          base,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    pullRequestMarkedReady(taskId, name) {
      commit(events.pullRequestMarkedReady({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestClosed(taskId, name) {
      commit(events.pullRequestClosed({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestReopened(taskId, name, state) {
      commit(events.pullRequestReopenedV2({ taskId, name, state, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestClosedOnGitHub(taskId, name) {
      commit(events.pullRequestClosedOnGitHub({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestPreviewFound(taskId, name, preview) {
      commit(
        events.pullRequestPreviewFound({ taskId, name, ...preview, at: new Date().toISOString() }),
      )
      updatedTask(taskId)
    },
    gitHubActivitySent(taskId, runId, notices) {
      commit(
        events.gitHubActivitySent({
          taskId,
          runId,
          notices: notices.map(({ key, sig, kind, where }) => ({ key, sig, kind, where })),
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    gitHubActivityHeld(taskId, notices) {
      commit(
        events.gitHubActivityHeld({
          taskId,
          notices: notices.map(({ key, sig, kind, where }) => ({ key, sig, kind, where })),
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    gitHubActivityQueued(taskId, notices) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      commit(
        events.gitHubActivityQueued({
          taskId,
          rank,
          notices: notices.map(({ key, sig, kind, where }) => ({ key, sig, kind, where })),
          at: new Date().toISOString(),
        }),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    gitHubSeen(taskId) {
      const seen = new Map<string, string>()
      const rows = store
        .query(queryDb(taskLog.where({ taskId }).orderBy('at', 'asc')))
        .filter(
          (row) => row.name === 'v1.GitHubActivitySent' || row.name === 'v1.GitHubActivityHeld',
        )
      for (const row of rows) {
        const notices = (JSON.parse(row.data) as { notices?: unknown }).notices
        if (!Array.isArray(notices)) continue
        for (const n of notices as { key?: unknown; sig?: unknown }[]) {
          if (typeof n.key === 'string' && typeof n.sig === 'string') seen.set(n.key, n.sig)
        }
      }
      return seen
    },
    linearIssueSeen(taskId, identifier, { stateType, state, team }) {
      commit(
        events.linearIssueSeen({
          taskId,
          identifier,
          stateType,
          state,
          team,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    linearSyncAllowed(taskId, identifier) {
      commit(
        events.linearSyncAllowed({ taskId, identifier, by: 'menu', at: new Date().toISOString() }),
      )
      return updatedTask(taskId)
    },
    allowLinearTeam(factoryId, team, consents) {
      const at = new Date().toISOString()
      const current = settings()
      const listed = current.linearSyncTeams[factoryId] ?? []
      const { [factoryId]: declined = [], ...otherDeclined } = current.linearSyncDeclined
      const stillDeclined = declined.filter((t) => t !== team)
      const changes: Partial<MachineSettings> = {
        ...(!listed.includes(team) && {
          linearSyncTeams: { ...current.linearSyncTeams, [factoryId]: [...listed, team] },
        }),
        ...(stillDeclined.length !== declined.length && {
          linearSyncDeclined:
            stillDeclined.length > 0
              ? { ...otherDeclined, [factoryId]: stillDeclined }
              : otherDeclined,
        }),
      }
      const changed = Object.keys(changes).length > 0
      const batch = [
        ...(changed
          ? [events.machineSettingsChanged({ changes: JSON.stringify(changes), at })]
          : []),
        ...consents.map(({ taskId, identifier }) =>
          events.linearTeamSyncAllowed({ taskId, identifier, team, at }),
        ),
      ]
      if (batch.length > 0) commit(...batch)
      if (changed) emit({ type: 'settings-changed', settings: settings() })
      for (const { taskId } of consents) updatedTask(taskId)
      return settings()
    },
    linearIssueMoved(taskId, identifier, step, state) {
      commit(
        events.linearIssueMoved({
          taskId,
          identifier,
          step,
          state: state ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    linearPullRequestsLinked(taskId, identifier, urls) {
      commit(
        events.linearPullRequestsLinked({
          taskId,
          identifier,
          urls: [...urls],
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    linearSync: linearRecord,
    trackerItemSeen(taskId, tracker, item, { closed, state, group }) {
      commit(
        events.trackerItemSeen({
          taskId,
          tracker,
          item,
          closed,
          state,
          group: group ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    trackerItemMoved(taskId, tracker, item, step, state) {
      commit(
        events.trackerItemMoved({
          taskId,
          tracker,
          item,
          step,
          state: state ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    trackerPullRequestsLinked(taskId, tracker, item, urls) {
      commit(
        events.trackerPullRequestsLinked({
          taskId,
          tracker,
          item,
          urls: [...urls],
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    trackerSync: trackerRecord,
    trackerSyncAllowed(taskId, tracker, item, account, by = 'menu') {
      if (tracker === 'asana') {
        asanaOpenChildren.delete(taskId)
        asanaLeftOpen.delete(taskId)
      }
      commit(
        events.trackerSyncAllowed({
          taskId,
          tracker,
          item,
          by,
          account: account ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    allowTrackerGroup(tracker, factoryId, group, consents, account) {
      const at = new Date().toISOString()
      const current = settings()
      const allowed = current.trackerSyncGroups[tracker] ?? {}
      const declined = current.trackerSyncDeclined[tracker] ?? {}
      const listed = allowed[factoryId] ?? []
      const wasDeclined = declined[factoryId] ?? []
      const stillDeclined = wasDeclined.filter((g) => g !== group)
      const { [factoryId]: _, ...otherDeclined } = declined
      const changes: Partial<MachineSettings> = {
        ...(!listed.includes(group) && {
          trackerSyncGroups: {
            ...current.trackerSyncGroups,
            [tracker]: { ...allowed, [factoryId]: [...listed, group] },
          },
        }),
        ...(stillDeclined.length !== wasDeclined.length && {
          trackerSyncDeclined: {
            ...current.trackerSyncDeclined,
            [tracker]:
              stillDeclined.length > 0
                ? { ...otherDeclined, [factoryId]: stillDeclined }
                : otherDeclined,
          },
        }),
        ...(account !== undefined &&
          current.trackerSyncGroupAccounts[tracker]?.[factoryId]?.[group] !== account && {
            trackerSyncGroupAccounts: withGroupAccount(
              current.trackerSyncGroupAccounts,
              tracker,
              factoryId,
              group,
              account,
            ),
          }),
      }
      const changed = Object.keys(changes).length > 0
      const batch = [
        ...(changed
          ? [events.machineSettingsChanged({ changes: JSON.stringify(changes), at })]
          : []),
        ...consents.map(({ taskId, item }) =>
          events.trackerGroupSyncAllowed({
            taskId,
            tracker,
            item,
            group,
            account: account ?? null,
            at,
          }),
        ),
      ]
      if (batch.length > 0) commit(...batch)
      if (changed) emit({ type: 'settings-changed', settings: settings() })
      for (const { taskId } of consents) updatedTask(taskId)
      if (changed && tracker === 'asana') updatedTasks(asanaTaskIds())
      return settings()
    },
    forgetTrackerGroup(tracker, factoryId, group, list, consents, account) {
      const at = new Date().toISOString()
      const current = settings()
      const name = list === 'allowed' ? 'trackerSyncGroups' : 'trackerSyncDeclined'
      const byFactory = current[name][tracker] ?? {}
      const listed = byFactory[factoryId] ?? []
      if (!listed.includes(group)) return current
      const kept = listed.filter((g) => g !== group)
      const { [factoryId]: _, ...others } = byFactory
      const accounts = current.trackerSyncGroupAccounts[tracker]?.[factoryId] ?? {}
      const { [group]: __, ...keptAccounts } = accounts
      const changes: Partial<MachineSettings> = {
        [name]: {
          ...current[name],
          [tracker]: kept.length > 0 ? { ...others, [factoryId]: kept } : others,
        },
        ...(list === 'allowed' &&
          group in accounts && {
            trackerSyncGroupAccounts: {
              ...current.trackerSyncGroupAccounts,
              [tracker]: {
                ...current.trackerSyncGroupAccounts[tracker],
                [factoryId]: keptAccounts,
              },
            },
          }),
      }
      commit(
        ...consents.map(({ taskId, item }) =>
          events.trackerGroupSyncAllowed({
            taskId,
            tracker,
            item,
            group,
            account: account ?? null,
            at,
          }),
        ),
        events.machineSettingsChanged({ changes: JSON.stringify(changes), at }),
      )
      emit({ type: 'settings-changed', settings: settings() })
      for (const { taskId } of consents) updatedTask(taskId)
      if (tracker === 'asana') updatedTasks(asanaTaskIds())
      return settings()
    },
    trackerItemGroupsSeen(taskId, tracker, item, groups) {
      commit(
        events.trackerItemGroupsSeen({
          taskId,
          tracker,
          item,
          groups: [...groups],
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    declineTrackerGroup(tracker, factoryId, group) {
      const current = settings().trackerSyncDeclined
      const byFactory = current[tracker] ?? {}
      const listed = byFactory[factoryId] ?? []
      if (listed.includes(group)) return
      const changes: Partial<MachineSettings> = {
        trackerSyncDeclined: {
          ...current,
          [tracker]: { ...byFactory, [factoryId]: [...listed, group] },
        },
      }
      commit(
        events.machineSettingsChanged({
          changes: JSON.stringify(changes),
          at: new Date().toISOString(),
        }),
      )
      emit({ type: 'settings-changed', settings: settings() })
    },
    worktreeCreated(taskId, repo) {
      commit(events.taskWorktreeCreated({ taskId, ...repo, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestWaiting(taskId, name, on) {
      commit(
        events.pullRequestWaitChanged({
          taskId,
          name,
          on: on ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    autoMergeEnabled(taskId, name, { method, requested }) {
      commit(
        events.pullRequestAutoMergeEnabled({
          taskId,
          name,
          method,
          requested,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    pullRequestMerged(taskId, name, { method, requested, noCi, byTed }) {
      commit(
        events.pullRequestMerged({
          taskId,
          name,
          method: method ?? null,
          requested: requested ?? null,
          noCi,
          byTed,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    branchRebased(taskId, name, { commit: rebased, onto }) {
      commit(
        events.taskBranchRebased({
          taskId,
          name,
          commit: rebased,
          onto,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    mergeStoppedPartway(taskId, { merged, open }) {
      commit(events.mergeStoppedPartway({ taskId, merged, open, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    isMerged: (taskId) => isMerged(taskId),
    autoMergeDisabled(taskId, name) {
      commit(events.pullRequestAutoMergeDisabled({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    mergeStarted(taskId) {
      commit(events.mergeStarted({ taskId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestTitleSet(taskId, { title, body }) {
      commit(
        events.pullRequestTitleSet({
          taskId,
          title,
          body: body ?? '',
          at: new Date().toISOString(),
        }),
      )
    },
    mergeLeadAdvanced(taskId, by) {
      commit(events.mergeLeadAdvanced({ taskId, by, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    gateKeptOvernight(taskId, stage, reason) {
      commit(events.gateKeptOvernight({ taskId, stage, reason, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    createdByAutomation(taskId) {
      return store.query(queryDb(automationTasks.where({ taskId }))).length > 0
    },
    gateRequestedFor(taskId, commentId, name, requested) {
      commit(
        events.gateRequestedFor({
          taskId,
          commentId,
          name,
          commit: requested,
          at: new Date().toISOString(),
        }),
      )
    },
    gateApprovalBound(taskId, commentId, name, approved) {
      commit(
        events.gateApprovalBound({
          taskId,
          commentId,
          name,
          commit: approved,
          at: new Date().toISOString(),
        }),
      )
    },
    gateSkippedOvernight(taskId, stage) {
      commit(events.gateSkippedOvernight({ taskId, stage, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    mergeCanceled(taskId, commentId) {
      commit(events.mergeCanceled({ taskId, commentId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    taskMarkedDone(taskId, by) {
      commit(events.taskMarkedDoneBy({ taskId, by, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    mergePending(taskId) {
      const task = taskRow(taskId)
      return mergesHere(task?.stage ?? '') && mergePendingFor(taskId, reposOf(taskId))
    },
    pullRequestSignedOff(taskId, name, signedOff) {
      commit(
        events.pullRequestSignedOff({
          taskId,
          name,
          commit: signedOff ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    setLocalFolder(repo, path) {
      commit(events.localFolderSet({ repo, path, at: new Date().toISOString() }))
    },
    clearLocalFolder(repo) {
      commit(events.localFolderCleared({ repo, at: new Date().toISOString() }))
    },
    setFactoryAutoStartBacklog(factoryId, enabled) {
      requireFactory(factoryId)
      commit(
        events.factoryAutoStartBacklogChanged({ factoryId, enabled, at: new Date().toISOString() }),
      )
      const factory = requireFactory(factoryId)
      emit({ type: 'factory-updated', factory: basicFactory(factory) })
      return factory
    },
    setFactoryIcon(factoryId, icon) {
      requireFactory(factoryId)
      commit(
        events.factoryIconChanged({
          factoryId,
          icon: icon === null ? null : JSON.stringify(icon),
          at: new Date().toISOString(),
        }),
      )
      return requireFactory(factoryId)
    },
    renameFactory(factoryId, name) {
      commit(events.factoryRenamed({ factoryId, name, at: new Date().toISOString() }))
      return requireFactory(factoryId)
    },
    factoryLayout: readFactoryLayout,
    saveFactoryLayout(layout) {
      if (JSON.stringify(layout) === JSON.stringify(readFactoryLayout())) return undefined
      commit(events.factoryLayoutSaved({ items: layout.items, at: new Date().toISOString() }))
      emit({ type: 'factory-layout-changed', layout: readFactoryLayout() })
      return listFactories()
    },
    removeFactory(factoryId) {
      commit(events.factoryRemoved({ factoryId, at: new Date().toISOString() }))
      emit({ type: 'factory-removed', factoryId })
      noteActivity()
    },
    changeFactoryRepos(factoryId, repos) {
      commit(events.factoryReposChanged({ factoryId, repos, at: new Date().toISOString() }))
      return requireFactory(factoryId)
    },
    localFolder: (repo) => store.query(queryDb(localFolders.where({ repo }))).at(0)?.path,
    changeStage(taskId, stage, entry, options) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId).filter(
        (row) =>
          ((row.gate !== null || row.kind === 'round') && row.stage !== stage) ||
          (stage === 'done' && row.archive !== null),
      )
      const answer: CommentAnswer = { kind: 'withdrawn', at, movedTo: stage }
      commit(
        events.taskStageChanged({ taskId, stage, at }),
        ...(options?.prepare
          ? [
              events.taskPreparationChanged({ taskId, state: 'ready', at }),
              events.taskStopped({
                taskId,
                runs: taskRuns(taskId).filter((r) => r.state !== 'finished').length,
                why: 'prepared',
                at,
              }),
            ]
          : []),
        ...(entry ? [stageEntered(taskId, stage, entry, at)] : []),
        ...(mergesHere(stage) ? [events.mergeAwaitsLead({ taskId, at })] : []),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      if (options?.prepare) updatedQueue(taskId)
      if (stage === 'done' || isCleanup(stage)) updatedDependents(taskId)
      return task
    },
    dashboard(factoryIds, range, asOf = Date.now()) {
      const shown = new Set(factoryIds)
      const reads = taskReads(true)
      const statuses = new Map(
        store
          .query(allTasks)
          .filter(
            (row) =>
              shown.has(row.factoryId) &&
              row.archivedAt === null &&
              !row.setup &&
              row.stage !== 'done',
          )
          .map((row) => [row.id, toTask(row, false, reads).status?.kind]),
      )
      return readDashboard(store, factoryIds, range, asOf, observationSessionId, statuses)
    },
    listStageEntries: (taskId) =>
      store.query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc'))).map(toStageEntry),
    recordedStages(taskId) {
      const saved = store
        .query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc')))
        .findLast((e) => e.order !== null)?.order
      return saved ? (JSON.parse(saved) as PlannedStage[]) : undefined
    },
    acceptWorkflowLayer(layer, { files, version }) {
      commit(
        events.workflowLayerAccepted({
          layer,
          files: JSON.stringify(files),
          version,
          at: new Date().toISOString(),
        }),
      )
    },
    rememberStageFileText(seen) {
      if (store.query(queryDb(stageFileTexts.where({ hash: seen.hash }))).length > 0) return
      commit(events.stageFileTextSeen({ ...seen, at: new Date().toISOString() }))
    },
    seenStageFileText(hash) {
      const row = store.query(queryDb(stageFileTexts.where({ hash }))).at(0)
      return (
        row && {
          hash: row.hash,
          layer: row.layer as LayerKind,
          stage: row.stage as AgentStageId,
          text: row.text,
          tedVersion: row.tedVersion,
        }
      )
    },
    lastValidWorkflowLayer(layer) {
      const row = store.query(queryDb(workflowLayers.where({ layer }))).at(0)
      return (
        row && {
          files: JSON.parse(row.files) as AcceptedLayer['files'],
          version: row.version,
          acceptedAt: row.acceptedAt,
        }
      )
    },
    setTaskLead(taskId, { agent, model, effort, effortMode }) {
      commit(
        events.taskLeadEffortModeSet({
          taskId,
          mode: effortMode ?? null,
          at: new Date().toISOString(),
        }),
        events.taskLeadSet({
          taskId,
          agent,
          model: model ?? null,
          effort: effort ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setLeadRestartPending(taskId, pending) {
      commit(events.taskLeadRestartPendingSet({ taskId, pending, at: new Date().toISOString() }))
    },
    tasksWithQueuedContinuations: () => [
      ...new Set([
        ...store
          .query(queryDb(tasks.where({ pendingLeadDeliveries: { op: '!=', value: null } })))
          .filter((row) =>
            (JSON.parse(row.pendingLeadDeliveries ?? '[]') as LeadMessage[]).some(
              (message) => message.waitForSlot,
            ),
          )
          .map((row) => row.id),
        ...store
          .query(queryDb(comments.where({ answerHeld: true })))
          .filter((comment) => comment.answerQueuedAt !== null)
          .map((comment) => comment.taskId),
        ...store
          .query(queryDb(comments.where({ talkRequested: true, answer: null })))
          .map((comment) => comment.taskId),
      ]),
    ],
    holdLeadMessage(taskId, text, waitForSlot = false, after) {
      const pending = toTask(requireTaskRow(taskId)).pendingLeadMessages
      const at = new Date().toISOString()
      commit(
        events.taskLeadMessagesHeld({
          taskId,
          messages: JSON.stringify([
            ...pending,
            {
              id: randomUUID(),
              text,
              ...(waitForSlot && { waitForSlot: true }),
              ...(waitForSlot && after !== undefined && { after, heldAt: at }),
            },
          ]),
          at,
        }),
      )
    },
    deliveredLeadMessages(taskId, ids) {
      const pending = toTask(requireTaskRow(taskId)).pendingLeadMessages
      const remaining = pending.filter((message) => !ids.includes(message.id))
      if (remaining.length === pending.length) return
      commit(
        events.taskLeadMessagesHeld({
          taskId,
          messages: JSON.stringify(remaining),
          at: new Date().toISOString(),
        }),
      )
    },
    setTaskAutopilot(taskId, choice) {
      commit(events.taskAutopilotChanged({ taskId, choice, at: new Date().toISOString() }))
      return updatedTask(taskId)
    },
    setTaskGates(taskId, overrides) {
      commit(
        events.taskGatesChanged({
          taskId,
          overrides: JSON.stringify(overrides),
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setClarifyDepth(taskId, { depth, by, runId, why }) {
      commit(
        events.clarifyDepthSet({
          taskId,
          depth,
          by,
          runId: runId ?? null,
          why: why ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setActivity(taskId, text, runId) {
      commit(
        events.taskActivitySet({
          taskId,
          text,
          runId: runId ?? null,
          stageEntries: entryRows(taskId).length,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    recordBrowserCapture(taskId, attachment) {
      requireTaskRow(taskId)
      commit(
        events.taskBrowserCaptureAdded({ taskId, ...attachment, at: new Date().toISOString() }),
      )
    },
    browserCaptures: browserCapturesOf,
    taskFiles: (taskId) => [
      ...attachmentsOf(taskId),
      ...browserCapturesOf(taskId),
      ...store
        .query(queryDb(commentAttachments.where({ taskId })))
        .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType })),
    ],
    taskDraft,
    saveTaskDraft(factoryId, draft) {
      requireFactory(factoryId)
      const state = taskDraft(factoryId)
      if (
        state.clearedRevision !== draft.revision &&
        !state.clearedRevisions?.includes(draft.revision)
      ) {
        commitDraft(
          events.taskDraftSavedV2({
            factoryId,
            draft: JSON.stringify(draft),
            clearedRevision: state.clearedRevision ?? null,
            at: new Date().toISOString(),
          }),
        )
      }
      return taskDraft(factoryId)
    },
    removeTaskDraft(factoryId) {
      commit(events.taskDraftRemoved({ factoryId, at: new Date().toISOString() }))
    },
    messageDraft,
    saveMessageDraft(box, owner, draft) {
      const key = messageDraftKey(box.kind, box.id)
      const at = new Date().toISOString()
      const kept = messageDraft(box)
      if (emptyMessageDraft(draft)) {
        if (kept) commitDraft(events.messageDraftCleared({ key, at }))
        return null
      }
      const text = JSON.stringify(draft)
      if (kept === null || JSON.stringify(kept) !== text) {
        commitDraft(
          events.messageDraftSaved({
            key,
            factoryId: owner.factoryId ?? null,
            taskId: owner.taskId ?? null,
            planId: owner.planId ?? null,
            draft: text,
            at,
          }),
        )
      }
      return messageDraft(box)
    },
    messageDraftFiles: (taskId) =>
      store
        .query(queryDb(messageDrafts.where({ taskId })))
        .flatMap((row) => (JSON.parse(row.draft) as MessageDraft).attachments),
    filesInUse: () =>
      new Set([
        ...store
          .query(queryDb(messageDrafts))
          .flatMap((row) => (JSON.parse(row.draft) as MessageDraft).attachments.map((a) => a.hash)),
        ...store
          .query(queryDb(taskDrafts))
          .flatMap((row) =>
            row.draft ? (JSON.parse(row.draft) as NewTaskDraft).attachments.map((a) => a.hash) : [],
          ),
        ...store.query(queryDb(taskAttachments)).map((a) => a.hash),
        ...store.query(queryDb(taskBrowserCaptures)).map((a) => a.hash),
        ...store.query(queryDb(runBrowserCaptures)).map((a) => a.hash),
        ...store.query(queryDb(commentAttachments)).map((a) => a.hash),
      ]),
    postAutomationNote(input, link) {
      const at = new Date().toISOString()
      const { id, event } = commentPosted(input, at)
      commit(event, events.automationTaskNoted({ ...link, taskId: input.taskId, at }))
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
      emit({ type: 'automation-updated', automationId: link.automationId })
      return comment
    },
    postComment(input) {
      const at = new Date().toISOString()
      const { id, event, attached } = commentPosted(input, at)
      commit(event, ...attached, ...lineCommentsSent(input.lineComments, id, at))
      const comment = requireComment(id)
      if (!comment.held) emit({ type: 'comment-posted', comment })
      if (comment.kind !== 'note') updatedTask(input.taskId)
      for (const taskId of new Set(comment.lineComments?.map((c) => c.taskId))) {
        emit({ type: 'line-comments-changed', taskId })
      }
      return comment
    },
    supersedeComment(oldId, input) {
      const at = new Date().toISOString()
      const { id, event, attached } = commentPosted(input, at)
      const answer: CommentAnswer = { kind: 'superseded', at, by: id }
      commit(
        event,
        ...attached,
        events.commentAnswered({ id: oldId, answer: JSON.stringify(answer), at }),
      )
      const comment = requireComment(id)
      if (!comment.held) emit({ type: 'comment-posted', comment })
      emitComment(oldId)
      updatedTask(input.taskId)
      return comment
    },
    heldRequests: () =>
      store
        .query(queryDb(comments.where({ heldFor: { op: '!=', value: null } })))
        .map(({ id, heldFor, createdAt }) => ({ id, runId: heldFor ?? '', createdAt })),
    releaseRequests(ids) {
      const held = ids.flatMap((id) => {
        const row = store.query(queryDb(comments.where({ id }))).at(0)
        return row?.heldFor ? [row] : []
      })
      if (held.length === 0) return
      const at = new Date().toISOString()
      commit(...held.map((row) => events.requestReleased({ commentId: row.id, at })))
      for (const row of held) {
        const comment = requireComment(row.id)
        emit({ type: 'comment-posted', comment })
        updatedTask(row.taskId)
      }
    },
    listComments: (taskId) => commentRows(taskId).map(toComment),
    commentTexts: () =>
      commentRows().map(({ id, taskId, title, body, authorKind, authorRunId, createdAt }) => ({
        id,
        taskId,
        ...(title !== null && { title }),
        body,
        author:
          authorKind === 'run' && authorRunId !== null
            ? { kind: 'run' as const, runId: authorRunId }
            : { kind: authorKind === 'ted' ? ('ted' as const) : ('human' as const) },
        createdAt,
      })),
    permissionComments(runId) {
      const taskId = runRow(runId)?.taskId
      if (taskId === undefined || taskId === null) return []
      return store
        .query(
          queryDb(
            comments
              .where({ authorRunId: runId, authorKind: 'run', kind: 'permission', taskId })
              .orderBy('createdAt', 'asc'),
          ),
        )
        .map(toComment)
    },
    getComment,
    answerComment(id, answer, sending, autopilot = false, queueAnswer = false) {
      commit(
        events.commentAnswered({ id, answer: JSON.stringify(answer), at: answer.at }),
        ...(autopilot
          ? [
              events.commentAnsweredByAutopilot({
                taskId: requireComment(id).taskId,
                commentId: id,
                at: answer.at,
              }),
            ]
          : []),
        ...(queueAnswer ? [events.commentAnswerQueued({ id, at: answer.at })] : []),
        ...lineCommentsSent(sending, id, answer.at),
      )
      const comment = emitComment(id)
      updatedTask(comment.taskId)
      if (sending !== undefined && sending.length > 0) {
        emit({ type: 'line-comments-changed', taskId: comment.taskId })
      }
      return comment
    },
    draftLineComment({ quoted, ...input }) {
      const id = randomUUID()
      commit(
        events.lineCommentDrafted({
          id,
          ...input,
          quoted: JSON.stringify(quoted),
          at: new Date().toISOString(),
        }),
      )
      emit({ type: 'line-comments-changed', taskId: input.taskId })
      return requireLineComment(id)
    },
    editLineComment(id, body) {
      commit(events.lineCommentEdited({ id, body, at: new Date().toISOString() }))
      const edited = requireLineComment(id)
      emit({ type: 'line-comments-changed', taskId: edited.taskId })
      return edited
    },
    deleteLineComments(taskId, ids) {
      if (ids.length === 0) return
      commit(events.lineCommentsDeleted({ ids: [...ids], at: new Date().toISOString() }))
      emit({ type: 'line-comments-changed', taskId })
    },
    getLineComment: (id) => lineCommentRow(id),
    lineCommentDrafts,
    taskLineComments: (taskId) =>
      store
        .query(queryDb(lineComments.where({ taskId, deleted: false }).orderBy('createdAt', 'asc')))
        .map(toLineComment),
    commentsDelivered(ids, runId) {
      if (ids.length === 0) return
      commit(events.commentsDelivered({ ids, runId, at: new Date().toISOString() }))
      for (const id of ids) emitComment(id)
    },
    commentsRead(ids) {
      if (ids.length === 0) return
      commit(events.commentsRead({ ids, at: new Date().toISOString() }))
      for (const id of ids) emitComment(id)
    },
    requestRoundTalk(id) {
      commit(events.roundTalkRequested({ id, at: new Date().toISOString() }))
      return emitComment(id)
    },
    startRoundTalk(id, runId, text) {
      const at = new Date().toISOString()
      const messageId = randomUUID()
      const taskId = taskIdOfRun(runId) ?? null
      commit(
        events.runMessageQueuedV2({ id: messageId, runId, taskId, text, at, from: 'ted' }),
        events.roundTalkStartedV2({
          id,
          runId,
          messageId,
          at,
        }),
      )
      emit({ type: 'run-output', runId })
      return emitComment(id)
    },
    roundTalkMessageIds(runId) {
      return store
        .query(
          queryDb(runMessages.where({ runId, roundId: { op: '!=', value: null }, queued: true })),
        )
        .map((message) => message.id)
    },
    pendingRoundTalks(runId) {
      return store
        .query(queryDb(comments.where({ talkRunId: runId, talkRequested: true, answer: null })))
        .flatMap((row) =>
          row.talkMessageId === null
            ? []
            : [{ messageId: row.talkMessageId, round: toComment(row) }],
        )
    },
    roundTalkNotified(id, runId, messageId) {
      const at = new Date().toISOString()
      const taskId = taskIdOfRun(runId) ?? null
      commit(
        events.runMessageDelivered({ id: messageId, runId, taskId, lead: false, at }),
        events.roundTalkNotified({ id, runId, messageId, at }),
      )
      emit({ type: 'run-output', runId })
      emitComment(id)
    },
    roundTalkDone(id) {
      commit(events.roundTalkDone({ id, at: new Date().toISOString() }))
      return emitComment(id)
    },
    holdAnswer(id) {
      commit(events.commentAnswerHeld({ id, at: new Date().toISOString() }))
    },
    heldAnswers: (taskId) =>
      store
        .query(queryDb(comments.where({ taskId, answerHeld: true }).orderBy('createdAt', 'asc')))
        .map(toComment),
    answersDelivered(ids, runId) {
      if (ids.length === 0) return
      commit(events.commentAnswersSent({ ids, runId, at: new Date().toISOString() }))
      for (const id of ids) updatedTask(emitComment(id).taskId)
    },
    ...history,
    taskIntervalHistory(taskId, asOf = new Date().toISOString()) {
      const row = requireTaskRow(taskId)
      const taskBoundaries = store.query(
        queryDb(intervalBoundaries.where({ subject: `task:${taskId}` })),
      )
      const queuedRunIds = taskBoundaries
        .filter((b) => isSubAgentRequested(b.name))
        .map((b) => String(JSON.parse(b.data).queuedRunId))
      return taskIntervalHistory({
        taskId,
        createdAt: row.createdAt,
        asOf,
        log: readTaskLog(taskId),
        observations: store.query(
          queryDb(intervalBoundaries.where({ subject: 'observation' }).orderBy('sequence', 'asc')),
        ),
        boundaries: [
          ...taskBoundaries,
          ...queuedRunIds.flatMap((id) =>
            store.query(queryDb(intervalBoundaries.where({ subject: `sub-agent:${id}` }))),
          ),
          ...taskRuns(taskId).flatMap((r) =>
            store.query(
              queryDb(
                intervalBoundaries.where({ subject: `run:${r.id}` }).orderBy('sequence', 'asc'),
              ),
            ),
          ),
        ],
        blockerCompletions: readTaskLog(taskId).flatMap((event) => {
          if (!event.name.endsWith('TaskBlockerAdded') || typeof event.data.blockerId !== 'string')
            return []
          const id = event.data.blockerId
          return blockerTransitions(id, [
            ...readTaskLog(id),
            ...store
              .query(queryDb(intervalBoundaries.where({ subject: `task:${id}` })))
              .filter((b) => b.name !== 'v1.TaskWaitObserved')
              .map((b) => ({
                id: b.id,
                name: b.name,
                at: b.at,
                data: JSON.parse(b.data) as Record<string, unknown>,
              })),
          ])
        }),
        agents: store.query(queryDb(intervalBoundaries.where({ subject: 'agent' }))),
        runAgents: new Map(taskRuns(taskId).map((r) => [r.id, r.agent])),
        sessionId: observationSessionId,
        comments: store
          .query(queryDb(comments.select('id', 'kind', 'createdAt', 'answer').where({ taskId })))
          .filter((row) => row.kind !== 'note')
          .map((row) => ({
            id: row.id,
            kind: row.kind as CommentKind,
            createdAt: row.createdAt,
            ...(row.answer !== null && { answer: JSON.parse(row.answer) as CommentAnswer }),
          })),
      })
    },
    taskLog: readTaskLog,
    listOpenRequests: () => shownRequestRows().map(toComment),
    listAnsweredRequests: (since, kinds) =>
      commentRows()
        .filter((row) => {
          if (row.kind === 'note' || row.answer === null) return false
          const answer = JSON.parse(row.answer) as CommentAnswer
          return answer.at >= since && (kinds === undefined || kinds.has(answer.kind))
        })
        .map(toComment),
    writeBrief({ taskId, text, runId }) {
      const row = taskRow(taskId)
      if (!row) throw new Error(`no Task ${taskId}`)
      const version = (briefRows(taskId).at(-1)?.version ?? 0) + 1
      const id = randomUUID()
      commit(
        events.taskBriefWritten({
          id,
          taskId,
          version,
          text,
          stage: row.stage,
          runId: runId ?? null,
          at: new Date().toISOString(),
        }),
      )
      const brief = briefRows(taskId).at(-1)
      if (!brief) throw new Error(`no brief for ${taskId}`)
      updatedTask(taskId)
      return toBrief(brief)
    },
    listBriefs: (taskId) => briefRows(taskId).map(toBrief),
    latestBrief(taskId) {
      const row = briefRows(taskId).at(-1)
      return row && toBrief(row)
    },
    recordSendBack({
      taskId,
      from,
      to,
      findings,
      counted,
      round,
      limit,
      checkRunId,
      cause,
      conflict,
    }) {
      const id = randomUUID()
      const at = new Date().toISOString()
      commit(
        events.taskSentBackV2({
          id,
          taskId,
          from,
          to,
          findings,
          counted,
          round: round ?? null,
          limit: limit ?? null,
          checkRunId: checkRunId ?? null,
          at,
        }),
        ...(cause === undefined
          ? []
          : [events.sendBackCauseRecorded({ sendBackId: id, taskId, cause, at })]),
        ...(conflict === undefined ? [] : [conflictFound(taskId, conflict, at, id)]),
      )
      const row = store.query(queryDb(sendBacks.where({ id }))).at(0)
      if (!row) throw new Error(`no send-back ${id}`)
      const sendBack = toSendBack(row)
      emit({ type: 'sent-back', sendBack })
      return sendBack
    },
    recordBaseConflict(taskId, conflict) {
      const event = conflictFound(taskId, conflict, new Date().toISOString(), null)
      commit(event)
      const row = store.query(queryDb(baseConflicts.where({ id: event.args.id }))).at(0)
      if (!row) throw new Error(`no base conflict ${event.args.id}`)
      return toBaseConflict(row)
    },
    baseConflicts: (taskId) =>
      store
        .query(
          queryDb(
            (taskId === undefined ? baseConflicts : baseConflicts.where({ taskId })).orderBy(
              'at',
              'asc',
            ),
          ),
        )
        .map(toBaseConflict),
    reportCleanupStep(taskId, runId, { step, result, text }) {
      commit(
        events.cleanupStepReported({
          id: randomUUID(),
          taskId,
          step,
          result,
          text,
          runId,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    cleanupReports: (taskId) => {
      const latest = new Map<string, CleanupStepReport>()
      for (const row of store.query(
        queryDb(cleanupReports.where({ taskId }).orderBy('at', 'asc')),
      )) {
        latest.set(row.step, {
          step: row.step,
          result: row.result as CleanupStepResult,
          text: row.text,
          runId: row.runId,
          at: row.at,
        })
      }
      return [...latest.values()]
    },
    recordCleanupCommand(taskId, result) {
      commit(
        events.cleanupCommandRan({
          id: randomUUID(),
          taskId,
          step: result.step,
          state: result.state,
          exitCode: result.exitCode ?? null,
          timeout: result.timeout,
          durationMs: result.durationMs,
          output: result.output,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    retryCleanup(taskId, steps) {
      commit(events.cleanupRetried({ taskId, steps: [...steps], at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    finishCleanupAnyway(taskId, steps) {
      commit(
        events.cleanupFinishedAnyway({ taskId, steps: [...steps], at: new Date().toISOString() }),
      )
    },
    baseAdopted(taskId, moved) {
      if (moved.length === 0) return
      const at = new Date().toISOString()
      commit(...moved.map((row) => events.baseBranchAdopted({ taskId, ...row, at })))
      updatedTask(taskId)
    },
    listSendBacks(taskId) {
      const declared = store.query(
        queryDb(severityDeclarations.where({ taskId }).orderBy('at', 'asc')),
      )
      const backs = store
        .query(queryDb(sendBacks.where({ taskId }).orderBy('at', 'asc')))
        .map(toSendBack)
      const severities = sendBackSeverities(backs, declared)
      return backs.map((sendBack, index) => {
        const severity = severities[index]
        return severity && severity !== 'none' ? { ...sendBack, severity } : sendBack
      })
    },
    declareSeverity(input) {
      commit(
        events.sendBackSeverityDeclared({
          ...input,
          id: randomUUID(),
          at: new Date().toISOString(),
        }),
      )
    },
    recordP1OnlyReview(input) {
      commit(events.p1OnlyReviewRecorded({ ...input, at: new Date().toISOString() }))
    },
    p1OnlyReview: (runId) => store.query(queryDb(p1OnlyReviews.where({ runId }))).length > 0,
    startChecks({ taskId, trigger, stage, checks }) {
      const id = randomUUID()
      commit(
        events.checksStarted({
          id,
          taskId,
          trigger,
          stage,
          checks: checks.map((check) => ({
            name: check.name,
            repo: check.repo ?? null,
            command: check.command,
            timeout: check.timeout,
            builtIn: check.builtIn ?? null,
            state: check.state,
          })),
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(id)
    },
    checkSlotBoundary(checkRunId, boundary, at) {
      const run = requireCheckRun(checkRunId)
      const event = {
        entered: events.checkSlotEntered,
        acquired: events.checkSlotAcquired,
        canceled: events.checkSlotCanceled,
        interrupted: events.checkSlotInterrupted,
        recovered: events.checkSlotRecoveryRecorded,
      }[boundary]
      commit(event({ taskId: run.taskId, checkRunId, stage: run.stage, trigger: run.trigger, at }))
      updatedCheckRun(checkRunId)
    },
    checkTiming(id) {
      const row = store.query(queryDb(checkRuns.where({ id }))).at(0)
      return row && toCheckRun(row).timing
    },
    listCheckTimings(taskId) {
      return checkRunRows(taskId).map((row) => toCheckRun(row).timing as CheckRunTiming)
    },
    checkInterrupted(checkRunId, position) {
      const run = requireCheckRun(checkRunId)
      commit(
        events.checkExecutionInterrupted({
          taskId: run.taskId,
          checkRunId,
          position,
          at: new Date().toISOString(),
        }),
      )
      updatedCheckRun(checkRunId)
    },
    checkKilledForMemory(checkRunId, position, { lowestMemory, durationMs }) {
      const run = requireCheckRun(checkRunId)
      const check = run.checks[position]
      if (!check) throw new Error(`Check run ${checkRunId} has no Check ${position}`)
      commit(
        events.checkKilledForMemory({
          taskId: run.taskId,
          checkRunId,
          position,
          name: checkLabel(check),
          stage: run.stage,
          lowestMemory,
          durationMs,
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(checkRunId)
    },
    checkStarted(checkRunId, position) {
      commit(events.checkStarted({ checkRunId, position, at: new Date().toISOString() }))
      return updatedCheckRun(checkRunId)
    },
    checkFinished(checkRunId, position, { state, exitCode, durationMs }) {
      commit(
        events.checkFinished({
          checkRunId,
          position,
          state,
          exitCode: exitCode ?? null,
          durationMs,
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(checkRunId)
    },
    finishChecks(checkRunId, outcome) {
      commit(events.checksFinished({ checkRunId, outcome, at: new Date().toISOString() }))
      return updatedCheckRun(checkRunId)
    },
    getCheckRun(id) {
      const row = store.query(queryDb(checkRuns.where({ id }))).at(0)
      return row && toCheckRun(row)
    },
    listCheckRuns: (taskId) => checkRunRows(taskId).map(toCheckRun),
    resetSendBacks(taskId, stage) {
      commit(
        events.sendBackCountReset({
          id: randomUUID(),
          taskId,
          stage,
          at: new Date().toISOString(),
        }),
      )
    },
    sendBackCount(taskId, stage) {
      const since = store
        .query(queryDb(sendBackResets.where({ taskId, stage }).orderBy('at', 'asc')))
        .at(-1)?.at
      return store
        .query(queryDb(sendBacks.where({ taskId, fromStage: stage, counted: true })))
        .filter((row) => since === undefined || row.at > since).length
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    startRun({
      taskId,
      sessionId,
      model,
      effort,
      permissions = 'auto',
      parentRunId,
      name,
      prompt,
      shared = [],
      ...input
    }) {
      const instructions = store
        .query(queryDb(subAgentInstructions.select('text').where({ id: input.id })))
        .at(0)
      const { parts, texts } = splitPrompt(
        prompt,
        shared,
        instructions === undefined ? undefined : { id: input.id, text: instructions },
      )
      const row = {
        ...input,
        sessionId: sessionId ?? '',
        taskId: taskId ?? null,
        model: model ?? null,
        effort: effort ?? null,
        parentRunId: parentRunId ?? null,
        name: name ?? null,
        startedAt: new Date().toISOString(),
      }
      const unseen = [...texts].filter(([hash]) => promptText(hash) === undefined)
      commit(
        ...unseen.map(([hash, text]) => events.promptTextSeen({ hash, text, at: row.startedAt })),
        events.runStartedV5({ ...row, promptParts: parts }),
        events.runPermissionsSet({ runId: row.id, permissions, at: row.startedAt }),
      )
      observedRuns.add(row.id)
      const run = toRun({
        ...row,
        retrying: false,
        steeringRelease: null,
        usesDefaultModel: false,
        problem: null,
        problemAt: null,
        failure: null,
        permissions,
        manualPermissions: false,
        state: 'working',
        readOffset: 0,
        lastOutputAt: null,
        revivedAt: null,
        ended: null,
      })
      emit({ type: 'run-updated', run })
      if (taskId !== undefined) updatedTask(taskId)
      noteActivity()
      return run
    },
    runPrompt(runId) {
      const row = store
        .query(queryDb(runs.select('prompt', 'promptParts').where({ id: runId })))
        .at(0)
      if (row === undefined) return ''
      if (row.promptParts === null) return row.prompt
      return joinPrompt(JSON.parse(row.promptParts) as PromptPart[], promptText, (id) =>
        store.query(queryDb(subAgentInstructions.select('text').where({ id }))).at(0),
      )
    },
    failRun(runId, error) {
      commit(events.runFailed({ runId, error, at: new Date().toISOString() }))
      const row = runRow(runId)
      if (row) emit({ type: 'run-updated', run: toRun(row) })
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
    },
    requestSubAgent({ model, effort, ...request }) {
      const at = new Date().toISOString()
      commit(
        events.subAgentRequestedV2({
          ...request,
          model: model ?? null,
          effort: effort ?? null,
          at,
        }),
      )
      updatedTask(request.taskId)
      return {
        ...request,
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
        at,
      }
    },
    subAgentRequests: (taskId) =>
      store
        .query(
          queryDb(
            (taskId === undefined ? subAgentRequests : subAgentRequests.where({ taskId })).orderBy(
              'at',
              'asc',
            ),
          ),
        )
        .map(toSubAgentRequest),
    dropSubAgentRequest(id) {
      const row = store.query(queryDb(subAgentRequests.where({ id }))).at(0)
      if (!row) return
      commit(events.subAgentRequestDropped({ id, at: new Date().toISOString() }))
      updatedTask(row.taskId)
    },
    chooseReviewer({ unavailable, ...reviewer }) {
      const at = new Date().toISOString()
      commit(events.reviewerChosen({ ...reviewer, unavailable: unavailable ?? null, at }))
      return { ...reviewer, ...(unavailable !== undefined && { unavailable }), at }
    },
    reviewerOf: (runId) => {
      const row = store.query(queryDb(reviewers.where({ runId }))).at(0)
      return row && toReviewer(row)
    },
    reviewers: (taskId) =>
      store.query(queryDb(reviewers.where({ taskId }).orderBy('at', 'asc'))).map(toReviewer),
    recordReviewScope({ since, ...scope }) {
      const at = new Date().toISOString()
      commit(events.reviewScopeRecorded({ ...scope, since: since ?? null, at }))
      return { ...scope, ...(since !== undefined && { since }), at }
    },
    reviewScopes: (taskId) =>
      store
        .query(queryDb(reviewScopes.where({ taskId }).orderBy('at', 'asc')))
        .map(({ commits, since, ...row }) => ({
          ...row,
          scope: row.scope as ReviewScope['scope'],
          commits: JSON.parse(commits) as RepoCommit[],
          ...(since !== null && { since: JSON.parse(since) as RepoCommit[] }),
        })),
    judgeValidate({ taskId, outcome, checkRunId, review, visual, reviewer }) {
      const judged = (j: { passed: boolean; notes?: number } | undefined) =>
        j === undefined ? null : { passed: j.passed, notes: j.notes ?? null }
      commit(
        events.validateJudgedV2({
          id: randomUUID(),
          taskId,
          outcome,
          checkRunId: checkRunId ?? null,
          validation:
            outcome === 'passed'
              ? JSON.stringify({
                  progress: failureStore.progress(taskId),
                  failures: failureStore.list(taskId).filter((failure) => failure.validation),
                })
              : null,
          review: judged(review),
          visual: judged(visual),
          reviewer:
            reviewer === undefined
              ? null
              : { agent: reviewer.agent, unavailable: reviewer.unavailable ?? null },
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    startLoopCheck({ checkRunId, limit, ...check }) {
      const at = new Date().toISOString()
      commit(
        events.loopCheckStarted({
          ...check,
          checkRunId: checkRunId ?? null,
          limit: limit ?? null,
          at,
        }),
      )
      updatedTask(check.taskId)
      return {
        ...check,
        ...(checkRunId !== undefined && { checkRunId }),
        ...(limit !== undefined && { limit }),
        at,
      }
    },
    finishLoopCheck(runId, verdict, reason) {
      const row = store.query(queryDb(loopChecks.where({ runId }))).at(0)
      if (!row || row.verdict !== null) return
      commit(
        events.loopCheckFinished({
          runId,
          taskId: row.taskId,
          verdict,
          reason,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(row.taskId)
    },
    loopChecks: (taskId) =>
      store
        .query(
          queryDb(
            (taskId === undefined ? loopChecks : loopChecks.where({ taskId })).orderBy('at', 'asc'),
          ),
        )
        .map(toLoopCheck),
    askAboutSendBack({ checkRunId, ...ask }) {
      const at = new Date().toISOString()
      commit(
        events.sendBackAsked({ ...ask, checkRunId: checkRunId ?? null, at }),
        events.commentPurposeRecorded({
          commentId: ask.commentId,
          purpose: JSON.stringify({ kind: 'send-back' }),
        }),
      )
      return { ...ask, ...(checkRunId !== undefined && { checkRunId }), at }
    },
    sendBackAsk: (commentId) => {
      const row = store.query(queryDb(sendBackAsks.where({ commentId }))).at(0)
      return row && toSendBackAsk(row)
    },
    sendBackAsks: (taskId) =>
      store.query(queryDb(sendBackAsks.where({ taskId }).orderBy('at', 'asc'))).map(toSendBackAsk),
    setOnSubAgents(runId, on) {
      if (waitingOnSubAgents.has(runId) === on) return
      stateCommits += 1
      if (on) waitingOnSubAgents.add(runId)
      else waitingOnSubAgents.delete(runId)
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
      noteActivity()
    },
    onSubAgents: (runId) => waitingOnSubAgents.has(runId),
    reconcileRunState(runId) {
      if (observedRuns.has(runId)) return
      const run = runRow(runId)
      if (!run || run.state === 'finished') return
      commit(events.runStateObserved({ runId, state: run.state, at: new Date().toISOString() }))
      observedRuns.add(runId)
    },
    recordRunOutput(
      runId,
      {
        toOffset,
        output,
        state,
        sessionId,
        problem,
        permissionPrompts = [],
        closedPermissions = [],
        autoModeUnavailable,
        agentRestarted,
        ending,
        memoryKilled,
        retrying,
      },
    ) {
      const current = runRow(runId)
      if (!current) throw new Error(`no Run ${runId}`)
      const at = new Date().toISOString()
      const taskId = current.taskId
      const asked =
        taskId === null
          ? []
          : permissionPrompts.map((prompt) => askedEvent(taskId, runId, prompt, at))
      const answeredAtOnce = asked.flatMap(({ id }, index) =>
        state === 'finished'
          ? [{ id, answer: { kind: 'withdrawn', at, runStopped: true } as CommentAnswer }]
          : closedPermissions.includes(permissionPrompts[index]?.requestId ?? '')
            ? [{ id, answer: { kind: 'withdrawn', at, cancelled: true } as CommentAnswer }]
            : [],
      )
      const withdrawn = [
        ...closedPermissions.flatMap((requestId) =>
          openPermissionRows(runId, requestId).map((row) => ({
            id: row.id,
            answer: { kind: 'withdrawn', at, cancelled: true } as CommentAnswer,
          })),
        ),
        ...(state === 'finished' || agentRestarted
          ? openPermissionRows(runId).map((row) => ({
              id: row.id,
              answer: { kind: 'withdrawn', at, runStopped: true } as CommentAnswer,
            }))
          : []),
      ]
      withdrawn.push(...answeredAtOnce)
      const withdrawnOnce = withdrawn.filter(
        ({ id }, index) => withdrawn.findIndex((w) => w.id === id) === index,
      )
      const unavailable =
        autoModeUnavailable === true && current.permissions === 'auto' && !current.manualPermissions
      const newProblem = problem !== undefined && current.problem === null
      const holding = (current.problem !== null || newProblem) && state === 'idle'
      const target = holding ? 'waiting' : state
      const stateChanged = target !== undefined && target !== current.state
      const nowRetrying = state === 'finished' ? false : (retrying ?? current.retrying)
      const retryChanged = nowRetrying !== current.retrying
      const held = heldOutput.get(runId)
      const lastOutputAt = output ? (output.lastAt ?? at) : held?.lastOutputAt
      const changes = [
        ...(sessionId !== undefined && sessionId !== current.sessionId
          ? [events.runSessionIdentified({ runId, sessionId })]
          : []),
        ...(newProblem ? [events.runProblemFound({ runId, problem, at })] : []),
        ...(retryChanged ? [events.runRetryingChanged({ runId, retrying: nowRetrying, at })] : []),
        ...(ending ? [events.runEnded({ runId, ending: JSON.stringify(ending), at })] : []),
        ...(ending && memoryKilled
          ? [
              events.runKilledForMemory({
                runId,
                taskId,
                lowestMemory: memoryKilled.lowestMemory,
                at,
              }),
            ]
          : []),
        ...(stateChanged && target !== undefined
          ? [events.runStateChanged({ runId, state: target, at })]
          : []),
        ...(unavailable ? [events.runAutoModeUnavailable({ runId, taskId, at })] : []),
        ...asked.flatMap(({ id, event }) => [
          event,
          events.commentPurposeRecorded({
            commentId: id,
            purpose: JSON.stringify({ kind: 'permission' }),
          }),
        ]),
        ...withdrawnOnce.map(({ id, answer }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      ]
      if (changes.length === 0) {
        heldOutput.set(runId, { toOffset, ...(lastOutputAt !== undefined && { lastOutputAt }) })
        if (output) emit({ type: 'run-output', runId, lines: true })
        return false
      }
      waitingUnchanged = asked.length === 0 && withdrawnOnce.length === 0
      try {
        commit(
          events.runOutputReadV3({ runId, toOffset, lastOutputAt: lastOutputAt ?? null }),
          ...changes,
        )
      } finally {
        waitingUnchanged = false
      }
      heldOutput.delete(runId)
      if (output) emit({ type: 'run-output', runId, lines: true })
      for (const { id } of asked) emit({ type: 'comment-posted', comment: requireComment(id) })
      for (const { id } of withdrawnOnce) emitComment(id)
      if (asked.length > 0 || withdrawnOnce.length > 0 || retryChanged) {
        if (taskId !== null && !(newProblem || stateChanged)) updatedTask(taskId)
      }
      if (newProblem || stateChanged || unavailable) {
        const row = runRow(runId)
        if (row) emit({ type: 'run-updated', run: toRun(row) })
        const taskId = taskIdOfRun(runId)
        if (taskId !== undefined) updatedTask(taskId)
      }
      if (stateChanged) {
        observedRuns.add(runId)
        noteActivity()
      }
      return true
    },
    holdRunOutput(runId, { from, toOffset, lastOutputAt }) {
      if (runRow(runId)?.readOffset !== from || toOffset <= from) return
      heldOutput.set(runId, { toOffset, ...(lastOutputAt !== undefined && { lastOutputAt }) })
    },
    savedReadOffset: (id) => runRow(id)?.readOffset ?? 0,
    setRunPermissions(runId, permissions) {
      const row = runRow(runId)
      if (!row || row.permissions === permissions) return
      commit(events.runPermissionsSet({ runId, permissions, at: new Date().toISOString() }))
      emit({ type: 'run-updated', run: toRun(runRow(runId) ?? row) })
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
    },
    setLiveTokens(runId, tokens) {
      if (liveTokens.get(runId) === tokens) return
      if (tokens === undefined) liveTokens.delete(runId)
      else liveTokens.set(runId, tokens)
      stateCommits += 1
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined && taskRow(taskId)) updatedTask(taskId)
    },
    setRunAsleep(runId, asleep) {
      if (asleepRuns.has(runId) === asleep) return
      if (asleep) asleepRuns.add(runId)
      else asleepRuns.delete(runId)
      const row = runRow(runId)
      if (row) emit({ type: 'run-updated', run: toRun(row) })
    },
    restartRun(runId, { model, effort, usesDefaultModel = false }) {
      const at = new Date().toISOString()
      const withdrawn = openPermissionRows(runId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, runStopped: true }
      commit(
        events.runRestarted({
          runId,
          model: model ?? null,
          effort: effort ?? null,
          usesDefaultModel,
          at,
        }),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const row = runRow(runId)
      if (!row) throw new Error(`no Run ${runId}`)
      const run = toRun(row)
      emit({ type: 'run-updated', run })
      const taskId = taskIdOfRun(runId)
      noteActivity()
      if (taskId !== undefined) updatedTask(taskId)
      return run
    },
    reviveRun(runId, flags) {
      const at = new Date().toISOString()
      commit(
        ...(flags
          ? [
              events.runRestarted({
                runId,
                model: flags.model ?? null,
                effort: flags.effort ?? null,
                usesDefaultModel: flags.usesDefaultModel ?? false,
                at,
              }),
            ]
          : []),
        events.runRevived({ runId, taskId: taskIdOfRun(runId) ?? null, at }),
      )
      const row = runRow(runId)
      if (!row) throw new Error(`no Run ${runId}`)
      const run = toRun(row)
      emit({ type: 'run-updated', run })
      const taskId = taskIdOfRun(runId)
      noteActivity()
      if (taskId !== undefined) updatedTask(taskId)
      return run
    },
    lastOutputAt: (runId) =>
      heldOutput.get(runId)?.lastOutputAt ?? runRow(runId)?.lastOutputAt ?? undefined,
    getRun(id) {
      const row = runRow(id)
      return row && toRun(row)
    },
    permissionTarget(commentId) {
      const row = store.query(queryDb(comments.where({ id: commentId }))).at(0)
      if (!row?.permission || row.authorRunId === null) return undefined
      const { requestId, generation, command, input } = storedPermission(row.permission)
      return {
        runId: row.authorRunId,
        requestId,
        generation: generation ?? 1,
        command,
        ...(input !== undefined && { input: JSON.parse(input) as unknown }),
      }
    },
    answerPermission(commentId, answer) {
      const row = store.query(queryDb(comments.where({ id: commentId }))).at(0)
      const runId = row?.authorRunId ?? undefined
      const run = runId === undefined ? undefined : runRow(runId)
      const othersOpen =
        runId === undefined
          ? false
          : openPermissionRows(runId).some((other) => other.id !== commentId)
      const resume =
        run !== undefined && run.state === 'waiting' && run.problem === null && !othersOpen
      commit(
        events.commentAnswered({ id: commentId, answer: JSON.stringify(answer), at: answer.at }),
        ...(resume && run
          ? [events.runStateChanged({ runId: run.id, state: 'working', at: answer.at })]
          : []),
      )
      if (resume && run) {
        const updated = runRow(run.id)
        if (updated) emit({ type: 'run-updated', run: toRun(updated) })
        noteActivity()
      }
      const comment = emitComment(commentId)
      updatedTask(comment.taskId)
      return comment
    },
    runProblemAt: (runId) => runRow(runId)?.problemAt ?? undefined,
    listRuns: () => store.query(allRuns).map(toRun),
    liveRuns: () => store.query(liveRuns).map(toRun),
    busyTaskIds: () => [
      ...store.query(queryDb(runRows.where({ state: 'working' }))).flatMap((r) => r.taskId ?? []),
      ...store.query(queryDb(taskRepos.where({ setupState: 'running' }))).map((r) => r.taskId),
    ],
    tasksIn: (ids) => {
      const reads = ids.size > readEveryTaskFrom ? taskReads(true) : undefined
      return store
        .query(allTasks)
        .filter((row) => ids.has(row.id))
        .map((row) => toPublicTask(toTask(row, false, reads)))
    },
    preparedTasks: () =>
      store
        .query(allTasks)
        .filter((row) => row.preparation === 'ready' && row.archivedAt === null)
        .map((row) => row.id),
    backlogTasks: () =>
      store
        .query(allTasks)
        .filter((row) => row.stage === 'backlog' && row.archivedAt === null)
        .map((row) => ({ id: row.id, snoozed: Boolean(row.snoozedUntil) })),
    unarchivedTaskRepos: () =>
      store
        .query(allTasks)
        .filter((row) => row.archivedAt === null)
        .map((row) => ({ id: row.id, stage: row.stage as StageId, repos: reposOf(row.id) })),
    taskOutlines: () =>
      store.query(allTasks).map((row) => ({
        id: row.id,
        factoryId: row.factoryId,
        stage: row.stage as StageId,
        archived: row.archivedAt !== null,
        setup: row.setup,
      })),
    factoryOfTask: (taskId) => taskRow(taskId)?.factoryId,
    taskVersion: () => stateCommits,
    taskBuilds: () => taskBuilds,
    sourcedTaskIds: () => store.query(queryDb(taskSources)).map((row) => row.taskId),
    taskSourceUrls: () =>
      store.query(queryDb(taskSources)).map(({ taskId, url }) => ({ taskId, url })),
    taskPullRequestUrls: (taskId) =>
      reposOf(taskId).flatMap((repo) =>
        repo.pullRequest && !repo.removed ? [repo.pullRequest.url] : [],
      ),
    runReadOffset: (id) => Math.max(runRow(id)?.readOffset ?? 0, heldOutput.get(id)?.toOffset ?? 0),
    recordRunUsage({ runId, agent, model, input, output, cost }) {
      commit(
        events.runUsageRecorded({
          runId,
          agent,
          model: model ?? null,
          input,
          output,
          cost: cost ?? null,
          at: new Date().toISOString(),
        }),
      )
      const row = runRow(runId)
      if (row) emit({ type: 'run-updated', run: toRun(row) })
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined && taskRow(taskId)) updatedTask(taskId)
    },
    apiCost(days, now = new Date()) {
      const since = new Date(now.getTime() - days * 86_400_000).toISOString()
      const rows = store.query(queryDb(runUsage.orderBy('at', 'asc')))
      const agents = new Map<AgentKind, AgentApiCost>()
      for (const row of rows) {
        if (row.at < since) continue
        const agent = row.agent as AgentKind
        const sum = agents.get(agent) ?? {
          agent,
          runs: 0,
          pricedRuns: 0,
          cost: 0,
          input: 0,
          output: 0,
        }
        sum.runs += 1
        sum.input += row.input
        sum.output += row.output
        if (row.cost !== null) {
          sum.pricedRuns += 1
          sum.cost += row.cost
        }
        agents.set(agent, sum)
      }
      const first = rows[0]?.at
      return {
        days,
        since,
        ...(first !== undefined && { countedFrom: first }),
        agents: [...agents.values()],
      }
    },
    taskRunList: (taskId) => taskRuns(taskId).map(toRun),
    recordRunMessage({ runId, text, lead }) {
      const taskId = taskIdOfRun(runId) ?? null
      const message = { id: randomUUID(), runId, text, at: new Date().toISOString() }
      commit(events.runMessageSent({ ...message, taskId, lead: lead && taskId !== null }))
      emit({ type: 'run-output', runId })
      if (taskId !== null && lead) updatedTask(taskId)
      return message
    },
    queueRunMessage({ runId, text, from }) {
      const taskId = taskIdOfRun(runId) ?? null
      const message = { id: randomUUID(), runId, text, at: new Date().toISOString() }
      commit(
        from === 'ted'
          ? events.runMessageQueuedV2({ ...message, taskId, from })
          : events.runMessageQueued({ ...message, taskId }),
      )
      emit({ type: 'run-output', runId })
      return { ...message, queued: true, ...(from && { from }) }
    },
    deliverRunMessages(runId, ids, lead) {
      if (ids.length === 0) return
      const taskId = taskIdOfRun(runId) ?? null
      const at = new Date().toISOString()
      commit(
        ...ids.map((id) =>
          events.runMessageDelivered({ id, runId, taskId, lead: lead && taskId !== null, at }),
        ),
      )
      emit({ type: 'run-output', runId })
      if (taskId !== null && lead) updatedTask(taskId)
    },
    deleteRunMessage(runId, id) {
      const row = store.query(queryDb(runMessages.where({ id, runId }))).at(0)
      if (!row?.queued) return undefined
      commit(events.runMessageDeleted({ id, runId, at: new Date().toISOString() }))
      emit({ type: 'run-output', runId })
      return { id, runId, text: row.text, at: row.at }
    },
    releaseRunSteering(runId, release) {
      commit(events.runSteeringReleased({ runId, release: JSON.stringify(release) }))
    },
    runSteeringRelease(runId) {
      const release = runRow(runId)?.steeringRelease
      return release ? (JSON.parse(release) as RunSteeringRelease) : undefined
    },
    recordTurnInterrupted(runId, hold) {
      const taskId = taskIdOfRun(runId) ?? null
      const interrupt = { id: randomUUID(), runId, hold, at: new Date().toISOString() }
      commit(events.runTurnInterrupted({ ...interrupt, taskId }))
      emit({ type: 'run-output', runId })
      return interrupt
    },
    runMessages: (runId) =>
      store
        .query(queryDb(runMessages.where({ runId, deletedAt: null }).orderBy('at', 'asc')))
        .map(({ id, text, at, queued, fromTed }) => ({
          id,
          runId,
          text,
          at,
          ...(queued && { queued }),
          ...(fromTed && { from: 'ted' as const }),
        })),
    runInterrupts: (runId) =>
      store
        .query(queryDb(runInterrupts.where({ runId }).orderBy('at', 'asc')))
        .map(({ id, hold, at }) => ({ id, runId, hold, at })),
    openTab(taskId, runId) {
      const at = new Date().toISOString()
      if (store.query(queryDb(conversationTabs.where({ id: `${taskId}:${runId}` }))).length === 0) {
        commit(events.conversationTabOpened({ taskId, runId, at }))
      }
      return updatedTask(taskId)
    },
    closeTab(taskId, runId) {
      if (store.query(queryDb(conversationTabs.where({ id: `${taskId}:${runId}` }))).length > 0) {
        commit(events.conversationTabClosed({ taskId, runId, at: new Date().toISOString() }))
      }
      return updatedTask(taskId)
    },
    settings,
    activity,
    waiting,
    snoozed,
    snoozeRequest(requestId, until) {
      const request = openRequests().find((r) => r.id === requestId)
      if (!request) return undefined
      const at = new Date().toISOString()
      const ownerId =
        request.source === 'task'
          ? request.taskId
          : request.source === 'plan'
            ? request.planId
            : request.source === 'coordinator'
              ? request.chatId
              : request.automationId
      commit(
        until === null
          ? events.requestSnoozeCleared({ requestId, at })
          : events.requestSnoozed({
              requestId,
              ownerId,
              factoryId: request.factoryId,
              until,
              at,
            }),
      )
      if (request.source === 'task') updatedTask(request.taskId)
      return until === null ? request : { ...request, snoozedUntil: until }
    },
    returnDueRequests(now) {
      const due = store
        .query(queryDb(requestSnoozes.select()))
        .filter((row) => Date.parse(row.until) <= now)
      if (due.length === 0) return []
      const at = new Date().toISOString()
      commit(...due.map((row) => events.requestSnoozeCleared({ requestId: row.requestId, at })))
      for (const ownerId of new Set(due.map((row) => row.ownerId))) {
        if (taskRow(ownerId)) updatedTask(ownerId)
      }
      return due.map((row) => row.requestId)
    },
    requestSnoozesPending: () => store.query(queryDb(requestSnoozes.select())).length > 0,
    setQueueActivity(value) {
      const before = new Map(queueActivity.taskPlaces?.map((entry) => [entry.id, entry.place]))
      const after = new Map(value.taskPlaces?.map((entry) => [entry.id, entry.place]))
      queueActivity = value
      const moved = [...new Set([...before.keys(), ...after.keys()])].filter(
        (id) => before.get(id) !== after.get(id),
      )
      if (moved.length > 0) stateCommits += 1
      updatedTasks(moved)
      noteActivity()
    },
    setShellsRunning(count) {
      shellsRunning = count
      noteActivity()
    },
    setAsanaConnection(account) {
      if (asanaConnection.known && asanaConnection.account === account) return
      asanaConnection = { known: true, ...(account !== undefined && { account }) }
      updatedTasks(asanaTaskIds())
    },
    asanaAccount() {
      return asanaConnection.known ? asanaConnection.account : undefined
    },
    setAsanaOpenChildren(taskId, count) {
      if (asanaOpenChildren.get(taskId) === count) return
      if (count === undefined) asanaOpenChildren.delete(taskId)
      else asanaOpenChildren.set(taskId, count)
      if (taskRow(taskId)) updatedTask(taskId)
    },
    setAsanaLeftOpen(taskId, leftOpen) {
      if (asanaLeftOpen.has(taskId) === leftOpen) return
      if (leftOpen) asanaLeftOpen.add(taskId)
      else asanaLeftOpen.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
    },
    checkWork,
    setScheduledChecks(counts) {
      if (counts.running === scheduledChecks.running && counts.waiting === scheduledChecks.waiting)
        return
      scheduledChecks = counts
      noteActivity()
    },
    updateSettings(changes) {
      const current = settings()
      const changed = Object.fromEntries(
        Object.entries(changes).filter(
          ([name, value]) =>
            value !== undefined && current[name as keyof MachineSettings] !== value,
        ),
      )
      if (Object.keys(changed).length > 0) {
        commit(
          events.machineSettingsChanged({
            changes: JSON.stringify(changed),
            at: new Date().toISOString(),
          }),
        )
        emit({ type: 'settings-changed', settings: settings() })
        if (changes.enabledAgents) {
          updatedQueue()
          for (const held of store.query(queryDb(heldRuns))) updatedTask(held.taskId)
        }
        if ('overnightMode' in changed) for (const row of store.query(allTasks)) updatedTask(row.id)
        else if ('asanaSync' in changed) updatedTasks(asanaTaskIds())
      }
      return settings()
    },
    raiseBanner({ id, problem, severity, factoryId, text, action }) {
      const current = bannerRow(id)
      const actionJson = action === undefined ? null : JSON.stringify(action)
      if (
        current &&
        current.severity === severity &&
        current.text === text &&
        current.action === actionJson
      ) {
        return toBanner(current)
      }
      commit(
        events.bannerRaised({
          id,
          problem,
          severity,
          factoryId: factoryId ?? null,
          text,
          action: actionJson,
          at: new Date().toISOString(),
        }),
      )
      const banner = requireBanner(id)
      emit({ type: current ? 'banner-updated' : 'banner-raised', banner })
      return banner
    },
    dismissBanner(id, until) {
      if (!bannerRow(id)) return undefined
      commit(events.bannerDismissed({ id, until, at: new Date().toISOString() }))
      const banner = requireBanner(id)
      emit({ type: 'banner-updated', banner })
      return banner
    },
    clearBanner(id) {
      if (!bannerRow(id)) return
      commit(events.bannerCleared({ id, at: new Date().toISOString() }))
      emit({ type: 'banner-cleared', id })
    },
    getBanner,
    listBanners: () => store.query(queryDb(banners)).map(toBanner).sort(bannerOrder),
    pauseAgent(agent, reason) {
      const current = pauses()[agent]
      if (current === reason) return
      const at = new Date().toISOString()
      commit(
        reason === undefined
          ? events.agentResumed({ agent, at })
          : events.agentPaused({ agent, reason, at }),
      )
      const affected = new Set([
        ...store
          .query(queryDb(runRows.where({ agent })))
          .filter((r) => r.state !== 'finished' && r.taskId !== null)
          .map((r) => r.taskId as string),
        ...store.query(queryDb(heldRuns.where({ agent }))).map((h) => h.taskId),
        ...queue()
          .filter((q) => taskRow(q.id)?.leadAgent === agent)
          .map((q) => q.id),
      ])
      for (const taskId of affected) updatedTask(taskId)
      noteActivity()
    },
    agentPauses: pauses,
    holdTaskRun({ taskId, agent, sessionId }) {
      const current = heldRow(taskId)
      if (current && current.agent === agent && (current.sessionId ?? undefined) === sessionId) {
        return
      }
      commit(
        events.taskRunHeld({
          taskId,
          agent,
          sessionId: sessionId ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
      noteActivity()
    },
    releaseTaskRun(taskId) {
      if (!heldRow(taskId)) return
      commit(events.taskRunReleased({ taskId, at: new Date().toISOString() }))
      updatedTask(taskId)
      noteActivity()
    },
    heldRuns: () =>
      store.query(queryDb(heldRuns.orderBy('at', 'asc'))).map((row) => ({
        taskId: row.taskId,
        agent: row.agent as AgentKind,
        ...(row.sessionId !== null && { sessionId: row.sessionId }),
      })),
    pausedRunCount: (agent) =>
      store.query(queryDb(runRows.where({ agent }))).filter((r) => r.state !== 'finished').length +
      store.query(queryDb(heldRuns.where({ agent }))).length,
    exportEventlog: () => ({
      fileName: eventlogName,
      data: Effect.runSync(store[StoreInternalsSymbol].clientSession.leaderThread.getEventlogData),
    }),
    persisted,
    holdNewWork(reason) {
      if (reason === newWorkHeld) return
      newWorkHeld = reason
      stateCommits += 1
      updatedTasks(tasksWaitingForSlots())
    },
    newWorkHold: () => newWorkHeld,
    holdWhenBusy(held) {
      if (JSON.stringify(held) === JSON.stringify(heldBusy)) return
      heldBusy = held
      stateCommits += 1
      updatedTasks(tasksWaitingForSlots())
    },
    setTaskMovingAfterChecks(taskId, on) {
      if (movingAfterChecks.has(taskId) === on) return
      stateCommits += 1
      if (on) {
        if (!taskRow(taskId)) return
        movingAfterChecks.add(taskId)
      } else movingAfterChecks.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
    },
    setRunsStopping(taskId, runIds, on) {
      const changed = runIds.filter((id) => stoppingRuns.has(id) !== on)
      if (changed.length === 0) return
      stateCommits += 1
      for (const id of changed) {
        if (on) stoppingRuns.add(id)
        else stoppingRuns.delete(id)
      }
      if (taskRow(taskId)) updatedTask(taskId)
    },
    setTaskChecking(taskId, on) {
      if (checkingTasks.has(taskId) === on) return
      stateCommits += 1
      if (on) {
        if (!taskRow(taskId)) return
        checkingTasks.add(taskId)
      } else checkingTasks.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
      noteActivity()
    },
    setChecksWaiting(places) {
      const before = checksWaiting
      stateCommits += 1
      checksWaiting = new Map([...places].filter(([taskId]) => taskRow(taskId)))
      for (const taskId of new Set([...before.keys(), ...checksWaiting.keys()])) {
        if (before.get(taskId) === checksWaiting.get(taskId) || !taskRow(taskId)) continue
        const unfinished = checkRunRows(taskId).find((r) => r.finishedAt === null)
        if (unfinished) updatedCheckRun(unfinished.id)
        else updatedTask(taskId)
      }
      noteActivity()
    },
    onWriteResult(listener) {
      writeListeners.add(listener)
      return () => writeListeners.delete(listener)
    },
    close: async () => {
      if (shutDown) return
      try {
        commit(
          events.intervalObservationEnded({
            sessionId: observationSessionId,
            at: new Date().toISOString(),
          }),
        )
        await persisted()
      } finally {
        shutDown = true
        testInvocationStore.close()
        await store.shutdownPromise()
      }
    },
  }
}

const tedStopEntries = new Set([
  'v1.TaskStoppedByTed',
  'v1.TedStopAnswered',
  'v1.TaskStopped',
  'v1.TaskResumed',
  'v1.TaskResumedOvernight',
  'v1.TaskRetried',
])

function sequence(id: string): number {
  const [global = 0, client = 0] = id.split('.').map(Number)
  return global * 1_000_000 + client
}

function describeOpenError(error: unknown): string {
  let event: string | undefined
  let message = ''
  for (let at: unknown = error; at !== undefined && at !== null; ) {
    const current = at as { message?: unknown; note?: unknown; cause?: unknown }
    const note = typeof current.note === 'string' ? current.note : ''
    event ??= /event definition "([^"]+)"/.exec(note)?.[1]
    if (typeof current.message === 'string' && current.message.trim() !== '') {
      message = current.message
    }
    at = current.cause
  }
  const text = message.replace(/\s+/g, ' ').trim() || 'unknown error'
  return event ? `${event}: ${text}` : text
}

function track(stage: StageId, entries: readonly (typeof stageEntries.Type)[]): TrackStage[] {
  const saved = entries.findLast((e) => e.order !== null)?.order
  const plan: PlannedStage[] = saved
    ? (JSON.parse(saved) as PlannedStage[])
    : agentStageIds.filter((id) => !isCleanup(id)).map((id) => ({ stage: id, enabled: true }))
  const order: StageId[] = plan.map((p) => p.stage)
  const entered = new Set(entries.map((e) => e.stage))
  const inOrder = order.includes(stage)
  const rank = (id: StageId) =>
    inOrder ? order.indexOf(id) : compareStages(id, stage, order) < 0 ? -1 : 1
  const state = (id: StageId, enabled: boolean): TrackStage['state'] => {
    if (id === stage) return 'current'
    if (!enabled) return 'skipped'
    if (stage === 'backlog') return 'future'
    if (stage === 'done' || rank(id) < rank(stage)) return entered.has(id) ? 'past' : 'skipped'
    return 'future'
  }
  return plan.map(({ stage: id, enabled, name }) => ({
    stage: id,
    ...(name !== undefined && { name }),
    state: state(id, enabled),
  }))
}

function realPath(dir: string): string {
  const resolved = path.resolve(dir)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

interface StoredPermission {
  requestId: string
  generation?: number
  command: string
  details?: string
  repo?: string
  input?: string
}

function storedPermission(json: string): StoredPermission {
  return JSON.parse(json) as StoredPermission
}

function publicPermission(json: string): NonNullable<Comment['permission']> {
  const { command, details, repo } = storedPermission(json)
  return {
    command,
    ...(details !== undefined && { details }),
    ...(repo !== undefined && { repo }),
  }
}

function headlineOf(title: string | null, body: string): string {
  if (title !== null && title.trim() !== '') return title.trim()
  return (
    body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

function androidAsk(simulator: string): boolean {
  try {
    return (JSON.parse(simulator) as SimulatorAsk).platform === 'android'
  } catch {
    return false
  }
}

function withGroupAccount(
  current: MachineSettings['trackerSyncGroupAccounts'],
  tracker: string,
  factoryId: string,
  group: string,
  account: string,
): MachineSettings['trackerSyncGroupAccounts'] {
  const byFactory = current[tracker] ?? {}
  return {
    ...current,
    [tracker]: { ...byFactory, [factoryId]: { ...byFactory[factoryId], [group]: account } },
  }
}
