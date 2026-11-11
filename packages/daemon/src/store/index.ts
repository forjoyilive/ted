import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb, StoreInternalsSymbol } from '@livestore/livestore'
import type { NewTaskDraft, PeerMessage, TaskDraftState, TaskGateOverrides } from '@ted/protocol'
import {
  type Activity,
  type AgentKind,
  type AgentStageId,
  type Appearance,
  type AppStarter,
  type Attachment,
  agentStageIds,
  type Banner,
  type BannerAction,
  type BannerSeverity,
  type BaseConflictFound,
  type BlockerEnded,
  bannerOrder,
  type CheckResult,
  type CheckRun,
  type CheckRunOutcome,
  type CheckRunTrigger,
  type CheckState,
  type CiSignal,
  type ClarifyDepth,
  type ClarifyDepthChooser,
  type Comment,
  type CommentAnswer,
  type CommentAuthor,
  type CommentKind,
  type ConversationTab,
  type CopySkip,
  type CreatedBy,
  type DaemonEvent,
  type DescriptionVersion,
  type DesignReview,
  type DiffRow,
  defaultMachineSettings,
  type Effort,
  type Factory,
  type FailureCase,
  type FindingSeverity,
  failureChoices,
  type GitHubWait,
  type LayerKind,
  type LayerUse,
  type LinearTeam,
  type LineComment,
  type LineSide,
  type MachineSettings,
  type MergeMethod,
  type PermissionMode,
  type Priority,
  type Proposal,
  type PullRequestPreview,
  parseLinearUrl,
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
  type StageEntry,
  type StageId,
  type Task,
  type TaskBrief,
  type TaskEnding,
  type TaskLead,
  type TaskPullRequest,
  type TaskRepo,
  type TaskSource,
  type TrackStage,
  validateFailureChoices,
  type WaitingRequest,
  type WorktreeCommandOutcome,
} from '@ted/protocol'
import { Effect } from 'effect'
import { isDiskFullError } from '../disk.ts'
import { type QueueEntry, queueOrder } from '../tasks/queue.ts'
import {
  commentBox,
  type TaskFacts,
  taskActivity,
  taskCanResume,
  taskMarkers,
  taskStatus,
  taskStatuses,
} from '../tasks/status.ts'
import { type AutomationDraftStore, createAutomationDraftStore } from './automation-drafts.ts'
import { type AutomationStore, createAutomationStore } from './automations.ts'
import { type CoordinatorStore, createCoordinatorStore } from './coordinators.ts'
import { createExecutionStore, type ExecutionStore } from './execution.ts'
import { createFailureStore, type FailureStore } from './failures.ts'
import { eventCount, eventlogFile, storeId } from './files.ts'
import { createPlanStore, type PlanStore } from './plans.ts'
import { countMaterialized } from './progress.ts'
import {
  agentPauses,
  automationComments,
  automations,
  automationTasks,
  banners,
  baseConflicts,
  checkResults,
  checkRuns,
  commentAttachments,
  comments,
  conversationTabs,
  coordinators,
  deletedTasks,
  events,
  factories,
  factoryOrder,
  factoryRepos,
  heldRuns,
  lineComments,
  localFolders,
  loopChecks,
  machineSettings,
  machineSettingValues,
  p1OnlyReviews,
  peerMessages,
  planRequests,
  plans,
  planTasks,
  pullRequests,
  reviewers,
  reviewScopes,
  runInterrupts,
  runMessages,
  runs,
  schema,
  sendBackAsks,
  sendBackResets,
  sendBacks,
  severityDeclarations,
  sideChats,
  stageEntries,
  stageFileTexts,
  subAgentRequests,
  taskAttachments,
  taskBlockers,
  taskBriefs,
  taskBrowserCaptures,
  taskDescriptions,
  taskDraftConsumptions,
  taskDrafts,
  taskLog,
  taskQueue,
  taskRepos,
  taskSources,
  tasks,
  workflowLayers,
} from './schema.ts'
import { createSideChatStore, type SideChatStore } from './side-chats.ts'
import { createTaskHistory, type TaskHistory } from './task-history.ts'

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
  retrying?: boolean
}

export interface LeadFailure {
  taskId: string
  runId: string
  reason: string
  recovery: 'resume' | 'fresh' | 'failed'
  resumeFailed: boolean
  ask?: { title: string; body: string }
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
  showTutorial: boolean
}

export interface StoredTask extends Task {
  pendingLeadMessages: { id: string; text: string }[]
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

export type StopReason = 'human' | 'blockers-removed'

export interface BlockerLink {
  blockerId: string
  displayId: string
  merged: boolean
  ended?: BlockerEnded
  setByRunId?: string
  at: string
}

export type AfterBlocking = 'backlog' | 'wait'

export interface NewTask {
  draftRevision?: string
  title: string
  factoryId?: string
  description?: string
  priority?: Priority
  clarifyDepth?: ClarifyDepth
  lead?: TaskLead
  startRequested?: boolean
  blockedBy?: string[]
  attachments?: Attachment[]
  source?: TaskSource
  followUpOf?: string
  forcedGates?: AgentStageId[]
  changesSettings?: boolean
  splitFrom?: string
  automation?: { automationId: string; firingId: string }
  plan?: { planId: string; row: number }
  setup?: boolean
  linearConsent?: boolean
}

export interface PlannedStage {
  stage: AgentStageId
  enabled: boolean
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

export interface NewComment {
  taskId: string
  body: string
  author: CommentAuthor
  kind?: CommentKind
  title?: string
  choices?: string[]
  round?: Round
  proposal?: Proposal
  sizeCheck?: SizeCheck
  gate?: NonNullable<Comment['gate']>
  attachments?: readonly Attachment[]
  lineComments?: readonly string[]
  design?: DesignReview
  tutorial?: boolean
  linearTeam?: LinearTeam
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
  addFactory(
    input: Pick<StoredFactory, 'key' | 'name' | 'repo' | 'cloneUrl' | 'defaultBranch'>,
  ): StoredFactory
  createFactory(input: NewFactory): StoredFactory
  factoryCloned(factoryId: string): StoredFactory
  listFactories(): StoredFactory[]
  getFactory(id: string): StoredFactory | undefined
  createTask(input: NewTask): Promise<Task>
  listTasks(): Task[]
  getTask(ref: string): StoredTask | undefined
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
  gateSkippedOvernight(taskId: string, stage: AgentStageId): void
  gateApprovalBound(taskId: string, commentId: string, name: string, commit: string): void
  gateRequestedFor(taskId: string, commentId: string, name: string, commit: string): void
  gateKeptOvernight(taskId: string, stage: AgentStageId, reason: 'settings' | 'unreadable'): void
  mergeCanceled(taskId: string, commentId: string): void
  mergePending(taskId: string): boolean
  isMerged(taskId: string): boolean
  setLocalFolder(repo: string, path: string): void
  clearLocalFolder(repo: string): void
  setFactoryAutoStartBacklog(factoryId: string, enabled: boolean): StoredFactory
  renameFactory(factoryId: string, name: string): StoredFactory
  reorderFactories(factoryIds: readonly string[]): StoredFactory[]
  removeFactory(factoryId: string): void
  changeFactoryRepos(factoryId: string, repos: StoredFactoryRepo[]): StoredFactory
  localFolder(repo: string): string | undefined
  queueTask(taskId: string, stage: StageId): Task
  moveToBacklog(taskId: string): Task
  needsPlanning(taskId: string, runId: string): Task
  startAfterPlanning(taskId: string, stage: StageId, entry: NewStageEntry): Task
  taskSplit(
    taskId: string,
    input: { pieceIds: string[]; narrowedTo: string; description: string },
  ): void
  taskPlanEnded(
    taskId: string,
    planId: string,
    outcome: 'approved' | 'stopped' | 'failed' | 'deleted',
  ): void
  rankTask(taskId: string, rank: number, priority: Priority): Task
  setPriority(taskId: string, priority: Priority): Task
  editTask(taskId: string, edit: { title?: string; description?: string }): Task
  descriptionVersions(taskId: string): DescriptionVersion[]
  archiveTask(taskId: string, record?: { closing: string[]; branches: number; why?: string }): Task
  unarchiveTask(taskId: string, input: { queue: boolean; waitForBlockers: boolean }): Task
  deleteTask(taskId: string): void
  blockedBy(blockerId: string): string[]
  queue(): QueuedTask[]
  dequeue(taskId: string): Task
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
  stopTask(taskId: string, input: { runs: number; why: StopReason }): Task
  resumeTask(taskId: string, options: { waitForBlockers: boolean }): Task
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
  requestSimulator(input: {
    taskId: string
    runId: string
    title: string
    body: string
    simulator: SimulatorAsk
  }): Comment
  leadFailed(failure: LeadFailure): Task
  retryTask(taskId: string, options: { waitForBlockers: boolean }): Task
  changeStage(taskId: string, stage: StageId, entry?: NewStageEntry): Task
  listStageEntries(taskId: string): StageEntry[]
  acceptWorkflowLayer(layer: string, accepted: Omit<AcceptedLayer, 'acceptedAt'>): void
  lastValidWorkflowLayer(layer: string): AcceptedLayer | undefined
  rememberStageFileText(seen: SeenStageFile): void
  seenStageFileText(hash: string): SeenStageFile | undefined
  setTaskLead(taskId: string, lead: TaskLead): Task
  setLeadRestartPending(taskId: string, pending: boolean): void
  holdLeadMessage(taskId: string, text: string): void
  deliveredLeadMessages(taskId: string, ids: readonly string[]): void
  setTaskGates(taskId: string, overrides: TaskGateOverrides): Task
  setClarifyDepth(
    taskId: string,
    input: { depth: ClarifyDepth; by: ClarifyDepthChooser; runId?: string; why?: string },
  ): Task
  setActivity(taskId: string, text: string, runId?: string): Task
  postComment(input: NewComment): Comment
  listComments(taskId: string): Comment[]
  taskFiles(taskId: string): Attachment[]
  recordBrowserCapture(taskId: string, attachment: Attachment): void
  browserCaptures(taskId: string): Attachment[]
  taskDraft(factoryId: string): TaskDraftState
  saveTaskDraft(factoryId: string, draft: NewTaskDraft): TaskDraftState
  removeTaskDraft(factoryId: string): void
  filesInUse(): Set<string>
  getComment(id: string): Comment | undefined
  answerComment(id: string, answer: CommentAnswer, lineComments?: readonly string[]): Comment
  draftLineComment(input: NewLineComment): LineComment
  editLineComment(id: string, body: string): LineComment
  deleteLineComments(taskId: string, ids: readonly string[]): void
  getLineComment(id: string): LineComment | undefined
  lineCommentDrafts(taskId: string): LineComment[]
  taskLineComments(taskId: string): LineComment[]
  commentsDelivered(ids: readonly string[], runId: string): void
  commentsRead(ids: readonly string[]): void
  holdAnswer(id: string): void
  startRoundTalk(id: string, runId: string): Comment
  roundTalkDone(id: string): Comment
  heldAnswers(taskId: string): Comment[]
  answersDelivered(ids: readonly string[], runId: string): void
  taskLog(taskId: string): LoggedEvent[]
  supersedeComment(id: string, input: NewComment): Comment
  listOpenRequests(): Comment[]
  listAnsweredRequests(): Comment[]
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
  }): Run
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
  recordRunOutput(runId: string, output: RunOutput): void
  permissionTarget(commentId: string): PermissionTarget | undefined
  answerPermission(commentId: string, answer: CommentAnswer): Comment
  setRunPermissions(runId: string, permissions: PermissionMode): void
  restartRun(runId: string, flags: RunFlags): Run
  reviveRun(runId: string, flags?: RunFlags): Run
  lastOutputAt(runId: string): string | undefined
  getRun(id: string): Run | undefined
  listRuns(): Run[]
  busyTaskIds(): string[]
  tasksIn(ids: ReadonlySet<string>): Task[]
  backlogTasks(): { id: string; snoozed: boolean }[]
  runReadOffset(id: string): number
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
  setShellsRunning(count: number): void
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
  holdForLoad(held: boolean): void
  setTaskChecking(taskId: string, on: boolean): void
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
  failures: FailureStore
  invalidateFailure(value: FailureCase, note: { title: string; body: string }): void
  postFailureDecision(value: FailureCase, body: string): FailureCase
  resolveFailure(
    value: FailureCase,
    commentId: string,
    answer: CommentAnswer,
    drafts: readonly string[],
  ): FailureCase
  plans: PlanStore
  close(): Promise<void>
}

function pick(values: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.includes(name)))
}

const persistTimeoutMs = 10_000

export type NewBanner = Omit<Banner, 'raisedAt' | 'dismissedUntil'>

export interface OpenProgress {
  done: number
  total: number
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
  let heldForLoad = false
  const waitingOnSubAgents = new Set<string>()
  const checkingTasks = new Set<string>()
  let checksWaiting: ReadonlyMap<string, number> = new Map()
  const tellWriters = (error?: unknown) => {
    for (const listener of writeListeners) listener(error)
  }
  let noteWaiting = () => {}
  let shutDown = false
  const commit = ((...args: unknown[]) => {
    try {
      const result = (store.commit as (...a: unknown[]) => unknown)(...args)
      noteWaiting()
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

  const internals = store[StoreInternalsSymbol]
  const persisted = async () => {
    const committed = Effect.runSync(internals.syncProcessor.syncState.get).localHead
    const deadline = Date.now() + persistTimeoutMs
    for (;;) {
      const written = Effect.runSync(internals.clientSession.leaderThread.syncState.get).localHead
      if (
        written.global > committed.global ||
        (written.global === committed.global && written.client >= committed.client)
      ) {
        return
      }
      if (Date.now() > deadline) throw new Error('the event log did not save in time')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  const allFactories = queryDb(factories.orderBy('createdAt', 'asc'))
  const allTasks = queryDb(tasks.orderBy('number', 'asc'))
  const allRuns = queryDb(runs.orderBy('startedAt', 'asc'))

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
      .map(({ row: { clonedAt, ...row } }, position) => ({
        ...row,
        position,
        repos: repos
          .filter((r) => r.factoryId === row.id)
          .map(({ repo, name, cloneUrl }) => ({ repo, name, cloneUrl })),
        ...(clonedAt !== null && { clonedAt }),
      }))
  }
  const requireFactory = (id: string) => {
    const found = listFactories().find((f) => f.id === id)
    if (!found) throw new Error(`no Factory ${id}`)
    return found
  }
  const factoryKey = (factoryId: string) =>
    factoryId === placeholderFactory.id
      ? placeholderFactory.key
      : (listFactories().find((f) => f.id === factoryId)?.key ?? '?')

  const runName = (run: typeof runs.Type) =>
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
    store.query(queryDb(runs.where({ taskId }).orderBy('startedAt', 'desc')))

  const pullRequestFields = (id: string): Partial<TaskRepo> => {
    const row = store.query(queryDb(pullRequests.where({ id }))).at(0)
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

  const toTaskRepo = (row: typeof taskRepos.Type): TaskRepo => ({
    ...pullRequestFields(row.id),
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

  const reposOf = (taskId: string) =>
    store.query(queryDb(taskRepos.where({ taskId }).orderBy('createdAt', 'asc'))).map(toTaskRepo)

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
    (taskId) => entryRows(taskId).findLast((e) => e.stage === 'merge')?.at ?? '',
  )

  const mergePendingFor = (taskId: string, repos: readonly TaskRepo[]): boolean =>
    repos.some((r) => !r.removed && r.pullRequest && r.pullRequest.state !== 'merged') &&
    history.mergeHistory(taskId).latest === 'started'

  const isMerged = (taskId: string): boolean =>
    taskRow(taskId)?.stage === 'done' &&
    store
      .query(queryDb(pullRequests.where({ taskId })))
      .every((row) => row.number === null || row.state === 'merged')

  const blockerRows = (taskId: string) =>
    store.query(queryDb(taskBlockers.where({ taskId }).orderBy('at', 'asc')))

  const blockersOf = (taskId: string) => blockerRows(taskId).map((row) => row.blockerId)

  const deletedRow = (id: string) => store.query(queryDb(deletedTasks.where({ id }))).at(0)

  const blockerOf = (id: string) => {
    const blocker = taskRow(id)
    if (blocker) {
      return {
        displayId: `${factoryKey(blocker.factoryId)}-${blocker.number}`,
        merged: isMerged(id),
        ...(blocker.archivedAt !== null && { ended: 'archived' as const }),
      }
    }
    const deleted = deletedRow(id)
    return {
      displayId: deleted ? `${factoryKey(deleted.factoryId)}-${deleted.number}` : id,
      merged: false,
      ended: 'deleted' as const,
    }
  }

  const blockerLinks = (taskId: string): BlockerLink[] =>
    blockerRows(taskId).map((row) => {
      const { displayId, merged, ended } = blockerOf(row.blockerId)
      return {
        blockerId: row.blockerId,
        displayId,
        merged,
        ...(ended !== undefined && { ended }),
        ...(row.setByRunId !== null && { setByRunId: row.setByRunId }),
        at: row.at,
      }
    })

  const commentFiles = (commentId: string): Attachment[] =>
    store
      .query(queryDb(commentAttachments.where({ commentId }).orderBy('position', 'asc')))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const attachmentsOf = (taskId: string): Attachment[] =>
    store
      .query(queryDb(taskAttachments.where({ taskId }).orderBy('at', 'asc')))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const browserCapturesOf = (taskId: string): Attachment[] =>
    store
      .query(queryDb(taskBrowserCaptures.where({ taskId })))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const sourceOf = (taskId: string): TaskSource | undefined => {
    const [row] = store.query(queryDb(taskSources.where({ taskId })))
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
    }
  }

  const entryRows = (taskId: string) =>
    store.query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc')))

  const pauses = (): Partial<Record<AgentKind, string>> =>
    Object.fromEntries(store.query(queryDb(agentPauses)).map((row) => [row.agent, row.reason]))

  const heldRow = (taskId: string) => store.query(queryDb(heldRuns.where({ taskId }))).at(0)

  const planTitleOf = (planId: string) =>
    store.query(queryDb(plans.where({ id: planId }))).at(0)?.title

  const planningFrom = (taskId: string) =>
    store
      .query(queryDb(plans.where({ fromTaskId: taskId })))
      .some((p) => p.state !== 'ended' && p.fromTaskGone === null)

  const toTask = ({
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
    failedAt,
    followUpOf,
    forcedGates,
    gateOverrides,
    changesSettings,
    splitFrom,
    needsPlanningAt,
    partlyMergedAt,
    setup,
    ...row
  }: typeof tasks.Type): StoredTask => {
    const stage = row.stage as StageId
    const all = taskRuns(row.id)
    const lead = all.find((r) => r.parentRunId === null)
    const live = all.filter((r) => r.state !== 'finished')
    const entries = entryRows(row.id)
    const blockedBy = blockersOf(row.id)
    const repos = reposOf(row.id)
    const unmerged = blockedBy.map(blockerOf).filter((b) => !b.merged)
    const waitingOn = unmerged.map((b) => b.displayId)
    const firstEnded = unmerged[0]?.ended
    const github =
      stage === 'merge'
        ? repos.find((r) => !r.removed && r.pullRequest?.waiting !== undefined)?.pullRequest
            ?.waiting
        : undefined
    const mergeWaits = stage === 'merge' && mergePendingFor(row.id, repos)
    const autoMergeLeft =
      stage === 'merge' &&
      !mergeWaits &&
      repos.some(
        (r) =>
          !r.removed && r.pullRequest?.autoMerge !== undefined && r.pullRequest.state !== 'merged',
      ) &&
      history.mergeHistory(row.id).canceledAt !== undefined
    const checking = checkRunRows(row.id).find((r) => r.finishedAt === null)
    const checkingNow = checking && checkProgress(checking.id)
    const queued = store.query(queryDb(taskQueue.where({ taskId: row.id }))).at(0)
    const paused = pauses()
    const held = heldRow(row.id)
    const place = queued ? queue().findIndex((q) => q.id === row.id) + 1 : 0
    const pausedReason =
      (held && paused[held.agent as AgentKind]) ??
      live.map((r) => paused[r.agent as AgentKind]).find((reason) => reason !== undefined) ??
      (place > 0 && leadAgent !== null ? paused[leadAgent as AgentKind] : undefined)
    const leadLive =
      lead !== undefined && lead.state !== 'finished' && stage !== 'backlog' && stage !== 'done'
    const leadStopped =
      lead?.state === 'finished' &&
      lead.ended !== null &&
      (JSON.parse(lead.ended) as RunEnding).how === 'stopped'
    const lastFailure = leadStopped
      ? store
          .query(queryDb(taskLog.where({ taskId: row.id, name: 'v1.TaskLeadFailed' })))
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
    const facts: TaskFacts = {
      ...(snoozedUntil !== null && { snoozedUntil }),
      ...(archivedAt !== null && { archived: true }),
      ...(failedAt !== null && { failed: true }),
      ...(partlyMerged && { partlyMerged }),
      ...(stoppedAt !== null && {
        stopped: {
          at: stoppedAt,
          runs: stoppedRuns ?? 0,
          why: stoppedWhy === 'blockers-removed' ? 'blockers-removed' : 'human',
        },
      }),
      stage,
      ...(leadLive && { leadLive }),
      ...(leadStopped &&
        !held &&
        !recovering &&
        !waitsForBlockers &&
        repos.some((r) => !r.removed) && { interrupted: true }),
      ...(place > 0 && { queue: newWorkHeld === undefined ? { place } : { hold: newWorkHeld } }),
      ...(place > 0 && heldForLoad && { heldForLoad }),
      runs: live.map((r) => r.state as RunState),
      openRequests: openRequestRows(row.id).filter((r) => r.linearTeam === null).length,
      ...permissionWait(row.id, lead?.id),
      ...(pausedReason !== undefined && { paused: pausedReason }),
      ...(waitingOn.length > 0 && { blockedBy: waitingOn }),
      ...(firstEnded !== undefined && { blockerEnded: firstEnded }),
      ...(github !== undefined && { github }),
      ...(mergeWaits && { mergePending: true }),
      ...(autoMergeLeft && { autoMergeLeft: true }),
      ...(stoppedAt === null &&
        place === 0 &&
        repos.some((r) => !r.removed && r.setup?.state === 'running') && { settingUp: true }),
      ...((checking || checkingTasks.has(row.id)) && { tedWorking: true }),
      ...(checkingNow && { checking: checkingNow }),
      ...(checksWaiting.has(row.id) && {
        checksWaiting: { place: checksWaiting.get(row.id) ?? 1 },
      }),
      ...(activity !== null && activityEntries === entries.length && { agentActivity: activity }),
      ...(live.some((r) => r.retrying) && { retrying: true }),
      ...(needsPlanningAt !== null && { needsPlanning: true }),
      ...(stage === 'clarify' && planningFrom(row.id) && { planningInChat: true }),
    }
    const status = taskStatus(facts)
    const shown = taskActivity(facts)
    const tabs: ConversationTab[] = store
      .query(queryDb(conversationTabs.where({ taskId: row.id }).orderBy('openedAt', 'asc')))
      .flatMap((tab) => {
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
      lastCommentAt(row.id),
      briefRows(row.id).at(-1)?.createdAt,
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
    const source = sourceOf(row.id)
    const original =
      followUpOf === null ? undefined : (taskRow(followUpOf) ?? deletedRow(followUpOf))
    const splitOriginal =
      splitFrom === null ? undefined : (taskRow(splitFrom) ?? deletedRow(splitFrom))
    const planLink = store.query(queryDb(planTasks.where({ taskId: row.id }))).at(0)
    const merged =
      stage === 'done'
        ? {
            at: entries.findLast((e) => e.stage === 'done')?.at ?? row.createdAt,
            pullRequests: repos.flatMap((r) =>
              r.pullRequest?.state === 'merged' ? [r.pullRequest.number] : [],
            ),
          }
        : undefined
    const createdBy: CreatedBy = setup
      ? 'setup'
      : followUpOf !== null
        ? 'follow-up'
        : splitFrom !== null
          ? 'split'
          : store.query(queryDb(automationTasks.where({ taskId: row.id }))).length > 0
            ? 'automation'
            : planLink
              ? 'planning'
              : 'human'
    const linearSync = linearSyncOf(row, source)
    return {
      ...row,
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
      pendingLeadMessages:
        pendingLeadDeliveries !== null
          ? (JSON.parse(pendingLeadDeliveries) as { id: string; text: string }[])
          : pendingLeadMessage !== null
            ? [{ id: `stage-legacy-${row.id}`, text: pendingLeadMessage }]
            : [],
      blockedBy,
      waitsForBlockers,
      stopped: stoppedAt !== null,
      gateOverrides: gateOverrides === null ? {} : (JSON.parse(gateOverrides) as TaskGateOverrides),
      forcedGates: forcedGates === null ? [] : (JSON.parse(forcedGates) as AgentStageId[]),
      changesSettings,
      repos,
      chosenRepos:
        chosenRepos !== null
          ? (JSON.parse(chosenRepos) as string[])
          : listFactories()
              .filter((f) => f.id === row.factoryId)
              .map((f) => f.repo),
      attachments: attachmentsOf(row.id),
      ...(source && { source }),
      stage,
      rank: rank ?? row.number,
      displayId: `${factoryKey(row.factoryId)}-${row.number}`,
      ...(branch !== null && { branch }),
      ...(worktree !== null && { worktree }),
      ...(lead !== undefined && { leadRunId: lead.id }),
      ...(status !== undefined && { status }),
      statuses: taskStatuses(facts),
      markers: taskMarkers(facts, status),
      ...(shown !== undefined && { activity: shown }),
      track: track(stage, entries),
      commentBox: commentBox(facts, status),
      ...(taskCanResume(facts) && { canResume: true }),
      tabs,
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
      ...(planLink && {
        fromPlan: {
          id: planLink.planId,
          title: planTitleOf(planLink.planId) ?? '',
          ...(planTitleOf(planLink.planId) === undefined && { deleted: true }),
        },
      }),
      ...(followUpOf !== null && {
        followUpOf: {
          id: followUpOf,
          displayId: original ? `${factoryKey(original.factoryId)}-${original.number}` : followUpOf,
        },
      }),
      ...(splitFrom !== null && {
        splitFrom: {
          id: splitFrom,
          displayId: splitOriginal
            ? `${factoryKey(splitOriginal.factoryId)}-${splitOriginal.number}`
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

  const toRun = ({
    readOffset: _,
    lastOutputAt: _lastOutputAt,
    taskId,
    sessionId,
    model,
    effort,
    usesDefaultModel,
    problem,
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
  }: typeof runs.Type): Run => ({
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
  })

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
    failedRunId,
    talkRunId,
    talkStartedAt,
    talkDoneAt,
    design,
    tutorial,
    linearTeam,
    ...row
  }: typeof comments.Type): Comment => ({
    ...row,
    kind: row.kind as CommentKind,
    author:
      authorKind === 'run' && authorRunId !== null
        ? { kind: 'run', runId: authorRunId }
        : { kind: authorKind === 'ted' ? 'ted' : 'human' },
    ...(stage !== null && { stage: stage as StageId }),
    ...(title !== null && { title }),
    ...(choices !== null && { choices: JSON.parse(choices) as string[] }),
    ...(round !== null && { round: JSON.parse(round) as Round }),
    ...(talkRunId !== null &&
      talkStartedAt !== null && {
        talk: {
          runId: talkRunId,
          startedAt: talkStartedAt,
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
    ...(readAt !== null && { readAt }),
    ...(failedRunId !== null && { failed: { runId: failedRunId } }),
    ...(tutorial && { tutorial: true as const }),
    ...(linearTeam !== null && { linearTeam: JSON.parse(linearTeam) as LinearTeam }),
    ...(design !== null && { design: JSON.parse(design) as DesignReview }),
    ...withFiles(row.id),
    ...withLineComments(row.id),
  })

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

  const permissionWait = (taskId: string, leadId: string | undefined) => {
    const asking = openRequestRows(taskId).filter((r) => r.kind === 'permission')
    if (asking.length === 0) return {}
    return {
      ...(asking.some((r) => r.simulator !== null) && { waitingOnSimulator: true }),
      waitingOnPermission: asking.some((r) => r.authorRunId === leadId)
        ? ('lead' as const)
        : ('sub-agent' as const),
    }
  }

  const openRequestRows = (taskId?: string) =>
    store
      .query(
        queryDb(
          (taskId === undefined ? comments : comments.where({ taskId })).orderBy(
            'createdAt',
            'asc',
          ),
        ),
      )
      .filter((row) => row.kind !== 'note' && row.answer === null)

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
    events.taskStageEnteredV3({
      id: randomUUID(),
      taskId,
      stage,
      effort: entry.effort ?? null,
      stageFileLayer: entry.stageFile?.layer ?? null,
      stageFilePath: entry.stageFile?.path ?? null,
      layers: JSON.stringify(entry.layers),
      order: JSON.stringify(entry.order),
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
  const toCheckRun = (row: typeof checkRuns.Type): CheckRun => ({
    id: row.id,
    taskId: row.taskId,
    trigger: row.trigger as CheckRunTrigger,
    stage: row.stage as StageId,
    checks: checkResultRows(row.id).map(toCheckResult),
    startedAt: row.startedAt,
    ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
    ...(row.outcome !== null && { outcome: row.outcome as CheckRunOutcome }),
    ...(row.finishedAt === null && checksWaiting.has(row.taskId) && { waiting: true }),
  })
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
    return store
      .query(queryDb(tasks.where({ number: Number(digits) })))
      .find((row) => factoryKey(row.factoryId) === key)
  }
  const lastCommentAt = (taskId: string) =>
    store
      .query(queryDb(comments.where({ taskId })))
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

  const nextRank = () => Math.max(0, ...store.query(allTasks).map((t) => t.rank ?? t.number)) + 1
  const runRow = (id: string) => store.query(queryDb(runs.where({ id }))).at(0)
  const listTasks = () => store.query(allTasks).map(toTask)
  const taskIdOfRun = (runId: string) => runRow(runId)?.taskId ?? undefined

  const listeners = new Set<(event: DaemonEvent) => void>()
  const emit = (event: DaemonEvent) => {
    for (const listener of listeners) listener(event)
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
  const commentPosted = (
    {
      taskId,
      body,
      author,
      kind = 'note',
      title,
      choices,
      round,
      proposal,
      sizeCheck,
      gate,
      attachments = [],
      design,
      tutorial = false,
      linearTeam,
    }: NewComment,
    createdAt: string,
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
    const attached = [
      ...files,
      ...(design === undefined
        ? []
        : [events.commentDesignAttached({ commentId: id, design: JSON.stringify(design) })]),
      ...(tutorial ? [events.commentMarkedTutorial({ commentId: id })] : []),
      ...(linearTeam ? [events.commentLinearTeamAsked({ commentId: id, ...linearTeam })] : []),
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
    emit({ type: 'comment-updated', comment })
    return comment
  }

  const updatedTask = (taskId: string): Task => {
    const row = taskRow(taskId)
    if (!row) throw new Error(`no Task ${taskId}`)
    const task = toPublicTask(toTask(row))
    emit({ type: 'task-updated', task })
    return task
  }

  const updatedQueue = (except?: string) => {
    for (const { id } of queue()) if (id !== except) updatedTask(id)
  }

  const updatedDependents = (blockerId: string) => {
    for (const { taskId } of store.query(queryDb(taskBlockers.where({ blockerId })))) {
      if (taskRow(taskId)) updatedTask(taskId)
    }
  }

  const linearRecord = (taskId: string): LinearSyncRecord => {
    const record: LinearSyncRecord = { linked: new Set(), allowed: false, allowedTeams: new Set() }
    const rows = store
      .query(queryDb(taskLog.where({ taskId }).orderBy('at', 'asc')))
      .filter((row) => row.name.startsWith('v1.Linear'))
    for (const row of rows) {
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

  const linearSyncOf = (
    row: { id: string; factoryId: string },
    source: TaskSource | undefined,
  ): 'on' | 'ask' | undefined => {
    if (!source || !parseLinearUrl(source.url)) return undefined
    const record = linearRecord(row.id)
    if (record.allowed) return 'on'
    const teams = settings().linearSyncTeams[row.factoryId] ?? []
    const team = record.seen?.team
    return team !== undefined && (teams.includes(team) || record.allowedTeams.has(team))
      ? 'on'
      : 'ask'
  }

  const settings = (): MachineSettings => {
    const legacy = store.query(queryDb(machineSettings.where({ id: 'machine' }))).at(0)
    const values = Object.fromEntries(
      store
        .query(queryDb(machineSettingValues.select()))
        .map(({ name, value }) => [name, JSON.parse(value) as unknown]),
    )
    return {
      ...defaultMachineSettings,
      ...(legacy && { appearance: legacy.appearance as Appearance }),
      ...pick(values, Object.keys(defaultMachineSettings)),
    }
  }

  let shellsRunning = 0
  const activity = (): Activity => {
    const active = store.query(allRuns).filter((run) => run.state !== 'finished')
    const held = store.query(queryDb(heldRuns)).length
    const factoryIds = new Set(store.query(allFactories).map((f) => f.id))
    const liveAutomations = store
      .query(queryDb(automations.select()))
      .filter((a) => factoryIds.has(a.factoryId))
    return {
      runs: {
        working: active.filter((run) => run.state === 'working').length,
        active: active.length + held,
        queued:
          store.query(queryDb(sideChats)).filter((row) => JSON.parse(row.data).state === 'queued')
            .length +
          store.query(queryDb(coordinators)).filter((row) => {
            const value = JSON.parse(row.data) as { phase: string }
            return value.phase === 'queued'
          }).length,
      },
      scheduledTasks: store
        .query(allTasks)
        .filter(
          (task) =>
            task.stage === 'backlog' && task.archivedAt === null && task.snoozedUntil !== null,
        ).length,
      automationsOn: liveAutomations.filter((a) => a.on).length,
      factoriesSettingUp: store.query(allFactories).filter((f) => f.clonedAt === null).length,
      checksRunning: [
        ...new Set([
          ...checkingTasks,
          ...store.query(queryDb(checkRuns.where({ finishedAt: null }))).map((r) => r.taskId),
        ]),
      ].filter((taskId) => !checksWaiting.has(taskId)).length,
      checksWaiting: checksWaiting.size,
      shellsRunning,
    }
  }
  const waiting = (): WaitingRequest[] => {
    const factoryIds = new Set(store.query(allFactories).map((f) => f.id))
    const liveTasks = new Map(
      store
        .query(allTasks)
        .filter((t) => t.archivedAt === null)
        .map((t) => [t.id, t]),
    )
    const fromTasks = openRequestRows().flatMap((row): WaitingRequest[] => {
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
    return [...fromTasks, ...fromAutomations, ...fromPlans].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )
  }
  let lastWaiting: WaitingRequest[] | undefined
  let waitingNoted = false
  noteWaiting = () => {
    if (waitingNoted) return
    waitingNoted = true
    queueMicrotask(() => {
      waitingNoted = false
      if (shutDown) return
      const next = waiting()
      if (lastWaiting !== undefined && isDeepStrictEqual(next, lastWaiting)) return
      lastWaiting = next
      emit({ type: 'inbox-changed', waiting: next })
    })
  }
  lastWaiting = waiting()

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
    changed(factoryId) {
      emit({ type: 'coordinator-changed', factoryId })
      noteActivity()
    },
  })

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
  await persisted()

  return {
    execution,
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
    automations: automationStore,
    plans: planStore,
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
    postFailureDecision(value, body) {
      const at = new Date().toISOString()
      const assessment = value.assessments.at(-1)
      if (!assessment) throw new Error('a failure decision needs an assessment')
      const { id, event, attached } = commentPosted(
        {
          taskId: value.taskId,
          kind: 'question',
          body,
          ...(value.validation && {
            title: `How should we handle the ${value.originalCheck?.name ?? 'validation'} failure?`,
          }),
          choices: Object.values(value.validation ? validateFailureChoices : failureChoices),
          author: { kind: 'ted' },
        },
        at,
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
      emit({ type: 'comment-posted', comment: requireComment(id) })
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
      commit(events.factoryAddedV2({ ...input, id, repos, createdAt: new Date().toISOString() }))
      const added = requireFactory(id)
      emit({ type: 'factory-added', factory: basicFactory(added) })
      noteActivity()
      return added
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
      title,
      linearConsent = false,
      factoryId = placeholderFactory.id,
      description = '',
      priority = 'none',
      clarifyDepth = 'auto',
      lead,
      startRequested = false,
      blockedBy = [],
      attachments = [],
      source,
      followUpOf,
      forcedGates = [],
      changesSettings = false,
      splitFrom,
      automation,
      plan,
      setup = false,
    }) {
      const inFactory = store.query(queryDb(tasks.where({ factoryId })))
      const deleted = store.query(queryDb(deletedTasks.where({ factoryId })))
      const used = [...inFactory.map((t) => t.number), ...deleted.map((t) => t.number)]
      const awaitingSetup =
        !setup &&
        listFactories().find((f) => f.id === factoryId)?.clonedAt === undefined &&
        factoryId !== placeholderFactory.id
      const currentDraft = draftRevision ? taskDraft(factoryId).draft : null
      const number = setup && !used.includes(1) ? 1 : Math.max(awaitingSetup ? 1 : 0, ...used) + 1
      const id = randomUUID()
      const at = new Date().toISOString()
      commit(
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
        events.taskRanked({ taskId: id, rank: nextRank(), at }),
        ...blockedBy.map((blockerId) =>
          events.taskBlockerAddedV2({ taskId: id, blockerId, runId: null, at }),
        ),
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
        ...(plan ? [events.planTaskCreated({ ...plan, taskId: id, at })] : []),
        ...(setup ? [events.setupTaskCreated({ taskId: id, factoryId, at })] : []),
      )
      const row = taskRow(id)
      if (!row) throw new Error(`no Task ${id}`)
      const task = toPublicTask(toTask(row))
      emit({ type: 'task-created', task })
      if (automation) emit({ type: 'automation-updated', automationId: automation.automationId })
      if (followUpOf !== undefined && taskRow(followUpOf)) updatedTask(followUpOf)
      return task
    },
    listTasks: () => listTasks().map(toPublicTask),
    getTask(ref) {
      const row = taskRow(ref)
      const found = row ?? taskRowByDisplayId(ref)
      return found && toTask(found)
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
    queueTask(taskId, stage) {
      const rank = nextRank()
      const at = new Date().toISOString()
      commit(
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        events.taskRanked({ taskId, rank, at }),
        events.taskQueued({ taskId, stage, rank, at }),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    moveToBacklog(taskId) {
      commit(events.taskMovedToBacklog({ taskId, at: new Date().toISOString() }))
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
    startAfterPlanning(taskId, stage, entry) {
      const at = new Date().toISOString()
      const rank = nextRank()
      commit(
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        events.taskRanked({ taskId, rank, at }),
        events.taskStartedAfterPlanning({ taskId, stage, rank, at }),
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
      commit(
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
      return task
    },
    unarchiveTask(taskId, { queue: queued, waitForBlockers }) {
      const at = new Date().toISOString()
      const rank = queued ? Math.max(0, ...queue().map((q) => q.rank)) + 1 : null
      commit(
        events.taskUnarchived({ taskId, rank, at }),
        ...(queued && waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      updatedDependents(taskId)
      return task
    },
    deleteTask(taskId) {
      const row = taskRow(taskId)
      if (!row) return
      checkingTasks.delete(taskId)
      const at = new Date().toISOString()
      commit(
        events.taskExecutionForgotten({ taskId, at }),
        events.taskDeleted({
          taskId,
          factoryId: row.factoryId,
          number: row.number,
          runIds: taskRuns(taskId).map((r) => r.id),
          checkRunIds: checkRunRows(taskId).map((r) => r.id),
          at,
        }),
      )
      emit({ type: 'task-deleted', taskId })
      updatedQueue()
      updatedDependents(taskId)
    },
    blockedBy: (blockerId) =>
      store.query(queryDb(taskBlockers.where({ blockerId }))).map((row) => row.taskId),
    queue,
    dequeue(taskId) {
      commit(events.taskDequeued({ taskId, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
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
      commit(
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
    stopTask(taskId, { runs, why }) {
      commit(events.taskStopped({ taskId, runs, why, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    resumeTask(taskId, { waitForBlockers }) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      const at = new Date().toISOString()
      commit(
        events.taskResumed({ taskId, rank, at }),
        ...(waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
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
    leadFailed({ taskId, runId, reason, recovery, resumeFailed, ask }) {
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
    gateKeptOvernight(taskId, stage, reason) {
      commit(events.gateKeptOvernight({ taskId, stage, reason, at: new Date().toISOString() }))
      updatedTask(taskId)
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
    mergePending(taskId) {
      const task = taskRow(taskId)
      return task?.stage === 'merge' && mergePendingFor(taskId, reposOf(taskId))
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
    renameFactory(factoryId, name) {
      commit(events.factoryRenamed({ factoryId, name, at: new Date().toISOString() }))
      return requireFactory(factoryId)
    },
    reorderFactories(factoryIds) {
      commit(
        events.factoriesReordered({ factoryIds: [...factoryIds], at: new Date().toISOString() }),
      )
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
    changeStage(taskId, stage, entry) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId).filter(
        (row) => (row.gate !== null || row.kind === 'round') && row.stage !== stage,
      )
      const answer: CommentAnswer = { kind: 'withdrawn', at, movedTo: stage }
      commit(
        events.taskStageChanged({ taskId, stage, at }),
        ...(entry ? [stageEntered(taskId, stage, entry, at)] : []),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      if (stage === 'done') {
        for (const { taskId: waiting } of store.query(
          queryDb(taskBlockers.where({ blockerId: taskId })),
        )) {
          updatedTask(waiting)
        }
      }
      return task
    },
    listStageEntries: (taskId) =>
      store.query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc'))).map(toStageEntry),
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
    holdLeadMessage(taskId, text) {
      const pending = toTask(requireTaskRow(taskId)).pendingLeadMessages
      commit(
        events.taskLeadMessagesHeld({
          taskId,
          messages: JSON.stringify([...pending, { id: randomUUID(), text }]),
          at: new Date().toISOString(),
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
        commit(
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
    filesInUse: () =>
      new Set([
        ...store
          .query(queryDb(taskDrafts))
          .flatMap((row) =>
            row.draft ? (JSON.parse(row.draft) as NewTaskDraft).attachments.map((a) => a.hash) : [],
          ),
        ...store.query(queryDb(taskAttachments)).map((a) => a.hash),
        ...store.query(queryDb(taskBrowserCaptures)).map((a) => a.hash),
        ...store.query(queryDb(commentAttachments)).map((a) => a.hash),
      ]),
    postComment(input) {
      const at = new Date().toISOString()
      const { id, event, attached } = commentPosted(input, at)
      commit(event, ...attached, ...lineCommentsSent(input.lineComments, id, at))
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
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
      emit({ type: 'comment-posted', comment })
      emitComment(oldId)
      updatedTask(input.taskId)
      return comment
    },
    listComments: (taskId) =>
      store.query(queryDb(comments.where({ taskId }).orderBy('createdAt', 'asc'))).map(toComment),
    getComment,
    answerComment(id, answer, sending) {
      commit(
        events.commentAnswered({ id, answer: JSON.stringify(answer), at: answer.at }),
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
    startRoundTalk(id, runId) {
      commit(events.roundTalkStarted({ id, runId, at: new Date().toISOString() }))
      return emitComment(id)
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
      commit(events.commentAnswersDelivered({ ids, runId, at: new Date().toISOString() }))
    },
    ...history,
    taskLog: readTaskLog,
    listOpenRequests: () => openRequestRows().map(toComment),
    listAnsweredRequests: () =>
      store
        .query(queryDb(comments.orderBy('createdAt', 'asc')))
        .filter((row) => row.kind !== 'note' && row.answer !== null)
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
    listSendBacks(taskId) {
      const declared = store.query(
        queryDb(severityDeclarations.where({ taskId }).orderBy('at', 'asc')),
      )
      let after = ''
      return store
        .query(queryDb(sendBacks.where({ taskId }).orderBy('at', 'asc')))
        .map(toSendBack)
        .map((sendBack) => {
          const since = after
          after = sendBack.at
          if (sendBack.from !== 'validate' || !sendBack.counted || sendBack.checkRunId) {
            return sendBack
          }
          const found = declared.findLast((d) => d.at > since && d.at <= sendBack.at)
          return found ? { ...sendBack, severity: found.severity as FindingSeverity } : sendBack
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
      ...input
    }) {
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
      commit(
        events.runStartedV4(row),
        events.runPermissionsSet({ runId: row.id, permissions, at: row.startedAt }),
      )
      const run = toRun({
        ...row,
        retrying: false,
        steeringRelease: null,
        usesDefaultModel: false,
        problem: null,
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
        events.subAgentRequested({ ...request, model: model ?? null, effort: effort ?? null, at }),
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
      commit(events.sendBackAsked({ ...ask, checkRunId: checkRunId ?? null, at }))
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
      if (on) waitingOnSubAgents.add(runId)
      else waitingOnSubAgents.delete(runId)
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
      noteActivity()
    },
    onSubAgents: (runId) => waitingOnSubAgents.has(runId),
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
      commit(
        events.runOutputReadV3({
          runId,
          toOffset,
          lastOutputAt: output ? (output.lastAt ?? at) : null,
        }),
        ...(sessionId !== undefined && sessionId !== current.sessionId
          ? [events.runSessionIdentified({ runId, sessionId })]
          : []),
        ...(newProblem ? [events.runProblemFound({ runId, problem, at })] : []),
        ...(retryChanged ? [events.runRetryingChanged({ runId, retrying: nowRetrying, at })] : []),
        ...(ending ? [events.runEnded({ runId, ending: JSON.stringify(ending), at })] : []),
        ...(stateChanged && target !== undefined
          ? [events.runStateChanged({ runId, state: target, at })]
          : []),
        ...(unavailable ? [events.runAutoModeUnavailable({ runId, taskId, at })] : []),
        ...asked.map(({ event }) => event),
        ...withdrawnOnce.map(({ id, answer }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      if (output) emit({ type: 'run-output', runId })
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
      if (stateChanged) noteActivity()
    },
    setRunPermissions(runId, permissions) {
      const row = runRow(runId)
      if (!row || row.permissions === permissions) return
      commit(events.runPermissionsSet({ runId, permissions, at: new Date().toISOString() }))
      emit({ type: 'run-updated', run: toRun(runRow(runId) ?? row) })
      const taskId = taskIdOfRun(runId)
      if (taskId !== undefined) updatedTask(taskId)
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
    lastOutputAt: (runId) => runRow(runId)?.lastOutputAt ?? undefined,
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
    listRuns: () => store.query(allRuns).map(toRun),
    busyTaskIds: () => [
      ...store.query(queryDb(runs.where({ state: 'working' }))).flatMap((r) => r.taskId ?? []),
      ...store.query(queryDb(taskRepos.where({ setupState: 'running' }))).map((r) => r.taskId),
    ],
    tasksIn: (ids) =>
      store
        .query(allTasks)
        .filter((row) => ids.has(row.id))
        .map((row) => toPublicTask(toTask(row))),
    backlogTasks: () =>
      store
        .query(allTasks)
        .filter((row) => row.stage === 'backlog' && row.archivedAt === null)
        .map((row) => ({ id: row.id, snoozed: Boolean(row.snoozedUntil) })),
    runReadOffset: (id) => runRow(id)?.readOffset ?? 0,
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
    setShellsRunning(count) {
      shellsRunning = count
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
          .query(queryDb(runs.where({ agent })))
          .filter((r) => r.state !== 'finished' && r.taskId !== null)
          .map((r) => r.taskId as string),
        ...store.query(queryDb(heldRuns.where({ agent }))).map((h) => h.taskId),
        ...queue()
          .filter((q) => taskRow(q.id)?.leadAgent === agent)
          .map((q) => q.id),
      ])
      for (const taskId of affected) updatedTask(taskId)
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
      store.query(queryDb(runs.where({ agent }))).filter((r) => r.state !== 'finished').length +
      store.query(queryDb(heldRuns.where({ agent }))).length,
    exportEventlog: () => ({
      fileName: eventlogName,
      data: Effect.runSync(store[StoreInternalsSymbol].clientSession.leaderThread.getEventlogData),
    }),
    persisted,
    holdNewWork(reason) {
      if (reason === newWorkHeld) return
      newWorkHeld = reason
      updatedQueue()
    },
    newWorkHold: () => newWorkHeld,
    holdForLoad(held) {
      if (held === heldForLoad) return
      heldForLoad = held
      updatedQueue()
    },
    setTaskChecking(taskId, on) {
      if (checkingTasks.has(taskId) === on) return
      if (on) {
        if (!taskRow(taskId)) return
        checkingTasks.add(taskId)
      } else checkingTasks.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
      noteActivity()
    },
    setChecksWaiting(places) {
      const before = checksWaiting
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
    close: () => {
      shutDown = true
      return store.shutdownPromise()
    },
  }
}

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
    : agentStageIds.map((id) => ({ stage: id, enabled: true }))
  const order: StageId[] = plan.map((p) => p.stage)
  const entered = new Set(entries.map((e) => e.stage))
  const inOrder = order.includes(stage)
  const rank = (id: StageId) => (inOrder ? order.indexOf(id) : builtInRank(id))
  return plan.map(({ stage: id, enabled }) => {
    if (id === stage) return { stage: id, state: 'current' }
    if (!enabled) return { stage: id, state: 'skipped' }
    if (stage === 'backlog') return { stage: id, state: 'future' }
    if (stage === 'done' || rank(id) < rank(stage)) {
      return { stage: id, state: entered.has(id) ? 'past' : 'skipped' }
    }
    return { stage: id, state: 'future' }
  })
}

function builtInRank(id: StageId): number {
  return id === 'backlog' ? -1 : id === 'done' ? agentStageIds.length : agentStageIds.indexOf(id)
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
