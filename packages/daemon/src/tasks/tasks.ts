import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentKind,
  AgentStageId,
  AnswerRequest,
  AnswerTedStopsRequest,
  AppCapture,
  AppLog,
  AppRef,
  AppStarter,
  ArchiveAsk,
  ArchiveDoneResult,
  ArchiveTaskRequest,
  AsanaImportPreview,
  AsanaImportRequest,
  AsanaImportResult,
  AsanaIntakeRequest,
  AsanaIntakeResult,
  AsanaIntakeScope,
  AsanaProjectList,
  AsanaProjectListName,
  AssessFailureRequest,
  Attachment,
  BaseConflictFound,
  BlockedChoice,
  AppRef as BrowserAppRef,
  BrowserCommand,
  BrowserReply,
  BrowserRequest,
  BrowserResult,
  CheckRun,
  CheckRunReport,
  ClarifyDepth,
  Comment,
  CommentAnswer,
  CommitChanges,
  DaemonEvent,
  DeleteTaskRequest,
  DescriptionVersion,
  DesignFile,
  DesignReview,
  DeviceRequest,
  DeviceResult,
  DraftLineCommentRequest,
  EditTaskRequest,
  Effort,
  FactoryBoard,
  FailureCase,
  FailureContext,
  FileDiff,
  FindingSeverity,
  InboxItem,
  LinearFile,
  LinearIssue,
  LineComment,
  MachineSettings,
  MergeMethod,
  MergeRow,
  MoveTaskRequest,
  OutcomeResult,
  Priority,
  ProposalCreated,
  ProposalInput,
  PullRequestChanges,
  RecordAppRequest,
  RecordFailureRequest,
  ReportCleanupStepRequest,
  ReportOutcomeRequest,
  RepoSetupReport,
  RequestArchiveRequest,
  ResolveFailureRequest,
  RoundInput,
  Run,
  RunMessage,
  RunSlots,
  SendBack,
  SendBackCause,
  SetClarifyDepthRequest,
  SetTaskAutopilotRequest,
  SetTaskGatesRequest,
  SetTaskParentRequest,
  SetTaskReposRequest,
  SetupProposal,
  SignOffChanges,
  SimulatorSlots,
  SizeCheckInput,
  SlotHolder,
  SnoozedRequest,
  StageId,
  StartAppRequest,
  StartSubAgentRequest,
  SubAgent,
  SubAgentWait,
  TalkThroughRequest,
  TalkThroughResult,
  Task,
  TaskApp,
  TaskBrief,
  TaskChanges,
  TaskCommit,
  TaskDefaults,
  TaskFileContent,
  TaskFiles,
  TaskGateOverrides,
  TaskGates,
  TaskHierarchy,
  TaskHierarchyPreview,
  TaskLead,
  TaskRepo,
  TaskReposResult,
  TaskSource,
  TedStoppedTask,
  ThreadEvent,
  UnarchiveTaskRequest,
  ValidateJudgments,
  ValidationObligations,
  WaitingRequest,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import {
  type AsanaStatus,
  agentShortNames,
  agentStageIds,
  archiveChoice,
  asanaAddChoice,
  asanaSyncAllowable,
  bannerId,
  briefHeadings,
  type CleanupStepReport,
  clarifyDepths,
  clarifyIsOver,
  cleanupFinishChoice,
  cleanupRetryChoice,
  isChat,
  isLoopbackUrl,
  isTrackerClosedQuestion,
  isTrackerGroupAsk,
  keepArchiveChoice,
  maxAsanaIntakeTasks,
  parseAsanaTaskUrl,
  parseLinearUrl,
  type ResetRefusal,
  resetRefusal,
  runOnlyBrowserActions,
  sizeChoices,
} from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { agentStartHold } from '../agent-eligibility.ts'
import type { AutoModeSignal } from '../agents/agent.ts'
import { diffTexts } from '../agents/diff.ts'
import type { Agents } from '../agents/index.ts'
import {
  type AppsOptions,
  type AppTask,
  createApps,
  type EmulatorOptions,
  type SimulatorOptions,
} from '../apps/apps.ts'
import { type AppDeclaration, appDeclarations } from '../apps/declared.ts'
import { createRunBrowsers } from '../apps/run-browser.ts'
import { AsanaReadError } from '../asana/asana.ts'
import { checkAsanaRoot, confirmAsanaScope, listAsanaIntake, scopeName } from '../asana/intake.ts'
import { confirmAsanaProject, listAsanaProjects } from '../asana/projects.ts'
import { type AsanaRead, type AsanaTree, readAsanaTree, retryingRead } from '../asana/tree.ts'
import { maxTasksPerFiring } from '../automations/check-failures.ts'
import type { Banners } from '../banners.ts'
import { type Clock, clockWait, systemClock, type Timer } from '../clock.ts'
import { loginShell, worktreeCommandEnv } from '../command-env.ts'
import type { FileStore } from '../downloads.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import { type Gh, GhError } from '../github/gh.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { IdleTimer } from '../idle.ts'
import { linkedFilesRewritten } from '../linear/files.ts'
import type { Linear } from '../linear/linear.ts'
import { machineLoadRatio } from '../load.ts'
import { acquireFactoryPermissions, factoryPermissions } from '../permissions.ts'
import { redactSecrets } from '../redact.ts'
import { resolveReference } from '../references.ts'
import { type WorktreeFileScope, worktreeFileScope } from '../regular-file.ts'
import { chatItems } from '../runs/conversations.ts'
import { parsedOutput } from '../runs/parsed-output.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { Steering } from '../runs/steering.ts'
import type { Sandbox, SandboxScope } from '../sandbox.ts'
import type {
  CleanupCommandResult,
  FoundConflict,
  LoopCheck,
  LoopVerdict,
  NewTask,
  NewWorktree,
  RecordedSetup,
  RepoCommit,
  StoredFactory,
  StoredTask,
  TedStore,
} from '../store/index.ts'
import { messageOf } from '../text.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import {
  type CheckSettings,
  type CleanupStep,
  checkLayer,
  githubRepoOf,
  isCommandStep,
  type WorkflowSettings,
} from '../workflow/check.ts'
import { readGitLayer } from '../workflow/layers.ts'
import {
  boardStages,
  type OvernightGuard,
  onDefaultBranch,
  type ResolvedWorkflow,
  setupWorkflow,
  withForcedGates,
  withoutGates,
  withTaskGates,
} from '../workflow/resolve.ts'
import {
  backStageMessage,
  cleanupStepsText,
  loopCheckInstructions,
  nextStageMessage,
  preambleText,
  setupInstructions,
  stageTitle,
  taskLeadPrompt,
  taskLeadSharedTexts,
} from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'
import { answerMessage } from './answer-message.ts'
import {
  asanaGoAheadChoice,
  asanaNotes,
  asanaRetryChoice,
  asanaSource,
  asanaTaskUrl,
  goAheadText,
  missingWorkText,
  missingWorkTitle,
  type ParentRef,
  planAsanaImport,
} from './asana-import.ts'
import { asanaTracker, createAsanaSync } from './asana-sync.ts'
import { ordinaryAutopilotRequest, taskAutopilot } from './autopilot.ts'
import {
  type BaseConflict,
  baseCheckTimeoutMs,
  conflictChecked,
  conflictRefusal,
  noConflictFound,
} from './base-conflict.ts'
import { createBrowserBroker } from './browser.ts'
import { conversationText } from './carry-over.ts'
import { commitChanges, fileDiffs, taskChanges, taskCommits } from './changes.ts'
import type { CheckSlots } from './check-slots.ts'
import {
  type CheckRunnerResult,
  checkEnv,
  defaultCheckTimeout,
  failureFindings,
  lastLines,
  planChecks,
  type RunnableCheck,
  readOutput,
  summary,
  tedSettingsCheck,
  touchesSettings,
} from './checks.ts'
import {
  acceptedCiCase,
  awaitsRerun,
  ciFailureSteps,
  openCiCase,
  unscoped,
  withoutCheckName,
} from './ci-failures.ts'
import {
  cleanupCommandReportRefusal,
  cleanupDoneRefusal,
  cleanupFailureBody,
  cleanupMoveTarget,
  cleanupNoBack,
  cleanupProgress,
  cleanupRestartNote,
} from './cleanup.ts'
import { cleanupCommandsText, runCleanupCommands } from './cleanup-commands.ts'
import { coalesced } from './coalesced.ts'
import type { CommandLaunch } from './command.ts'
import { createTaskExecution } from './execution.ts'
import {
  acceptedResolution,
  ciFailureKey,
  createFailureCases,
  failureNoticeTitles,
  failureText,
  leadClosesFailures,
  leadClosesRefusal,
} from './failure-cases.ts'
import { freshAfterFailure, retryChoice } from './failures.ts'
import { listTaskFiles, readTaskFile } from './files.ts'
import {
  activityMessage,
  ciFailureEvidence,
  clean,
  failedChecks,
  freshRunReason,
  type GitHubNotice,
  summary as gitHubSummary,
  jobLogPath,
  logTail,
  noticesFor,
  previewOf,
  trustedCheck,
  unseen,
} from './github-activity.ts'
import { createPullRequestWatch } from './github-watch.ts'
import { createHeldRequests } from './held-requests.ts'
import {
  type HierarchyMember,
  type HierarchyView,
  hierarchyChangedText,
  hierarchyText,
} from './hierarchy-text.ts'
import {
  answered as answeredItems,
  answeredSince,
  byHuman,
  waiting as waitingItems,
} from './inbox.ts'
import { type AdoptedBase, baseStep, firstWorkEntry, latestBaseNote } from './latest-base.ts'
import {
  atIdlePoint,
  continueMessage,
  createLeadLifecycle,
  effectiveLead,
  liveLeadOf,
  type SetupStep,
  sameChoice,
} from './lead-lifecycle.ts'
import { anchorIn, lineCommentsText, markOutdated } from './line-comments.ts'
import { verifyLinearIntake } from './linear-intake.ts'
import {
  createLinearSync,
  type LinearSyncApi,
  linearConnector,
  linearRecords,
} from './linear-sync.ts'
import { createLocalLifecycle } from './local-lifecycle.ts'
import {
  chooseMethod,
  defaultHost,
  deleteBranch,
  nextStep,
  type PullRequestRead,
  type PullRequestRef,
  type RemoteCheck,
  type RemotePullRequest,
  reviewMissing,
} from './merge.ts'
import {
  createMergeWatcher,
  isCiStuck,
  type MergeCycle,
  type MergeWork,
  mergeMode as mergeModeFor,
  startMerging as startMergingFor,
} from './merge-watcher.ts'
import { placeBetween } from './order.ts'
import { overnightGuidance } from './overnight.ts'
import { createPeers, type Peers } from './peers.ts'
import { checkPreparationWorkflow } from './preparation.ts'
import { readPullRequestChanges } from './pull-request-changes.ts'
import {
  createPullRequests,
  type PullRequestTarget,
  type PullRequestTask,
} from './pull-requests.ts'
import {
  heldForLoad,
  type QueueEntry,
  type QueueSource,
  queueOrder,
  type SlotUse,
  startsNow,
} from './queue.ts'
import { removeInside } from './remove-files.ts'
import {
  chosenEntries,
  type FactoryRepoEntry,
  factoryRepos,
  findRepo,
  repoEntry,
  sameRepo,
} from './repos.ts'
import {
  answerTaskRequest,
  backToDesignChoice,
  checkBack,
  createRequestAnswers,
  diagnoseChoice,
  loopChoices,
  tryAgainChoice,
} from './request-answers.ts'
import {
  type ConflictSendBack,
  conflictReviewPrompt,
  conflictRoundText,
  type EarlierRound,
  type FixesSince,
  type MergedBase,
  type MovedRepo,
  type RecordedConflict,
  reviewMovedRefusal,
  scopedReviewPrompt,
  validateRoundText,
  workRoundText,
} from './review-rounds.ts'
import {
  clarifySignoffCaption,
  depthNames,
  depthOrder,
  pickDepth,
  roundAnswerSummary,
} from './rounds.ts'
import { clashMessage, sourceClash, sourceKey } from './sources.ts'
import {
  afterPlanningWhy,
  planApprovedLeadMessage,
  planEndedLeadMessage,
  planOutsideNote,
  sizeCheckTitle,
  splitApprovedSummary,
} from './split.ts'
import { leadAskedAtMerge } from './status.ts'
import { createSubAgents, type PlannedReview, type ReviewerChoice } from './sub-agents.ts'
import { titleFromText } from './task-title.ts'
import { nudgeMessage, taskThreadEvents } from './thread.ts'
import { createTrackerConsent, type TrackerConsent } from './tracker-sync/consent.ts'
import type { TrackerTaskActions } from './tracker-sync/sync.ts'
import {
  noEarlierFindingRefusal,
  p1OnlyAt,
  p1OnlyRefusal,
  p1OnlyReviewPrompt,
  subAgentsInValidate,
} from './validate-settings.ts'
import { createValidation, type HandOffChecks, StaleCoverageError } from './validation.ts'
import { failureCaseFindings, failureCaseReference } from './validation-report.ts'
import { type CommandResult, outputTail } from './worktree.ts'

export type Caller = { kind: 'app' } | { kind: 'file' } | { kind: 'run'; runId: string }

export interface RunAppOwner {
  ready: Promise<void>
  owns(runId: string): boolean
  live(runId: string): boolean
  appTask(runId: string): Promise<AppTask>
}

export interface TaskPlanning {
  fromTask(input: { taskId: string; sizeCheckId: string; text: string }): Promise<{
    id: string
    title: string
  }>
  taskGone(taskId: string, reason: 'archived' | 'deleted' | 'reset'): void
}

export interface PlanApproval {
  planId: string
  planTitle: string
  created: ProposalCreated
  text: string
}

export interface PlanEnd {
  planId: string
  planTitle: string
  outcome: 'stopped' | 'failed' | 'deleted'
}

export interface CreateTaskInput
  extends Omit<
    NewTask,
    | 'title'
    | 'factoryId'
    | 'startRequested'
    | 'blockedBy'
    | 'source'
    | 'followUpOf'
    | 'splitFrom'
    | 'automation'
    | 'parentId'
  > {
  title?: string
  source?: string
  sentryId?: string
  followUp?: string
  factory?: string
  blockedBy?: string[]
  parent?: string
  attachments?: Attachment[]
  start?: boolean
  startInBackground?: boolean
}

export interface WorktreeAccess {
  fileScope: WorktreeFileScope
  taskId: string
  repo: string
  worktree: string
  env: NodeJS.ProcessEnv
}

export type DesignSubmissionFile = Attachment & { caption?: string }

export interface DesignSubmission {
  title?: string
  summary?: string
  screenshots?: DesignSubmissionFile[]
  video?: DesignSubmissionFile
  prototype?: DesignSubmissionFile
  figma?: { url: string; label?: string }
  worthYourEye?: string[]
  setup?: SetupProposal
}

type AdvanceRequest = Extract<ReportOutcomeRequest, { outcome: 'advance' }>

export type OutcomeInput =
  | Exclude<ReportOutcomeRequest, { outcome: 'advance' }>
  | (Omit<AdvanceRequest, 'design'> & { design?: DesignSubmission })

export interface TaskReference {
  taskId: string
  displayId: string
}

export interface CheckFailureInput {
  automationId: string
  firingId: string
  factoryId: string
  failures: readonly { key: string; title: string; description: string; note: string }[]
}

export interface Tasks {
  deliveryAllowed(runId: string): boolean
  failureContext(ref: string, id: string, caller: Caller): FailureContext
  listFailures(ref: string, caller: Caller): Promise<FailureCase[]>
  validationObligations(ref: string, caller: Caller): Promise<ValidationObligations>
  captureFailureContext(ref: string, caller: Caller): Promise<FailureContext>
  recordFailure(ref: string, caller: Caller, input: RecordFailureRequest): Promise<FailureCase>
  addFailureEvidence(
    ref: string,
    caller: Caller,
    id: string,
    evidence: string,
    contextId?: string,
  ): Promise<FailureCase>
  assessFailure(
    ref: string,
    caller: Caller,
    id: string,
    input: AssessFailureRequest,
  ): Promise<FailureCase>
  verifyFailure(ref: string, caller: Caller, id: string, evidence: string): Promise<FailureCase>
  requestFailureDecision(ref: string, caller: Caller, id: string): Promise<FailureCase>
  resolveFailure(ref: string, id: string, input: ResolveFailureRequest): Promise<FailureCase>
  create(input: CreateTaskInput, caller?: Caller): Promise<Task>
  asanaPreview(input: AsanaImportRequest, caller?: Caller): Promise<AsanaImportPreview>
  importAsana(input: AsanaImportRequest, caller?: Caller): Promise<AsanaImportResult>
  asanaIntake(input: AsanaIntakeRequest, caller?: Caller): Promise<AsanaIntakeResult>
  cancelMerge(ref: string, comment: string, attachments?: Attachment[]): Promise<Comment>
  markDone(ref: string, by?: 'human' | 'coordinator'): Promise<Task>
  leadDone(ref: string, caller: Caller): Promise<Task>
  reportCleanupStep(
    ref: string,
    caller: Caller,
    report: ReportCleanupStepRequest,
  ): Promise<CleanupStepReport[]>
  defaults(factoryId: string): Promise<TaskDefaults>
  setUpFactory(factoryId: string): Promise<Task | undefined>
  checkFailed(input: CheckFailureInput): Promise<{ created: string[]; updated: string[] }>
  automationNote(ref: string, caller: Caller, body: string): TaskReference
  automationStart(ref: string, caller: Caller): Promise<TaskReference>
  newSetupTask(factoryId: string): Promise<Task>
  board(factoryId: string): Promise<FactoryBoard>
  start(ref: string, request?: import('@ted/protocol').StartTaskRequest): Promise<Task>
  moveToBacklog(ref: string): Task
  stop(ref: string): Promise<Task>
  resume(ref: string, input?: { comment?: string; attachments?: Attachment[] }): Promise<Task>
  stoppingForQuit(): void
  tedStops(): TedStoppedTask[]
  answerTedStops(request: AnswerTedStopsRequest): Promise<TedStoppedTask[]>
  move(ref: string, request: MoveTaskRequest): Task
  setTaskSnooze(ref: string, until: string | null): Task
  snoozeRequest(requestId: string, until: string | null): WaitingRequest | SnoozedRequest
  setPriority(ref: string, priority: Priority): Task
  edit(ref: string, request: EditTaskRequest): Promise<Task>
  descriptions(ref: string): DescriptionVersion[]
  archive(ref: string, options?: ArchiveTaskRequest): Task
  requestArchive(ref: string, caller: Caller, request: RequestArchiveRequest): Promise<Comment>
  allowLinearSync(ref: string): Task
  allowAsanaSync(ref: string): Promise<Task>
  asanaStatusSeen(status: AsanaStatus): void
  allowLinearTeam(factoryId: string, team: string): MachineSettings
  asanaProjects(): Promise<AsanaProjectList>
  allowAsanaProject(factoryId: string, project: string): Promise<MachineSettings>
  forgetAsanaProject(
    factoryId: string,
    project: string,
    list: AsanaProjectListName,
  ): Promise<MachineSettings>
  archiveDone(factory: string): ArchiveDoneResult
  followUp(ref: string, request: { comment?: string; attachments?: Attachment[] }): Promise<Task>
  hierarchy(ref: string, caller?: Caller): TaskHierarchy
  hierarchyPreview(ref: string): TaskHierarchyPreview
  setParent(ref: string, input: SetTaskParentRequest): Task
  unarchive(ref: string, input?: UnarchiveTaskRequest): Promise<Task>
  reset(ref: string): Promise<Task>
  delete(ref: string, options: DeleteTaskRequest): Promise<void>
  removeFactoryTasks(factoryId: string, options: { closePullRequests: boolean }): Promise<void>
  block(ref: string, caller: Caller, by: string): Promise<Task>
  unblock(ref: string, caller: Caller, by?: string): Task
  slots(): Promise<RunSlots>
  publishedSlots(): RunSlots | undefined
  subscribe(listener: (event: DaemonEvent) => void): () => void
  comment(
    ref: string,
    caller: Caller,
    input: {
      body: string
      choices?: string[]
      round?: RoundInput
      proposal?: ProposalInput
      sizeCheck?: SizeCheckInput
      supersedes?: string
      attachments?: Attachment[]
      tutorial?: boolean
    },
  ): Promise<Comment>
  upload(ref: string, caller: Caller, save: () => Promise<Attachment>): Promise<Attachment>
  uploadForCreate(caller: Caller, save: () => Promise<Attachment>): Promise<Attachment>
  taskGates(ref: string): Promise<TaskGates>
  setTaskAutopilot(ref: string, caller: Caller, request: SetTaskAutopilotRequest): Promise<Task>
  answerAutopilot(ref: string, id: string, caller: Caller, request: AnswerRequest): Promise<Comment>
  setTaskGates(ref: string, caller: Caller, request: SetTaskGatesRequest): Promise<TaskGates>
  setClarifyDepth(ref: string, caller: Caller, request: SetClarifyDepthRequest): Promise<Task>
  markRead(ref: string): number
  threadEvents(ref: string): ThreadEvent[]
  setActivity(ref: string, caller: Caller, text: string): Task
  reportOutcome(ref: string, caller: Caller, outcome: OutcomeInput): Promise<OutcomeResult>
  answer(commentId: string, answer: AnswerRequest): Promise<Comment>
  coordinatorTell(ref: string, body: string): Promise<Comment>
  coordinatorAnswer(commentId: string, answer: AnswerRequest, mark: string): Promise<Comment>
  coordinatorResume(ref: string, comment?: string): Promise<Task>
  coordinatorCreate(
    factoryId: string,
    input: Omit<CreateTaskInput, 'factory' | 'coordinatorOperation'>,
    operation: string,
  ): Promise<Task>
  isFailureDecision(commentId: string): boolean
  talkThrough(commentId: string, request: TalkThroughRequest): Promise<TalkThroughResult>
  doneTalking(commentId: string): Promise<Comment>
  closeRound(ref: string, caller: Caller, summary: string): Promise<Comment>
  writeBrief(ref: string, caller: Caller, text: string): TaskBrief
  brief(ref: string, caller: Caller): TaskBrief
  peers: Peers
  inbox(): InboxItem[]
  answered(): InboxItem[]
  setLead(ref: string, lead: TaskLead): Task
  useDefaultModel(ref: string): Promise<Task>
  restartLead(ref: string): Promise<Task>
  setupLog(ref: string, repo: string): Promise<string>
  worktreeAccess(ref: string, repo: string): Promise<WorktreeAccess>
  changes(ref: string): Promise<TaskChanges>
  pullRequestChanges(ref: string, repo: string): Promise<PullRequestChanges>
  files(ref: string): Promise<TaskFiles>
  file(ref: string, repo: string, path: string): Promise<TaskFileContent>
  fileDiffs(ref: string, repo: string, path?: string): Promise<FileDiff[]>
  commits(ref: string, ids: readonly string[]): Promise<TaskCommit[]>
  commitChanges(ref: string, id: string): Promise<CommitChanges>
  lineComments(ref: string): Promise<LineComment[]>
  draftLineComment(ref: string, request: DraftLineCommentRequest): Promise<LineComment>
  editLineComment(id: string, body: string): LineComment
  deleteLineComment(id: string): void
  discardLineComments(ref: string): void
  sendLineComments(ref: string): Promise<Comment>
  setRepos(ref: string, caller: Caller, request: SetTaskReposRequest): Promise<TaskReposResult>
  repoSetup(ref: string, repo: string, caller: Caller): Promise<RepoSetupReport>
  runChecks(ref: string, caller: Caller, only?: string): Promise<CheckRun>
  checkRun(id: string, caller: Caller): Promise<CheckRunReport>
  checkOutput(id: string, position: number): Promise<{ text: string; log: string }>
  wake(factoryId?: string): void
  startSubAgent(ref: string, caller: Caller, input: StartSubAgentRequest): Promise<SubAgent>
  waitForSubAgent(runId: string, caller: Caller, timeoutMs: number): Promise<SubAgentWait>
  sendSubAgent(runId: string, caller: Caller, text: string): Promise<SubAgent>
  stopSubAgent(runId: string, caller: Caller): Promise<SubAgent>
  addQueueSource(source: QueueSource): () => void
  mergesInFlight(): number
  browserApp(ref: string, caller: Caller, app: AppRef): Promise<TaskApp>
  browserCommand(ref: string, caller: Caller, request: BrowserRequest): Promise<BrowserResult>
  browserCaptureAccess(ref: string, caller: Caller, hash: string): Attachment
  browserPoll(session: string): Promise<BrowserCommand | null>
  browserReply(session: string, id: string, reply: BrowserReply): void
  browserCapture(session: string, id: string, save: () => Promise<Attachment>): Promise<Attachment>
  listApps(ref: string, caller: Caller): Promise<TaskApp[]>
  startApp(ref: string, caller: Caller, app: StartAppRequest): Promise<TaskApp>
  stopApp(ref: string, app: AppRef): Promise<TaskApp>
  restartApp(ref: string, app: AppRef): Promise<TaskApp>
  appLog(ref: string, app: AppRef): Promise<AppLog>
  showApp(ref: string, app: AppRef): Promise<TaskApp>
  screenshotApp(ref: string, caller: Caller, app: AppRef): Promise<AppCapture>
  recordApp(ref: string, caller: Caller, request: RecordAppRequest): Promise<AppCapture>
  simulators(): SimulatorSlots
  emulators(): SimulatorSlots
  setRunAppOwner(owner: RunAppOwner): void
  listRunApps(runId: string, caller: Caller): Promise<TaskApp[]>
  startRunApp(runId: string, caller: Caller, app: StartAppRequest): Promise<TaskApp>
  stopRunApp(runId: string, caller: Caller, app: AppRef): Promise<TaskApp>
  showRunApp(runId: string, caller: Caller, app: AppRef): Promise<TaskApp>
  runAppLog(runId: string, caller: Caller, app: AppRef): Promise<AppLog>
  stopRunApps(runId: string): Promise<void>
  runBrowserCommand(runId: string, caller: Caller, request: BrowserRequest): Promise<BrowserResult>
  runBrowserCapture(runId: string, caller: Caller, hash: string): Attachment
  runDeviceCommand(runId: string, caller: Caller, request: DeviceRequest): Promise<DeviceResult>
  planApproved(taskId: string, input: PlanApproval): Promise<void>
  stopLeadForChildren(taskId: string): Promise<void>
  planEnded(taskId: string, input: PlanEnd): Promise<void>
  close(): Promise<void>
}

const slugLength = 40
const recordedConflictFiles = 50
const handOffCheckLimit = 3

function withoutRepeats(files: readonly Attachment[]): Attachment[] {
  const seen = new Map<string, Attachment>()
  for (const { hash, name, size, mediaType } of files) {
    seen.set(`${hash}:${name}`, { hash, name, size, mediaType })
  }
  return [...seen.values()]
}

export function createTasks(options: {
  testReportingEnv?: (
    task: Task,
    checkRunId: string,
    position: number,
    supported: boolean,
  ) => Promise<Record<string, string>>
  steering: Steering
  store: TedStore
  runs: RunManager
  workflows: Workflows
  banners: Banners
  reposDir: string
  worktreesDir: string
  logsDir: string
  libraryDir?: string
  runsDir?: string
  agents: Agents
  health: AgentHealthMonitor
  attachmentFile: (attachment: Attachment) => string
  linear?: Pick<Linear, 'issueFor'> &
    Partial<LinearSyncApi> &
    Partial<Pick<Linear, 'intakeMembership'>>
  linearSyncMs?: number
  asana?: {
    read: AsanaRead
    user(): Promise<{ gid: string; name: string }>
    files?: FileStore
    allowLoopbackFiles?: boolean
    intakeLimit?: number
    comment?(gid: string, text: string, account: string): Promise<void>
    complete?(gid: string, account: string): Promise<void>
    account?(): Promise<string | undefined>
  }
  asanaSyncMs?: number
  isCloned?: (factoryId: string) => boolean
  idle?: IdleTimer
  gh?: Gh
  env?: () => NodeJS.ProcessEnv
  clock?: Clock
  nudgeAfterMs?: number
  mergePollMs?: number
  githubReadBurst?: number
  beforeMerge?: (taskId: string) => Promise<void>
  ciStuckMs?: { noChecks: number; pending: number }
  stallAfterMs?: number
  snoozes?: { now?: () => Date; checkEveryMs?: number }
  heldRequests?: { maxMs?: number }
  load?: { ratio?: () => number; checkEveryMs?: number }
  appsDir?: string
  apps?: Pick<AppsOptions, 'pollMs' | 'readyTimeoutMs' | 'stopGraceMs' | 'logBytes'>
  simulators?: Omit<SimulatorOptions, 'dir' | 'banners'> & { dir?: string }
  emulators?: Omit<EmulatorOptions, 'dir' | 'banners'> & { dir?: string }
  saveAttachment?: (file: string, name: string, mediaType: string) => Promise<Attachment>
  planning?: () => TaskPlanning | undefined
  sandbox: Sandbox
  checkSlots: CheckSlots
}): Tasks {
  const {
    store,
    runs,
    workflows,
    banners,
    reposDir,
    worktreesDir,
    logsDir,
    agents,
    health,
    attachmentFile,
  } = options
  const execution = createTaskExecution(store)
  const lifecycle = createLocalLifecycle({
    store,
    banners,
    reposDir,
    worktreesDir,
    logsDir,
    sandbox: options.sandbox,
    sandboxSockets: async (taskId) => sandboxSockets(find(taskId)),
    env: () => options.env?.() ?? process.env,
  })

  async function removeRepoWorktree(
    task: StoredTask,
    repo: Pick<TaskRepo, 'name' | 'repo'>,
  ): Promise<void> {
    const ref = await execution.local(task.id)
    await lifecycle.remove(lifecycle.worktree(ref, repo))
  }
  const peers = createPeers(store, (id) => options.steering.syncQueuedFlag(id))
  const starting = new Set<string>()
  const finishingParents = new Set<string>()
  const parentsChecked = new Set<string>()
  const promptComments = new Set<string>()
  const relaunching = new Set<string>()
  const continuing = new Set<string>()
  const continuationFailures = new Set<string>()
  const pullRequestChangeReads = new Map<string, Promise<PullRequestChanges>>()
  const advancing = new Set<string>()
  const released = new Map<string, Promise<void>>()
  const humanWaitMs = 15_000
  const stoppingForBlockers = new Set<string>()
  const runUploads = new Set<string>()
  const automationUploads = new Set<string>()
  const checkOwnFiles = (task: StoredTask, files: readonly Attachment[]) => {
    const known = new Set(store.taskFiles(task.id).map((a) => a.hash))
    const foreign = files.find((a) => !known.has(a.hash) && !runUploads.has(`${task.id}:${a.hash}`))
    if (foreign) {
      throw new RequestError(
        403,
        `${foreign.name} isn’t on ${task.displayId}; attach your own files with ted comment --attach`,
      )
    }
  }
  const plainText = (comment: Comment): string => {
    const files = comment.attachments ?? []
    return [
      comment.body,
      ...(files.length > 0
        ? [`Attached files:\n${files.map((a) => `- ${a.name}: ${attachmentFile(a)}`).join('\n')}`]
        : []),
    ]
      .filter((part) => part !== '')
      .join('\n\n')
  }
  const linesText = (comment: Comment): string | undefined =>
    comment.lineComments === undefined
      ? undefined
      : lineCommentsText(comment.lineComments, comment.taskId, (id) => store.getTask(id)?.displayId)
  const commentText = (comment: Comment): string =>
    [plainText(comment), linesText(comment) ?? ''].filter((part) => part !== '').join('\n\n')
  const linearConsent = createTrackerConsent(store, linearConnector(), linearRecords(store))
  const trackerConsents: TrackerConsent[] = [linearConsent]
  const drafts = (taskId: string): string[] => store.lineCommentDrafts(taskId).map((c) => c.id)
  const stoppingByHand = new Set<string>()
  const clock = options.clock ?? systemClock
  const nudgeTimers = new Map<string, Timer>()
  const nudgeAfterMs = options.nudgeAfterMs ?? 60_000
  const stallAfterMs = options.stallAfterMs ?? 30 * 60_000
  const overnightSeen = new Map<string, boolean>()
  const mergeGuards = new Map<string, { key: string; guard: OvernightGuard | undefined }>()
  let overnightChangedAt = new Date().toISOString()
  const background = new Set<Promise<void>>()
  const stopping = new AbortController()
  const holds = new Map<string, number>()
  const beginning = new Map<string, Promise<void>>()
  const settingUp = new Map<string, AbortController>()
  const repoSetups = new Map<string, AbortController>()
  const changingRepos = new Map<string, Promise<TaskReposResult>>()
  const caps = new Map<string, number | undefined>()
  const listeners = new Set<(event: DaemonEvent) => void>()
  const checking = new Set<string>()
  const mergeWaits = new Map<string, AbortController>()
  const checkWaits = new Map<string, AbortController>()
  options.checkSlots.watch((places) => store.setChecksWaiting(places))
  const checksIdle = new Map<string, (() => void)[]>()
  function setChecking(taskId: string, on: boolean): void {
    if (on) checking.add(taskId)
    else {
      checking.delete(taskId)
      mergeWaits.get(taskId)?.abort()
      if (merging.has(taskId)) watch?.kick()
      const waiting = checksIdle.get(taskId)
      checksIdle.delete(taskId)
      for (const resolve of waiting ?? []) resolve()
    }
    store.setTaskChecking(taskId, on)
  }
  const untilChecksIdle = (taskId: string) =>
    checking.has(taskId)
      ? new Promise<void>((resolve) =>
          checksIdle.set(taskId, [...(checksIdle.get(taskId) ?? []), resolve]),
        )
      : Promise.resolve()
  const sandboxDir = path.join(path.dirname(worktreesDir), 'sandbox')
  const pullRequests = options.gh && createPullRequests({ store, gh: options.gh })
  let runAppOwner: RunAppOwner | undefined
  let ownerSet: (owner: RunAppOwner) => void = () => {}
  const ownerKnown = new Promise<RunAppOwner>((resolve) => {
    ownerSet = resolve
  })

  async function ownerAppTask(id: string): Promise<AppTask> {
    if (store.getTask(id) === undefined && store.automations.firing(id) !== undefined) {
      const owner = await ownerKnown
      await owner.ready
      if (owner.owns(id)) return owner.appTask(id)
    }
    return appTask(id)
  }
  const runBrowsers = createRunBrowsers({
    dir: path.join(path.dirname(worktreesDir), 'browsers'),
    env: () => options.env?.() ?? process.env,
    lowPriority: () => store.settings().lowPriorityWork,
  })
  const apps = createApps({
    appsDir: options.appsDir ?? path.join(path.dirname(worktreesDir), 'apps'),
    store,
    ...(options.env !== undefined && { env: options.env }),
    ...(options.idle !== undefined && { idle: options.idle }),
    ...options.apps,
    simulators: {
      dir: path.join(path.dirname(worktreesDir), 'simulators'),
      ...options.simulators,
      banners,
    },
    emulators: {
      dir: path.join(path.dirname(worktreesDir), 'emulators'),
      ...options.emulators,
      banners,
    },
    emit: (event) => {
      if (event.type === 'apps-changed' && runBrowsers.opened(event.taskId)) {
        const runId = event.taskId
        void apps.list(runId).then(
          (list) => runBrowsers.appsChanged(runId, list),
          () => runBrowsers.close(runId),
        )
      }
      for (const listener of listeners) listener(event)
    },
    keep(taskId) {
      const task = store.getTask(taskId)
      if (task === undefined) return store.automations.firing(taskId)?.state === 'started'
      return !task.archived && task.stage !== 'done'
    },
    task: ownerAppTask,
    sandbox: options.sandbox,
    sandboxProblem,
  })

  async function sandboxProblem(factoryId: string): Promise<string | undefined> {
    const ref = { problem: 'sandbox-unavailable', factoryId }
    const problem = await options.sandbox.problem()
    if (problem === undefined) {
      if (store.getBanner(bannerId(ref))) banners.clear(ref)
      return undefined
    }
    banners.raise({ ...ref, severity: 'stops-work', text: problem })
    return problem
  }

  async function sandboxSockets(task: StoredTask): Promise<readonly string[]> {
    return (await taskWorkflow(task, { fetch: false })).workflow.settings.sandbox_sockets ?? []
  }

  async function sandboxScope(
    task: StoredTask,
    repos: readonly TaskRepo[] = task.repos,
  ): Promise<Omit<SandboxScope, 'tmp'>> {
    const live = repos.filter((r) => !r.removed)
    return {
      writable: [...new Set(live.map((r) => r.worktree))],
      readable: [...new Set(live.map((r) => clonePath(reposDir, r)))],
      cache: path.join(sandboxDir, task.displayId, 'cache'),
      sockets: await sandboxSockets(task),
    }
  }

  async function prepareCommandLaunch(
    task: StoredTask,
    repos: readonly TaskRepo[] = task.repos,
  ): Promise<CommandLaunch> {
    const release = await acquireFactoryPermissions(store, task.factoryId)
    try {
      if (factoryPermissions(store, task.factoryId) === 'bypass') return { release }
      await sandboxProblem(task.factoryId)
      return {
        release,
        sandbox: {
          sandbox: options.sandbox,
          scope: await sandboxScope(task, repos),
          tmpRoot: path.join(sandboxDir, task.displayId),
        },
      }
    } catch (error) {
      release()
      throw error
    }
  }

  async function appTask(taskId: string): Promise<AppTask> {
    const task = find(taskId)
    const live = task.repos.filter((r) => !r.removed)
    if (live.length === 0) {
      return { displayId: task.displayId, factoryId: task.factoryId, repos: [] }
    }
    const factory = factoryOf(task)
    const entries = factoryRepos(
      (await resolveWorkflow(factory, { fetch: false })).workflow,
      factory,
    )
    const setupApps = task.setup ? await approvedSetupApps(task) : undefined
    const bypass = runsInBypass(await taskWorkflow(find(task.id), { fetch: false }))
    const scope = await sandboxScope(task)
    return {
      displayId: task.displayId,
      factoryId: task.factoryId,
      cache: scope.cache,
      ...(!bypass && {
        sandbox: scope,
        outsideSandbox: store.settings().appsOutsideSandbox[task.factoryId] ?? [],
      }),
      repos: live.map((repo) => {
        const entry = repoEntry(entries, repo)
        return {
          name: repo.name,
          worktree: repo.worktree,
          env: store.recordedSetup(task.id, repo.name)?.env ?? entry?.env ?? {},
          apps: setupApps ? (setupApps.get(repo.name) ?? []) : (entry?.apps ?? []),
        }
      }),
    }
  }

  const browser = createBrowserBroker()
  const browserApps = new Map<string, BrowserAppRef>()

  async function browserApp(ref: string, caller: Caller, app?: BrowserAppRef) {
    const { task } = runnableApps(ref, caller)
    if (caller.kind === 'run' && store.getRun(caller.runId)?.state === 'finished')
      throw new RequestError(403, 'This Run has ended')
    const selected = app ?? browserApps.get(task.id)
    if (!selected) throw new RequestError(409, 'Open a web App with ted browser open first')
    const matches = (await apps.list(task.id)).filter(
      (a) => a.name === selected.name && (selected.repo === undefined || a.repo === selected.repo),
    )
    const shown = matches.length === 1 ? matches[0] : undefined
    if (shown?.kind !== 'web' || shown.state !== 'running' || !shown.url || shown.removed) {
      throw new RequestError(409, 'Choose a running web App and its repo')
    }
    return { task, app: shown }
  }

  function appCaller(
    ref: string,
    caller: Caller,
  ): { task: StoredTask; by: AppStarter; runId?: string } {
    if (caller.kind === 'run') {
      const { task, runId } = ownTask(ref, caller)
      const by = store.getRun(runId)?.parentRunId === undefined ? 'task-lead' : 'sub-agent'
      return { task, by, runId }
    }
    return { task: find(ref), by: 'human' }
  }

  async function saveCapture(
    task: StoredTask,
    runId: string | undefined,
    file: string,
    name: string,
    mediaType: string,
    body: string,
  ): Promise<Attachment> {
    if (!options.saveAttachment) {
      await rm(file, { force: true })
      throw new RequestError(503, 'TED can’t save files here')
    }
    const attachment = await options
      .saveAttachment(file, name, mediaType)
      .finally(() => rm(file, { force: true }))
    if (runId === undefined) await humanComment(task, body, [attachment])
    else
      store.postComment({
        taskId: task.id,
        body,
        author: { kind: 'run', runId },
        attachments: [attachment],
      })
    return attachment
  }

  async function saveRunCapture(runId: string, file: string, app: string): Promise<Attachment> {
    if (!options.saveAttachment) throw new RequestError(503, 'TED can’t save files here')
    const attachment = await options
      .saveAttachment(file, `${app} screenshot.png`, 'image/png')
      .finally(() => rm(file, { force: true }))
    store.automations.recordBrowserCapture(runId, attachment)
    await store.persisted()
    automationUploads.add(`${runId}:${attachment.hash}`)
    return attachment
  }

  async function ownedRun(runId: string, caller: Caller): Promise<void> {
    if (caller.kind === 'run' && caller.runId !== runId) {
      throw new RequestError(403, 'A Run can reach only its own Apps')
    }
    await runAppOwner?.ready
    if (runAppOwner?.owns(runId) !== true) {
      throw new RequestError(404, 'This Run has no checkout, so it has no Apps')
    }
  }

  function runnableApps(ref: string, caller: Caller) {
    const found = appCaller(ref, caller)
    if (found.task.archived)
      throw new RequestError(409, `${found.task.displayId} is archived, so its Apps don’t run`)
    if (found.task.stage === 'done')
      throw new RequestError(409, `${found.task.displayId} is Done, so its Apps don’t run`)
    return found
  }
  const pullRequestQueue = new Map<string, Promise<void>>()
  const clearingAway = new Map<string, Promise<void>>()
  const deleting = new Set<string>()
  const hierarchyBusy = new Set<string>()
  const removingFactories = new Set<string>()
  const merging = new Set<string>()
  const mergePollMs = options.mergePollMs ?? 30_000
  const ciStuckMs = options.ciStuckMs ?? { noChecks: 10 * 60_000, pending: 60 * 60_000 }
  const watch =
    options.gh &&
    createPullRequestWatch({
      gh: options.gh,
      clock,
      everyMs: mergePollMs,
      ...(options.githubReadBurst !== undefined && { urgentBurst: options.githubReadBurst }),
      refs: watchedPullRequests,
      onRead: reactToGitHub,
      inBackground: (what, work) => inBackground(what, work),
    })
  const trackerActions: TrackerTaskActions = {
    gone: (taskId) => deleting.has(taskId),
    liveRun: (task) => hasLiveRun(find(task.id)),
    openRequests,
    archive(task, why) {
      settleDependents(task.id, 'unblock')
      archiveNow(find(task.id), false, why)
      wake()
    },
    under: (taskId) => underToArchive(taskId).map((id) => find(id)),
  }
  const linearApi = options.linear
  const linearSync =
    linearApi?.issueStates &&
    linearApi.teamStates &&
    linearApi.moveIssue &&
    linearApi.linkUrl &&
    createLinearSync({
      store,
      linear: {
        issueStates: linearApi.issueStates,
        teamStates: linearApi.teamStates,
        moveIssue: linearApi.moveIssue,
        linkUrl: linearApi.linkUrl,
      },
      actions: trackerActions,
      clock,
      everyMs: options.linearSyncMs ?? 60_000,
      // A hold released on every cycle would start the idle exit’s time again for ever.
      inBackground: (what, work) => inBackground(what, work, false),
    })
  const asanaApi = options.asana
  const asanaSync =
    asanaApi?.comment &&
    asanaApi.complete &&
    asanaApi.account &&
    createAsanaSync({
      store,
      asana: {
        read: asanaApi.read,
        comment: asanaApi.comment,
        complete: asanaApi.complete,
        account: asanaApi.account,
      },
      actions: trackerActions,
      clock,
      everyMs: options.asanaSyncMs ?? 60_000,
      inBackground: (what, work) => inBackground(what, work, false),
    })
  if (asanaSync) trackerConsents.push(asanaSync.consent)
  const sources: QueueSource[] = []
  let pumping: Promise<void> | undefined
  let again = false
  let shownSlots = ''
  let publishedSlots: RunSlots | undefined
  const loadRatio = options.load?.ratio ?? machineLoadRatio
  let heldAtLoad: number | undefined
  let loadTimer: NodeJS.Timeout | undefined
  const autoStartFailures = new Set<string>()
  let backlogVersion = 0

  function hold(taskId: string): () => void {
    holds.set(taskId, (holds.get(taskId) ?? 0) + 1)
    publishQueueActivity()
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (holds.get(taskId) ?? 1) - 1
      if (left > 0) holds.set(taskId, left)
      else {
        holds.delete(taskId)
        setImmediate(() => {
          if (!closed) pendingTalks(taskId)
        })
      }
      void pump()
    }
  }

  function remember(factoryId: string, resolution: WorkflowResolution): WorkflowResolution {
    caps.set(factoryId, resolution.workflow.settings.max_working_runs)
    return resolution
  }

  async function resolveWorkflow(
    factory: StoredFactory,
    options?: { fetch?: boolean },
  ): Promise<WorkflowResolution> {
    return remember(factory.id, await workflows.resolve(factory, options))
  }

  async function taskWorkflow(
    task: StoredTask,
    options?: { fetch?: boolean; inheritedGates?: boolean; keepGates?: OvernightGuard },
  ): Promise<WorkflowResolution> {
    const factory = factoryOf(task)
    const resolution = await resolveWorkflow(factory, options)
    const chosen = withTaskGates(
      resolution.workflow,
      options?.inheritedGates ? {} : task.gateOverrides,
    )
    const kept = taskAutopilot(task) ? options?.keepGates : undefined
    const night =
      taskAutopilot(task) && !options?.inheritedGates && kept === undefined
        ? withoutGates(chosen)
        : { workflow: chosen, off: [] }
    const forced = withForcedGates(
      night.workflow,
      kept !== undefined && !task.forcedGates.includes('review')
        ? [...task.forcedGates, 'review']
        : task.forcedGates,
    )
    const based = task.changesSettings ? onDefaultBranch(forced) : forced
    const workflow = task.setup
      ? setupWorkflow(based, await setupInstructions(factory.showTutorial))
      : based
    const overnightGates = night.off.filter((id) => workflow.settings.stages[id]?.gate !== true)
    if (kept !== undefined) {
      const stages = agentStageIds.filter(
        (id) =>
          workflow.stages.includes(id) &&
          workflow.settings.stages[id]?.gate === true &&
          !task.forcedGates.includes(id) &&
          !(task.setup && (id === 'design' || id === 'review')),
      )
      return { ...resolution, workflow: { ...workflow, overnightKept: { reason: kept, stages } } }
    }
    if (overnightGates.length === 0) return { ...resolution, workflow }
    return { ...resolution, workflow: { ...workflow, overnightGates } }
  }

  function primaryRepo(task: StoredTask, workflow: ResolvedWorkflow) {
    const entries = factoryRepos(workflow, factoryOf(task))
    const repo = task.repos.find(
      (r) => !r.removed && (repoEntry(entries, r)?.name ?? r.name) === (entries[0]?.name ?? ''),
    )
    return { repo, baseBranch: repo && repoEntry(entries, repo)?.baseBranch, repos: entries.length }
  }

  async function settingsFingerprint(worktree: string): Promise<string> {
    const seen: string[] = []
    const walk = async (file: string): Promise<void> => {
      const info = await lstat(file).catch(() => undefined)
      if (!info) return
      seen.push(`${file}:${info.size}:${info.mtimeMs}:${info.ino}`)
      if (!info.isDirectory()) return
      for (const name of (await readdir(file)).sort()) await walk(path.join(file, name))
    }
    await walk(path.join(worktree, '.ted'))
    return createHash('sha256').update(seen.join('\n')).digest('hex')
  }

  async function settingsGuard(
    task: StoredTask,
    workflow: ResolvedWorkflow,
  ): Promise<OvernightGuard | undefined> {
    if (!task.repos.some((r) => !r.removed)) {
      return task.stage === 'backlog' ? undefined : 'unreadable'
    }
    const { repo, baseBranch, repos } = primaryRepo(task, workflow)
    if (!repo) return repos > 1 ? undefined : 'unreadable'
    try {
      const atMerge = task.stage === 'merge'
      const signed = atMerge ? repo.pullRequest?.signedOff : undefined
      const head = atMerge ? await git.headCommit(repo.worktree) : ''
      const edits = atMerge ? await settingsFingerprint(repo.worktree) : ''
      const key = `${visitStart(task)}:${head}:${signed ?? ''}:${edits}`
      const cached = atMerge ? mergeGuards.get(task.id) : undefined
      if (cached?.key === key) return cached.guard
      const base = `origin/${baseBranch ?? (await git.defaultBranch(repo.worktree))}`
      let touched = touchesSettings(await git.changedFiles(repo.worktree, base))
      if (!touched && signed !== undefined && signed !== head) {
        const from = await git.mergeBase(repo.worktree, base, signed)
        const merging = await git.changesBetween(repo.worktree, { from, to: signed })
        touched = touchesSettings(merging.map((f) => f.path))
      }
      const guard = touched ? ('settings' as const) : undefined
      if (atMerge) mergeGuards.set(task.id, { key, guard })
      return guard
    } catch {
      return 'unreadable'
    }
  }

  async function gateWorkflow(
    task: StoredTask,
    options?: { fetch?: boolean },
  ): Promise<WorkflowResolution> {
    const plain = await taskWorkflow(task, options)
    if (!taskAutopilot(task)) return plain
    const guard = await settingsGuard(task, plain.workflow)
    if (guard === undefined) return plain
    const kept = await taskWorkflow(task, { fetch: false, keepGates: guard })
    const { workflow } = kept
    if (task.stage !== 'merge' || !workflow.overnightKept) return kept
    const unseen = !(await approvalBound(task, workflow))
    return {
      ...kept,
      workflow: { ...workflow, overnightKept: { ...workflow.overnightKept, unseen } },
    }
  }

  async function approvalBound(task: StoredTask, workflow: ResolvedWorkflow): Promise<boolean> {
    const { repo } = primaryRepo(task, workflow)
    const signed = repo?.pullRequest?.signedOff
    if (!repo || signed === undefined) return false
    const since =
      store.listStageEntries(task.id).findLast((e) => e.stage !== 'review' && e.stage !== 'merge')
        ?.at ?? ''
    const bound = new Set(store.approvalsBoundToCommit(task.id, signed))
    const approved = store
      .listComments(task.id)
      .filter(
        (c) => c.gate && c.answer?.kind === 'approved' && c.answer.at >= since && bound.has(c.id),
      )
    if (approved.some((c) => c.stage === 'merge')) return true
    if (!approved.some((c) => c.stage === 'review')) return false
    return git.headCommit(repo.worktree).then(
      (head) => head === signed,
      () => false,
    )
  }

  async function requestCommit(
    task: StoredTask,
    workflow: ResolvedWorkflow,
  ): Promise<{ name: string; commit: string } | undefined> {
    const { repo } = primaryRepo(task, workflow)
    if (!repo) return undefined
    return git.headCommit(repo.worktree).then(
      (commit) => ({ name: repo.name, commit }),
      () => undefined,
    )
  }

  async function bindApproval(
    task: StoredTask,
    comment: Comment,
    workflow: ResolvedWorkflow,
  ): Promise<void> {
    if (comment.stage !== 'review' && comment.stage !== 'merge') return
    const { repo, baseBranch } = primaryRepo(task, workflow)
    if (!repo) return
    let commit = repo.pullRequest?.signedOff
    if (comment.stage === 'review') {
      const requested = store.gateRequestCommit(task.id, comment.id)
      commit = await (async () => {
        const base = `origin/${baseBranch ?? (await git.defaultBranch(repo.worktree))}`
        const changes = await git.workingChanges(repo.worktree, base)
        const same = changes.head === requested && !changes.files.some((f) => f.uncommitted)
        return same ? changes.head : undefined
      })().catch(() => undefined)
    }
    if (commit !== undefined) store.gateApprovalBound(task.id, comment.id, repo.name, commit)
  }

  function gateKept(task: Task): boolean {
    return store.overnightGateHistory(task.id, task.stage, visitStart(task)).kept
  }

  function gateRequested(task: Task): boolean {
    const since = visitStart(task)
    return store
      .listComments(task.id)
      .some((c) => c.gate && c.stage === task.stage && c.createdAt >= since)
  }

  function gateOn(task: Task, workflow: ResolvedWorkflow, stage: AgentStageId): boolean {
    if (workflow.settings.stages[stage]?.gate === true) return true
    if (stage === task.stage && openGateRequest(task)) return true
    return (
      workflow.overnightGates?.includes(stage) === true &&
      stage === task.stage &&
      gateRequested(task)
    )
  }

  function gateSkipped(task: Task): boolean {
    return store.overnightGateHistory(task.id, task.stage, visitStart(task)).skipped
  }

  async function gatesFor(taskId: string): Promise<TaskGates> {
    const plain = await taskWorkflow(find(taskId), { fetch: false, inheritedGates: true })
    const task = find(taskId)
    const finished = task.archived || task.stage === 'done'
    const overnightMode = taskAutopilot(task)
    const guard = overnightMode && !finished ? await settingsGuard(task, plain.workflow) : undefined
    const { workflow } =
      guard === undefined
        ? plain
        : await taskWorkflow(task, { fetch: false, inheritedGates: true, keepGates: guard })
    const overrides = task.gateOverrides ?? {}
    const position = workflow.order.indexOf(task.stage as AgentStageId)
    const rows = workflow.order
      .filter((stage) => workflow.stages.includes(stage))
      .map((stage) => {
        const required = task.forcedGates.includes(stage)
          ? 'Required by TED for this Task'
          : task.setup && ['design', 'review'].includes(stage)
            ? 'Required for Factory setup'
            : stage === 'review' && guard === 'settings'
              ? 'Required while Autopilot is on: this Task changes .ted/'
              : stage === 'review' && guard === 'unreadable'
                ? 'Required while Autopilot is on: TED couldn’t read this Task’s changes'
                : undefined
        const posted = stage === task.stage && gateRequested(task)
        const locked = finished
          ? 'This Task has finished'
          : (required ??
            (stage === 'merge' && task.stage === 'merge'
              ? 'Merge has started'
              : workflow.order.indexOf(stage) < position
                ? 'Stage already passed'
                : posted
                  ? 'Sign-off has been requested; answer it in the thread'
                  : undefined))
        const inherited = required !== undefined || workflow.settings.stages[stage]?.gate === true
        const chosen = required !== undefined || (overrides[stage] ?? inherited)
        const atMerge = stage === 'merge' && task.stage === 'merge'
        const overnight =
          chosen &&
          required === undefined &&
          guard === undefined &&
          !finished &&
          !posted &&
          (atMerge && gateSkipped(task)
            ? true
            : overnightMode && workflow.order.indexOf(stage) >= position)
        return {
          stage,
          inherited,
          effective: chosen && !overnight,
          required: required !== undefined,
          ...(overrides[stage] !== undefined && { override: overrides[stage] }),
          ...(overnight && { overnight: true as const }),
          ...(locked && { locked }),
        }
      })
    return { overrides, rows, revision: JSON.stringify({ stage: task.stage, overrides, rows }) }
  }

  async function capOf(factoryId: string): Promise<number | undefined> {
    if (caps.has(factoryId)) return caps.get(factoryId)
    const factory = store.getFactory(factoryId)
    if (!factory) return undefined
    const resolution = await workflows.resolve(factory, { fetch: false }).catch(() => undefined)
    if (!resolution) return undefined
    return remember(factoryId, resolution).workflow.settings.max_working_runs
  }

  // The pump reads the same Tasks several times per pass. A built Task is reused only
  // while store.taskVersion() is unchanged, so it is never older than the store.
  let builtAt = -1
  const built = new Map<string, StoredTask | undefined>()
  let builtList: { key: string; tasks: Task[] } | undefined
  function builtNow(): void {
    const version = store.taskVersion()
    if (version === builtAt) return
    built.clear()
    builtList = undefined
    builtAt = version
  }
  function sameSource(url: string): Task[] {
    const key = sourceKey(url)
    const ids = store
      .taskSourceUrls()
      .flatMap((source) => (sourceKey(source.url) === key ? [source.taskId] : []))
    return store.tasksIn(new Set(ids))
  }
  function taskNow(id: string): StoredTask | undefined {
    builtNow()
    if (!built.has(id)) built.set(id, store.getTask(id))
    return built.get(id)
  }
  function tasksNow(ids: ReadonlySet<string>): Task[] {
    builtNow()
    const key = [...ids].sort().join(' ')
    if (builtList?.key !== key) builtList = { key, tasks: store.tasksIn(ids) }
    return builtList.tasks
  }

  async function slotUse(factoryIds: readonly string[]) {
    const candidates = tasksNow(
      new Set([...store.busyTaskIds(), ...holds.keys(), ...subAgents.startingTasks()]),
    )
    const holders = candidates.flatMap((task) => {
      const working = task.runs.filter(
        (r) => r.state === 'working' && r.paused === undefined && !r.onSubAgents,
      )
      const startingSubAgents = subAgents.starting(task.id)
      const runs = working.length + startingSubAgents
      const subAgentRuns = working.filter((r) => r.role === 'sub-agent').length + startingSubAgents
      const settingUp =
        task.status?.kind !== 'stopped' &&
        !task.statuses.includes('queued') &&
        task.repos.some((r) => !r.removed && r.setup?.state === 'running')
      const slots = Math.max(runs, settingUp || holds.has(task.id) ? 1 : 0)
      return slots > 0 ? [{ task, runs, subAgentRuns, settingUp, slots }] : []
    })
    const byFactory: Record<string, number> = {}
    for (const { task, slots } of holders) {
      byFactory[task.factoryId] = (byFactory[task.factoryId] ?? 0) + slots
    }
    const others = sources.flatMap((source) => source.holders())
    const counted = others.filter((h) => !isChat(h.kind))
    for (const { factoryId, runs } of counted) {
      byFactory[factoryId] = (byFactory[factoryId] ?? 0) + runs
    }
    const capsNow: Record<string, number | undefined> = {}
    for (const id of new Set([
      ...factoryIds,
      ...holders.map((h) => h.task.factoryId),
      ...counted.map((h) => h.factoryId),
    ])) {
      capsNow[id] = await capOf(id)
    }
    const use: SlotUse = {
      limit: store.settings().maxWorkingRuns,
      working:
        holders.reduce((sum, h) => sum + h.slots, 0) + counted.reduce((sum, h) => sum + h.runs, 0),
      byFactory,
      caps: capsNow,
      handoffs: slotHandoffs(
        candidates,
        holders.map((h) => h.task.id),
      ),
      heldForLoad: heldAtLoad !== undefined,
    }
    return { use, holders, others, candidates }
  }

  function slotHandoffs(working: readonly Task[], holding: readonly string[]): Set<string> {
    const taken = new Set(holding)
    const handoffs = new Set<string>()
    for (const request of store.subAgentRequests()) {
      if (taken.has(request.taskId) || !subAgentRunnable(request.id)) continue
      const lead = working
        .find((task) => task.id === request.taskId)
        ?.runs.find((r) => r.id === request.parentRunId)
      if (lead?.state !== 'working' || lead.paused !== undefined || !lead.onSubAgents) continue
      taken.add(request.taskId)
      handoffs.add(request.id)
    }
    return handoffs
  }

  const cloned = (factoryId: string) => options.isCloned?.(factoryId) ?? true
  const ready = (): QueueEntry[] =>
    queueOrder<QueueEntry>([
      ...subAgents.queued(),
      ...continuationsReady(),
      ...runnable(store.queue()).filter((q) => q.factoryId === undefined || cloned(q.factoryId)),
      ...sources.flatMap((source) =>
        source
          .queued()
          .filter(
            (q) => source.runnable(q.id) && (q.factoryId === undefined || cloned(q.factoryId)),
          ),
      ),
    ]).filter((q) => q.kind !== 'sub-agent' || subAgentRunnable(q.id))

  function continuationsReady(includeFailures = false): QueueEntry[] {
    return queueOrder<QueueEntry>(
      store.tasksWithQueuedContinuations().flatMap((id) => {
        const task = taskNow(id)
        if (!task || task.stopped || task.archived || task.waitsForBlockers) return []
        if (
          holds.has(id) ||
          advancing.has(id) ||
          leadLifecycle.applying(id) ||
          hierarchyBusy.has(id) ||
          deleting.has(id) ||
          unfinishedChildren(id)
        )
          return []
        if (!includeFailures && continuationFailures.has(id)) return []
        if (
          !task.pendingLeadMessages.some((message) => message.waitForSlot) &&
          !queuedAnswers(id).length &&
          !(
            availableTalkLead(task) &&
            store.listComments(id).some((comment) => comment.talkRequested && !comment.answer)
          )
        )
          return []
        const run = liveLeadOf(store, task)
        if (!run || !atIdlePoint(run) || store.agentPauses()[run.agent] !== undefined) return []
        const nextAgent =
          task.leadRestartPending || leadLifecycle.restartWaiting(task.id)
            ? (task.lead?.agent ?? run.agent)
            : run.agent
        if (
          !includeFailures &&
          agentStartHold(store, nextAgent, nextAgent === run.agent ? run.id : undefined)
        )
          return []
        return [
          {
            id,
            kind: 'continuation',
            rank: task.rank,
            priority: task.priority,
            factoryId: task.factoryId,
          },
        ]
      }),
    )
  }

  function queuedAnswers(taskId: string): Comment[] {
    return store
      .heldAnswers(taskId)
      .filter((comment) => comment.answerDelivery && !promptComments.has(comment.id))
  }

  function beginContinuation(taskId: string): void {
    continuing.add(taskId)
    const release = hold(taskId)
    inBackground('continue an answered Task', async () => {
      try {
        await applyLead(taskId)
        const current = find(taskId)
        const run = liveLeadOf(store, current)
        const answers = queuedAnswers(taskId)
        if (run && atIdlePoint(run) && answers.length > 0) {
          const accepted = await runs.dispatch(
            run.id,
            answers.map((comment) => ({
              id: comment.id,
              text: `${answerMessage(comment, linesText(comment))}\n\n${overnightGuidance(taskAutopilot(current), current.setup)}`,
            })),
            false,
            (id) => {
              const now = find(taskId)
              const nextAgent = now.lead?.agent ?? run.agent
              return (
                !now.stopped &&
                !now.archived &&
                !now.waitsForBlockers &&
                !agentStartHold(store, nextAgent, nextAgent === run.agent ? run.id : undefined) &&
                store.newWorkHold() === undefined &&
                now.leadRunId === run.id &&
                store.getRun(run.id)?.state !== 'finished' &&
                store.agentPauses()[run.agent] === undefined &&
                (id === undefined || queuedAnswers(taskId).some((comment) => comment.id === id))
              )
            },
          )
          if (accepted) {
            store.answersDelivered(
              answers.map((comment) => comment.id),
              run.id,
            )
            await store.persisted()
          }
        }
        const talking = liveLeadOf(store, find(taskId))
        if (talking) {
          pendingTalks(taskId, true)
          const pending = store.pendingRoundTalks(talking.id)
          if (pending.length > 0) {
            await store.persisted()
            let accepted = false
            while (!closed && !stopping.signal.aborted) {
              const current = store.getTask(taskId)
              const live = store.getRun(talking.id)
              if (
                !current ||
                current.stopped ||
                current.archived ||
                current.stage === 'done' ||
                current.stage === 'backlog' ||
                current.waitsForBlockers ||
                current.leadRunId !== talking.id ||
                !live ||
                live.state === 'finished' ||
                live.problem ||
                store.agentPauses()[live.agent] !== undefined ||
                !store
                  .pendingRoundTalks(talking.id)
                  .some(({ messageId }) =>
                    pending.some((message) => message.messageId === messageId),
                  )
              )
                break
              if (
                store.newWorkHold() === undefined &&
                availableTalkLead(current, true)?.id === talking.id
              ) {
                accepted = await runs.dispatch(
                  talking.id,
                  pending.map(({ messageId, round }) => ({ id: messageId, text: talkLine(round) })),
                  false,
                  (id) => {
                    const current = find(taskId)
                    return (
                      store.newWorkHold() === undefined &&
                      !current.waitsForBlockers &&
                      availableTalkLead(current, true)?.id === talking.id &&
                      store
                        .pendingRoundTalks(talking.id)
                        .some(({ messageId }) => id === undefined || id === messageId)
                    )
                  },
                  { revocable: true, signal: stopping.signal },
                )
                if (accepted) break
              }
              await clockWait(clock, 150, stopping.signal)
            }
            if (accepted) {
              for (const { messageId, round } of store.pendingRoundTalks(talking.id)) {
                if (pending.some((message) => message.messageId === messageId))
                  store.roundTalkNotified(round.id, talking.id, messageId)
              }
              await store.persisted()
            }
          }
        }
      } catch (error) {
        continuationFailures.add(taskId)
        throw error
      } finally {
        continuing.delete(taskId)
        release()
        const run = liveLeadOf(store, find(taskId))
        if (run) await options.steering.refresh(run.id)
      }
    })
  }

  function subAgentRunnable(id: string): boolean {
    const request = store.subAgentRequests().find((r) => r.id === id)
    return (
      request !== undefined &&
      !agentStartHold(store, request.agent) &&
      store.agentPauses()[request.agent] === undefined
    )
  }

  function heldReady(): QueueEntry[] {
    const paused = store.agentPauses()
    return store.heldRuns().flatMap((held) => {
      const task = taskNow(held.taskId)
      const agent = task?.lead?.agent ?? held.agent
      if (
        !task ||
        agentStartHold(store, agent) ||
        paused[agent] !== undefined ||
        holds.has(task.id)
      )
        return []
      if (
        task.waitsForBlockers ||
        task.stopped ||
        hierarchyBusy.has(task.id) ||
        deleting.has(task.id) ||
        unfinishedChildren(task.id)
      )
        return []
      return [{ id: task.id, kind: 'task' as const, rank: -1, factoryId: task.factoryId }]
    })
  }

  function revivesReady(): QueueEntry[] {
    const paused = store.agentPauses()
    return leadLifecycle
      .reviveCandidates()
      .flatMap(({ taskId, factoryId, agent }) =>
        agentStartHold(store, agent, taskNow(taskId)?.leadRunId) ||
        paused[agent] !== undefined ||
        holds.has(taskId) ||
        hierarchyBusy.has(taskId) ||
        deleting.has(taskId) ||
        unfinishedChildren(taskId)
          ? []
          : [{ id: taskId, kind: 'task' as const, rank: -1, factoryId }],
      )
  }

  function backlogEligible(task: StoredTask, preparing = false): boolean {
    return (
      task.stage === 'backlog' &&
      (!task.snoozedUntil || Date.parse(task.snoozedUntil) <= snoozeNow()) &&
      !task.archived &&
      !task.setup &&
      !task.stopped &&
      !task.statuses.includes('failed') &&
      (preparing || !starting.has(task.id)) &&
      !holds.has(task.id) &&
      !autoStartFailures.has(task.id) &&
      !deleting.has(task.id) &&
      !hierarchyBusy.has(task.id) &&
      !removingFactories.has(task.factoryId) &&
      cloned(task.factoryId) &&
      (task.snoozedUntil !== undefined ||
        store.getFactory(task.factoryId)?.autoStartBacklog === true) &&
      unmergedBlockers(task.id).length === 0
    )
  }

  function preparedEligible(task: StoredTask): boolean {
    const agent = task.lead?.agent ?? store.getRun(task.leadRunId ?? '')?.agent
    return (
      store.settings().overnightMode &&
      task.autopilot?.choice !== 'off' &&
      task.preparation === 'ready' &&
      !task.archived &&
      task.runs.length === 0 &&
      !stoppingByHand.has(task.id) &&
      !advancing.has(task.id) &&
      !starting.has(task.id) &&
      !holds.has(task.id) &&
      !deleting.has(task.id) &&
      !hierarchyBusy.has(task.id) &&
      !removingFactories.has(task.factoryId) &&
      cloned(task.factoryId) &&
      (agent === undefined || store.agentPauses()[agent] === undefined) &&
      unmergedBlockers(task.id).length === 0
    )
  }

  function checkLoad(waiting: boolean): void {
    const ratio = waiting && store.settings().adjustRunsToLoad ? loadRatio() : undefined
    const was = heldAtLoad !== undefined
    const held = ratio !== undefined && heldForLoad(was, ratio)
    heldAtLoad = held ? ratio : undefined
    if (held && !loadTimer) {
      loadTimer = setInterval(() => void pump(), options.load?.checkEveryMs ?? 15_000)
      loadTimer.unref()
    } else if (!held) stopLoadTimer()
    if (held !== was) store.holdForLoad(held)
  }

  function stopLoadTimer(): void {
    clearInterval(loadTimer)
    loadTimer = undefined
  }

  let restoreTalkAdmissions = true
  async function fill(): Promise<void> {
    if (closed) return
    if (restoreTalkAdmissions) {
      restoreTalkAdmissions = false
      for (const id of store.tasksWithQueuedContinuations()) {
        const task = store.getTask(id)
        if (
          !task ||
          task.stopped ||
          task.archived ||
          task.stage === 'done' ||
          task.stage === 'backlog' ||
          task.waitsForBlockers ||
          holds.has(id)
        )
          continue
        const run = liveLeadOf(store, task)
        if (!run || run.problem || store.agentPauses()[run.agent] !== undefined) continue
        const pending = store.pendingRoundTalks(run.id)
        if (pending.length === 0) continue
        const consumed = new Set(runs.consumedInputs(run.id))
        if (pending.some(({ messageId }) => consumed.has(messageId))) beginContinuation(id)
      }
    }
    if (store.newWorkHold() !== undefined) return
    for (const id of store.preparedTasks()) {
      const task = taskNow(id)
      if (!task || task.archived || task.preparation !== 'ready') continue
      if (task.runs.length > 0) {
        stopPreparedLead(task)
      }
    }
    const version = backlogVersion
    const automatic = queueOrder<QueueEntry>(
      [...store.backlogTasks(), ...store.preparedTasks().map((id) => ({ id }))]
        .flatMap(({ id }) => {
          const stored = taskNow(id)
          return stored && (backlogEligible(stored) || preparedEligible(stored)) ? [stored] : []
        })
        .map((task) => ({
          id: task.id,
          kind: 'task',
          rank: task.rank,
          priority: task.priority,
          factoryId: task.factoryId,
        })),
    )
    const revives = revivesReady()
    const held = heldReady()
    const queued = ready()
    const waiting = queued.length + held.length + revives.length + automatic.length > 0
    checkLoad(waiting)
    if (!waiting) return
    const { use } = await slotUse(
      [...revives, ...held, ...queued, ...automatic].flatMap((q) => q.factoryId ?? []),
    )
    if (closed || store.newWorkHold() !== undefined) return
    const heldIds = new Set(held.map((h) => h.id))
    const reviveIds = new Set(revives.map((r) => r.id))
    const sourceOf = new Map(
      sources.flatMap((source) => source.queued().map((q) => [q.id, source] as const)),
    )
    for (const entry of startsNow<QueueEntry>([...revives, ...held, ...ready()], use)) {
      if (hierarchyBusy.has(entry.id) || deleting.has(entry.id) || unfinishedChildren(entry.id))
        continue
      if (reviveIds.has(entry.id)) {
        inBackground('resume a Task Lead session', () => leadLifecycle.beginRevive(entry.id))
      } else if (heldIds.has(entry.id)) relaunch(entry.id)
      else if (entry.kind === 'continuation') beginContinuation(entry.id)
      else if (entry.kind === 'sub-agent') subAgents.begin(entry.id)
      else if (sourceOf.has(entry.id)) sourceOf.get(entry.id)?.begin(entry.id)
      else if (!holds.has(entry.id)) begin(entry.id)
    }
    for (const entry of automatic) {
      if (closed || store.newWorkHold() !== undefined) return
      const task = taskNow(entry.id)
      if (!task || !(backlogEligible(task) || preparedEligible(task))) continue
      try {
        const { use } = await slotUse([task.factoryId])
        if (version !== backlogVersion) return
        const before = [...revivesReady(), ...heldReady(), ...ready()]
        if (!startsNow([...before, entry], use).some((q) => q.id === entry.id)) continue
        const current = find(task.id)
        if (current.preparation === 'ready') {
          if (!preparedEligible(current)) continue
          store.resumeTask(task.id, { waitForBlockers: false, overnight: true })
          begin(task.id)
          again = true
          return
        }
        if (await queueStart(task.id, version)) {
          begin(task.id)
          again = true
          return
        }
        if (version !== backlogVersion) return
      } catch (error) {
        autoStartFailures.add(task.id)
        console.error(
          `couldn’t automatically start ${task.displayId}:`,
          redactSecrets(textOf(error)),
        )
      }
    }
  }

  function runnable<T extends { id: string }>(entries: readonly T[]): T[] {
    const paused = store.agentPauses()
    return entries.filter((entry) => {
      const task = taskNow(entry.id)
      if (hierarchyBusy.has(entry.id) || deleting.has(entry.id)) return false
      if (task && unfinishedChildren(task.id)) return false
      const agent = task?.lead?.agent
      return agent === undefined || (!agentStartHold(store, agent) && paused[agent] === undefined)
    })
  }

  function publishQueueActivity(): void {
    const queuedRuns = new Set(subAgents.queued().map((entry) => entry.id))
    for (const source of sources) {
      for (const entry of source.queued()) {
        const described = source.describe(entry.id, 0)
        if (described && 'runId' in described) queuedRuns.add(described.runId)
      }
    }
    const startingRuns = new Set(sources.flatMap((source) => source.starting?.() ?? []))
    for (const request of store.subAgentRequests()) {
      if (!queuedRuns.has(request.id)) startingRuns.add(request.id)
    }
    const ordered = queueOrder<QueueEntry>([
      ...subAgents.queued(),
      ...continuationsReady(true),
      ...store.queue(),
      ...sources.flatMap((source) => source.queued()),
    ])
    for (const entry of ordered) {
      if (entry.kind !== 'continuation') continue
      const runId = taskNow(entry.id)?.leadRunId
      if (runId) queuedRuns.add(runId)
    }
    store.setQueueActivity({
      taskPlaces: ordered.flatMap((entry, index) =>
        entry.kind === 'task' || entry.kind === 'setup-task' || entry.kind === 'continuation'
          ? [{ id: entry.id, place: index + 1 }]
          : [],
      ),
      queuedTasks: leadLifecycle.pendingRecoveryTaskIds(),
      queuedRuns: [...queuedRuns],
      startingRuns: [...startingRuns],
      startingTasks: [...holds.keys()],
    })
  }

  function pump(): Promise<void> {
    again = true
    if (closed) return Promise.resolve()
    publishQueueActivity()
    pumping ??= (async () => {
      while (again) {
        again = false
        await fill()
      }
    })()
      .catch((error: unknown) => console.error('couldn’t start queued Tasks:', error))
      .finally(() => {
        pumping = undefined
        if (again) void pump()
        else void publishSlots()
      })
    return pumping
  }

  async function slots(): Promise<RunSlots> {
    const factoryIds = store.listFactories().map((f) => f.id)
    const { use, holders, others, candidates } = await slotUse(factoryIds)
    const requests = new Map(store.subAgentRequests().map((r) => [r.id, r]))
    const sourceOf = new Map(
      sources.flatMap((source) => source.queued().map((q) => [q.id, source] as const)),
    )
    const ordered = queueOrder<QueueEntry>([
      ...subAgents.queued(),
      ...continuationsReady(true),
      ...store.queue(),
      ...sources.flatMap((source) => source.queued()),
    ])
    const byId = new Map(candidates.map((t) => [t.id, t]))
    const missing = new Set(
      ordered
        .map((entry) => requests.get(entry.id)?.taskId ?? entry.id)
        .filter((id) => !byId.has(id)),
    )
    if (missing.size > 0) for (const task of store.tasksIn(missing)) byId.set(task.id, task)
    const queue = ordered.flatMap((entry, i): RunSlots['queue'] => {
      const described = sourceOf.get(entry.id)?.describe(entry.id, i + 1)
      if (described) return [described]
      const request = requests.get(entry.id)
      const task = byId.get(request?.taskId ?? entry.id)
      if (!task) return []
      if (request) {
        return [
          {
            kind: 'sub-agent',
            place: 0,
            runId: request.id,
            name: request.name,
            taskId: task.id,
            displayId: task.displayId,
            factoryId: task.factoryId,
          },
        ]
      }
      return [
        {
          kind: 'task',
          place: 0,
          taskId: task.id,
          displayId: task.displayId,
          title: task.title,
          factoryId: task.factoryId,
          priority: task.priority,
          ...(task.setup && { setup: true as const }),
        },
      ]
    })
    for (const [i, entry] of queue.entries()) entry.place = i + 1
    return {
      limit: use.limit,
      working: use.working,
      queued: queue.length,
      holders: holders
        .map(
          ({ task, runs, subAgentRuns, settingUp }): SlotHolder => ({
            kind: 'task' as const,
            taskId: task.id,
            displayId: task.displayId,
            title: task.title,
            factoryId: task.factoryId,
            runs,
            subAgents: subAgentRuns,
            settingUp,
          }),
        )
        .concat(others),
      queue,
      factories: factoryIds.flatMap((factoryId) => {
        const cap = use.caps[factoryId]
        return cap === undefined ? [] : [{ factoryId, cap, working: use.byFactory[factoryId] ?? 0 }]
      }),
      ...(heldAtLoad !== undefined && {
        heldForLoad: true as const,
        loadRatio: Math.round(heldAtLoad * 100) / 100,
      }),
    }
  }

  async function publishSlots(): Promise<void> {
    if (closed) return
    publishQueueActivity()
    const current = await slots().catch(() => undefined)
    const shown = JSON.stringify(current)
    if (!current || closed || shown === shownSlots) return
    const first = shownSlots === ''
    shownSlots = shown
    publishedSlots = current
    if (first) return
    for (const listener of listeners) listener({ type: 'slots-changed', slots: current })
  }

  function begin(taskId: string): Promise<void> {
    const release = hold(taskId)
    const work = launchQueued(taskId)
      .catch((error: unknown) => {
        autoStartFailures.add(taskId)
        if (store.queue().some((q) => q.id === taskId)) {
          if (store.getTask(taskId)?.repos.some((r) => !r.removed)) store.waitForBlockers(taskId)
          else store.moveToBacklog(taskId)
          const message = error instanceof Error ? error.message : String(error)
          const why = redactSecrets(`Couldn’t start: ${message}`)
          store.setActivity(taskId, oneLine(why))
          tedNote(taskId, oneLine(why, 600))
        }
        throw error
      })
      .finally(() => {
        beginning.delete(taskId)
        release()
      })
    beginning.set(taskId, work)
    inBackground(`start ${store.getTask(taskId)?.displayId ?? taskId}`, () => work)
    return work
  }

  function tedNote(taskId: string, body: string): void {
    const last = store.listComments(taskId).at(-1)
    if (last?.author.kind === 'ted' && last.kind === 'note' && last.body === body) return
    store.postComment({ taskId, kind: 'note', author: { kind: 'ted' }, body })
  }

  const movingOn = new Map<string, number>()
  let waitingMoves = 0
  function dropWaitingMove(taskId: string): void {
    if (!movingOn.delete(taskId)) return
    store.setTaskMovingAfterChecks(taskId, false)
  }

  async function checksFirst<T>(
    taskId: string,
    action: () => Promise<T>,
    waiting: () => T,
  ): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (!(error instanceof StaleCoverageError)) throw error
      if (!movingOn.has(taskId)) await checksThen(taskId, action)
      return waiting()
    }
  }

  async function startChecksBeforeMove(
    taskId: string,
  ): Promise<{ done: Promise<CheckRunnerResult | undefined> }> {
    if (checking.has(taskId)) return { done: untilChecksIdle(taskId).then(() => undefined) }
    setChecking(taskId, true)
    try {
      const task = find(taskId)
      const resolution = await gateWorkflow(task, { fetch: false })
      const problem = runsInBypass(resolution) ? undefined : await sandboxProblem(task.factoryId)
      if (problem !== undefined) throw new RequestError(409, problem)
      const started = await validation.begin(
        find(taskId),
        resolution,
        task.stage === 'merge' ? 'merge' : 'agent',
      )
      if (!started) {
        setChecking(taskId, false)
        return { done: Promise.resolve(undefined) }
      }
      return { done: started.done.finally(() => setChecking(taskId, false)) }
    } catch (error) {
      setChecking(taskId, false)
      throw error
    }
  }

  async function checksThen(
    taskId: string,
    action: () => Promise<unknown>,
    round = 1,
  ): Promise<void> {
    if (movingOn.has(taskId))
      throw new RequestError(
        409,
        `TED is already running ${find(taskId).displayId}’s Checks before moving it on; try again when they finish`,
      )
    waitingMoves += 1
    const waiting = waitingMoves
    movingOn.set(taskId, waiting)
    store.setTaskMovingAfterChecks(taskId, true)
    let done: Promise<CheckRunnerResult | undefined>
    try {
      done = (await startChecksBeforeMove(taskId)).done
    } catch (error) {
      if (movingOn.get(taskId) === waiting) dropWaitingMove(taskId)
      throw error
    }
    if (movingOn.get(taskId) !== waiting) {
      void done.catch(() => undefined)
      return
    }
    const before = find(taskId)
    inBackground(`move ${before.displayId} on after its Checks`, async () => {
      const result = await done.catch(() => undefined)
      if (movingOn.get(taskId) !== waiting) return
      dropWaitingMove(taskId)
      const current = store.getTask(taskId)
      if (!current || current.archived || current.stopped || current.stage !== before.stage) return
      if (result?.outcome === 'interrupted') return
      if (result !== undefined && result.outcome !== 'passed') {
        const failureId = store.failures.progress(taskId)?.failureId
        const failed = `TED ran the Checks before moving ${current.displayId} on, and one failed, so the Task stays in ${stageTitle(current.stage)}.${failureId ? ` The failure is recorded as failure case ${shortReference(failureId)}.` : ''}`
        tedNote(taskId, failed)
        await deliver(
          find(taskId),
          failureId
            ? `${failed} Investigate it, add evidence and assess it as the Stage’s instructions say before reporting an outcome again.`
            : `${failed} Fix it, commit and report the outcome again.`,
        )
        return
      }
      try {
        await action()
      } catch (error) {
        if (error instanceof StaleCoverageError && round < 2) {
          await checksThen(taskId, action, round + 1)
          return
        }
        const why =
          error instanceof StaleCoverageError
            ? 'its code changed while they ran'
            : error instanceof Error
              ? error.message
              : String(error)
        const stuck = `TED ran the Checks before moving ${current.displayId} on, but couldn’t move it: ${redactSecrets(why)}`
        tedNote(taskId, stuck)
        await deliver(find(taskId), stuck)
      }
    })
  }

  function inBackground(what: string, work: () => Promise<void>, holdIdle = true): void {
    const release = holdIdle ? options.idle?.hold() : undefined
    const done = work()
      .catch((error: unknown) => console.error(`couldn’t ${what}:`, error))
      .finally(() => {
        background.delete(done)
        release?.()
      })
    background.add(done)
  }

  const commandLog = (task: Task, kind: 'setup' | 'teardown', name: string) =>
    path.join(logsDir, 'worktrees', `${task.displayId}-${name}-${kind}.log`)

  const commandEnv = (task: Task, env: Record<string, string>): NodeJS.ProcessEnv =>
    worktreeCommandEnv(env, { TED_TASK: task.displayId }, options.env?.() ?? process.env)

  const checkDir = (task: Task, checkRunId: string) =>
    path.join(logsDir, 'checks', task.displayId, checkRunId)

  const checkLog = (task: Task, checkRunId: string, position: number) =>
    path.join(checkDir(task, checkRunId), `${position + 1}.log`)

  async function approvedSetup(task: StoredTask) {
    const factory = factoryOf(task)
    const primary = task.repos.find((r) => !r.removed && sameRepo(r.repo, factory.repo))
    if (!primary) return undefined
    const found = await readGitLayer(primary.worktree, 'HEAD').catch(() => undefined)
    if (!found) return undefined
    const layer = checkLayer({ kind: 'factory', files: found.files, primaryRepo: factory.repo })
    if (!layer.valid) return undefined
    const proposal = store
      .listComments(task.id)
      .findLast(
        (c) => c.gate && c.stage === 'design' && c.answer?.kind === 'approved' && c.design?.setup,
      )?.design?.setup
    return proposal && { primary, settings: layer.settings, proposal }
  }

  async function approvedSetupChecks(task: StoredTask): Promise<CheckSettings[]> {
    const approved = await approvedSetup(task)
    if (!approved) return []
    const { primary, settings, proposal } = approved
    const key = (name: string, command: string, repo: string | undefined) =>
      [name, command, repo ?? primary.name].join('\0')
    const passed = new Set(
      proposal.checks.filter((c) => c.passed).map((c) => key(c.name, c.command, c.repo)),
    )
    return (settings.stages.validate?.checks ?? []).filter((c) =>
      passed.has(key(c.name, c.run, c.repo)),
    )
  }

  async function approvedSetupApps(task: StoredTask): Promise<Map<string, AppDeclaration[]>> {
    const approved = await approvedSetup(task)
    if (!approved) return new Map()
    const { primary, settings, proposal } = approved
    const passed = (names: readonly string[], app: AppDeclaration) =>
      proposal.apps.some(
        (a) =>
          a.passed &&
          a.name === app.name &&
          a.run === app.run &&
          names.includes(a.repo ?? primary.name),
      )
    const remoteRepo = (remote: string | undefined) =>
      remote === undefined ? undefined : githubRepoOf(remote)
    const repos = settings.repos ?? []
    return new Map(
      task.repos
        .filter((r) => !r.removed)
        .map((r) => {
          const listed =
            r === primary
              ? repos[0]
              : repos.slice(1).find((s) => {
                  const repo = remoteRepo(s.remote)
                  return repo !== undefined && sameRepo(repo, r.repo)
                })
          const names = [r.name, ...(listed?.name !== undefined ? [listed.name] : [])]
          const apps = appDeclarations(listed?.apps).filter((a) => passed(names, a))
          return [r.name, apps] as const
        }),
    )
  }

  async function startSetupApps(task: StoredTask): Promise<string | undefined> {
    const lines: string[] = []
    for (const [repo, declared] of await approvedSetupApps(task)) {
      for (const app of declared) {
        const started = await apps.start(task.id, { name: app.name, repo }, 'task-lead').then(
          (shown) => `- ${app.name}: ${shown.state}${shown.url ? ` at ${shown.url}` : ''}`,
          (error: unknown) => `- ${app.name}: didn’t start: ${messageOf(error)}`,
        )
        lines.push(started)
      }
    }
    return lines.length === 0
      ? undefined
      : `# Apps\n\nTED started the approved Apps from this branch:\n\n${lines.join('\n')}`
  }

  async function checkPlan(
    task: StoredTask,
    resolution: WorkflowResolution,
    only?: string,
  ): Promise<RunnableCheck[]> {
    const factory = factoryOf(task)
    const entries = factoryRepos(resolution.workflow, factory)
    const repos = await Promise.all(
      task.repos
        .filter((r) => !r.removed)
        .map(async (r) => {
          const entry = repoEntry(entries, r)
          return {
            name: entry?.name ?? r.name,
            worktree: r.worktree,
            baseBranch: entry?.baseBranch ?? (await git.defaultBranch(r.worktree)),
            env: entry?.env ?? {},
          }
        }),
    )
    return planChecks({
      checks: task.setup
        ? await approvedSetupChecks(task)
        : (resolution.workflow.settings.stages.validate?.checks ?? []),
      repos,
      primary: entries[0]?.name ?? '',
      ...(only !== undefined && task.stage !== 'validate' && { only }),
    })
  }

  function reportAutoMode(factoryId: string, signal: AutoModeSignal): void {
    const ref = { problem: 'auto-mode-unavailable', factoryId }
    if (signal === 'on') {
      if (store.getBanner(bannerId(ref))) banners.clear(ref)
      return
    }
    const why =
      store.settings().billing.claude === 'api-key'
        ? 'Claude Code’s auto mode is off under API key billing, because TED keeps the key out of the commands Claude runs'
        : 'Claude Code’s auto mode isn’t available'
    banners.raise({
      ...ref,
      severity: 'warning',
      text: `${why} · every permission prompt comes to the Inbox`,
    })
  }

  function reportNotFound(factoryId: string, result: CheckRunnerResult): void {
    const ref = { problem: 'setup-suggested', factoryId, subject: 'check-not-found' }
    const [command] = result.notFound
    if (command !== undefined) {
      banners.raise({
        ...ref,
        severity: 'warning',
        text: `A Check’s command wasn’t found: \`${command}\``,
        action: { label: 'Open Factory settings', opens: { kind: 'factory-settings', factoryId } },
      })
    } else if (result.outcome !== 'interrupted') {
      banners.clear(ref)
    }
  }

  async function failedFindings(task: Task, checkRun: CheckRun): Promise<string | undefined> {
    const position = checkRun.checks.findIndex(
      (c) => c.state === 'failed' || c.state === 'timed-out',
    )
    const check = checkRun.checks[position]
    if (!check) return undefined
    const log = checkLog(task, checkRun.id, position)
    return failureFindings({ check, output: await lastLines(log), log, checks: checkRun.checks })
  }

  async function report(checkRun: CheckRun): Promise<string> {
    const task = find(checkRun.taskId)
    if (checkRun.outcome === 'interrupted') {
      return `TED stopped before the Checks finished.\n\n${summary(checkRun.checks)}`
    }
    return (await failedFindings(task, checkRun)) ?? `Checks passed.\n\n${summary(checkRun.checks)}`
  }

  async function applyValidationFix(task: StoredTask, value: FailureCase): Promise<void> {
    const references = [failureCaseReference(value), failureCaseReference(value, true)]
    const matches = (record: { findings: string }) =>
      references.some((reference) => record.findings.startsWith(`${reference}\n\n`))
    if (store.sendBackAsks(task.id).some(matches) || store.loopChecks(task.id).some(matches)) return
    if (
      pendingLoopCheck(task.id) ||
      store.sendBackAsks(task.id).some((ask) => !store.getComment(ask.commentId)?.answer)
    )
      return
    if (task.stage === 'merge') {
      const current = find(task.id)
      const mode = mergeMode(current, (await taskWorkflow(current, { fetch: false })).workflow)
      if (current.stopped || mode === undefined || mode === 'off' || mode === 'canceled') return
      await mergeSendBack(
        task.id,
        failureCaseFindings(value),
        value.source.kind === 'post-rebase-check' ? value.source.checkRunId : undefined,
      )
      return
    }
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    const sent = store.listSendBacks(task.id).find(matches)
    if (sent) {
      if (sent.at >= visitStart(task))
        await move(
          task,
          resolution,
          'work',
          backMessage(resolution.workflow, 'work', 'validate', sent),
        )
      return
    }
    judge(task, 'sent-back', undefined)
    await sendBack(
      task,
      resolution,
      'validate',
      { outcome: 'back', to: 'work', findings: failureCaseFindings(value) },
      value.source.kind === 'factory-check' ? value.source.checkRunId : undefined,
    )
  }

  type StartedChecks = NonNullable<Awaited<ReturnType<typeof validation.begin>>>

  const liveHeads = (task: StoredTask) =>
    Promise.all(
      task.repos
        .filter((r) => !r.removed)
        .map((r) => git.headCommit(r.worktree).catch(() => undefined)),
    )

  function handOffAsks(taskId: string): Comment[] {
    const asks = new Set(
      store
        .sendBackAsks(taskId)
        .filter((a) => a.from === 'work' && a.to === 'work')
        .map((a) => a.commentId),
    )
    return store.listComments(taskId).filter((c) => asks.has(c.id))
  }

  function handOffFailures(task: StoredTask): number {
    const since = handOffAsks(task.id)
      .map((c) => c.answer?.at ?? '')
      .reduce(latest, visitStart(task))
    return store
      .listCheckRuns(task.id)
      .filter((r) => r.trigger === 'hand-off' && r.outcome === 'failed' && r.startedAt >= since)
      .length
  }

  const leftWork = (task: StoredTask) => task.stage !== 'work' || task.archived

  const handOffHalted = (task: StoredTask, lead: string | undefined) =>
    task.stopped || task.status?.kind === 'failed' || task.leadRunId !== lead

  async function handOffUnused(task: StoredTask): Promise<void> {
    const text = `# TED didn’t use the Checks’ result\n\nTED ran the Factory’s Checks to move ${task.displayId} to Validate, but the Task was stopped or its Task Lead changed before they finished, so TED didn’t use their result. The Task is still in Work. Report the outcome again with \`ted outcome advance\` when the work is finished.`
    if (await deliver(task, text)) return
    store.holdLeadMessage(task.id, text)
    await store.persisted()
  }

  async function leaveWorkToDiagnose(
    task: StoredTask,
  ): Promise<(message: string) => Promise<Task>> {
    const refuseHalted = (now: StoredTask) => {
      if (leftWork(now)) throw new RequestError(409, `${task.displayId} has left Work`)
      if (now.stopped || now.status?.kind === 'failed') {
        throw new RequestError(
          409,
          `${task.displayId} is stopped or Failed; resume it, then answer this request`,
        )
      }
    }
    refuseHalted(task)
    if (checking.has(task.id)) {
      throw new RequestError(
        409,
        `TED is running ${task.displayId}’s Checks; answer when they finish`,
      )
    }
    await execution.local(task.id)
    const resolution = await gateWorkflow(task)
    const { workflow } = resolution
    if (workflow.next('work') !== 'validate' || gateOn(task, workflow, 'work')) {
      throw new RequestError(
        409,
        `${task.displayId}’s Workflow no longer goes from Work straight to Validate; choose ${tryAgainChoice}`,
      )
    }
    await requireObligations(task, undefined, 'validate')
    const conflict = await baseConflict(task)
    if (conflict) {
      store.recordBaseConflict(task.id, foundConflict(task, conflict))
      throw new RequestError(
        409,
        `${task.displayId}’s branch conflicts with ${clean(conflict.base, 200)}, so it can’t leave Work yet. Choose ${tryAgainChoice} and the Task Lead resolves the conflict in Work.`,
      )
    }
    refuseHalted(find(task.id))
    return (message) => {
      if (workflow.overnightGates?.includes('work') && !gateSkipped(task)) {
        store.gateSkippedOvernight(task.id, 'work')
      }
      return move(
        task,
        resolution,
        'validate',
        `${message}\n\n${nextStageMessage(workflow, 'validate')}`,
      )
    }
  }

  async function handOffChecks(
    taskId: string,
    begun?: {
      started: StartedChecks
      coverage: string | undefined
      heads: readonly (string | undefined)[]
      lead: string
    },
  ): Promise<void> {
    let handedOver = false
    let cleared = false
    const again = 'Report the outcome again with `ted outcome advance` when the work is finished.'
    try {
      if (!begun) await execution.local(taskId)
      const lead = begun ? begun.lead : find(taskId).leadRunId
      const heads = begun ? begun.heads : await liveHeads(find(taskId))
      const coverage = begun ? begun.coverage : await validation.coverage(find(taskId))
      const started =
        begun?.started ??
        (await validation.begin(
          find(taskId),
          await gateWorkflow(find(taskId), { fetch: false }),
          'hand-off',
        ))
      const result = started === undefined ? undefined : await started.done
      const checkRun =
        started === undefined
          ? undefined
          : (store.getCheckRun(started.checkRun.id) ?? started.checkRun)
      const current = find(taskId)
      if (result?.outcome === 'interrupted' || leftWork(current)) return
      if (handOffHalted(current, lead)) return await handOffUnused(current)
      if (checkRun === undefined || result?.outcome === 'passed') {
        await untilFree(taskId)
        let halted = false
        const problem = await holding(current, async () => {
          const now = find(taskId)
          if (leftWork(now)) return undefined
          if (handOffHalted(now, lead)) {
            halted = true
            return undefined
          }
          const after = await liveHeads(now)
          if (after.length !== heads.length || after.some((commit, i) => commit !== heads[i])) {
            return 'the branch changed while the Checks ran'
          }
          const resolution = await gateWorkflow(now, { fetch: false })
          const { workflow } = resolution
          if (workflow.next('work') !== 'validate' || gateOn(now, workflow, 'work')) {
            return 'the Workflow changed while the Checks ran'
          }
          const still = find(taskId)
          if (leftWork(still)) return undefined
          if (handOffHalted(still, lead)) {
            halted = true
            return undefined
          }
          if (workflow.overnightGates?.includes('work') && !gateSkipped(now)) {
            store.gateSkippedOvernight(now.id, 'work')
          }
          await move(now, resolution, 'validate', nextStageMessage(workflow, 'validate'), {
            ...(checkRun !== undefined && { checked: { run: checkRun, coverage } }),
          })
          handedOver = true
          return undefined
        }).catch((error: unknown) => messageOf(error))
        if (halted) return await handOffUnused(find(taskId))
        if (problem !== undefined) {
          await deliver(
            find(taskId),
            `# Still in Work\n\nThe Factory’s Checks passed, but TED didn’t move ${current.displayId} to Validate: ${redactSecrets(problem)}. ${again}`,
          )
        }
        return
      }
      const findings = (await failedFindings(current, checkRun)) ?? summary(checkRun.checks)
      await writeFile(path.join(checkDir(current, checkRun.id), 'findings.md'), findings, {
        mode: 0o600,
      })
      const failures = handOffFailures(current)
      const head = `# A Check failed\n\nTED ran the Factory’s Checks before moving ${current.displayId} to Validate and one failed, so the Task stays in Work. This isn’t a send-back and doesn’t count against Validate’s limit.`
      if (failures >= handOffCheckLimit) {
        setChecking(taskId, false)
        cleared = true
        const request = store.postComment({
          taskId,
          kind: 'question',
          author: { kind: 'ted' },
          purpose: { kind: 'send-back' },
          title: `Checks have failed ${failures} times as ${current.displayId} tried to leave Work`,
          body: [
            'Each time the Task Lead reported Work finished, TED ran the Factory’s Checks and one failed, so the Task stayed in Work. The last failure’s output is in the Task’s thread.',
            `**${tryAgainChoice}** keeps the Task in Work: the Task Lead repairs what the Check reports and reports again. Add guidance if you have any.`,
            `**${diagnoseChoice}** moves the Task to Validate with the Check still failing. TED runs the Checks there and the failure becomes a failure case you can retry, send back to be fixed in this Task, or accept. Choose it when the Check fails for a reason outside this Task, such as a test that is already broken on the base branch.`,
          ].join('\n\n'),
          choices: [tryAgainChoice, diagnoseChoice],
        })
        store.askAboutSendBack({
          commentId: request.id,
          taskId,
          from: 'work',
          to: 'work',
          findings,
          loop: false,
          checkRunId: checkRun.id,
        })
        await deliver(
          current,
          `${head} That is ${failures} failures in this visit to Work, so TED asked the human what to do (request ${request.id}). They can let you try again, or move the Task to Validate with the Check still failing, where the failure is diagnosed and can be accepted. TED refuses an outcome until they answer and sends you their answer. You can keep fixing what the Check reports meanwhile.\n\n${findings}`,
        )
        return
      }
      await deliver(
        current,
        `${head} Fix what the Check reports and nothing else, commit, then report \`ted outcome advance\` again. This is failure ${failures} of ${handOffCheckLimit} in this visit to Work; at ${handOffCheckLimit} TED asks the human, who can keep the Task in Work or move it to Validate to diagnose the failure there. If the Check fails for a reason outside this Task, don’t change unrelated code to make it pass: say so in the Task brief with what shows it, and report again.\n\n${findings}`,
      )
    } finally {
      if (!handedOver && !cleared) setChecking(taskId, false)
    }
  }

  async function pullRequestTargets(task: StoredTask): Promise<PullRequestTarget[]> {
    const factory = factoryOf(task)
    const { workflow } = await taskWorkflow(find(task.id), { fetch: false })
    const entries = factoryRepos(workflow, factory)
    const live = task.repos.filter((r) => !r.removed)
    return Promise.all(
      live.map(async (r) => {
        const entry = repoEntry(entries, r)
        return {
          name: r.name,
          repo: r.repo,
          branch: r.branch,
          worktree: r.worktree,
          url: entry?.cloneUrl ?? factory.cloneUrl,
          base: entry?.baseBranch ?? (await git.defaultBranch(r.worktree)),
        }
      }),
    )
  }

  const manyRepos = (task: StoredTask) => task.repos.filter((r) => !r.removed).length > 1

  const baseTips = new Map<string, string>()
  const baseNotes = new Map<string, string>()
  const baseTipKey = (taskId: string, repo: string) => `${taskId}\n${repo}`

  function foundConflict(task: StoredTask, conflict: BaseConflict): FoundConflict {
    return {
      stage: task.stage,
      repo: conflict.name,
      base: clean(conflict.base, 200),
      tip: conflict.tip,
      fileCount: conflict.files.length,
      files: conflict.files.slice(0, recordedConflictFiles).map((file) => clean(file, 300)),
    }
  }

  async function baseConflict(task: StoredTask): Promise<BaseConflict | undefined> {
    await execution.local(task.id)
    for (const target of await pullRequestTargets(task)) {
      const repo = task.repos.find((r) => r.name === target.name)
      if (repo?.pullRequest?.state === 'merged') continue
      try {
        const head = await git.headCommit(target.worktree)
        const known = await git
          .revParse(target.worktree, `origin/${target.base}`)
          .catch(() => undefined)
        const tip = await git.fetchBranch(target.worktree, {
          url: target.url,
          branch: target.base,
          haves: [head, ...(known === undefined ? [] : [known])],
          timeoutMs: baseCheckTimeoutMs,
        })
        baseTips.set(baseTipKey(task.id, target.name), tip)
        const files = await git.mergeConflicts(target.worktree, { ours: head, theirs: tip })
        if (files !== undefined && files.length > 0) {
          return { name: target.name, base: target.base, tip, files }
        }
      } catch (error) {
        console.error(
          `couldn’t check ${task.displayId}’s ${target.name} against ${target.base}:`,
          redactSecrets(textOf(error)),
        )
      }
    }
    return undefined
  }

  async function adoptLatestBase(task: StoredTask): Promise<string | undefined> {
    const moved: AdoptedBase[] = []
    try {
      await execution.local(task.id)
      const factory = factoryOf(task)
      const { workflow } = await taskWorkflow(find(task.id), { fetch: false })
      const entries = factoryRepos(workflow, factory)
      for (const target of await pullRequestTargets(task)) {
        try {
          const repo = task.repos.find((r) => r.name === target.name)
          const entry = repo && repoEntry(entries, repo)
          if (!repo || !entry || repo.pullRequest !== undefined) continue
          await worktreeFileScope(worktreesDir, target.worktree)
          const head = await git.headCommit(target.worktree)
          const tracked = () =>
            git.revParse(target.worktree, `origin/${target.base}`).catch(() => undefined)
          const known = await tracked()
          const tip = await git.fetchBranch(target.worktree, {
            url: target.url,
            branch: target.base,
            haves: [head, ...(known === undefined ? [] : [known])],
            timeoutMs: baseCheckTimeoutMs,
          })
          if (tip === head) continue
          const headInTip = await git.isAncestor(target.worktree, head, tip)
          const inClone = async () => {
            const at = await tracked()
            return (
              at !== undefined && (at === tip || (await git.isAncestor(target.worktree, tip, at)))
            )
          }
          let tipInClone = headInTip && (await inClone())
          if (headInTip && !tipInClone) {
            await git.fetch(await cloneFor(task, factory, entry), baseCheckTimeoutMs)
            tipInClone = await inClone()
          }
          const step = baseStep({ head, tip, headInTip, tipInClone })
          if (step === 'clone-behind') {
            console.error(
              `left ${task.displayId}’s ${target.name} where it was: TED’s clone doesn’t have the latest ${redactSecrets(clean(target.base, 200))}`,
            )
          }
          if (step !== 'move') continue
          await worktreeFileScope(worktreesDir, target.worktree)
          if ((await git.headCommit(target.worktree)) !== head) continue
          if (!(await git.moveBranchTo(target.worktree, tip, head))) continue
          baseTips.set(baseTipKey(task.id, target.name), tip)
          moved.push({ repo: target.name, base: clean(target.base, 200), from: head, to: tip })
        } catch (error) {
          console.error(
            `couldn’t move ${task.displayId}’s ${target.name} to the latest ${redactSecrets(clean(target.base, 200))}:`,
            redactSecrets(textOf(error)),
          )
        }
      }
      if (moved.length === 0) return undefined
      store.baseAdopted(task.id, moved)
      return latestBaseNote(moved, manyRepos(task))
    } catch (error) {
      console.error(
        `couldn’t move ${task.displayId} to the latest base branch:`,
        redactSecrets(textOf(error)),
      )
      return moved.length > 0 ? latestBaseNote(moved, manyRepos(task)) : undefined
    }
  }

  function pullRequestTask(task: StoredTask): PullRequestTask {
    const brief = store.latestBrief(task.id)
    const goal = brief ? briefSection(brief.text, 'goal') : task.description
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      ...(goal !== undefined && goal !== '' && { goal }),
      ...(task.source?.url !== undefined && { sourceUrl: task.source.url }),
      ...(task.source?.sentry && { fixes: task.source.sentry.shortId }),
    }
  }

  function pullRequestWork(
    taskId: string,
    what: 'first' | 'again' | 'ready' | 'close' | 'reopen' | 'signoff',
  ): void {
    const prs = pullRequests
    if (!prs) return
    const task = find(taskId)
    const work = async () => {
      if (what === 'close') return prs.close(taskId)
      if (what === 'reopen') return prs.reopen(taskId)
      if (what === 'signoff') return recordSignOff(taskId)
      const current = find(taskId)
      const targets = await pullRequestTargets(current)
      if (what === 'ready') await prs.ready(pullRequestTask(current), targets)
      else await prs.push(pullRequestTask(current), targets, what)
    }
    const next = (pullRequestQueue.get(taskId) ?? Promise.resolve()).then(work)
    const settled = next.catch(() => undefined)
    pullRequestQueue.set(taskId, settled)
    void settled.then(() => {
      if (pullRequestQueue.get(taskId) === settled) pullRequestQueue.delete(taskId)
    })
    inBackground(`update ${task.displayId}’s pull requests`, () => next)
  }

  function recordSignOff(taskId: string): void {
    for (const repo of find(taskId).repos) {
      const pr = repo.pullRequest
      if (repo.removed || !pr || pr.state === 'merged' || pr.state === 'closed') continue
      const valid = pr.state === 'ready' && !repo.pushFailed && repo.pushed !== undefined
      store.pullRequestSignedOff(taskId, repo.name, valid ? repo.pushed?.commit : undefined)
    }
  }

  const mergeMode = (task: Task, workflow: ResolvedWorkflow) => mergeModeFor(store, task, workflow)

  function tedMerges(task: Task, workflow: ResolvedWorkflow): boolean {
    return mergeMode(task, workflow) === 'merge'
  }

  const startMerging = (task: Task, workflow: ResolvedWorkflow) =>
    startMergingFor(store, task, workflow)

  function openPullRequests(task: Task) {
    return task.repos.filter(
      (r) =>
        !r.removed &&
        r.pullRequest !== undefined &&
        r.pullRequest.state !== 'merged' &&
        r.pullRequest.state !== 'closed',
    )
  }

  function watched(task: StoredTask | undefined): task is StoredTask {
    if (!task || task.archived) return false
    if (task.stage === 'merge') return true
    return task.stage === 'done' && openPullRequests(task).length > 0
  }

  function holdsMerge(taskId: string): boolean {
    return openRequests(taskId).some(
      (c) => !isCiStuck(c) && !isTrackerClosedQuestion(c) && !isTrackerGroupAsk(c),
    )
  }

  function hostOfPullRequest(url: string): string {
    try {
      return new URL(url).host.toLowerCase() || defaultHost
    } catch {
      return defaultHost
    }
  }

  function watchedPullRequests(): PullRequestRef[] {
    return store.unarchivedTaskRepos().flatMap((task) =>
      task.repos.flatMap((repo) => {
        const pr = repo.pullRequest
        if (repo.removed || !pr) return []
        if (
          pr.state === 'merged' &&
          (task.stage === 'done' || store.failures.list(task.id).length === 0)
        )
          return []
        return [
          {
            key: `${task.id}:${repo.name}`,
            repo: repo.repo,
            number: pr.number,
            host: hostOfPullRequest(pr.url),
          },
        ]
      }),
    )
  }

  let ciNoted = new Set<string>()

  async function reactToGitHub(read: PullRequestRead): Promise<void> {
    if (closed) return
    // Only a Task with a pull request or a failure case can be affected by what GitHub
    // reported; building every other Task after every read held the daemon for a long time.
    const all = store.unarchivedTaskRepos()
    const unarchived = all.filter(
      ({ id, repos }) =>
        repos.some((repo) => !repo.removed && repo.pullRequest) ||
        store.failures.list(id).length > 0,
    )
    // A Task that just lost its last pull request gets one more look, so the CI noted for
    // it is cleared.
    const kept = new Set(unarchived.map(({ id }) => id))
    const left = all.filter(({ id }) => ciNoted.has(id) && !kept.has(id))
    ciNoted = kept
    const breathe = () => new Promise<void>((resolve) => setImmediate(resolve))
    // No pause in this loop: a caller waiting for this read must find the CI it reported
    // already noted, or its tested context counts as superseded.
    for (const { id, stage } of [...unarchived, ...left]) {
      if (stage === 'done') continue
      const task = taskNow(id)
      if (!task) continue
      let ci: string | null | undefined
      let ciFailures: string[] | undefined
      try {
        const observed = failureCi(task, read)
        ci = observed.ci
        ciFailures = observed.ciFailures
      } catch {
        ci = null
      }
      const effects = failures.observeCi(task, ci, ciFailures)
      inBackground(`apply ${task.displayId}’s failure observation`, () => effects)
    }
    for (const { id, stage, repos } of unarchived) {
      if (closed) return
      if (stage === 'done' && !repos.some((repo) => read.pulls.has(`${id}:${repo.name}`))) continue
      await breathe()
      if (closed) return
      const task = taskNow(id)
      if (!task || task.archived) continue
      try {
        recordPullRequests(task, read)
        if (
          task.stage !== 'done' &&
          store.failures.list(task.id).length > 0 &&
          !advancing.has(task.id) &&
          !mergeWatcher.inFlight(task.id)
        ) {
          inBackground(`verify ${task.displayId}’s failure context`, async () => {
            if (store.failures.list(task.id).some(openCiCase))
              await reconcileCi(task.id, read).catch((error: unknown) => {
                if (!(error instanceof RequestError && error.status === 409)) throw error
              })
            if (advancing.has(task.id) || closed) return
            await holding(find(task.id), async () => {
              // With the read just made: asking for a fresh one here made every read cause
              // the next, without end, while any open Task had a failure case.
              const context = await failures
                .snapshot(find(task.id), (bindCi) => failureSnapshot(find(task.id), read, bindCi))
                .catch(() => null)
              if (!closed) await failures.obligations(find(task.id), context)
            })
          })
        }
        await sendActivity(task.id, read)
      } catch (error) {
        console.error(
          `couldn’t pass GitHub activity on to ${task.displayId}:`,
          redactSecrets(textOf(error)),
        )
      }
    }
  }

  function recordPullRequests(task: StoredTask, read: PullRequestRead): void {
    for (const repo of task.repos) {
      const stored = repo.pullRequest
      const pr = read.pulls.get(`${task.id}:${repo.name}`)
      if (repo.removed || !stored || !pr || stored.state === 'merged') continue
      if (pr.state === 'MERGED' && store.failures.list(task.id).length > 0) {
        store.pullRequestMerged(task.id, repo.name, { noCi: false, byTed: false })
      }
      if (pr.state === 'CLOSED' && (stored.state === 'draft' || stored.state === 'ready')) {
        store.pullRequestClosedOnGitHub(task.id, repo.name)
      } else if (
        pr.state === 'OPEN' &&
        stored.state === 'closed' &&
        stored.closedOnGitHub !== undefined
      ) {
        store.pullRequestReopened(task.id, repo.name, pr.isDraft ? 'draft' : 'ready')
      }
      const preview = previewOf(pr)
      const known = stored.preview
      if (
        preview &&
        (known?.url !== preview.url ||
          known.label !== preview.label ||
          known.source !== preview.source)
      ) {
        store.pullRequestPreviewFound(task.id, repo.name, preview)
      }
    }
  }

  function canStartFresh(task: StoredTask): boolean {
    return (
      !task.archived &&
      !task.stopped &&
      !task.waitsForBlockers &&
      task.status?.kind !== 'failed' &&
      task.stage !== 'backlog' &&
      task.stage !== 'done' &&
      task.repos.some((r) => !r.removed) &&
      !store.queue().some((q) => q.id === task.id) &&
      !store.heldRuns().some((h) => h.taskId === task.id) &&
      !starting.has(task.id) &&
      !relaunching.has(task.id) &&
      !beginning.has(task.id) &&
      !checking.has(task.id) &&
      !holds.has(task.id)
    )
  }

  function canStartForGitHub(task: StoredTask): boolean {
    const lead = task.leadRunId === undefined ? undefined : store.getRun(task.leadRunId)
    return (
      canStartFresh(task) &&
      (task.stage === 'merge' || !(lead?.state === 'finished' && lead.ended?.how === 'stopped'))
    )
  }

  async function sendActivity(taskId: string, read: PullRequestRead): Promise<void> {
    const task = find(taskId)
    if (task.stage === 'backlog' || task.stage === 'done') return
    const run = liveLead(task)
    const deliverable = run !== undefined || canStartForGitHub(task)
    const mode =
      task.stage === 'merge'
        ? mergeMode(task, (await taskWorkflow(find(task.id), { fetch: false })).workflow)
        : undefined
    const both = mode === undefined || mode === 'off'
    const choice = { ci: both, conflict: both }
    const seen = store.gitHubSeen(taskId)
    const fresh: GitHubNotice[] = []
    for (const repo of task.repos) {
      const stored = repo.pullRequest
      const key = `${taskId}:${repo.name}`
      const pr = read.pulls.get(key)
      if (repo.removed || !stored || !pr) continue
      if (stored.state === 'merged' || stored.state === 'closed') continue
      const where = `${repo.repo}#${stored.number}`
      let notices = unseen(noticesFor(where, pr, choice), seen)
      if (run && notices.some((n) => n.kind === 'ci')) {
        const tails = await ciTails(repo.repo, read.hostOf.get(key) ?? defaultHost, pr)
        notices = unseen(noticesFor(where, pr, choice, tails), seen)
      }
      fresh.push(...notices)
    }
    if (closed) return
    const held = fresh.filter((n) => n.kind === 'outside')
    const forward = fresh.filter((n) => n.kind !== 'outside')
    if (held.length > 0) store.gitHubActivityHeld(taskId, held)
    if (!deliverable || forward.length === 0) return
    const now = find(taskId)
    const live = liveLead(now)
    if (live?.id !== run?.id) return
    if (live) {
      await runs.send(live.id, activityMessage(forward, now.stage))
      store.gitHubActivitySent(taskId, live.id, forward)
    } else if (canStartForGitHub(now)) {
      store.gitHubActivityQueued(taskId, forward)
      void pump()
    }
  }

  async function ciTails(
    repo: string,
    host: string,
    pr: RemotePullRequest,
  ): Promise<Map<string, string>> {
    const tails = new Map<string, string>()
    const gh = options.gh
    if (!gh) return tails
    for (const check of failedChecks(pr)
      .filter((c) => trustedCheck(pr, c))
      .slice(0, 5)) {
      const logPath = jobLogPath(repo, check)
      if (logPath === undefined) continue
      try {
        const log = await gh.run(['api', logPath], host === defaultHost ? {} : { host })
        const tail = logTail(log)
        if (tail !== '') tails.set(check.name, tail)
      } catch (error) {
        console.error(`couldn’t read a CI log on ${repo}:`, redactSecrets(textOf(error)))
      }
    }
    return tails
  }

  async function reconcileCi(taskId: string, read: PullRequestRead): Promise<void> {
    const task = find(taskId)
    const failed = task.repos.some((repo) =>
      read.pulls.get(`${taskId}:${repo.name}`)?.checks.some((check) => check.state === 'failed'),
    )
    if (!failed && !store.failures.list(taskId).some(openCiCase)) return
    await untilFree(taskId)
    const fix = await holding(find(taskId), () => reconcileCiHeld(taskId, read))
    if (!fix) return
    await applyValidationFix(find(taskId), fix)
    if (find(taskId).stage !== 'merge')
      await holding(find(taskId), () => reconcileCiHeld(taskId, read))
  }

  async function reconcileCiHeld(
    taskId: string,
    read: PullRequestRead,
  ): Promise<FailureCase | undefined> {
    const task = find(taskId)
    const resolution = await gateWorkflow(task, { fetch: false })
    const mode = mergeMode(task, resolution.workflow)
    const merging = task.stage === 'merge' && !task.archived
    const recording = merging && !task.stopped && (mode === 'merge' || mode === 'gate')
    const accepted = acceptedCi(taskId)
    const pulls = (merging ? await mergeTargets(task, resolution) : []).flatMap((target) => {
      const pr = read.pulls.get(`${taskId}:${target.name}`)
      if (!pr) return []
      const step = nextStep(target, pr, { accepted })
      return [
        {
          repo: target.repo,
          number: target.number,
          pr,
          record: recording && step.kind === 'ci-failed',
          host: read.hostOf.get(`${taskId}:${target.name}`) ?? defaultHost,
        },
      ]
    })
    const complete = task.repos.every((repo) => {
      if (repo.removed || !repo.pullRequest) return true
      const pr = read.pulls.get(`${taskId}:${repo.name}`)
      return pr !== undefined && !unscoped(pr)
    })
    const steps = ciFailureSteps({
      merging,
      complete,
      cases: store.failures.list(taskId),
      pulls,
    })
    for (const step of steps) {
      if (step.kind !== 'close') continue
      failures.verifyResult(find(taskId), step.id, step.evidence)
      store.postComment({
        taskId,
        author: { kind: 'ted' },
        title: 'CI failure closed',
        body: `Failure ${shortReference(step.id)}\n\n${step.evidence}`,
      })
    }
    const records = steps.filter((step) => step.kind === 'record')
    if (records.length > 0) {
      const context = await failures.snapshot(find(taskId), (bindCi) =>
        failureSnapshot(find(taskId), read, bindCi),
      )
      const tails = new Map<string, Map<string, string>>()
      let captured = false
      for (const step of records) {
        const { pull, check } = step
        const where = `${pull.repo}#${pull.number}`
        if (!tails.has(where))
          tails.set(where, await ciTails(pull.repo, pull.host ?? defaultHost, pull.pr))
        const request = {
          source: step.source,
          evidence: ciFailureEvidence(where, pull.pr, check, tails.get(where)?.get(check.name)),
        }
        const runId = find(taskId).leadRunId ?? 'ted'
        const value = captured
          ? await failures.record(find(taskId), runId, { ...request, contextId: context.id }, true)
          : await failures.recordCi(find(taskId), runId, request, context)
        captured = true
        if (step.replaces)
          failures.verifyResult(
            find(taskId),
            step.replaces,
            `A later attempt of this check failed too; see failure ${shortReference(value.id)}.`,
            undefined,
            value.id,
          )
      }
      await store.persisted()
      await sendWaiting(taskId)
    }
    if (merging) {
      for (const value of store.failures.list(taskId).filter(awaitsRerun)) {
        const source = value.source
        if (source.kind !== 'github-ci') continue
        const repo = find(taskId).repos.find(
          (r) =>
            !r.removed && sameRepo(r.repo, source.repo) && r.pullRequest?.number === source.number,
        )
        if (repo?.pullRequest && repo.pullRequest.waiting !== 'rerun')
          store.pullRequestWaiting(taskId, repo.name, 'rerun')
      }
    }
    await store.persisted()
    const fix = steps.find((step) => step.kind === 'send-back')
    return fix ? store.failures.get(fix.id) : undefined
  }

  function acceptedCi(taskId: string): Set<string> {
    return new Set(
      store.failures
        .list(taskId)
        .filter(acceptedCiCase)
        .map((value) => value.source.attempt),
    )
  }

  async function ciBlocked(
    taskId: string,
    target: MergeWork,
    _pr: RemotePullRequest,
    checks: readonly RemoteCheck[],
  ): Promise<void> {
    const keys = new Set(checks.map((check) => check.identity))
    const cases = store.failures
      .list(taskId)
      .filter(acceptedCiCase)
      .filter((value) => keys.has(value.source.attempt))
    if (cases.length === 0) return
    const body = `You accepted ${cases.length === 1 ? 'a failed CI check' : `${cases.length} failed CI checks`} on ${target.repo}#${target.number} (${cases.map((value) => `failure ${shortReference(value.id)}`).join(', ')}), but GitHub still won’t merge the pull request. Accepting a failure in TED never overrides GitHub’s own rules. TED merges once GitHub allows it: rerun the check on GitHub so it passes, or change the branch rule that requires it. Until then the Task waits at Merge.`
    if (
      store
        .listComments(taskId)
        .some((comment) => comment.author.kind === 'ted' && comment.body === body)
    )
      return
    store.postComment({
      taskId,
      author: { kind: 'ted' },
      title: 'GitHub still blocks this merge',
      body,
    })
    await store.persisted()
  }

  const mergeWatcher = createMergeWatcher({
    store,
    gh: options.gh,
    clock,
    ciStuckMs,
    port: {
      find,
      busy: (id) => advancing.has(id),
      held: holdsMerge,
      untilFree,
      holding,
      resolve: (task) => gateWorkflow(task, { fetch: false }),
      targets: mergeTargets,
      checks: mergeChecks,
      sendBack: mergeSendBack,
      finish: finishMerge,
      postGate: postMergeGate,
      recordPullRequests,
      requireObligations,
      read: () => watch?.next({ now: true }) ?? Promise.resolve(undefined),
      ciFailures: reconcileCi,
      acceptedCi,
      ciBlocked,
      beforeMerge: options.beforeMerge,
    },
  })

  function watchMerge(taskId: string): void {
    if (merging.has(taskId) || closed) return
    merging.add(taskId)
    const name = find(taskId).displayId
    const canWatch = () => {
      const current = taskNow(taskId)
      return (
        !current?.stopped &&
        !checking.has(taskId) &&
        !hierarchyBusy.has(taskId) &&
        !unfinishedChildren(taskId)
      )
    }
    const canAct = () => canWatch() && !holdsMerge(taskId)
    inBackground(`merge ${name}’s pull requests`, async () => {
      try {
        let urgent = true
        let busy = 0
        while (!closed) {
          if (!watched(taskNow(taskId))) return
          await pullRequestQueue.get(taskId)
          let next: MergeCycle = 'wait'
          let read: PullRequestRead | undefined
          if (canWatch() && watch) {
            read = await watch.next({ now: urgent })
            if (closed || !watched(taskNow(taskId))) return
          }
          const current = taskNow(taskId)
          const repair =
            current &&
            !current.stopped &&
            !checking.has(taskId) &&
            validation.pendingRepair(current)
          const onlyMergedOutside = !canAct() && !repair
          if (canWatch() || repair) {
            next = await mergeWatcher
              .cycle(taskId, read, { onlyMergedOutside })
              .catch((error: unknown) => {
                if (error instanceof RequestError && error.status === 409) return 'busy' as const
                console.error(
                  `couldn’t merge ${name}’s pull requests:`,
                  redactSecrets(textOf(error)),
                )
                return 'wait' as const
              })
          }
          if (next === 'done') return
          busy = next === 'busy' ? busy + 1 : 0
          // A Task that stays busy is tried again a little later each time and, after the
          // third try, with the next scheduled read, so it can’t ask GitHub in a tight loop.
          urgent = busy > 0 && busy <= 3
          if (next === 'busy' || read === undefined) {
            const wait =
              next === 'busy' ? Math.min(100 * 2 ** (busy - 1), mergePollMs) : mergePollMs
            const wake = new AbortController()
            mergeWaits.set(taskId, wake)
            try {
              await clockWait(clock, wait, AbortSignal.any([stopping.signal, wake.signal]))
            } finally {
              mergeWaits.delete(taskId)
            }
          }
        }
      } finally {
        merging.delete(taskId)
      }
    })
  }

  async function mergeTargets(
    task: StoredTask,
    resolution: WorkflowResolution,
  ): Promise<MergeWork[]> {
    const open = task.repos.filter(
      (r) => !r.removed && r.pullRequest !== undefined && r.pullRequest.state !== 'merged',
    )
    if (open.length === 0) return []
    const methods = resolution.workflow.settings.repos ?? []
    const order = factoryRepos(resolution.workflow, factoryOf(task))
    const rank = (repo: string) => {
      const i = order.findIndex((e) => sameRepo(e.repo, repo))
      return i === -1 ? order.length : i
    }
    const targets = (await pullRequestTargets(task)).sort((a, b) => rank(a.repo) - rank(b.repo))
    return targets.flatMap((target) => {
      const repo = open.find((r) => r.name === target.name)
      const pr = repo?.pullRequest
      if (!repo || !pr) return []
      const method = methods.find((m) => m.name === target.name)?.merge_method ?? 'squash'
      return [
        {
          ...target,
          number: pr.number,
          expectedHead: pr.signedOff ?? '',
          hasCi: repo.pushed?.ci ?? true,
          method: method as MergeMethod,
        },
      ]
    })
  }

  async function mergeChecks(taskId: string, resolution: WorkflowResolution): Promise<boolean> {
    return validation.merge(taskId, resolution)
  }

  async function mergeSendBack(
    taskId: string,
    findings: string,
    checkRunId?: string,
    toValidate = false,
    options: { counted?: boolean; cause?: SendBackCause } = {},
  ): Promise<MergeCycle> {
    const task = find(taskId)
    if (task.stage !== 'merge') return 'done'
    const split = mergeSplit(task)
    if (split && !task.statuses.includes('partly-merged')) {
      store.mergeStoppedPartway(taskId, split)
    }
    const told = split ? `${findings}\n\n${partwayFindings(split)}` : findings
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    const { stages } = resolution.workflow
    const to = toValidate && stages.includes('validate') ? 'validate' : 'work'
    if (!stages.includes(to)) {
      console.error(`couldn’t send ${task.displayId} back to ${stageTitle(to)}: it’s off`)
      return 'wait'
    }
    if (advancing.has(taskId)) return 'busy'
    const outcome = await holding(task, () =>
      sendBack(
        find(taskId),
        resolution,
        'merge',
        { outcome: 'back', to, findings: told },
        checkRunId,
        options,
      ),
    )
    return outcome.request ? 'wait' : 'done'
  }

  function mergeSplit(task: StoredTask): { merged: string[]; open: string[] } | undefined {
    const opened = task.repos.filter((r) => !r.removed && r.pullRequest !== undefined)
    const merged = opened.filter((r) => r.pullRequest?.state === 'merged').map((r) => r.name)
    const open = opened.filter((r) => r.pullRequest?.state !== 'merged').map((r) => r.name)
    return merged.length > 0 && open.length > 0 ? { merged, open } : undefined
  }

  async function finishMerge(taskId: string): Promise<MergeCycle> {
    const task = find(taskId)
    if (task.stage !== 'merge') return 'done'
    if (advancing.has(taskId)) return 'busy'
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    await holding(task, async () => {
      const current = find(taskId)
      if (current.stage === 'merge') await move(current, resolution, 'done', undefined)
    })
    return 'done'
  }

  const partwayFindings = ({ merged, open }: { merged: string[]; open: string[] }) =>
    `The merge stopped partway: ${joinAnd(merged)} already merged and TED doesn’t revert it. Fix only ${joinAnd(open)}; don’t change ${joinAnd(merged)}. The Task comes back through Validate for a short re-sign-off, then TED merges the rest.`

  function lastApproval(task: Task): Comment | undefined {
    return store
      .listComments(task.id)
      .findLast(
        (c) =>
          c.kind === 'signoff' &&
          c.gate !== undefined &&
          c.stage !== 'merge' &&
          c.answer?.kind === 'approved',
      )
  }

  async function signOffChanges(
    task: StoredTask,
    summary?: string,
  ): Promise<SignOffChanges | undefined> {
    const approval = lastApproval(task)
    if (approval?.answer?.kind !== 'approved') return undefined
    const approvedAt = approval.answer.at
    await pullRequestQueue.get(task.id)
    const current = find(task.id)
    const targets = await pullRequestTargets(current)
    const repos: SignOffChanges['repos'] = []
    for (const target of targets) {
      const repo = current.repos.find((r) => r.name === target.name)
      const to = repo?.pullRequest?.signedOff ?? repo?.pushed?.commit
      const approved = store.signedOffCommit(task.id, target.name, approvedAt)
      if (approved === undefined || to === undefined) continue
      const base = repo?.pullRequest?.base ?? target.base
      const baseTip = await git
        .fetchBranch(target.worktree, { url: target.url, branch: base, haves: [approved, to] })
        .catch(() => undefined)
      const files = await git
        .changesBetween(target.worktree, {
          from: approved,
          to,
          ...(baseTip !== undefined && { baseTip }),
        })
        .catch((error: unknown) => {
          console.error(
            `couldn’t list the changes since sign-off in ${target.name}:`,
            redactSecrets(textOf(error)),
          )
          return undefined
        })
      repos.push(
        files ? { name: target.name, files } : { name: target.name, files: [], unavailable: true },
      )
    }
    if (repos.length === 0) return undefined
    return {
      since: approval.id,
      ...(summary !== undefined && summary !== '' && { summary }),
      repos,
    }
  }

  async function postMergeGate(
    task: StoredTask,
    ready: readonly { target: MergeWork; pr: RemotePullRequest }[],
  ): Promise<void> {
    if (openGateRequest(task)) return
    await requireObligations(task)
    const rows: MergeRow[] = ready.map(({ target, pr }) => ({
      name: target.name,
      repo: target.repo,
      number: target.number,
      title: pr.title !== '' ? pr.title : task.title,
      url: task.repos.find((r) => r.name === target.name)?.pullRequest?.url ?? '',
      checks: {
        passed: pr.checks.filter((c) => c.state === 'passed').length,
        failed: pr.checks.filter((c) => c.state === 'failed').length,
        pending: pr.checks.filter((c) => c.state === 'pending').length,
      },
      mergeable: pr.mergeable === 'MERGEABLE',
      method: chooseMethod(target.method, pr.allowed) ?? target.method,
      reviewMissing: reviewMissing(pr),
    }))
    const changes = await signOffChanges(task)
    await requireObligations(find(task.id))
    const count = rows.length
    store.postComment({
      taskId: task.id,
      kind: 'signoff',
      author: { kind: 'ted' },
      title:
        count === 1
          ? `Ready to merge: PR #${rows[0]?.number ?? ''}`
          : `Ready to merge: ${count} pull requests`,
      body: changes ? '' : (store.latestBrief(task.id)?.text ?? ''),
      gate: {
        approveLabel: count === 1 ? 'Merge' : `Merge ${count} pull requests`,
        pullRequests: rows,
        ...(changes && { changes }),
      },
    })
  }

  async function cancelMerge(
    ref: string,
    text: string,
    attachments: Attachment[] = [],
  ): Promise<Comment> {
    await untilFree(find(ref).id)
    const task = find(ref)
    if (!store.mergePending(task.id)) {
      throw new RequestError(409, `TED isn’t merging ${task.displayId}’s pull requests`)
    }
    const posted = await holding(task, async () => {
      if (!store.mergePending(task.id)) {
        throw new RequestError(409, `TED isn’t merging ${task.displayId}’s pull requests`)
      }
      const comment = store.postComment({
        taskId: task.id,
        body: text,
        author: { kind: 'human' },
        attachments,
        lineComments: drafts(task.id),
      })
      store.mergeCanceled(task.id, comment.id)
      return comment
    })
    await mergeWatcher.settled(task.id)
    const stillOn = await mergeWatcher.disableAutoMerge(task.id)
    watchMerge(task.id)
    for (const repo of find(task.id).repos) {
      if (repo.pullRequest?.waiting !== undefined && repo.pullRequest.state !== 'merged') {
        store.pullRequestWaiting(task.id, repo.name, undefined)
      }
    }
    const current = find(task.id)
    const run = liveLead(current)
    if (run) {
      await sendComment(run.id)
      await deliver(
        current,
        'The human cancelled the merge with that Comment, and it counts as Request changes. TED won’t merge. Decide whether the fix belongs in Work or in Design, write the human’s request into a Findings file, and send the Task back with `ted outcome back --to work --findings <file>` (or `--to design`). The fix passes Validate again and comes back with a new sign-off.',
      )
    }
    if (stillOn.length > 0) {
      throw new RequestError(
        502,
        `Your Comment is posted and TED won’t merge, but GitHub’s auto-merge is still on for ${stillOn.join(', ')}, so GitHub may still merge it. TED keeps trying to turn it off.`,
      )
    }
    return store.getComment(posted.id) ?? posted
  }

  async function markDone(
    ref: string,
    by: 'human' | 'lead' | 'coordinator' = 'human',
  ): Promise<Task> {
    const id = find(ref).id
    return checksFirst(
      id,
      () => markDoneNow(id, by),
      () => publicTask(id),
    )
  }

  async function markDoneNow(id: string, by: 'human' | 'lead' | 'coordinator'): Promise<Task> {
    await untilFree(id)
    await mergeWatcher.settled(id)
    const task = find(id)
    if (task.stage === 'done' && store.isMerged(id)) return publicTask(id)
    const notAtMerge = (t: StoredTask) =>
      new RequestError(
        409,
        t.stage === 'cleanup'
          ? cleanupDoneRefusal(t.displayId)
          : `${t.displayId} isn’t at Merge, so it can’t be marked done`,
      )
    if (task.stage !== 'merge' || task.archived) throw notAtMerge(task)
    return holding(task, async () => {
      if (!watch) {
        throw new RequestError(
          409,
          `TED can’t read GitHub, so it can’t check that ${task.displayId}’s pull requests merged`,
        )
      }
      const read = await watch.next({ now: true })
      const before = find(id)
      if (before.stage !== 'merge' || before.archived) throw notAtMerge(before)
      if (!before.repos.some((r) => !r.removed && r.pullRequest !== undefined)) {
        throw new RequestError(409, `${before.displayId} has no pull request to check on GitHub`)
      }
      const unmerged = (t: StoredTask) =>
        t.repos.flatMap((r) =>
          !r.removed && r.pullRequest !== undefined && r.pullRequest.state !== 'merged'
            ? [{ name: r.name, where: `${r.repo}#${r.pullRequest.number}` }]
            : [],
        )
      const verified = new Set<string>()
      for (const { name, where } of unmerged(before)) {
        const key = `${id}:${name}`
        const host = read.hostOf.get(key)
        const remote = read.pulls.get(key)
        if ((host !== undefined && read.failed.has(host)) || !remote) {
          throw new RequestError(409, `TED couldn’t read ${where} from GitHub; try again`)
        }
        if (remote.state === 'CLOSED') {
          throw new RequestError(409, `${where} was closed on GitHub without merging`)
        }
        if (remote.state !== 'MERGED') {
          throw new RequestError(409, `${where} is still open on GitHub`)
        }
        verified.add(`${name}:${where}`)
      }
      await requireObligations(before, read, 'done', true)
      const resolution = await taskWorkflow(find(id), { fetch: false })
      const current = find(id)
      if (current.stage !== 'merge' || current.archived) throw notAtMerge(current)
      const left = unmerged(current)
      const changed = left.find(({ name, where }) => !verified.has(`${name}:${where}`))
      if (changed) {
        throw new RequestError(409, `${changed.where} changed while TED read GitHub; try again`)
      }
      store.taskMarkedDone(id, by)
      for (const { name } of left) {
        store.pullRequestMerged(id, name, { noCi: false, byTed: false })
      }
      await move(find(id), resolution, 'done', undefined)
      await store.persisted()
      return publicTask(id)
    })
  }

  const leadFrom = (settings?: WorkflowSettings) =>
    resolveAgentChoices(
      settings,
      {
        claude: agents.installed('claude'),
        antigravity: agents.installed('antigravity'),
        codex: agents.installed('codex'),
      },
      store.settings().enabledAgents,
    ).lead

  const subAgents = createSubAgents({
    store,
    runs,
    agents,
    async prepareExecution(task) {
      await execution.local(task.id)
    },
    find: (ref) => find(ref),
    async leadFor(task) {
      if (task.lead) return task.lead
      return leadFrom((await taskWorkflow(find(task.id), { fetch: false })).workflow.settings)
    },
    reviewerFor: (task) => reviewerFor(task),
    visitStart: (task) => visitStart(task),
    planReview: (task, prompt) => planReview(task, prompt),
    validateSubAgents: async (task) =>
      subAgentsInValidate((await taskWorkflow(task, { fetch: false })).workflow),
    async envFor(task, repo) {
      const appVars = await apps.envFor(task.id)
      const recorded = store.recordedSetup(task.id, repo.name)?.env
      if (recorded) return { ...recorded, ...appVars }
      return { ...(repoEntry(await entriesOf(factoryOf(task)), repo)?.env ?? {}), ...appVars }
    },
    async permissionsFor(task) {
      const resolution = await taskWorkflow(find(task.id), { fetch: false })
      return resolution.workflow.settings.permissions === 'bypass' ? 'bypass' : 'auto'
    },
    clonePathFor: (repo) => clonePath(reposDir, repo),
    runFolder: async (task) => runFolderOf(find(task.id), await entriesOf(factoryOf(task))),
    worktreesDir,
    pump: () => void pump(),
    inBackground: (what, work) => inBackground(what, work),
  })

  async function reviewerFor(task: StoredTask): Promise<ReviewerChoice> {
    const { settings } = (await taskWorkflow(find(task.id), { fetch: false })).workflow
    const lead = task.lead ?? leadFrom(settings)
    const setting = settings.reviewer
    const tuned = {
      ...(setting?.model !== undefined && { model: setting.model }),
      ...(setting?.effort !== undefined && { effort: setting.effort as Effort }),
    }
    if (setting?.agent !== undefined) {
      const agent = setting.agent === 'same' ? lead.agent : (setting.agent as AgentKind)
      await health.ready(agent).catch(() => false)
      return { lead: { agent, ...tuned } }
    }
    const enabled = store.settings().enabledAgents
    const other = enabled.find((kind) => kind !== lead.agent) ?? enabled[0] ?? lead.agent
    const canRun = async (kind: AgentKind) =>
      enabled.includes(kind) &&
      agents.installed(kind) &&
      store.agentPauses()[kind] === undefined &&
      (await health.ready(kind))
    let agent = other
    for (const kind of [
      ...enabled.filter((kind) => kind !== lead.agent),
      ...enabled.filter((kind) => kind === lead.agent),
    ]) {
      if (await canRun(kind)) {
        agent = kind
        break
      }
    }
    return { lead: { agent, ...tuned }, ...(agent !== other && { unavailable: other }) }
  }

  async function setRepos(
    ref: string,
    caller: Caller,
    request: SetTaskReposRequest,
  ): Promise<TaskReposResult> {
    const task =
      caller.kind === 'run' ? taskLead(ref, caller, 'changes the Task’s repos').task : find(ref)
    const work = (changingRepos.get(task.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await beginning.get(task.id)?.catch(() => undefined)
        return holding(find(task.id), async () => {
          if (caller.kind === 'run') taskLead(ref, caller, 'changes the Task’s repos')
          try {
            return await changeRepos(task.id, caller, request)
          } finally {
            if (store.failures.list(task.id).length > 0) await failures.obligations(find(task.id))
          }
        })
      })
    changingRepos.set(task.id, work)
    try {
      return await work
    } finally {
      if (changingRepos.get(task.id) === work) changingRepos.delete(task.id)
    }
  }

  async function changeRepos(
    taskId: string,
    caller: Caller,
    request: SetTaskReposRequest,
  ): Promise<TaskReposResult> {
    await beginning.get(taskId)?.catch(() => undefined)
    const task = find(taskId)
    if (hierarchyBusy.has(task.id) || deleting.has(task.id))
      throw new RequestError(409, `${task.displayId} has a hierarchy operation underway; try again`)
    if (task.archived) throw new RequestError(409, `${task.displayId} is archived`)
    if (task.stage === 'done') throw new RequestError(409, `${task.displayId} is done`)
    const factory = factoryOf(task)
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    const entries = factoryRepos(resolution.workflow, factory)
    if (entries.length < 2) {
      throw new RequestError(
        409,
        `${factory.name} has one repo, so its Tasks always use ${entries[0]?.name ?? 'it'}`,
      )
    }
    const names = entries.map((e) => e.name).join(', ')
    const named = (refs: readonly string[]) =>
      refs.map((ref) => {
        const entry = findRepo(entries, ref)
        if (!entry) {
          throw new RequestError(
            400,
            `${factory.name} has no repo named “${ref}”; its repos are ${names}`,
          )
        }
        return entry
      })
    const current = chosenEntries(task.chosenRepos, entries)
    const wanted =
      'set' in request
        ? named(request.set)
        : 'add' in request
          ? [...current, ...named(request.add)]
          : current.filter((e) => !named(request.remove).includes(e))
    const next = entries.filter((e) => wanted.includes(e))
    if (next.length === 0) throw new RequestError(400, 'a Task needs at least one repo')
    const adding = next.filter((e) => !current.includes(e))
    const removing = current.filter((e) => !next.includes(e))
    const live = (entry: FactoryRepoEntry) =>
      task.repos.find((r) => !r.removed && sameRepo(r.repo, entry.repo))
    for (const entry of removing) {
      const open = task.repos.find(
        (r) =>
          sameRepo(r.repo, entry.repo) &&
          (r.pullRequest?.state === 'draft' || r.pullRequest?.state === 'ready'),
      )?.pullRequest
      if (open) {
        throw new RequestError(
          409,
          `${entry.name} has an open pull request (#${open.number}), so it stays in ${task.displayId}’s repos`,
        )
      }
    }
    const confirm = 'confirm' in request && request.confirm === true
    const toConfirm = confirm
      ? []
      : (
          await Promise.all(
            removing.map(async (entry) => {
              const repo = live(entry)
              if (!repo) return undefined
              const base = entry.baseBranch ?? (await git.defaultBranch(repo.worktree))
              const commits = await git.commitsAhead(repo.worktree, `origin/${base}`).catch(() => 0)
              return commits > 0 ? { name: entry.name, commits } : undefined
            }),
          )
        ).filter((c) => c !== undefined)
    const unchanged = (extra: { confirm?: typeof toConfirm }) => ({
      task: publicTask(task.id),
      repos: current.map((e) => e.name),
      added: [],
      removed: [],
      ...extra,
    })
    if (toConfirm.length > 0) return unchanged({ confirm: toConfirm })
    const changed = adding.length > 0 || removing.length > 0
    if (changed) {
      store.setTaskRepos(task.id, {
        repos: next.map((e) => e.repo),
        names: next.map((e) => e.name),
        by: caller.kind === 'run' ? 'task-lead' : 'human',
        ...(caller.kind === 'run' && { runId: caller.runId }),
      })
    }
    await beginning.get(task.id)?.catch(() => undefined)
    const now = find(task.id)
    const liveNow = (entry: FactoryRepoEntry) =>
      now.repos.find((r) => !r.removed && sameRepo(r.repo, entry.repo))
    const created: string[] = []
    if (now.repos.some((r) => !r.removed) && now.branch !== undefined) {
      for (const entry of next.filter((e) => !liveNow(e))) {
        const made = await openWorktree(now, factory, entry, now.branch, false)
        store.worktreeCreated(task.id, made)
        created.push(made.name)
        const repo = find(task.id).repos.find((r) => r.name === made.name && !r.removed)
        const setup = entry.setup
        if (repo && setup) {
          const step = {
            repo,
            setup: { command: setup.run, timeoutMs: setup.timeoutMs, env: entry.env },
          }
          inBackground(`set up ${task.displayId}’s ${repo.name} worktree`, () =>
            setUpAdded(task.id, step, caller.kind !== 'run'),
          )
        }
      }
      for (const entry of removing) {
        const repo = liveNow(entry)
        if (!repo) continue
        repoSetups.get(`${task.id}:${repo.name}`)?.abort()
        await apps.stopRepo(task.id, repo.name).catch(() => undefined)
        const teardown = await tearDown(task, repo, entry)
        await removeRepoWorktree(task, repo).catch((error) => {
          console.error(`couldn’t remove ${task.displayId}’s ${repo.name} worktree:`, error)
        })
        store.worktreeRemoved(task.id, repo.name, teardown)
      }
    }
    if (!changed && created.length === 0) return unchanged({})
    const added = [...new Set([...adding.map((e) => e.name), ...created])]
    if (caller.kind !== 'run') {
      const run = liveLead(find(task.id))
      if (run) await runs.send(run.id, reposChangedMessage(find(task.id), adding, removing))
    }
    return {
      task: publicTask(task.id),
      repos: next.map((e) => e.name),
      added,
      removed: removing.map((e) => e.name),
    }
  }

  function reposChangedMessage(
    task: StoredTask,
    adding: readonly FactoryRepoEntry[],
    removing: readonly FactoryRepoEntry[],
  ): string {
    const names = task.repos
      .filter((r) => !r.removed)
      .map((r) => r.name)
      .join(', ')
    const lines = [
      `The human changed this Task’s repos. They are now: ${names}.`,
      ...adding.map((e) => {
        const repo = task.repos.find((r) => !r.removed && sameRepo(r.repo, e.repo))
        const where = repo ? ` Its worktree is ${repo.worktree}, on branch ${repo.branch}.` : ''
        const setup = e.setup ? ' TED is running its setup command and tells you when it ends.' : ''
        return `- Added ${e.name} (${e.repo}).${where}${setup}`
      }),
      ...removing.map((e) => `- Removed ${e.name} (${e.repo}). Its worktree is gone.`),
    ]
    return lines.join('\n')
  }

  function setUpAdded(taskId: string, step: SetupStep, tellLead: boolean): Promise<void> {
    return leadLifecycle.prepare(taskId, { kind: 'added', step, tellLead })
  }

  async function performAddedSetup(
    taskId: string,
    step: SetupStep,
  ): Promise<{ report?: string } | undefined> {
    const key = `${taskId}:${step.repo.name}`
    if (repoSetups.has(key)) return
    const cancel = new AbortController()
    repoSetups.set(key, cancel)
    try {
      const task = find(taskId)
      const signal = AbortSignal.any([stopping.signal, cancel.signal])
      store.worktreeSetupStarted(task.id, step.repo.name, step.setup)
      return await runSetup(task, step.repo, step.setup, signal, { untilStopped: false })
    } finally {
      repoSetups.delete(key)
    }
  }

  async function repoSetup(ref: string, caller: Caller, name: string): Promise<RepoSetupReport> {
    const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
    const repo = task.repos.findLast((r) => r.name === name || sameRepo(r.repo, name))
    if (!repo || repo.removed) return { name, state: 'none', output: '' }
    const setup = repo.setup
    const done = setup !== undefined && setup.state !== 'running'
    return {
      name: repo.name,
      worktree: repo.worktree,
      state: setup?.state ?? 'none',
      ...(setup && { command: setup.command }),
      ...(setup?.exitCode !== undefined && { exitCode: setup.exitCode }),
      output: done ? await outputTail(commandLog(task, 'setup', repo.name)) : '',
    }
  }

  const heldRequests = createHeldRequests(store, runs, options.heldRequests)
  const leadLifecycle = createLeadLifecycle({
    store,
    runs,
    clock,
    health,
    agents,
    stallAfterMs,
    local: (id) => execution.local(id),
    beforeLeadStart: async (id) =>
      (await incorporateRepairs(find(id))) ? taskWorkflow(find(id), { fetch: false }) : undefined,
    afterLeadStart: (id) => {
      baseNotes.delete(id)
      scheduleRepairChecks(id)
    },
    workflow: (task) => taskWorkflow(task, { fetch: false }),
    entries: (task, resolution) => factoryRepos(resolution.workflow, factoryOf(task)),
    defaultLead: leadFrom,
    context: leadContext,
    appEnv: (id) => apps.envFor(id),
    protectComments(comments, on) {
      for (const comment of comments) {
        if (on) promptComments.add(comment.id)
        else promptComments.delete(comment.id)
      }
    },
    launched: (run, mode) => {
      overnightSeen.set(run.id, mode)
    },
    deliver: sendWaiting,
    editedSince,
    freshRunNote,
    agentChangeNote,
    failedSetupReports,
    setUp: runSetups,
    setUpAdded: performAddedSetup,
    hold,
    mayContinue: (id) => {
      const task = store.getTask(id)
      if (!task) return true
      if (
        !task.pendingLeadMessages.some((message) => message.waitForSlot) &&
        !queuedAnswers(id).length
      )
        return true
      const run = liveLeadOf(store, task)
      return (
        continuing.has(id) &&
        store.newWorkHold() === undefined &&
        run !== undefined &&
        store.agentPauses()[run.agent] === undefined
      )
    },
    stopRequested: (id) => stoppingByHand.has(id) || stoppingForBlockers.has(id),
    wake: () => {
      void pump()
    },
    background: inBackground,
    hasAnswerText: (comment) => answerText(comment) !== undefined,
    refreshSteering: (id) => options.steering.refresh(id),
  })

  const liveLead = (task: StoredTask) => liveLeadOf(store, task)
  const acknowledgeLeadMessages = (run: Run) => leadLifecycle.acknowledgeLeadMessages(run)
  const applyLead = async (taskId: string, options?: { restart?: boolean }) => {
    await leadLifecycle.applyLead(taskId, options)
    pendingTalks(taskId)
  }

  async function askAboutModel(updated: Run): Promise<void> {
    if (updated.taskId === undefined) return
    await untilFree(updated.taskId)
    if (closed) return
    const run = store.getRun(updated.id)
    if (!run) return
    const questions = store
      .listComments(updated.taskId)
      .filter((comment) => comment.purpose?.kind === 'model' && comment.purpose.runId === run.id)
    if (run.problem !== 'model-unavailable') {
      for (const question of questions.filter((c) => c.answer === undefined)) {
        store.answerComment(question.id, {
          kind: 'answered',
          at: new Date().toISOString(),
          text: 'The Task Lead no longer waits on this model.',
        })
      }
      return
    }
    const task = store.getTask(updated.taskId)
    if (
      !task ||
      task.leadRunId !== run.id ||
      questions.some((c) => c.createdAt >= (store.runProblemAt(run.id) ?? ''))
    )
      return
    store.postComment({
      taskId: task.id,
      kind: 'question',
      purpose: { kind: 'model', runId: run.id },
      author: { kind: 'ted' },
      title: `${run.model} isn’t in your plan`,
      body: `The Task Lead asked for the model “${run.model}”, which your plan doesn’t include. TED won’t switch models on its own, so the Run is waiting. Choose Use the default model to run this Run on the CLI’s default model, or Change setting to pick another model in the Task Lead field.`,
      choices: [useDefaultChoice, 'Change setting'],
    })
  }

  async function restartLead(ref: string): Promise<Task> {
    const task = find(ref)
    await leadLifecycle.restartNow(task.id)
    return publicTask(task.id)
  }

  async function agentChangeNote(
    task: StoredTask,
    run: Run,
    agent: AgentKind,
    unread: readonly RunMessage[],
  ): Promise<string> {
    const items = chatItems({
      run,
      prompt: store.runPrompt(run.id),
      entries: parsedOutput(runs.output, agents, run).chat.entries(),
      messages: store.runMessages(run.id),
      interrupts: store.runInterrupts(run.id),
      preamble: await preambleText().catch(() => ''),
    })
    const { text, cut, leftOut } = conversationText(items)
    const name = agentShortNames[agent]
    if (cut) {
      const middle =
        leftOut > 0
          ? `; ${leftOut} ${leftOut === 1 ? 'message' : 'messages'} in the middle were left out`
          : ''
      tedNote(
        task.id,
        `Part of the conversation was left out. It was too long to pass to ${name} whole, so the new Task Lead got the Task brief, the start of the conversation and the newest part${middle}.`,
      )
      await store.persisted()
    }
    return [
      fromTheBrief(task, {
        heading: 'Picking up after an agent change',
        why: `The human switched this Task’s Task Lead from ${agentShortNames[run.agent]} to ${name}.`,
      }),
      ...(text !== '' ? [`## The conversation so far\n\n${text}`] : []),
      ...(unread.length > 0
        ? [
            `## Messages the old Task Lead hadn’t read\n\n${unread
              .map((m) => `${m.from === 'ted' ? 'TED' : 'The user'}: ${m.text.trim()}`)
              .join('\n\n')}`,
          ]
        : []),
    ].join('\n\n')
  }

  async function useDefaultModel(ref: string): Promise<Task> {
    const task = find(ref)
    await leadLifecycle.useDefaultModel(task)
    pendingTalks(task.id)
    return publicTask(task.id)
  }

  let closed = false
  const unsubscribe = store.subscribe((event) => {
    if (event.type !== 'run-updated' || event.run.taskId === undefined) return
    const { run } = event
    setImmediate(() => {
      if (closed) return
      watchIdle(run)
      inBackground('update the model request', () => askAboutModel(run))
      if (run.taskId !== undefined) {
        const taskId = run.taskId
        pendingTalks(taskId)
        inBackground('apply the Task Lead setting', () => applyLead(taskId))
      }
    })
  })
  for (const task of store.listTasks()) {
    inBackground('apply the Task Lead setting', () => applyLead(task.id))
  }

  function find(ref: string): StoredTask {
    const task = store.getTask(ref)
    if (!task) throw new RequestError(404, `no Task ${ref}`)
    return task
  }

  function ownTask(ref: string, caller: Caller): { task: StoredTask; runId: string } {
    if (caller.kind !== 'run') {
      throw new RequestError(403, 'only a Run on this Task can do this for now')
    }
    const task = find(ref)
    if (store.getRun(caller.runId)?.taskId !== task.id) {
      throw new RequestError(403, `this Run doesn’t belong to ${task.displayId}`)
    }
    return { task, runId: caller.runId }
  }

  function taskLead(
    ref: string,
    caller: Caller,
    does: string,
  ): { task: StoredTask; runId: string } {
    const owned = ownTask(ref, caller)
    if (owned.task.leadRunId !== owned.runId) {
      throw new RequestError(403, `only the Task Lead ${does}`)
    }
    return owned
  }

  function factoryOf(task: Task) {
    const factory = store.getFactory(task.factoryId)
    if (!factory) throw new RequestError(409, `${task.displayId}’s Factory has no repo`)
    return factory
  }

  async function linearIssue(url: string): Promise<LinearIssue | undefined> {
    const link = parseLinearUrl(url)
    if (!link || !options.linear) return undefined
    const lookup = await options.linear.issueFor(link).catch((error: unknown) => {
      console.error(
        redactSecrets(`fetching ${link.identifier} from Linear failed: ${String(error)}`),
      )
      return undefined
    })
    return lookup?.state === 'found' ? lookup.issue : undefined
  }

  const asanaImports = new Map<string, Promise<unknown>>()

  function asanaTarget(input: AsanaImportRequest, caller: Caller) {
    if (input.addToTree === true && caller.kind !== 'app') {
      throw new RequestError(403, 'only the app can add children to an existing tree')
    }
    if (input.draftRevision !== undefined && caller.kind !== 'app') {
      throw new RequestError(403, 'only the app can consume a New Task draft')
    }
    const automation = automationCaller(caller)
    if (automation && input.factory !== undefined && input.factory !== automation.factoryKey) {
      throw new RequestError(
        403,
        `this Automation creates Tasks only in ${automation.factoryKey}, its own Factory`,
      )
    }
    const key = automation?.factoryKey ?? input.factory
    if (key === undefined) throw new RequestError(400, 'name the Factory to import into')
    const factory = store.listFactories().find((f) => f.key === key)
    if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
    if (removingFactories.has(factory.id)) {
      throw new RequestError(409, `${factory.name} is being removed`)
    }
    const gid = parseAsanaTaskUrl(input.url)?.gid
    if (gid === undefined) throw new RequestError(400, 'url must be an Asana task URL')
    return { factory, automation, gid }
  }

  async function readAsana(factoryId: string, gid: string, withFiles: boolean) {
    const asana = options.asana
    if (!asana) throw new RequestError(409, 'Connect Asana in Settings → Integrations first.')
    const tasksNow = store.listTasks()
    const tracked = new Set(
      tasksNow.flatMap((task) => {
        if (task.factoryId !== factoryId || !task.source) return []
        const key = sourceKey(task.source.url)
        return key.startsWith('asana:') ? [key.slice('asana:'.length)] : []
      }),
    )
    if (sourceClash(tasksNow, factoryId, asanaTaskUrl(gid))?.kind !== 'open') tracked.delete(gid)
    const user = await asana.user().catch((error: unknown) => {
      throw new RequestError(409, error instanceof Error ? error.message : 'Connect Asana first')
    })
    const tree = await readAsanaTree({
      read: asana.read,
      rootGid: gid,
      tracked,
      ...(withFiles && asana.files && { files: asana.files }),
      ...(asana.allowLoopbackFiles && { allowLoopbackFiles: true }),
    }).catch((error: unknown) => {
      const status = error instanceof AsanaReadError ? error.status : undefined
      throw new RequestError(
        409,
        status === 403
          ? 'Asana didn’t let TED read this task. Check that the connected account can open it.'
          : status === 404
            ? 'Asana couldn’t find this task.'
            : redactSecrets(error instanceof Error ? error.message : 'Couldn’t read Asana'),
      )
    })
    return { tree, user }
  }

  function planAsana(
    tree: AsanaTree,
    factoryId: string,
    userGid: string,
    app: boolean,
    doneParent?: string,
  ) {
    return planAsanaImport({
      tree,
      tasks: store.listTasks(),
      factoryId,
      userGid,
      app,
      ...(doneParent !== undefined && { doneParent }),
      parentRefusal: (taskId) => {
        try {
          requireHierarchyIdle([taskId])
          if (taskId !== doneParent || find(taskId).stage !== 'done') safeParent(find(taskId))
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      blockersOf: (taskId) => store.blockers(taskId).map((link) => link.blockerId),
    })
  }

  async function asanaPreview(input: AsanaImportRequest, caller: Caller = { kind: 'app' }) {
    const { factory, automation, gid } = asanaTarget(input, caller)
    const unchanged = automation ? await requireIntakeRoot(factory, gid) : undefined
    const { tree, user } = await readAsana(factory.id, gid, false)
    unchanged?.()
    return planAsana(tree, factory.id, user.gid, caller.kind === 'app').preview
  }

  class IntakeBudgetError extends Error {}

  const intakeLimit = options.asana?.intakeLimit ?? maxAsanaIntakeTasks

  function asanaAllowance(
    automation: { link: { automationId: string; firingId: string } } | undefined,
  ): number {
    if (!automation) return Number.POSITIVE_INFINITY
    const { automationId, firingId } = automation.link
    const used = store.automations
      .createdTasks(automationId)
      .filter(
        (row) =>
          row.firingId === firingId &&
          parseAsanaTaskUrl(store.getTask(row.taskId)?.source?.url ?? '') !== undefined,
      ).length
    return intakeLimit - used
  }

  interface IntakeImport {
    budget: number
    unchanged: () => void
  }

  interface AsanaClosing {
    commentId: string
    choice: string
    doneParent?: string
  }

  function intakeAsana() {
    const asana = options.asana
    if (!asana) throw new RequestError(409, 'Connect Asana in Settings → Integrations first.')
    return { asana, read: retryingRead(asana.read) }
  }

  function intakeGuard(factory: StoredFactory): { scope: AsanaIntakeScope; unchanged: () => void } {
    const scope = store.settings().asanaIntakeScopes[factory.id]
    if (!scope) {
      throw new RequestError(
        403,
        `An Automation imports Asana work only from ${factory.name}’s Asana intake project. Choose one in Factory settings first.`,
      )
    }
    const unchanged = () => {
      if (
        JSON.stringify(store.settings().asanaIntakeScopes[factory.id]) !== JSON.stringify(scope)
      ) {
        throw new RequestError(
          409,
          `${factory.name}’s Asana intake choice changed during the import. TED stopped; the next run uses the new choice.`,
        )
      }
      if (removingFactories.has(factory.id) || !store.getFactory(factory.id)) {
        throw new RequestError(409, `${factory.name} is being removed`)
      }
    }
    return { scope, unchanged }
  }

  const trackedAsana = (factoryId: string, gid: string) =>
    sourceClash(store.listTasks(), factoryId, asanaTaskUrl(gid))

  async function requireIntakeRoot(factory: StoredFactory, gid: string): Promise<() => void> {
    const { scope, unchanged } = intakeGuard(factory)
    const { asana, read } = intakeAsana()
    const user = await asana.user().catch((error: unknown) => {
      throw new RequestError(409, error instanceof Error ? error.message : 'Connect Asana first')
    })
    await confirmAsanaScope(read, scope)
    const check = await checkAsanaRoot({ read, scope, userGid: user.gid, gid })
    unchanged()
    if (check.kind !== 'root') {
      throw new RequestError(
        409,
        `${check.name} isn’t work ${factory.name}’s Asana intake takes: ${check.reason}.`,
      )
    }
    const above = check.ancestors.find((ancestor) => trackedAsana(factory.id, ancestor))
    const clash = above === undefined ? undefined : trackedAsana(factory.id, above)
    if (clash) {
      throw new RequestError(
        409,
        `${check.name} sits under ${clash.task.displayId}, which TED already tracks. Add it to that tree from the app instead.`,
      )
    }
    return unchanged
  }

  function importAsana(
    input: AsanaImportRequest,
    caller: Caller = { kind: 'app' },
    closing?: AsanaClosing,
    intake?: IntakeImport,
  ): Promise<AsanaImportResult> {
    const target = asanaTarget(input, caller)
    if (input.dryRun === true) {
      return asanaPreview(input, caller).then((preview) => ({ preview, created: [], linked: [] }))
    }
    const prior = asanaImports.get(target.factory.id) ?? Promise.resolve()
    const next = prior
      .catch(() => undefined)
      .then(() => importAsanaNow(input, caller, target, closing, intake))
    asanaImports.set(target.factory.id, next)
    return next.finally(() => {
      if (asanaImports.get(target.factory.id) === next) asanaImports.delete(target.factory.id)
    })
  }

  const asanaIntakes = new Map<string, Promise<unknown>>()

  function asanaIntake(
    input: AsanaIntakeRequest,
    caller: Caller = { kind: 'app' },
  ): Promise<AsanaIntakeResult> {
    const automation = automationCaller(caller)
    if (automation && input.factory !== undefined && input.factory !== automation.factoryKey) {
      throw new RequestError(
        403,
        `this Automation imports only into ${automation.factoryKey}, its own Factory`,
      )
    }
    const key = automation?.factoryKey ?? input.factory
    if (key === undefined) throw new RequestError(400, 'name the Factory to import into')
    const factory = store.listFactories().find((f) => f.key === key)
    if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
    if (removingFactories.has(factory.id)) {
      throw new RequestError(409, `${factory.name} is being removed`)
    }
    const prior = asanaIntakes.get(factory.id) ?? Promise.resolve()
    const next = prior.catch(() => undefined).then(() => asanaIntakeNow(factory, caller))
    asanaIntakes.set(factory.id, next)
    return next.finally(() => {
      if (asanaIntakes.get(factory.id) === next) asanaIntakes.delete(factory.id)
    })
  }

  async function asanaIntakeNow(
    factory: StoredFactory,
    caller: Caller,
  ): Promise<AsanaIntakeResult> {
    const { scope, unchanged } = intakeGuard(factory)
    const { asana, read } = intakeAsana()
    const user = await asana.user().catch((error: unknown) => {
      throw new RequestError(409, error instanceof Error ? error.message : 'Connect Asana first')
    })
    const confirmed = await confirmAsanaScope(read, scope)
    unchanged()
    const listed = await listAsanaIntake(read, scope)
    const parents = new Map<string, string | null>()
    const checks = []
    for (const item of listed.items) {
      checks.push(await checkAsanaRoot({ read, scope, userGid: user.gid, gid: item.gid, parents }))
    }
    const roots = checks
      .flatMap((check) => (check.kind === 'root' ? [check] : []))
      .sort((a, b) => a.ancestors.length - b.ancestors.length)
    const result: AsanaIntakeResult = {
      scope: confirmed,
      imported: [],
      skipped: checks.flatMap((check) =>
        check.kind === 'unreadable'
          ? [{ gid: check.gid, name: check.name, url: check.url, reason: check.reason }]
          : [],
      ),
      tracked: 0,
      left: 0,
      ...(listed.incomplete !== undefined && { incomplete: listed.incomplete }),
    }
    let budget = Math.min(intakeLimit, asanaAllowance(automationCaller(caller)))
    for (const root of roots) {
      if (result.stopped !== undefined) break
      if (
        trackedAsana(factory.id, root.gid) ||
        root.ancestors.some((ancestor) => trackedAsana(factory.id, ancestor))
      ) {
        result.tracked++
        continue
      }
      if (budget <= 0) {
        result.left++
        continue
      }
      try {
        unchanged()
        const imported = await importAsana(
          { url: asanaTaskUrl(root.gid), factory: factory.key },
          caller,
          undefined,
          { budget, unchanged },
        )
        budget -= imported.created.length
        if (imported.root) {
          result.imported.push({
            gid: root.gid,
            name: root.name,
            root: imported.root,
            created: imported.created,
            linked: imported.linked,
          })
        }
      } catch (error) {
        if (error instanceof IntakeBudgetError) {
          budget = 0
          result.left++
          continue
        }
        const reason = redactSecrets(error instanceof Error ? error.message : String(error))
        try {
          unchanged()
        } catch (changed) {
          result.stopped = changed instanceof Error ? changed.message : reason
          break
        }
        result.skipped.push({ gid: root.gid, name: root.name, url: root.url, reason })
      }
    }
    if (result.imported.length > 0 || result.stopped !== undefined) {
      console.log(
        redactSecrets(
          `Asana intake for ${factory.key} from ${scopeName(confirmed)}: imported ${result.imported.length}, skipped ${result.skipped.length}, left ${result.left}${result.stopped ? ', stopped' : ''}`,
        ),
      )
    }
    return result
  }

  function asanaSyncChoice(
    input: AsanaImportRequest,
    caller: Caller,
    closing: AsanaClosing | undefined,
    account: string,
  ): 'grant' | 'decline' | undefined {
    if (caller.kind !== 'app') return undefined
    if (closing === undefined) return input.taskSync === false ? 'decline' : 'grant'
    const taskId = store.getComment(closing.commentId)?.taskId
    if (taskId === undefined) return undefined
    const record = store.trackerSync(taskId, 'asana')
    if (record.declined) return 'decline'
    return record.allowed && record.allowedAccount === account ? 'grant' : undefined
  }

  async function importAsanaNow(
    input: AsanaImportRequest,
    caller: Caller,
    { factory, automation, gid }: ReturnType<typeof asanaTarget>,
    closing?: AsanaClosing,
    intake?: IntakeImport,
  ): Promise<AsanaImportResult> {
    const unchanged =
      intake?.unchanged ??
      (automation && closing === undefined ? await requireIntakeRoot(factory, gid) : undefined)
    const { tree, user } = await readAsana(factory.id, gid, true)
    const resolution = await resolveWorkflow(factory, { fetch: cloned(factory.id) }).catch(
      (error: unknown) => {
        console.error(redactSecrets(`couldn’t read ${factory.repo}’s Workflow: ${String(error)}`))
        return undefined
      },
    )
    if (removingFactories.has(factory.id)) {
      throw new RequestError(409, `${factory.name} is being removed`)
    }
    unchanged?.()
    const plan = planAsana(
      tree,
      factory.id,
      user.gid,
      caller.kind === 'app' && !intake,
      closing?.doneParent,
    )
    if (plan.preview.refusal !== undefined) throw new RequestError(409, plan.preview.refusal)
    if (intake && plan.creates.length > intake.budget) throw new IntakeBudgetError()
    const allowance = asanaAllowance(automation)
    if (plan.creates.length > allowance) {
      if (intake) throw new IntakeBudgetError()
      throw new RequestError(
        409,
        `This Automation Run has already created ${intakeLimit - allowance} Tasks from Asana. TED creates at most ${intakeLimit} per run; the rest wait for the next run.`,
      )
    }
    const tracked = plan.preview.tracked
    if (tracked && input.addToTree !== true && closing === undefined) {
      throw new RequestError(
        409,
        `Already tracked as ${tracked.displayId}. Add its new children to the existing tree instead.`,
      )
    }
    const reread = [
      ...new Set(
        plan.preview.rows.flatMap((row) =>
          row.action.kind === 'kept' ||
          row.action.kind === 'linked' ||
          row.action.kind === 'conflict'
            ? [row.action.taskId]
            : [],
        ),
      ),
    ]
    const replaced = reread.flatMap((id) =>
      store
        .listComments(id)
        .filter((c) => c.asanaMissing && !c.answer && c.id !== closing?.commentId)
        .map((c) => c.id),
    )
    const held = automation !== undefined && (!resolution || runsInBypass(resolution))
    const lead = { ...leadFrom(resolution?.workflow.settings), effortMode: 'stage' as const }
    const syncChoice = asanaSyncChoice(input, caller, closing, user.gid)
    const at = new Date().toISOString()
    const ref = (parent: ParentRef) =>
      'gid' in parent ? { key: parent.gid } : { taskId: parent.taskId }
    const gidOf = (parent: ParentRef) =>
      'gid' in parent
        ? parent.gid
        : (parseAsanaTaskUrl(find(parent.taskId).source?.url ?? '')?.gid ?? gid)
    const result = store.createTaskTree({
      factoryId: factory.id,
      tasks: plan.creates.map(({ node, parent }) => ({
        key: node.gid,
        ...(parent && { parent: ref(parent) }),
        title: node.name,
        description: node.notes ?? '',
        priority: input.priority ?? 'none',
        lead,
        startRequested: input.start === true && !held,
        attachments: withoutRepeats(
          (node.files ?? []).map(({ hash, name, size, mediaType }) => ({
            hash,
            name,
            size,
            mediaType,
          })),
        ),
        sourceUrl: node.url,
        asana: asanaSource(node, tree, user.gid, at),
        ...(automation && { automation: automation.link }),
        ...(syncChoice === 'grant' && { syncAccount: user.gid }),
        ...(syncChoice === 'decline' && { syncDeclined: true }),
        ...(node.projects && { projects: node.projects.map((p) => p.gid) }),
      })),
      links: plan.links.map((link) => ({ taskId: link.taskId, parent: ref(link.parent) })),
      comments: [
        ...plan.creates.flatMap(({ node }) =>
          asanaNotes(node).map((body) => ({
            task: { key: node.gid },
            kind: 'note' as const,
            author: { kind: 'ted' as const },
            body: redactSecrets(body),
          })),
        ),
        ...plan.holds.map((hold) => ({
          task: ref(hold.parent),
          kind: 'question' as const,
          author: { kind: 'ted' as const },
          title: missingWorkTitle,
          body: missingWorkText(hold.items),
          choices: [asanaRetryChoice, asanaGoAheadChoice],
          asanaMissing: { rootGid: gidOf(hold.parent), items: hold.items },
        })),
        ...(held && automation && plan.creates[0]
          ? [
              {
                task: { key: plan.creates[0].node.gid },
                kind: 'note' as const,
                author: { kind: 'ted' as const },
                body: `Created by ${automation.name} · left in Backlog because this Factory runs in Bypass`,
              },
            ]
          : []),
      ],
      ...(input.draftRevision !== undefined && { draftRevision: input.draftRevision }),
      closings: [
        ...(closing
          ? [
              {
                commentId: closing.commentId,
                answer: { kind: 'answered' as const, at, choice: closing.choice },
              },
            ]
          : []),
        ...replaced.map((commentId) => ({
          commentId,
          answer: { kind: 'withdrawn' as const, at, asanaReread: true as const },
        })),
      ],
    })
    const created = [...result.created.values()]
    if (automation && asanaSync) {
      for (const { node } of plan.creates) {
        const task = result.created.get(node.gid)
        if (task && node.projects) {
          const projects = node.projects.map((p) => ({ key: p.gid, name: p.name }))
          asanaSync.consent.askGroups(task.id, automation.name, projects)
        }
      }
    }
    const existingParents = new Set([
      ...plan.creates.flatMap(({ parent }) =>
        parent && 'taskId' in parent ? [parent.taskId] : [],
      ),
      ...plan.links.flatMap((link) => ('taskId' in link.parent ? [link.parent.taskId] : [])),
    ])
    const heldIds = plan.holds.flatMap(({ parent }) => {
      const id = 'taskId' in parent ? parent.taskId : result.created.get(parent.gid)?.id
      return id === undefined ? [] : [id]
    })
    for (const id of new Set([...existingParents, ...heldIds])) holdParent(id)
    for (const id of reread) if (!heldIds.includes(id)) wakeTask(id)
    tellHierarchyChanged([...existingParents, ...plan.links.map((link) => link.taskId)])
    const startAll =
      resolution !== undefined &&
      !held &&
      (input.start === true || !resolution.workflow.stages.includes('backlog'))
    if (startAll) {
      for (const task of created) {
        await start(task.id).catch((error: unknown) => {
          console.error(redactSecrets(`couldn’t start ${task.displayId}: ${String(error)}`))
        })
      }
    }
    wake()
    const root = result.created.get(gid)
    return {
      preview: plan.preview,
      ...(root
        ? { root: { taskId: root.id, displayId: root.displayId } }
        : tracked && { root: { taskId: tracked.taskId, displayId: tracked.displayId } }),
      created: created.map((task) => ({ taskId: task.id, displayId: task.displayId })),
      linked: result.linked.map((task) => ({ taskId: task.id, displayId: task.displayId })),
    }
  }

  async function answerAsanaMissing(
    task: Task,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment> {
    if (comment.answer) throw new RequestError(409, 'this request has already been answered')
    const missing = comment.asanaMissing
    if (!missing) throw new RequestError(400, 'this question isn’t about Asana work')
    if (text !== '') {
      throw new RequestError(400, `answer with ${asanaRetryChoice} or ${asanaGoAheadChoice}`)
    }
    if (choice === asanaRetryChoice) {
      const factory = factoryOf(find(task.id))
      await importAsana(
        { url: asanaTaskUrl(missing.rootGid), factory: factory.key, addToTree: true },
        { kind: 'app' },
        { commentId: comment.id, choice },
      )
      wakeTask(task.id)
    } else if (choice === asanaGoAheadChoice) {
      store.answerComment(comment.id, { kind: 'answered', at: new Date().toISOString(), choice })
      store.postComment({
        taskId: task.id,
        kind: 'note',
        author: { kind: 'ted' },
        body: goAheadText(missing.items),
      })
      wakeTask(task.id)
    } else {
      throw new RequestError(400, `answer with ${asanaRetryChoice} or ${asanaGoAheadChoice}`)
    }
    return store.getComment(comment.id) ?? comment
  }

  async function answerAsanaUnfinished(
    task: Task,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment> {
    if (comment.answer) throw new RequestError(409, 'this request has already been answered')
    const unfinished = comment.asanaUnfinished
    if (!unfinished) throw new RequestError(400, 'this question isn’t about Asana work')
    const choices = comment.choices ?? []
    if (text !== '' || choice === undefined || !choices.includes(choice)) {
      throw new RequestError(400, `answer with ${choices.join(', ')}`)
    }
    if (choice === asanaAddChoice) {
      const current = find(task.id)
      await importAsana(
        {
          url: asanaTaskUrl(unfinished.parentGid),
          factory: factoryOf(current).key,
          addToTree: true,
        },
        { kind: 'app' },
        { commentId: comment.id, choice, doneParent: current.id },
      )
    } else {
      store.answerComment(comment.id, { kind: 'answered', at: new Date().toISOString(), choice })
    }
    return store.getComment(comment.id) ?? comment
  }

  async function storedFiles(files: readonly LinearFile[]): Promise<LinearFile[]> {
    const found = await Promise.all(
      files.map(async (file) =>
        (await stat(attachmentFile(file)).catch(() => undefined))?.isFile() ? file : undefined,
      ),
    )
    return found.filter((file) => file !== undefined)
  }

  function withStoredFiles(issue: LinearIssue, files: readonly LinearFile[]): LinearIssue {
    if (issue.description === undefined || files.length === 0) return issue
    return {
      ...issue,
      description: linkedFilesRewritten(issue.description, files, (file) => attachmentFile(file)),
    }
  }

  function noteUnfetched(taskId: string, issue: LinearIssue, stored: readonly LinearFile[]): void {
    if (issue.discussionWarning) {
      store.postComment({
        taskId,
        kind: 'note',
        author: { kind: 'ted' },
        body: `${issue.discussionWarning}\n\nRead the full discussion in Linear: ${issue.url}`,
      })
    }
    const kept = new Set(stored.map((file) => file.url))
    const missing = [
      ...(issue.unfetched ?? []),
      ...(issue.files ?? [])
        .filter((file) => !kept.has(file.url))
        .map((file) => ({ name: file.name, url: file.url, reason: 'TED’s copy is gone' })),
    ]
    if (missing.length === 0) return
    store.postComment({
      taskId,
      kind: 'note',
      author: { kind: 'ted' },
      body: [
        `TED couldn’t fetch ${missing.length} ${missing.length === 1 ? 'file' : 'files'} from Linear ${issue.identifier}. Their links:`,
        ...missing.map((file) => `- ${file.name}: ${file.reason}. ${file.url}`),
      ].join('\n'),
    })
  }

  async function branchFor(clones: readonly string[], task: Task): Promise<string> {
    const [first] = clones
    if (first === undefined) throw new Error(`${task.displayId} has no clone`)
    const suggested = task.source?.linear?.branchName
    const base =
      suggested !== undefined && (await git.isValidBranchName(first, suggested))
        ? suggested
        : ['ted/', task.displayId.toLowerCase(), slug(task.title)].join('')
    for (let n = 1; ; n++) {
      const branch = n === 1 ? base : `${base}-${n}`
      const taken = await Promise.all(clones.map((clone) => git.branchExists(clone, branch)))
      if (!taken.some(Boolean)) return branch
    }
  }

  async function finish(task: StoredTask, resolution: WorkflowResolution): Promise<void> {
    await pullRequestQueue.get(task.id)
    subAgents.dropFor(task.id)
    browser.cancel(task.id)
    browserApps.delete(task.id)
    await apps.stopTask(task.id).catch((error: unknown) => {
      console.error(`couldn’t stop ${task.displayId}’s Apps:`, error)
    })
    await Promise.all(
      store
        .taskRunList(task.id)
        .filter((r) => r.state !== 'finished')
        .map((r) => runs.stop(r.id)),
    )
    const factory = factoryOf(task)
    const ref = await execution.local(task.id)
    const live = task.repos.filter((r) => !r.removed)
    for (const handle of lifecycle.auxiliaryWorktrees(ref)) {
      await lifecycle.remove(handle).catch((error: unknown) => {
        console.error(`couldn’t remove a sub-agent worktree of ${task.displayId}:`, error)
      })
    }
    const entries = factoryRepos(resolution.workflow, factory)
    const removed: { name: string; teardown?: TeardownRecord }[] = []
    for (const [index, repo] of live.entries()) {
      const teardown = await tearDown(task, repo, repoEntry(entries, repo), live.slice(index))
      await removeRepoWorktree(task, repo)
      removed.push({ name: repo.name, ...(teardown && { teardown }) })
    }
    const legacy = lifecycle.legacyWorktree(ref)
    if (legacy) await lifecycle.remove(legacy)
    await lifecycle.cleanFolders(ref)
    for (const { name, teardown } of removed) store.worktreeRemoved(task.id, name, teardown)
  }

  type TeardownRecord = { command: string; outcome: WorktreeCommandOutcome }

  async function tearDown(
    task: StoredTask,
    repo: TaskRepo,
    entry: FactoryRepoEntry | undefined,
    remainingRepos?: readonly TaskRepo[],
  ): Promise<TeardownRecord | undefined> {
    const teardown = entry?.teardown
    if (!teardown) return undefined
    const current = find(task.id)
    const ref = await execution.local(task.id)
    const result: CommandResult = await lifecycle
      .command(lifecycle.worktree(ref, repo), {
        kind: 'teardown',
        command: teardown,
        env: entry.env,
        remaining: (remainingRepos ?? current.repos)
          .filter((r) => !r.removed)
          .map((r) => lifecycle.worktree(ref, r)),
        signal: stopping.signal,
      })
      .catch((error: unknown) => {
        console.error(`couldn’t run teardown for ${task.displayId}:`, error)
        return { outcome: 'failed' as const }
      })
    if (result.outcome !== 'passed') {
      console.error(
        `teardown for ${task.displayId} in ${repo.name} ${result.outcome}; removing the worktree anyway`,
      )
    }
    return result.outcome === 'interrupted'
      ? undefined
      : { command: teardown.run, outcome: result.outcome }
  }

  async function entriesOf(
    factory: StoredFactory,
    resolution?: WorkflowResolution,
  ): Promise<FactoryRepoEntry[]> {
    const { workflow } = resolution ?? (await resolveWorkflow(factory, { fetch: false }))
    return factoryRepos(workflow, factory)
  }

  function runFolderOf(task: StoredTask, entries: readonly FactoryRepoEntry[]): string | undefined {
    if (entries.length > 1) return path.join(worktreesDir, task.displayId)
    return task.repos.find((r) => !r.removed)?.worktree
  }

  async function cloneFor(
    task: StoredTask,
    factory: StoredFactory,
    entry: FactoryRepoEntry,
  ): Promise<string> {
    const ref = await execution.local(task.id)
    return lifecycle.localPath(await lifecycle.prepare(ref, factory, entry))
  }

  async function openWorktree(
    task: StoredTask,
    factory: StoredFactory,
    entry: FactoryRepoEntry,
    branch: string,
    fresh: boolean,
  ): Promise<NewWorktree & { branch: string; worktree: string }> {
    const ref = await execution.local(task.id)
    const clone = await lifecycle.prepare(ref, factory, entry)
    const { handle, ...made } = await lifecycle.create(clone, entry, branch, fresh)
    return { ...made, worktree: lifecycle.localPath(handle) }
  }

  async function clearLeftover(
    task: StoredTask,
    factory: StoredFactory,
    entry: FactoryRepoEntry,
    keep?: string,
  ): Promise<void> {
    const ref = await execution.local(task.id)
    const clone = await lifecycle.prepare(ref, factory, entry)
    const cleared = await lifecycle.clear(clone, entry, keep)
    if (!cleared) return
    const branch =
      cleared.branch === undefined
        ? ''
        : cleared.branchDeleted
          ? ` and its branch ${cleared.branch}`
          : ` (its branch ${cleared.branch} is kept)`
    tedNote(
      task.id,
      redactSecrets(
        oneLine(
          `TED found a ${entry.name} worktree left by an earlier start that didn’t finish. It had nothing uncommitted, so TED removed it${branch} and started again.`,
          600,
        ),
      ),
    )
  }

  const interruptedSetups = (task: StoredTask) => leadLifecycle.interruptedSetups(task)

  function failedSetupReports(task: StoredTask): Promise<string[]> {
    return Promise.all(
      task.repos.flatMap((repo) => {
        const setup = repo.setup
        const state = setup?.state
        if (repo.removed || !setup || state === undefined || state === 'passed') return []
        if (state === 'running') return []
        return [
          outputTail(commandLog(task, 'setup', repo.name)).then((output) =>
            setupFailure(
              setup.command,
              {
                outcome: state,
                ...(setup.exitCode !== undefined && { exitCode: setup.exitCode }),
              },
              output,
            ),
          ),
        ]
      }),
    )
  }

  async function leadContext(
    task: StoredTask,
    current: StoredTask,
    resolution: WorkflowResolution,
    setupReport: string | undefined,
    { resumeSession, pickUp }: { resumeSession?: string | undefined; pickUp?: string | undefined },
  ) {
    const repairBrief =
      resumeSession === undefined &&
      store.failures.list(task.id).some((f) => f.resolutions.at(-1)?.resolution === 'repair')
    const note = repairBrief
      ? freshRunNote(current)
      : (pickUp ?? (resumeSession === undefined ? pendingPickUp(current) : undefined))
    const followUp = resumeSession === undefined ? followUpNote(current) : undefined
    const waiting = waitingForRun(task.id)
    const since = sinceLastRun(task.id, waiting, resumeSession === undefined && note === undefined)
    const entries = factoryRepos(resolution.workflow, factoryOf(current))
    const cwd = runFolderOf(current, entries)
    if (cwd === undefined) throw new Error(`${task.displayId} has no worktree`)
    const overnightMode = taskAutopilot(task)
    const pending = current.pendingLeadMessages
    const baseNote = baseNotes.get(task.id)
    const round =
      resumeSession === undefined && current.stage === 'validate'
        ? await validateRound(current, resolution.workflow)
        : resumeSession === undefined && current.stage === 'cleanup'
          ? cleanupProgress(cleanupSteps(resolution.workflow), store.cleanupReports(task.id))
          : undefined
    const hierarchyPrompt = hierarchyText(hierarchyView(task.id))
    const prompt = [
      overnightGuidance(overnightMode, task.setup),
      ...pending.map((message) => message.text),
      ...(resumeSession === undefined
        ? [
            await taskLeadPrompt(
              withOriginal(task, current),
              resolution.workflow,
              task.stage as AgentStageId,
              attachmentFile,
              setupReport,
              {
                factory: entries.map(({ name, repo, primary }) => ({ name, repo, primary })),
                task: current.repos
                  .filter((r) => !r.removed)
                  .map((r) => ({ name: r.name, worktree: r.worktree })),
                folder: cwd,
              },
            ),
            ...(hierarchyPrompt !== undefined ? [hierarchyPrompt] : []),
            ...(round !== undefined ? [round] : []),
            ...(followUp !== undefined ? [followUp] : []),
            ...(note !== undefined ? [note] : []),
          ]
        : [continueMessage, ...editedSince(current)]),
      ...(baseNote !== undefined ? [baseNote] : []),
      ...(since !== undefined ? [since] : []),
      ...(resumeSession !== undefined && movedByApproval(current, waiting.answers)
        ? [nextStageMessage(resolution.workflow, current.stage as AgentStageId)]
        : []),
    ].join('\n\n')
    return {
      prompt,
      cwd,
      waiting,
      overnight: overnightMode,
      shared: taskLeadSharedTexts(resolution.workflow, current.stage as AgentStageId),
    }
  }

  function scheduleRepairChecks(taskId: string): void {
    const task = find(taskId)
    if (
      checking.has(taskId) ||
      task.archived ||
      task.stopped ||
      task.waitsForBlockers ||
      !['validate', 'merge'].includes(task.stage) ||
      !validation.pendingRepair(task)
    )
      return
    setChecking(taskId, true)
    inBackground(`revalidate ${task.displayId} after its repair`, async () => {
      try {
        await execution.local(taskId)
        if (!(await incorporateRepairs(find(taskId)))) return
        const current = find(taskId)
        if (current.archived || current.stopped || current.waitsForBlockers) return
        if (current.stage === 'validate') await validation.enter(taskId)
        else if (current.stage === 'merge') watchMerge(taskId)
      } finally {
        setChecking(taskId, false)
      }
    })
  }

  function withOriginal(task: StoredTask, current: StoredTask): StoredTask & { original?: string } {
    const [first] = store.descriptionVersions(task.id)
    const edited = { ...task, title: current.title, description: current.description }
    return first && first.text !== current.description
      ? { ...edited, original: first.text }
      : edited
  }

  function editedSince(task: StoredTask): string[] {
    const run = task.leadRunId === undefined ? undefined : store.getRun(task.leadRunId)
    if (!run) return []
    const edited = store.editedSince(task.id, run.startedAt)
    if (!edited) return []
    const current = find(task.id)
    return [
      `The human edited this Task while your session was running or stopped. Work from this version:\n\nTitle: ${current.title}\n\n${current.description || '(no description)'}`,
    ]
  }

  const failureNotice = (comment: Comment) =>
    comment.author.kind === 'ted' && failureNoticeTitles.includes(comment.title)

  function waitingForRun(taskId: string): { comments: Comment[]; answers: Comment[] } {
    return {
      comments: store
        .listComments(taskId)
        .filter(
          (c) =>
            (c.author.kind === 'human' || failureNotice(c) || peers.isMessage(c.id)) &&
            c.delivered === undefined,
        ),
      answers: store.heldAnswers(taskId),
    }
  }

  function withLines(line: string, comment: Comment): string {
    const lines = linesText(comment)
    return lines === undefined ? line : `${line}\n\n${lines}\n`
  }

  function sinceLastRun(
    taskId: string,
    { comments, answers }: { comments: Comment[]; answers: Comment[] },
    withBrief: boolean,
  ): string | undefined {
    const items = [
      ...comments.map((c) => ({
        at: c.createdAt,
        line: withLines(
          `- ${c.createdAt}: ${failureNotice(c) ? 'TED: ' : ''}${peers.isMessage(c.id) ? plainText(c) : flat(plainText(c))}`,
          c,
        ),
      })),
      ...answers.flatMap((c) => {
        const task = store.getTask(taskId)
        const planNote = task && heldPlanNote(task, c)
        if (planNote !== undefined) {
          return [
            {
              at: c.answer?.at ?? c.createdAt,
              line: `- ${c.answer?.at ?? c.createdAt}: ${planNote}`,
            },
          ]
        }
        if (
          c.kind === 'question' &&
          c.purpose?.kind === 'question' &&
          c.answer?.kind === 'answered'
        ) {
          return [{ at: c.answer.at, line: answerMessage(c, linesText(c)) }]
        }
        const answer = answerText(c)
        return answer === undefined
          ? []
          : [
              {
                at: c.answer?.at ?? c.createdAt,
                line: withLines(
                  `- ${c.answer?.at ?? c.createdAt}: ${c.autopilotAnswered ? 'Autopilot' : 'the human'} answered “${c.title ?? firstLine(c.body)}”: ${flat(answer)}`,
                  c,
                ),
              },
            ]
      }),
    ].sort((a, b) => a.at.localeCompare(b.at))
    if (items.length === 0) return undefined
    const brief = withBrief ? store.latestBrief(taskId) : undefined
    return [
      '# Comments since the last Run',
      'These messages arrived while no Run was working on this Task. Read them before you carry on. Answer their questions in the Thread with ted comment; for a status question, give a brief progress update, then continue your work.',
      ...(brief ? [`## Task brief (version ${brief.version})\n\n${brief.text.trim()}`] : []),
      items.map((i) => i.line).join('\n'),
    ].join('\n\n')
  }

  async function sendWaiting(taskId: string): Promise<void> {
    const task = store.getTask(taskId)
    const run = task && liveLead(task)
    if (!task || !run) return
    pendingTalks(taskId)
    const waiting = waitingForRun(taskId)
    if (waiting.comments.length > 0 || waiting.answers.some((c) => c.answerDelivery))
      await sendComment(run.id)
  }

  async function sendComment(runId: string): Promise<void> {
    try {
      await options.steering.changed(runId)
      await store.persisted()
    } catch (error) {
      console.error(`couldn’t send a Comment to Run ${runId}; the next Run gets it:`, error)
    }
  }

  function roundsThisVisit(task: Task): Comment[] {
    const since = visitStart(task)
    return store
      .listComments(task.id)
      .filter((c) => c.kind === 'round' && c.stage === 'clarify' && c.createdAt >= since)
  }

  function openRound(task: Task): Comment | undefined {
    return store.listComments(task.id).find((c) => c.kind === 'round' && c.answer === undefined)
  }

  function humanDepth(taskId: string): ClarifyDepth | undefined {
    return store.humanClarifyDepth(taskId)
  }

  async function postRound(
    task: StoredTask,
    runId: string,
    input: RoundInput,
    supersedes: string | undefined,
  ): Promise<Comment> {
    if (task.leadRunId !== runId) throw new RequestError(403, 'only the Task Lead posts a round')
    if (task.stage !== 'clarify') {
      throw new RequestError(
        409,
        `rounds are for Clarify, and ${task.displayId} is in ${stageTitle(task.stage)}`,
      )
    }
    if (task.clarifyDepth === 'auto') {
      throw new RequestError(409, `pick a Clarify depth first with \`${pickDepth}\``)
    }
    if (task.clarifyDepth === 'none') {
      throw new RequestError(
        409,
        `Clarify depth is None, which asks no questions; change it with \`${pickDepth}\` first`,
      )
    }
    return holding(task, async () => {
      const old = supersedes === undefined ? undefined : store.getComment(supersedes)
      if (supersedes !== undefined) {
        if (!old || old.taskId !== task.id) {
          throw new RequestError(404, `no request ${supersedes} on ${task.displayId}`)
        }
        if (old.kind !== 'round') throw new RequestError(400, 'a round can replace only a round')
        if (!postedBy(old, task, runId)) {
          throw new RequestError(403, 'a Run can supersede only its own requests')
        }
        if (old.answer) throw new RequestError(409, 'that request has already been answered')
      } else {
        const open = openRound(task)
        if (open) {
          throw new RequestError(
            409,
            `Round ${open.round?.number ?? ''} is still waiting on the human; if it’s out of date, replace it with \`ted ask --supersedes ${open.id} --round <file>\``,
          )
        }
        const answered = roundsThisVisit(task).some(
          (c) => c.answer?.kind === 'answered' && c.answer.talkedThrough === undefined,
        )
        if (task.clarifyDepth === 'few' && answered) {
          throw new RequestError(
            409,
            'Clarify depth is Few, which asks one round; to ask more, switch to grilling with `ted clarify depth grilling "<why>"`',
          )
        }
      }
      const numbers = store.listComments(task.id).map((c) => c.round?.number ?? 0)
      const comment = {
        taskId: task.id,
        kind: 'round' as const,
        title: input.title,
        body: input.summary ?? '',
        author: { kind: 'run' as const, runId },
        round: {
          number: old?.round?.number ?? Math.max(0, ...numbers) + 1,
          questions: input.questions,
        },
      }
      return old ? store.supersedeComment(old.id, comment) : store.postComment(comment)
    })
  }

  function openRequestOf(task: Task, test: (c: Comment) => boolean): Comment | undefined {
    return store.listComments(task.id).find((c) => test(c) && c.answer === undefined)
  }

  function supersedable(
    task: StoredTask,
    runId: string,
    supersedes: string,
    test: (c: Comment) => boolean,
    what: string,
  ): Comment {
    const old = store.getComment(supersedes)
    if (!old || old.taskId !== task.id) {
      throw new RequestError(404, `no request ${supersedes} on ${task.displayId}`)
    }
    if (!test(old)) throw new RequestError(400, `a ${what} can replace only a ${what}`)
    if (!postedBy(old, task, runId)) {
      throw new RequestError(403, 'a Run can supersede only its own requests')
    }
    if (old.answer) throw new RequestError(409, 'that request has already been answered')
    return old
  }

  async function postSizeCheck(
    task: StoredTask,
    runId: string,
    input: SizeCheckInput,
    supersedes: string | undefined,
  ): Promise<Comment> {
    if (task.stage !== 'clarify') {
      throw new RequestError(
        409,
        `the size check is for Clarify, and ${task.displayId} is in ${stageTitle(task.stage)}`,
      )
    }
    const isSizeCheck = (c: Comment) => c.sizeCheck !== undefined
    return holding(task, async () => {
      const old =
        supersedes === undefined
          ? undefined
          : supersedable(task, runId, supersedes, isSizeCheck, 'size check')
      if (!old && openRequestOf(task, isSizeCheck)) {
        throw new RequestError(409, 'the size check is already waiting on the human')
      }
      const comment = {
        taskId: task.id,
        kind: 'question' as const,
        title: sizeCheckTitle,
        body: input.why,
        author: { kind: 'run' as const, runId },
        choices: Object.values(sizeChoices),
        sizeCheck: { settle: input.settle },
      }
      return old ? store.supersedeComment(old.id, comment) : store.postComment(comment)
    })
  }

  async function postProposal(
    task: StoredTask,
    runId: string,
    input: ProposalInput,
    supersedes: string | undefined,
  ): Promise<Comment> {
    if (task.stage !== 'clarify') {
      throw new RequestError(
        409,
        `a split is proposed at Clarify, and ${task.displayId} is in ${stageTitle(task.stage)}`,
      )
    }
    if (input.tasks.length < 2) {
      throw new RequestError(
        400,
        'a split needs at least two rows; each becomes a child Task of this Task',
      )
    }
    const isProposal = (c: Comment) => c.kind === 'proposal'
    return holding(task, async () => {
      const old =
        supersedes === undefined
          ? undefined
          : supersedable(task, runId, supersedes, isProposal, 'proposal')
      const open = old ? undefined : openRequestOf(task, isProposal)
      if (open) {
        throw new RequestError(
          409,
          `your proposal is still waiting on the human; if it’s out of date, replace it with \`ted task propose --supersedes ${open.id} --file <file>\``,
        )
      }
      const comment = {
        taskId: task.id,
        kind: 'proposal' as const,
        title: input.title,
        body: input.summary ?? '',
        author: { kind: 'run' as const, runId },
        proposal: {
          firstPiece: { id: task.id, displayId: task.displayId },
          rows: input.tasks.map((row) => ({
            title: row.title,
            scope: row.scope,
            ...(row.description !== undefined && { description: row.description }),
            priority: row.priority ?? task.priority,
            blockedBy: row.blockedBy ?? [],
          })),
        },
      }
      return old ? store.supersedeComment(old.id, comment) : store.postComment(comment)
    })
  }

  function planningInChat(taskId: string): boolean {
    return store.plans
      .list()
      .some((p) => p.fromTask?.taskId === taskId && !p.fromTask.gone && p.state !== 'ended')
  }

  function planSizeCheck(taskId: string, planId: string): Comment | undefined {
    return store
      .listComments(taskId)
      .findLast((c) => c.sizeCheck && c.answer?.kind === 'answered' && c.answer.planId === planId)
  }

  function heldPlanNote(task: StoredTask, comment: Comment): string | undefined {
    if (comment.answer?.kind !== 'answered' || comment.answer.planId === undefined) return undefined
    const planId = comment.answer.planId
    const plan = store.plans.get(planId)
    if (plan && plan.state !== 'ended') return undefined
    const planTitle = plan?.title ?? `Plan: ${task.title}`
    const approved = store.plans
      .requests(planId)
      .findLast((r) => r.kind === 'proposal' && r.answer?.kind === 'approved')?.answer
    if (approved?.kind === 'approved' && approved.created) {
      return planApprovedLeadMessage({
        planTitle,
        created: approved.created,
        text: approved.text ?? '',
      })
    }
    const outcome = !plan ? 'deleted' : plan.outcome === 'failed' ? 'failed' : 'stopped'
    return planEndedLeadMessage({ planTitle, outcome })
  }

  async function tellLeadAboutPlan(taskId: string, planId: string, text: string): Promise<void> {
    const task = store.getTask(taskId)
    if (!task) return
    const run = liveLead(task)
    if (!run) {
      const sizeCheck = planSizeCheck(taskId, planId)
      if (sizeCheck) store.holdAnswer(sizeCheck.id)
      return
    }
    await runs.send(run.id, text).catch((error: unknown) => {
      console.error(
        `couldn’t tell the Task Lead of ${task.displayId} about its planning chat:`,
        error,
      )
    })
  }

  async function planApproved(taskId: string, input: PlanApproval): Promise<void> {
    const task = store.getTask(taskId)
    if (!task || task.archived) return
    waitForChildren(
      task.id,
      input.created.tasks.map((c) => c.id),
      'plan-task',
    )
    store.taskPlanEnded(task.id, input.planId, 'approved')
    await tellLeadAboutPlan(task.id, input.planId, planApprovedLeadMessage(input))
  }

  async function planEnded(taskId: string, input: PlanEnd): Promise<void> {
    const task = store.getTask(taskId)
    if (!task || task.archived) return
    store.taskPlanEnded(task.id, input.planId, input.outcome)
    await tellLeadAboutPlan(task.id, input.planId, planEndedLeadMessage(input))
  }

  function planOutside(task: StoredTask, comment: Comment): void {
    const runId =
      liveLead(task)?.id ?? (comment.author.kind === 'run' ? comment.author.runId : undefined)
    if (runId === undefined || !comment.sizeCheck) return
    store.postComment({
      taskId: task.id,
      body: planOutsideNote(comment.body, comment.sizeCheck),
      author: { kind: 'run', runId },
    })
    store.needsPlanning(task.id, runId)
    inBackground(`move ${task.displayId} to Backlog for planning`, () => clearing(task.id))
  }

  async function answerAs(
    id: string,
    request: AnswerRequest,
    sendDrafts: boolean,
    mark?: string,
    automatic = false,
    expectedLead?: string,
  ): Promise<Comment> {
    const answered = await createRequestAnswers(
      {
        store,
        untilFree,
        find,
        holding,
        failures: { findDecision: failures.findDecision, resolve: validation.resolve },
        holdingSignoff,
        humanComment,
        answerRunPermission: (runId, generation, reply) =>
          runs.answerPermission(runId, generation, reply),
        resumeByHand,
        drafts,
        deliverAnswer,
        gateWorkflow,
        requireObligations: (task, target) => requireObligations(task, undefined, target),
        checksThen: (taskId, action) => checksThen(taskId, action),
        bindApproval,
        liveLead,
        startMerging,
        watchMerge,
        deliver: (task, text) => deliver(task, text, true),
        pullRequestWork,
        move: (task, resolution, next, message, options) =>
          move(task, resolution, next, message, { ...options, waitForSlot: true }),
        backMessage,
        leaveWorkToDiagnose,
        settleDependents,
        beforeArchive: (task) => {
          archivePlan(task.id)
        },
        archiveNow: (task, close) => archiveHierarchy(task.id, { closePullRequests: close }),
        archiveAsked: (task, options) => {
          const revision =
            options.hierarchyRevision ??
            (underToArchive(task.id).length === 0 ? hierarchyRevision(task.factoryId) : undefined)
          const chosen = {
            ...options,
            ...(revision !== undefined && { hierarchyRevision: revision }),
          }
          archivePlan(task.id, chosen.hierarchyRevision, chosen.children === 'detach')
          return () => archiveHierarchy(task.id, chosen)
        },
        wake,
        sendNudge,
        useDefaultModel,
        linesText,
        gateName,
        firstLine,
        answerAsanaMissing,
        answerAsanaUnfinished,
        trackerConsents,
        answerCleanupFailure,
        withSimulatorRequest: (comment, work) => apps.withSimulatorRequest(comment, work),
        mergeSendBack: (id, findings) =>
          mergeSendBack(id, findings, undefined, false, { counted: false }),
        startTask: (id) => start(id),
        planOutside,
        stopLeadForChildren,
        waitForChildren,
        ...(options.planning && { planning: options.planning }),
      },
      automatic ? { guard: (comment) => guardAutopilotAnswer(comment, expectedLead) } : undefined,
    )(id, request, sendDrafts, mark)
    await resumeAfterAnswer(answered)
    return answered
  }

  function resumesAtMerge(task: StoredTask, answered: Comment): boolean {
    const lead = task.leadRunId === undefined ? undefined : store.getRun(task.leadRunId)
    return (
      leadAskedAtMerge({
        stage: task.stage,
        leadRunId: task.leadRunId,
        askedBy: answered.author.kind === 'run' ? answered.author.runId : undefined,
        leadEnded: lead?.state === 'finished' ? lead.ended?.how : undefined,
        openRequests: openRequests(task.id).length,
      }) &&
      canStartFresh(task) &&
      !leadLifecycle.pendingRevive(task.id) &&
      !leadLifecycle.recovering(task.leadRunId ?? '')
    )
  }

  async function resumeAfterAnswer(answered: Comment): Promise<void> {
    const taskId = answered.taskId
    const task = store.getTask(taskId)
    if (!task || stoppingByHand.has(taskId)) return
    if (!interrupted(task) && !resumesAtMerge(task, answered)) return
    if (store.tedStopPending(taskId)) store.answerTedStop(taskId, 'restart')
    store.resumeTask(taskId, { waitForBlockers: unmergedBlockers(taskId).length > 0 })
    await store.persisted()
    await pump()
  }

  async function guardAutopilotAnswer(comment: Comment, expectedLead?: string): Promise<void> {
    const task = find(comment.taskId)
    const current = store.getComment(comment.id)
    if (
      expectedLead &&
      (task.leadRunId !== expectedLead || store.getRun(expectedLead)?.state === 'finished')
    )
      throw new RequestError(403, 'only the current Task Lead may answer')
    if (
      !taskAutopilot(task) ||
      task.setup ||
      task.archived ||
      task.stopped ||
      task.waitsForBlockers ||
      task.stage === 'done' ||
      !current ||
      current.held ||
      !ordinaryAutopilotRequest(current)
    )
      throw new RequestError(409, 'Autopilot cannot answer this request')
    if (current.archive && underToArchive(task.id).length > 0)
      throw new RequestError(
        403,
        'archiving would archive the Tasks under it too, so this needs the user',
      )
    if (comment.gate) {
      if (
        comment.stage !== task.stage ||
        task.setup ||
        task.forcedGates.includes(task.stage as AgentStageId)
      )
        throw new RequestError(403, 'this sign-off needs the user')
      const plain = await taskWorkflow(task, { fetch: false, inheritedGates: true })
      if (await settingsGuard(task, plain.workflow))
        throw new RequestError(403, 'Workflow changes need the user’s sign-off')
    }
    if (
      !taskAutopilot(find(task.id)) ||
      (expectedLead && find(task.id).leadRunId !== expectedLead) ||
      store.getComment(comment.id)?.answer
    )
      throw new RequestError(409, 'Autopilot or this request changed')
  }

  const automaticProcessing = new Set<string>()
  const automaticNotified = new Set<string>()
  async function processAutopilot(id: string): Promise<void> {
    if (closed || automaticProcessing.has(id)) return
    automaticProcessing.add(id)
    try {
      const task = store.getTask(id)
      if (
        !task ||
        !taskAutopilot(task) ||
        task.setup ||
        task.stopped ||
        task.archived ||
        task.waitsForBlockers
      ) {
        for (const key of automaticNotified)
          if (key.startsWith(`${id}:`)) automaticNotified.delete(key)
        return
      }
      for (const comment of openRequests(id)) {
        if (comment.held || !ordinaryAutopilotRequest(comment)) continue
        if (comment.archive) {
          try {
            await answerAs(
              comment.id,
              {
                action: 'answer',
                choice: archiveChoice,
                archive: {
                  closePullRequests: comment.archive.pullRequests?.recommend === 'close',
                  blocked: 'unblock',
                },
              },
              false,
              undefined,
              true,
            )
          } catch (error) {
            if (!(error instanceof RequestError) || (error.status !== 403 && error.status !== 409))
              throw error
          }
          continue
        }
        if (comment.kind !== 'round' && !comment.gate) {
          const key = `${id}:${comment.id}:${find(id).leadRunId ?? ''}`
          if (!automaticNotified.has(key)) {
            automaticNotified.add(key)
            const message = `Autopilot is on. Resolve your waiting ordinary question ${comment.id} from the Task context with \`ted autopilot answer ${comment.id} [--choice "<choice>"] "<decision and explanation>"\`. If information cannot be obtained, leave it open and explain what is missing. Question data: ${JSON.stringify({ question: comment.body, choices: comment.choices })}`
            const current = find(id)
            const run = liveLead(current)
            if (run?.state === 'working') {
              store.queueRunMessage({ runId: run.id, text: message, from: 'ted' })
              await options.steering.changed(run.id)
            } else if (run) {
              await deliver(current, message, true)
            } else {
              store.holdLeadMessage(id, message)
              if (canStartFresh(current)) store.queueTask(id, current.stage)
            }
          }
          continue
        }
        try {
          await answerAs(
            comment.id,
            comment.gate
              ? { action: 'approve', text: 'Autopilot approved this sign-off.' }
              : { action: 'accept-recommended' },
            false,
            'Autopilot used the recommended answers.',
            true,
          )
        } catch (error) {
          if (!(error instanceof RequestError) || (error.status !== 403 && error.status !== 409))
            throw error
        }
      }
    } finally {
      automaticProcessing.delete(id)
    }
  }

  function autopilotCandidates(): string[] {
    const ids = new Set(store.listOpenRequests().map((comment) => comment.taskId))
    for (const key of automaticNotified) ids.add(key.slice(0, key.indexOf(':')))
    return [...ids]
  }

  function requireCommentable(task: StoredTask): void {
    if (task.archived) {
      throw new RequestError(409, `${task.displayId} is archived; unarchive it to comment`)
    }
    if (publicTask(task.id).commentBox === 'merge-pending') {
      throw new RequestError(
        409,
        `TED is merging ${task.displayId}’s pull requests. Sending a Comment now cancels the merge and counts as Request changes; use Send and cancel merge.`,
      )
    }
  }

  async function humanComment(
    task: StoredTask,
    body: string,
    attachments: readonly Attachment[],
    sendDrafts = true,
  ): Promise<Comment> {
    const posted = store.postComment({
      taskId: task.id,
      body,
      author: { kind: 'human' },
      attachments,
      ...(sendDrafts && task.stage !== 'done' && { lineComments: drafts(task.id) }),
    })
    const run = liveLead(find(task.id))
    if (!run) return posted
    await sendComment(run.id)
    return store.getComment(posted.id) ?? posted
  }

  function markAccepted(run: Run, texts: string[]): void {
    if (run.taskId === undefined) return
    const read = store
      .listComments(run.taskId)
      .filter(
        (c) =>
          c.author.kind === 'human' &&
          (c.delivered?.runId === run.id ||
            (c.delivered === undefined &&
              store.getTask(run.taskId ?? '')?.leadRunId === run.id &&
              texts.some((text) => flat(text) === flat(humanMessage(commentText(c)))))) &&
          c.readAt === undefined &&
          texts.some((text) => flat(text).includes(flat(commentText(c)))),
      )
    store.commentsRead(read.map((c) => c.id))
  }

  async function runSetups(
    task: StoredTask,
    steps: readonly SetupStep[],
  ): Promise<string[] | undefined> {
    const before = find(task.id)
    if (before.stopped || before.archived) return
    await execution.local(task.id)
    if (store.queue().some((q) => q.id === task.id)) store.dequeue(task.id)
    const cancel = new AbortController()
    settingUp.set(task.id, cancel)
    const reports: string[] = []
    for (const { repo, setup } of steps) store.worktreeSetupStarted(task.id, repo.name, setup)
    try {
      for (const { repo, setup } of steps) {
        const signal = AbortSignal.any([stopping.signal, cancel.signal])
        const finished = await runSetup(task, repo, setup, signal, { untilStopped: true })
        if (!finished) return
        if (finished.report !== undefined) reports.push(finished.report)
      }
    } finally {
      settingUp.delete(task.id)
    }
    return reports
  }

  async function runSetup(
    task: StoredTask,
    repo: TaskRepo,
    setup: RecordedSetup,
    signal: AbortSignal,
    { untilStopped }: { untilStopped: boolean },
  ): Promise<{ result: CommandResult; report?: string } | undefined> {
    const log = commandLog(task, 'setup', repo.name)
    const ref = await execution.local(task.id)
    const result = await lifecycle.command(lifecycle.worktree(ref, repo), {
      kind: 'setup',
      command: { run: setup.command, timeoutMs: setup.timeoutMs },
      env: setup.env,
      signal,
    })
    const now = find(task.id)
    if (result.outcome === 'interrupted' || now.archived || (untilStopped && now.stopped)) {
      return undefined
    }
    store.worktreeSetupFinished(task.id, repo.name, {
      outcome: result.outcome,
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
    })
    if (result.outcome === 'passed') return { result }
    return { result, report: setupFailure(setup.command, result, await outputTail(log)) }
  }

  const resume = (taskId: string) => leadLifecycle.resume(taskId)

  function entryFor({ workflow, layers }: WorkflowResolution, stage: AgentStageId | 'done') {
    const file = stage === 'done' ? undefined : workflow.stageFile(stage)
    const order = workflow.order.map((id) => ({
      stage: id,
      enabled: workflow.stages.includes(id),
    }))
    const effort =
      stage === 'done' ? undefined : (workflow.settings.stages[stage]?.effort as Effort | undefined)
    return {
      ...(file && { stageFile: { layer: file.layer, path: file.path } }),
      layers,
      order,
      ...(effort !== undefined && { effort }),
    }
  }

  function publicTask(id: string): Task {
    const task = store.tasksIn(new Set([id])).at(0)
    if (!task) throw new RequestError(404, `no Task ${id}`)
    return task
  }

  async function holding<T>(task: Task, work: () => Promise<T>): Promise<T> {
    if (hierarchyBusy.has(task.id) || deleting.has(task.id))
      throw new RequestError(409, `${task.displayId} has a hierarchy operation underway; try again`)
    if (advancing.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is already moving; try again`)
    }
    advancing.add(task.id)
    let release = () => {}
    released.set(
      task.id,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    try {
      return await work()
    } finally {
      advancing.delete(task.id)
      released.delete(task.id)
      release()
      void pump()
    }
  }

  async function holdingSignoff<T>(task: Task, work: () => Promise<T>): Promise<T> {
    const deadline = clock.now() + 60_000
    for (let held = released.get(task.id); held; held = released.get(task.id)) {
      const left = deadline - clock.now()
      if (left <= 0) {
        throw new RequestError(
          409,
          `${task.displayId} is still busy after waiting a minute. No answer was applied; try again when its current operation finishes.`,
        )
      }
      const timer = new AbortController()
      await Promise.race([held, clockWait(clock, left, timer.signal)])
      timer.abort()
    }
    return holding(find(task.id), work)
  }

  async function untilFree(taskId: string): Promise<void> {
    const deadline = clock.now() + humanWaitMs
    for (let held = released.get(taskId); held; held = released.get(taskId)) {
      const left = deadline - clock.now()
      if (left <= 0) return
      const timer = new AbortController()
      await Promise.race([held, clockWait(clock, left, timer.signal)])
      timer.abort()
    }
  }

  async function deliver(task: Task, text: string, waitForSlot = false): Promise<boolean> {
    const runId = find(task.id).leadRunId
    const run = runId === undefined ? undefined : store.getRun(runId)
    if (!run || run.state === 'finished') return false
    const mode = taskAutopilot(find(task.id))
    const current = find(task.id)
    const lead = effectiveLead(current)
    const message = `${text}\n\n${overnightGuidance(mode, current.setup)}`
    if (waitForSlot && run.state !== 'working' && !continuing.has(task.id)) {
      store.holdLeadMessage(task.id, message, true)
      await store.persisted()
      void pump()
    } else if (
      lead &&
      (leadLifecycle.applying(task.id) ||
        leadLifecycle.restartWaiting(task.id) ||
        current.leadRestartPending ||
        current.pendingLeadMessages.length > 0)
    ) {
      store.holdLeadMessage(task.id, message)
      await store.persisted()
      inBackground('apply the Task Lead settings before delivery', () => applyLead(task.id))
    } else await runs.send(run.id, message)
    overnightSeen.set(run.id, mode)
    return true
  }

  async function deliverAnswer(task: Task, comment: Comment, text: string): Promise<void> {
    if (store.getComment(comment.id)?.answerDelivery) {
      await store.persisted()
      await sendWaiting(task.id)
      void pump()
      return
    }
    if (!(await deliver(task, text, true))) store.holdAnswer(comment.id)
  }

  function openTalkRound(commentId: string): { task: StoredTask; round: Comment } {
    const round = store.getComment(commentId)
    if (!round) throw new RequestError(404, `no Comment ${commentId}`)
    if (round.kind !== 'round')
      throw new RequestError(400, 'only a Clarify round can be talked through')
    if (round.answer) throw new RequestError(409, 'this round has already been answered')
    return { task: find(round.taskId), round }
  }

  function talkLead(task: StoredTask): Run {
    const run = liveLead(task)
    if (!run) {
      throw new RequestError(
        409,
        `${task.displayId}’s Task Lead isn’t running, so there’s no one to talk it through with`,
      )
    }
    return run
  }

  function talkMessages(runId: string, since: string, until: string): number {
    const run = store.getRun(runId)
    if (!run) return 0
    const within = (at: string | undefined) => at !== undefined && at >= since && at <= until
    const human = store
      .runMessages(runId)
      .filter((m) => m.from !== 'ted' && m.queued !== true && within(m.at))
    const agent = agents
      .get(run.agent)
      .chat(runs.output.entries(runId), run.cwd)
      .filter((entry) => entry.kind === 'agent' && within(entry.at))
    return human.length + agent.length
  }

  function availableTalkLead(task: StoredTask, admitted = false): Run | undefined {
    const run = liveLead(task)
    if (
      !run ||
      task.stopped ||
      task.archived ||
      task.stage === 'done' ||
      task.stage === 'backlog' ||
      run.problem ||
      store.agentPauses()[run.agent] ||
      (holds.has(task.id) && !admitted) ||
      leadLifecycle.applying(task.id) ||
      leadLifecycle.recovering(run.id) ||
      task.leadRestartPending
    )
      return undefined
    return run
  }

  function talkLine(round: Comment): string {
    return `The human wants to talk Round ${round.round?.number ?? ''} “${round.title ?? ''}” through with you here; when it’s settled, post a summary with \`ted ask --close --summary <file>\`.`
  }

  function bindRoundTalk(task: StoredTask, round: Comment): Comment {
    const run = talkLead(task)
    const bound =
      round.talk?.runId === run.id &&
      (!round.talkRequested ||
        store.pendingRoundTalks(run.id).some((pending) => pending.round.id === round.id))
    const talking = bound ? round : store.startRoundTalk(round.id, run.id, talkLine(round))
    inBackground('deliver the talk request', () => options.steering.changed(run.id))
    void pump()
    return talking
  }

  function pendingTalks(taskId: string, admitted = false): void {
    const task = store.getTask(taskId)
    if (!task || stoppingByHand.has(task.id) || !availableTalkLead(task, admitted)) return
    for (const round of store.listComments(taskId)) {
      if (round.kind === 'round' && !round.answer && round.talkRequested) bindRoundTalk(task, round)
    }
  }

  async function talkThrough(
    commentId: string,
    request: TalkThroughRequest,
  ): Promise<TalkThroughResult> {
    const { task, round } = openTalkRound(commentId)
    if (task.archived || task.stage === 'done' || task.stage === 'backlog') {
      throw new RequestError(409, 'this Task is no longer available for a talk')
    }
    if (stoppingByHand.has(task.id))
      throw new RequestError(409, 'the Task is still stopping; try again')
    const stoppedByTed = store.tedStopPending(task.id)
    if (
      (stoppedByTed || (task.stopped && store.taskStoppedByHuman(task.id))) &&
      !request.confirmResume
    )
      return { resumeRequired: true }
    if (availableTalkLead(task)) return bindRoundTalk(task, round)
    if (task.status?.kind === 'failed') {
      throw new RequestError(409, 'retry the failed Task before talking it through')
    }
    if (
      task.stopped ||
      (!liveLead(task) &&
        canStartFresh(task) &&
        !leadLifecycle.pendingRevive(task.id) &&
        !leadLifecycle.recovering(task.leadRunId ?? ''))
    ) {
      if (stoppedByTed) store.answerTedStop(task.id, 'restart')
      store.resumeTask(task.id, {
        waitForBlockers: unmergedBlockers(task.id).length > 0,
        talkCommentId: round.id,
      })
    } else if (!round.talkRequested) store.requestRoundTalk(round.id)
    await store.persisted()
    void pump()
    return store.getComment(round.id) ?? round
  }

  async function doneTalking(commentId: string): Promise<Comment> {
    const { task, round } = openTalkRound(commentId)
    if (!round.talk) throw new RequestError(409, 'this round isn’t being talked through')
    if (round.talk.doneAt !== undefined) return round
    if (talkLead(task).id !== round.talk.runId) {
      throw new RequestError(
        409,
        'The Task Lead has restarted since this talk began; click Talk it through to talk with the new one',
      )
    }
    const done = store.roundTalkDone(round.id)
    await deliver(
      task,
      [
        `The human is done talking Round ${round.round?.number ?? ''} through.`,
        'Write a summary of the talk to a file: each question and what you agreed, then what is still open. Post it with `ted ask --close --summary <file>`; TED posts it as your note and closes the round as answered in Talk it through.',
        'If anything is still open, ask it in a new round with `ted ask --round <file>` after closing this one.',
      ].join('\n\n'),
    )
    return done
  }

  async function closeRound(ref: string, caller: Caller, summary: string): Promise<Comment> {
    const { task, runId } = taskLead(ref, caller, 'closes a round')
    const text = summary.trim()
    if (text === '') throw new RequestError(400, 'the summary is empty')
    return holding(task, async () => {
      const round = store
        .listComments(task.id)
        .find((c) => c.kind === 'round' && c.answer === undefined && c.talk !== undefined)
      if (!round?.talk) {
        throw new RequestError(
          409,
          'no round is being talked through; `ted ask --close` closes a round after the human clicks Talk it through',
        )
      }
      if (round.talk.runId !== runId) {
        throw new RequestError(
          409,
          `the human talked Round ${round.round?.number ?? ''} through with an earlier Task Lead Run; ask them to click Talk it through again, or ask a new round`,
        )
      }
      const note = store.postComment({
        taskId: task.id,
        body: text,
        author: { kind: 'run', runId },
      })
      const at = new Date().toISOString()
      return answerRequest(task, round, {
        kind: 'answered',
        at,
        talkedThrough: {
          runId: round.talk.runId,
          summaryId: note.id,
          messages: talkMessages(round.talk.runId, round.talk.startedAt, note.createdAt),
        },
      })
    })
  }

  function stopPreparedLead(task: Task): void {
    if (stoppingByHand.has(task.id)) return
    stoppingByHand.add(task.id)
    if (store.heldRuns().some((h) => h.taskId === task.id)) store.releaseTaskRun(task.id)
    subAgents.dropFor(task.id)
    inBackground(`stop ${task.displayId} before Work`, async () => {
      try {
        await store.persisted()
        await Promise.all(find(task.id).runs.map((run) => runs.stop(run.id)))
      } finally {
        stoppingByHand.delete(task.id)
        void pump()
      }
    })
  }

  function holdBeforeWork(task: StoredTask, resolution: WorkflowResolution): Task {
    const held = store.changeStage(task.id, 'work', entryFor(resolution, 'work'), { prepare: true })
    stopPreparedLead(held)
    return held
  }

  async function move(
    task: StoredTask,
    resolution: WorkflowResolution,
    to: AgentStageId | 'done',
    given: string | undefined,
    {
      signedOff = false,
      checked,
      waitForSlot = false,
    }: { signedOff?: boolean; checked?: HandOffChecks; waitForSlot?: boolean } = {},
  ): Promise<Task> {
    if (
      to === 'done' ||
      resolution.workflow.order.indexOf(to) >
        resolution.workflow.order.indexOf(task.stage as AgentStageId)
    )
      await requireObligations(task, undefined, to)
    const target = cleanupMoveTarget(task.stage, to, resolution.workflow.stages)
    const mergeOff = target.why === 'merge-off'
    const cleanup = target.why === 'cleanup'
    const next = target.next
    const message = mergeOff
      ? mergeOffMessage
      : cleanup
        ? nextStageMessage(resolution.workflow, 'cleanup')
        : given
    if (task.preparation === 'preparing') {
      checkPreparationWorkflow(resolution.workflow)
      if (next === 'work') return holdBeforeWork(task, resolution)
      if (
        next === 'done' ||
        resolution.workflow.order.indexOf(next) > resolution.workflow.order.indexOf('work')
      )
        throw new RequestError(409, 'Preparation must stop before Work')
    }
    const baseNote = firstWorkEntry(next, store.listStageEntries(task.id))
      ? await adoptLatestBase(task)
      : undefined
    const moved = store.changeStage(task.id, next, entryFor(resolution, next))
    const waitingLead = liveLead(find(task.id))
    const choice = effectiveLead(find(task.id))
    if (next !== 'done' && waitingLead && choice && !sameChoice(choice, waitingLead))
      store.setLeadRestartPending(task.id, true)
    if (task.stage === 'merge' && next !== 'done' && next !== 'cleanup') {
      for (const repo of task.repos) {
        if (repo.pullRequest?.signedOff !== undefined) {
          store.pullRequestSignedOff(task.id, repo.name, undefined)
        }
      }
    }
    if (next === 'validate') pullRequestWork(task.id, 'first')
    if (next === 'merge' && !signedOff) {
      pullRequestWork(task.id, 'ready')
      pullRequestWork(task.id, 'signoff')
    }
    if (next === 'done') {
      inBackground(`finish ${task.displayId}`, () => finish(task, resolution))
    } else if (next === 'cleanup' && message !== undefined) {
      await cleanupThen(task.id, resolution.workflow, message)
    } else if (next === 'validate' && message !== undefined) {
      setChecking(task.id, true)
      inBackground(`run ${task.displayId}’s Checks`, () =>
        validation.enter(task.id, message, checked),
      )
    } else if (message !== undefined) {
      const told = await deliver(
        task,
        baseNote === undefined ? message : `${message}\n\n${baseNote}`,
        waitForSlot,
      )
      if (!told && baseNote !== undefined) baseNotes.set(task.id, baseNote)
    } else if (baseNote !== undefined) baseNotes.set(task.id, baseNote)
    if (next === 'merge') {
      const { workflow } = await gateWorkflow(find(task.id), { fetch: false })
      if (tedMerges(moved, workflow)) startMerging(moved, workflow)
      watchMerge(task.id)
    }
    return moved
  }

  function cleanupSteps(workflow: ResolvedWorkflow): CleanupStep[] {
    return workflow.settings.stages.cleanup?.steps ?? []
  }

  function pendingCleanupCommands(taskId: string, workflow: ResolvedWorkflow) {
    const reported = new Set(store.cleanupReports(taskId).map((r) => r.step))
    return cleanupSteps(workflow)
      .filter(isCommandStep)
      .filter((step) => !reported.has(step.name))
  }

  async function cleanupThen(
    taskId: string,
    workflow: ResolvedWorkflow,
    message: string,
  ): Promise<void> {
    if (pendingCleanupCommands(taskId, workflow).length === 0) {
      await afterCleanupCommands(taskId, workflow, message, [])
      return
    }
    setChecking(taskId, true)
    inBackground(`run ${find(taskId).displayId}’s Cleanup commands`, () =>
      runCleanupCommandsFor(taskId, workflow, message),
    )
  }

  async function runCleanupCommandsFor(
    taskId: string,
    workflow: ResolvedWorkflow,
    message: string,
  ): Promise<void> {
    const wait = new AbortController()
    checkWaits.set(taskId, wait)
    let ran: CleanupCommandResult[] = []
    let interrupted = false
    try {
      const task = find(taskId)
      const steps = pendingCleanupCommands(taskId, workflow)
      const factory = factoryOf(task)
      const primary = task.repos.find((r) => !r.removed && sameRepo(r.repo, factory.repo))
      if (!primary) {
        ran = steps.map((step) => ({
          step: step.name,
          state: 'failed' as const,
          timeout: step.timeout ?? defaultCheckTimeout,
          durationMs: 0,
          output: 'TED didn’t run the command: the Task has no worktree of the primary repo',
        }))
        for (const result of ran) store.recordCleanupCommand(taskId, result)
      } else {
        const signal = AbortSignal.any([stopping.signal, wait.signal])
        const release = await options.checkSlots.take({ taskId, signal })
        if (release === undefined) {
          interrupted = true
          return
        }
        const batch = randomUUID()
        try {
          const entry = repoEntry(factoryRepos(workflow, factory), primary)
          const env = options.env?.() ?? process.env
          const result = await runCleanupCommands({
            steps,
            cwd: primary.worktree,
            env: checkEnv(task.displayId, entry?.env ?? {}, env),
            shell: [loginShell(env), '-lc'],
            logFor: (position) =>
              path.join(checkDir(task, `cleanup-${batch}`), `${position + 1}.log`),
            prepareLaunch: () => prepareCommandLaunch(find(taskId)),
            lowPriority: store.settings().lowPriorityWork,
            signal,
            record: (r) => store.recordCleanupCommand(taskId, r),
          })
          if (result.outcome === 'interrupted') {
            interrupted = true
            return
          }
          ran = result.results
        } finally {
          release()
        }
      }
    } finally {
      if (checkWaits.get(taskId) === wait) checkWaits.delete(taskId)
      setChecking(taskId, false)
      if (interrupted && !stopping.signal.aborted) resumedDuringCleanup(taskId, workflow, message)
    }
    await store.persisted()
    await afterCleanupCommands(taskId, workflow, message, ran)
  }

  function resumedDuringCleanup(taskId: string, workflow: ResolvedWorkflow, message: string) {
    const task = store.getTask(taskId)
    if (task?.stage !== 'cleanup' || task.archived || find(taskId).stopped) return
    if (pendingCleanupCommands(taskId, workflow).length === 0) return
    inBackground(`run ${task.displayId}’s Cleanup commands again`, async () => {
      if (store.queue().some((q) => q.id === taskId)) store.dequeue(taskId)
      await cleanupThen(taskId, workflow, message)
    })
  }

  function cleanupLeft(taskId: string, workflow: ResolvedWorkflow): 'nothing' | 'lead' {
    const reports = new Map(store.cleanupReports(taskId).map((r) => [r.step, r]))
    const leadNeeded = cleanupSteps(workflow).some((step) =>
      isCommandStep(step) ? reports.get(step.name)?.result === 'failed' : !reports.has(step.name),
    )
    return leadNeeded || openCleanupFailure(taskId) !== undefined ? 'lead' : 'nothing'
  }

  async function afterCleanupCommands(
    taskId: string,
    workflow: ResolvedWorkflow,
    message: string,
    ran: readonly CleanupCommandResult[],
  ): Promise<void> {
    const task = store.getTask(taskId)
    if (task?.stage !== 'cleanup' || task.archived || task.stopped) return
    const steps = cleanupSteps(workflow)
    const reports = new Set(store.cleanupReports(taskId).map((r) => r.step))
    const instructionsLeft = steps.filter(
      (step) => !isCommandStep(step) && !reports.has(step.name),
    ).length
    if (cleanupLeft(taskId, workflow) === 'nothing') {
      inBackground(`finish ${task.displayId}’s Cleanup`, async () => {
        await untilFree(taskId)
        await holding(find(taskId), async () => {
          const current = find(taskId)
          if (current.stage !== 'cleanup' || current.stopped || current.archived) return
          await finishCleanup(current, await taskWorkflow(current, { fetch: false }))
        })
      })
      return
    }
    const text =
      ran.length > 0 ? `${message}\n\n${cleanupCommandsText(ran, instructionsLeft)}` : message
    if (!(await deliver(task, text, true))) {
      store.resumeTask(taskId, { waitForBlockers: false })
      await store.persisted()
      void pump()
    }
  }

  function openCleanupFailure(taskId: string): Comment | undefined {
    return openRequests(taskId).find((c) => c.cleanupFailure !== undefined)
  }

  async function finishCleanup(
    task: StoredTask,
    resolution: WorkflowResolution,
  ): Promise<OutcomeResult> {
    const asked = openCleanupFailure(task.id)
    if (asked)
      throw new RequestError(
        409,
        `TED asked the user what to do about the failed Cleanup steps (request ${asked.id}); wait for their answer`,
      )
    const steps = cleanupSteps(resolution.workflow)
    if (pendingCleanupCommands(task.id, resolution.workflow).length > 0) {
      await cleanupThen(
        task.id,
        resolution.workflow,
        'TED ran the Cleanup commands that had no result yet.',
      )
      return {
        task: publicTask(task.id),
        message:
          'TED is running the Cleanup commands that have no result yet and sends you their results. End your turn.',
      }
    }
    const reports = new Map(store.cleanupReports(task.id).map((r) => [r.step, r]))
    const missing = steps.filter((step) => !reports.has(step.name))
    if (missing.length > 0)
      throw new RequestError(
        409,
        `report every Cleanup step first with \`ted cleanup report "<step name>" done|skipped|failed "<what happened>"\`; still to report: ${missing.map((step) => `“${step.name}”`).join(', ')}`,
      )
    const failed = steps.filter((step) => reports.get(step.name)?.result === 'failed')
    if (failed.length === 0) {
      await move(task, resolution, 'done', undefined)
      return { task: publicTask(task.id), message: `${task.displayId} moved to Done` }
    }
    const names = failed.map((step) => step.name)
    const request = store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title:
        names.length === 1
          ? `A Cleanup step failed: ${names[0]}`
          : `${names.length} Cleanup steps failed`,
      body: cleanupFailureBody(failed.map((step) => ({ step, report: reports.get(step.name) }))),
      choices: [cleanupRetryChoice, cleanupFinishChoice],
      cleanupFailure: { steps: names },
    })
    return {
      task: publicTask(task.id),
      message: `TED asked the user whether to try the failed Cleanup steps again or finish anyway (request ${request.id}). End your turn; TED sends you their answer.`,
      request,
    }
  }

  async function answerCleanupFailure(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment> {
    if (choice !== cleanupRetryChoice && choice !== cleanupFinishChoice)
      throw new RequestError(400, `answer with ${cleanupRetryChoice} or ${cleanupFinishChoice}`)
    const picked: string = choice
    return holding(task, async () => {
      const current = find(task.id)
      const open = store.getComment(comment.id)
      if (open?.answer) throw new RequestError(409, 'this request has already been answered')
      if (current.stage !== 'cleanup')
        throw new RequestError(409, `${current.displayId} isn’t in Cleanup any more`)
      const steps = comment.cleanupFailure?.steps ?? []
      const resolution = await taskWorkflow(current, { fetch: true })
      const at = new Date().toISOString()
      const answered = answerRequest(
        current,
        comment,
        { kind: 'answered', at, choice: picked, ...(text !== '' && { text }) },
        drafts(current.id),
      )
      if (picked === cleanupFinishChoice) {
        store.finishCleanupAnyway(current.id, steps)
        store.postComment({
          taskId: current.id,
          author: { kind: 'ted' },
          body: `The user chose Finish anyway. These Cleanup steps didn’t happen: ${steps.map((name) => `“${name}”`).join(', ')}.`,
        })
        await move(current, resolution, 'done', undefined)
        return store.getComment(answered.id) ?? answered
      }
      store.retryCleanup(current.id, steps)
      const retry = cleanupSteps(resolution.workflow).filter((step) => steps.includes(step.name))
      const message = [
        `The user chose ${cleanupRetryChoice}${text === '' ? '.' : `, and wrote:\n\n${text}`}`,
        retry.length > 0
          ? cleanupStepsText(retry, '# Cleanup steps to redo')
          : 'The failed steps are no longer in the Factory’s Cleanup steps, so there is nothing to redo.',
        retry.some((step) => !isCommandStep(step))
          ? 'Report each instruction step again, post a note, then run `ted outcome advance`.'
          : '',
      ]
        .filter((part) => part !== '')
        .join('\n\n')
      await store.persisted()
      await cleanupThen(current.id, resolution.workflow, message)
      return store.getComment(answered.id) ?? answered
    })
  }

  function postedBy(request: Comment, task: StoredTask, runId: string): boolean {
    const { author } = request
    if (author.kind !== 'run') return false
    if (author.runId === runId) return true
    const authorRun = store.getRun(author.runId)
    return (
      task.leadRunId === runId &&
      authorRun?.taskId === task.id &&
      authorRun.parentRunId === undefined
    )
  }

  function draftOf(id: string): LineComment {
    const found = store.getLineComment(id)
    if (!found) throw new RequestError(404, `no line comment ${id}`)
    if (found.sent) throw new RequestError(409, 'that line comment has already been sent')
    return found
  }

  function answerRequest(
    task: Task,
    comment: Comment,
    answer: CommentAnswer,
    lineComments?: readonly string[],
  ): Comment {
    return answerTaskRequest(store, task, comment, answer, lineComments)
  }

  function visitStart(task: Task): string {
    return store.listStageEntries(task.id).findLast((e) => e.stage === task.stage)?.at ?? ''
  }

  function lastChangesRequested(task: Task): string {
    const since = visitStart(task)
    const canceled = task.stage === 'merge' ? store.mergeHistory(task.id).canceledAt : undefined
    return store
      .listComments(task.id)
      .flatMap((c) =>
        c.gate && c.stage === task.stage && c.answer?.kind === 'changes-requested'
          ? [c.answer.at]
          : [],
      )
      .concat(canceled === undefined ? [] : [canceled])
      .filter((at) => at >= since)
      .reduce(latest, '')
  }

  function openGateRequest(task: Task): Comment | undefined {
    return store
      .listComments(task.id)
      .find((c) => c.gate && c.stage === task.stage && c.answer === undefined)
  }

  async function sendBack(
    task: StoredTask,
    resolution: WorkflowResolution,
    from: AgentStageId,
    request: Extract<ReportOutcomeRequest, { outcome: 'back' }>,
    checkRunId?: string,
    options: { counted?: boolean; cause?: SendBackCause; conflict?: FoundConflict } = {},
  ): Promise<OutcomeResult & { pending?: boolean }> {
    const { workflow } = resolution
    const to = request.to
    const findings = request.findings.trim()
    checkBack(workflow, from, to)
    const counted = options.counted ?? lastChangesRequested(task) === ''
    const limit = workflow.settings.stages[from]?.max_back
    const count = store.sendBackCount(task.id, from)
    if (counted && limit !== undefined && count >= limit) {
      const times = `${count} ${count === 1 ? 'time' : 'times'}`
      if (from === 'validate') {
        if (
          workflow.settings.stages.validate?.loop_check !== false &&
          (await startLoopCheck(task, {
            to,
            findings,
            round: count + 1,
            limit,
            ...(checkRunId !== undefined && { checkRunId }),
          }))
        ) {
          return {
            task: publicTask(task.id),
            message:
              'TED is checking progress before asking the human. The Task stays in Validate.',
            pending: true,
          }
        }
        const request = askAboutLoop(task, workflow, {
          to,
          findings,
          title: `Validate has sent this Task back ${times}, its limit`,
          intro: `TED couldn’t assess progress. ${workflow.settings.stages.validate?.loop_check === false ? 'Loop checks are disabled.' : 'A Loop check couldn’t start.'} Validate has reached its send-back limit (${count}) and needs your decision.`,
          ...(checkRunId !== undefined && { checkRunId }),
        })
        return {
          task: publicTask(task.id),
          message: `Validate has sent this Task back ${times}, its limit, so TED asked the human instead. TED sends you their answer.`,
          request,
        }
      }
      const request = store.postComment({
        taskId: task.id,
        kind: 'question',
        author: { kind: 'ted' },
        title: `${stageTitle(from)} wants to send this Task back to ${stageTitle(to)} again`,
        purpose: { kind: 'send-back' },
        body: `${stageTitle(from)} has reached its send-back limit (${count}) and needs your decision. Send it back to ${stageTitle(to)} for another attempt, or keep it in ${stageTitle(from)} to revisit the approach. Full Findings are in the Task’s history.`,
        choices: [`Send it back to ${stageTitle(to)}`, `Keep it in ${stageTitle(from)}`],
      })
      store.askAboutSendBack({
        commentId: request.id,
        taskId: task.id,
        from,
        to,
        findings,
        loop: false,
        ...(checkRunId !== undefined && { checkRunId }),
      })
      return {
        task: publicTask(task.id),
        message: `${stageTitle(from)} has sent this Task back ${times}, its limit, so TED asked the human instead. TED sends you their answer.`,
        request,
      }
    }
    const loopAt = from === 'validate' ? workflow.settings.stages.validate?.loop_check : undefined
    if (counted && typeof loopAt === 'number' && count + 1 === loopAt) {
      const started = await startLoopCheck(task, {
        to,
        findings,
        round: count + 1,
        ...(limit !== undefined && { limit }),
        ...(checkRunId !== undefined && { checkRunId }),
      })
      if (started) {
        return {
          task: publicTask(task.id),
          message: `This is Validate’s send-back number ${count + 1}, so TED started a loop check to see whether the rounds are converging. The Task stays in Validate until it answers; TED sends you the result.`,
          pending: true,
        }
      }
    }
    const cause: SendBackCause | undefined =
      options.cause ??
      (from === 'merge'
        ? undefined
        : checkRunId !== undefined
          ? 'check'
          : !counted
            ? 'human'
            : from === 'validate'
              ? 'review'
              : undefined)
    const sentBack = store.recordSendBack({
      taskId: task.id,
      from,
      to,
      findings,
      counted,
      ...(counted && { round: count + 1 }),
      ...(counted && limit !== undefined && { limit }),
      ...(checkRunId !== undefined && { checkRunId }),
      ...(cause !== undefined && { cause }),
      ...(options.conflict !== undefined && { conflict: options.conflict }),
    })
    if (from === 'review') store.resetSendBacks(task.id, 'validate')
    const moved = await move(task, resolution, to, backMessage(workflow, to, from, sentBack))
    return { task: moved, message: `${task.displayId} moved back to ${stageTitle(to)}` }
  }

  async function reviewRound(task: StoredTask): Promise<{
    round: number
    commits: RepoCommit[]
    rounds: EarlierRound[]
    fixes?: FixesSince[]
    conflict?: { sendBacks: ConflictSendBack[]; found: RecordedConflict[] }
    baseConflict?: boolean
  }> {
    await execution.local(task.id)
    const series = countedValidateSendBacks(task.id)
    const live = task.repos.filter((r) => !r.removed)
    const heads = await Promise.all(
      live.map(async (r) => ({
        name: r.name,
        worktree: r.worktree,
        commit: await git.headCommit(r.worktree).catch(() => undefined),
      })),
    )
    const commits = heads.flatMap(({ name, commit }) =>
      commit === undefined ? [] : [{ name, commit }],
    )
    const rounds = series.flatMap((b, i) =>
      b.checkRunId === undefined ? [{ round: b.round ?? i + 1, findings: b.findings }] : [],
    )
    const full = { round: series.length + 1, commits, rounds }
    const visit = visitStart(task)
    const last = store
      .reviewScopes(task.id)
      .findLast((scope) => scope.at < visit && subAgents.reviewed(scope.runId))
    if (!last || commits.length !== heads.length) return full
    const inSeries = new Set(series.map((b) => b.id))
    const since = store.listSendBacks(task.id).filter((b) => b.at > last.at)
    const conflicted = since.some((b) => b.cause === 'base-conflict')
    const conflictOnly = conflicted && since.every((b) => b.cause === 'base-conflict')
    const whole = conflicted ? { ...full, baseConflict: true } : full
    if (conflicted && !conflictOnly) return whole
    if (
      !conflictOnly &&
      (since.length === 0 ||
        !since.every((b) => inSeries.has(b.id) && b.to === 'work') ||
        since.every((b) => b.checkRunId !== undefined))
    ) {
      return full
    }
    const reviewedRepos = new Set(last.commits.map((c) => c.name))
    if (reviewedRepos.size !== heads.length || heads.some((h) => !reviewedRepos.has(h.name))) {
      return whole
    }
    const found = store.baseConflicts(task.id).filter((c) => c.at > last.at)
    const fixes: FixesSince[] = []
    for (const head of heads) {
      const reviewed = last.commits.find((c) => c.name === head.name)?.commit
      if (reviewed === undefined || head.commit === undefined) return whole
      if (!(await git.isAncestor(head.worktree, reviewed, head.commit))) return whole
      const range = { from: reviewed, to: head.commit }
      const own = await ownChanges(task, head, range, found)
      if (own !== undefined) {
        fixes.push({ name: head.name, since: reviewed, head: head.commit, ...own })
        continue
      }
      if (conflictOnly) return whole
      const files = await git.changesBetween(head.worktree, range).catch(() => [])
      fixes.push({
        name: head.name,
        since: reviewed,
        head: head.commit,
        files: files.map((f) => f.path),
      })
    }
    if (!conflictOnly) return { ...full, fixes }
    return {
      ...full,
      fixes,
      conflict: {
        sendBacks: since.map((b) => ({ from: stageTitle(b.from), findings: b.findings })),
        found: found.filter((c) => c.sendBackId !== undefined),
      },
    }
  }

  async function movedSinceReview(task: StoredTask): Promise<string | undefined> {
    const runId = subAgents.visitReviewer(task)
    const scope = store.reviewScopes(task.id).find((s) => s.runId === runId)
    if (runId === undefined || scope === undefined) return undefined
    await execution.local(task.id)
    const heads = await Promise.all(
      task.repos
        .filter((r) => !r.removed)
        .map(async (r) => ({
          name: r.name,
          now: await git.headCommit(r.worktree).catch(() => undefined),
        })),
    )
    const repos: MovedRepo[] = [
      ...heads.flatMap(({ name, now }) => {
        const reviewed = scope.commits.find((c) => c.name === name)?.commit
        if (reviewed !== undefined && reviewed === now) return []
        return [
          { name, ...(reviewed !== undefined && { reviewed }), ...(now !== undefined && { now }) },
        ]
      }),
      ...scope.commits
        .filter((c) => !heads.some((h) => h.name === c.name))
        .map((c) => ({ name: c.name, reviewed: c.commit, gone: true })),
    ]
    if (repos.length === 0) return undefined
    return reviewMovedRefusal({ displayId: task.displayId, runId, repos })
  }

  async function ownChanges(
    task: StoredTask,
    head: { name: string; worktree: string },
    range: { from: string; to: string },
    found: readonly BaseConflictFound[],
  ): Promise<Pick<FixesSince, 'files' | 'merges' | 'commitCount'> | undefined> {
    const commits = await git.ownCommits(head.worktree, range)
    if (commits === undefined) return undefined
    const tips = [
      ...found.filter((c) => c.repo === head.name).map((c) => c.tip),
      ...[baseTips.get(baseTipKey(task.id, head.name))].flatMap((tip) => tip ?? []),
    ]
    const merges: MergedBase[] = []
    const files = new Set<string>()
    let from = range.from
    const addOwn = async (to: string) => {
      if (from === to) return
      const changed = await git.changesBetween(head.worktree, { from, to }).catch(() => [])
      for (const file of changed) files.add(file.path)
    }
    for (const { commit, parents } of commits) {
      const [first, merged, ...more] = parents
      if (merged === undefined) continue
      if (first === undefined || more.length > 0) return undefined
      const fromBase = await Promise.all(
        tips.map((tip) => git.isAncestor(head.worktree, merged, tip)),
      )
      if (!fromBase.some(Boolean)) return undefined
      await addOwn(first)
      from = commit
      const conflicts = await git.mergeConflicts(head.worktree, { ours: first, theirs: merged })
      if (conflicts === undefined) return undefined
      merges.push({ commit, base: merged, files: conflicts })
    }
    await addOwn(range.to)
    return {
      files: [...files],
      commitCount: commits.length,
      ...(merges.length > 0 && { merges }),
    }
  }

  async function planReview(task: StoredTask, prompt: string): Promise<PlannedReview> {
    const { round, commits, rounds, fixes, conflict, baseConflict } = await reviewRound(task)
    const p1OnlyFrom = p1OnlyAt((await taskWorkflow(task, { fetch: false })).workflow, round)
    const p1Only = p1OnlyFrom === undefined ? {} : { p1OnlyFrom }
    if (fixes === undefined) {
      return {
        prompt:
          p1OnlyFrom === undefined
            ? prompt
            : p1OnlyReviewPrompt({
                displayId: task.displayId,
                round,
                from: p1OnlyFrom,
                added: prompt,
                ...(baseConflict && { conflict: true }),
              }),
        scope: { taskId: task.id, scope: 'full', round, commits },
        ...p1Only,
      }
    }
    const since = fixes.map(({ name, since }) => ({ name, commit: since }))
    if (conflict !== undefined) {
      return {
        prompt: conflictReviewPrompt({
          displayId: task.displayId,
          repos: fixes,
          sendBacks: conflict.sendBacks,
          found: conflict.found,
          multiRepo: fixes.length > 1,
          added: prompt,
          ...p1Only,
        }),
        scope: { taskId: task.id, scope: 'conflict', round, commits, since },
        ...p1Only,
      }
    }
    return {
      ...p1Only,
      prompt: scopedReviewPrompt({
        displayId: task.displayId,
        round,
        rounds,
        repos: fixes,
        multiRepo: fixes.length > 1,
        added: prompt,
        ...p1Only,
      }),
      scope: {
        taskId: task.id,
        scope: 'fixes',
        round,
        commits,
        since,
      },
    }
  }

  async function validateRound(
    task: StoredTask,
    workflow: ResolvedWorkflow,
  ): Promise<string | undefined> {
    const { round, rounds, fixes, conflict, baseConflict } = await reviewRound(task)
    const limit = workflow.settings.stages.validate?.max_back
    if (conflict !== undefined) {
      return conflictRoundText({
        round,
        ...(limit !== undefined && { limit }),
        ...validateRoundSettings(workflow, round),
      })
    }
    if (round === 1) return undefined
    return validateRoundText({
      round,
      rounds,
      scoped: fixes !== undefined,
      ...(baseConflict && { baseConflict }),
      ...(limit !== undefined && { limit }),
      ...validateRoundSettings(workflow, round),
    })
  }

  function validateRoundSettings(workflow: ResolvedWorkflow, round: number) {
    const p1OnlyFrom = p1OnlyAt(workflow, round)
    return {
      ...(p1OnlyFrom !== undefined && { p1OnlyFrom }),
      ...(subAgentsInValidate(workflow) && { subAgents: true }),
    }
  }

  async function declareSeverity(
    task: StoredTask,
    workflow: ResolvedWorkflow,
    runId: string,
    severity: FindingSeverity | undefined,
  ): Promise<void> {
    const round = store.sendBackCount(task.id, 'validate') + 1
    const from = p1OnlyAt(workflow, round)
    if (from !== undefined && lastChangesRequested(task) === '') {
      if (severity === undefined) {
        if ((await movedSinceReview(task)) !== undefined) return
        throw new RequestError(409, p1OnlyRefusal(round, from))
      }
      if (
        severity === 'unfixed' &&
        !countedValidateSendBacks(task.id).some((b) => b.checkRunId === undefined)
      ) {
        throw new RequestError(409, noEarlierFindingRefusal(round))
      }
    }
    if (severity !== undefined) store.declareSeverity({ taskId: task.id, runId, round, severity })
  }

  function backMessage(
    workflow: ResolvedWorkflow,
    to: AgentStageId,
    from: AgentStageId,
    sendBack: SendBack,
  ): string {
    const message = backStageMessage(workflow, to, from, sendBack.findings)
    if (from !== 'validate' || to !== 'work' || sendBack.round === undefined) return message
    return [
      message,
      workRoundText({
        round: sendBack.round,
        cause: sendBack.cause,
        ...(sendBack.limit !== undefined && { limit: sendBack.limit }),
      }),
    ].join('\n\n')
  }

  function countedValidateSendBacks(taskId: string) {
    const count = store.sendBackCount(taskId, 'validate')
    if (count === 0) return []
    return store
      .listSendBacks(taskId)
      .filter((b) => b.from === 'validate' && b.counted)
      .slice(-count)
  }

  function roundsText(rounds: readonly string[]): string {
    return rounds.map((findings, i) => `## Round ${i + 1}\n\n${findings.trim()}`).join('\n\n')
  }

  function askAboutLoop(
    task: StoredTask,
    workflow: ResolvedWorkflow,
    input: {
      to: AgentStageId
      findings: string
      title: string
      intro: string
      verdict?: LoopVerdict
      checkRunId?: string
    },
  ): Comment {
    const choices = loopChoices(workflow)
    const recommendation =
      input.verdict === 'looping' && choices.includes(backToDesignChoice)
        ? `Recommended: ${backToDesignChoice}. Revisit the approach before another repair.`
        : input.verdict === 'converging'
          ? `Recommended: ${tryAgainChoice}. Allow another attempt at the remaining Findings.`
          : input.verdict === 'looping'
            ? `Recommended: ${tryAgainChoice}. Add guidance to break the repeated pattern.`
            : `Suggested next step: ${tryAgainChoice} to allow another repair attempt${choices.includes(backToDesignChoice) ? ', or Back to Design to revisit the approach' : ''}.`
    const request = store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: input.title,
      purpose: { kind: 'send-back' },
      body: [
        input.intro,
        recommendation,
        'Full Findings are in the Task’s history. Moving on leaves the Findings open.',
      ].join('\n\n'),
      choices,
    })
    store.askAboutSendBack({
      commentId: request.id,
      taskId: task.id,
      from: 'validate',
      to: input.to,
      findings: input.findings,
      loop: true,
      ...(input.checkRunId !== undefined && { checkRunId: input.checkRunId }),
    })
    return request
  }

  async function roundCommits(task: StoredTask): Promise<string[]> {
    const worktree = task.repos.find((r) => !r.removed)?.worktree
    if (worktree === undefined) return []
    const commits = await Promise.all(
      countedValidateSendBacks(task.id).map((b) =>
        git.commitAt(worktree, b.at).catch(() => undefined),
      ),
    )
    const head = await git.revParse(worktree, 'HEAD').catch(() => undefined)
    return [...commits, head].map((c, i) => `- Round ${i + 1}: ${c ?? 'unknown'}`)
  }

  async function startLoopCheck(
    task: StoredTask,
    input: {
      to: AgentStageId
      findings: string
      round: number
      limit?: number
      checkRunId?: string
    },
  ): Promise<boolean> {
    const rounds = [...countedValidateSendBacks(task.id).map((b) => b.findings), input.findings]
    const prompt = [
      await loopCheckInstructions(),
      roundsText(rounds),
      `# Commits\n\n${(await roundCommits(task)).join('\n')}`,
      `# The Task: ${task.displayId}\n\n${task.title}`,
    ].join('\n\n')
    const runId = subAgents.requestForTed(task, {
      name: 'Loop check · Validate',
      prompt,
      choice: await reviewerFor(task),
      purpose: 'loop-check',
    })
    if (runId === undefined) return false
    const check = store.startLoopCheck({
      runId,
      taskId: task.id,
      to: input.to,
      findings: input.findings,
      round: input.round,
      ...(input.limit !== undefined && { limit: input.limit }),
      ...(input.checkRunId !== undefined && { checkRunId: input.checkRunId }),
    })
    inBackground(`run ${task.displayId}’s loop check`, () => awaitLoopCheck(check))
    return true
  }

  function pendingLoopCheck(taskId: string): LoopCheck | undefined {
    return store.loopChecks(taskId).find((c) => c.verdict === undefined)
  }

  async function awaitLoopCheck(check: LoopCheck): Promise<void> {
    const result = await subAgents.result(check.runId)
    if (closed) return
    const said = result.message?.trim() ?? ''
    const finished = result.error === undefined && result.state !== 'stopped'
    const verdict: LoopVerdict = finished ? (verdictIn(said) ?? 'failed') : 'failed'
    const reason =
      verdict !== 'failed'
        ? reasonIn(said)
        : finished
          ? 'the loop check gave no verdict'
          : 'the loop check didn’t finish'
    const run = store.getRun(check.runId)
    if (run && run.state !== 'finished') await runs.stop(run.id).catch(() => undefined)
    const resolution = await taskWorkflow(find(check.taskId), { fetch: false })
    const { workflow } = resolution
    store.finishLoopCheck(check.runId, verdict, reason)
    const task = find(check.taskId)
    if (task.stage !== 'validate' || task.archived) return
    const atLimit = check.limit !== undefined && check.round > check.limit
    if (verdict === 'converging' && !atLimit) {
      const sentBack = store.recordSendBack({
        taskId: task.id,
        from: 'validate',
        to: check.to,
        findings: check.findings,
        counted: true,
        round: check.round,
        ...(check.limit !== undefined && { limit: check.limit }),
        ...(check.checkRunId !== undefined && { checkRunId: check.checkRunId }),
        cause: check.checkRunId !== undefined ? 'check' : 'review',
      })
      await move(
        task,
        resolution,
        check.to,
        [
          backMessage(workflow, check.to, 'validate', sentBack),
          `# Loop check\n\nTED checked Validate’s ${check.round} rounds of Findings and the changes between them. Verdict: converging. ${reason}`,
        ].join('\n\n'),
      )
      return
    }
    const looping = verdict === 'looping'
    const request = askAboutLoop(task, workflow, {
      to: check.to,
      findings: check.findings,
      title: atLimit
        ? `Validate has sent this Task back ${check.round - 1} ${check.round === 2 ? 'time' : 'times'}, its limit`
        : looping
          ? 'Validate and Work are going round in circles'
          : `Validate has sent this Task back ${check.round} times`,
      intro: looping
        ? `Work and Validate are repeating the same problem. ${reason}`
        : verdict === 'converging'
          ? `Making progress, but Validate has reached its send-back limit (${check.limit}) and needs your decision. ${reason}`
          : `TED couldn’t assess progress: ${reason}. The Task is waiting for your decision.`,
      verdict,
      ...(check.checkRunId !== undefined && { checkRunId: check.checkRunId }),
    })
    await deliver(
      task,
      `TED’s loop check ${looping ? 'found Validate’s rounds are looping' : verdict === 'converging' ? 'found progress, but the send-back limit still needs a human decision' : 'gave no verdict'}, so TED asked the human what to do (request ${request.id}). The Task stays in Validate; TED sends you their answer.`,
    )
  }

  function judge(
    task: StoredTask,
    outcome: 'passed' | 'sent-back',
    judged: ValidateJudgments | undefined,
  ): void {
    const since = visitStart(task)
    const checkRuns = store.listCheckRuns(task.id)
    const entries = store.listStageEntries(task.id)
    const before = entries[entries.findLastIndex((e) => e.stage === task.stage) - 1]
    const checkRun =
      checkRuns.filter((r) => r.trigger === 'validate' && r.startedAt >= since).at(-1) ??
      (before?.stage === 'work'
        ? checkRuns.findLast(
            (r) =>
              r.trigger === 'hand-off' &&
              r.outcome === 'passed' &&
              r.startedAt >= before.at &&
              r.startedAt <= since,
          )
        : undefined)
    const reviewers = store
      .reviewers(task.id)
      .filter((r) => r.purpose === 'review' && r.at >= since)
    const reviewer = reviewers.at(-1)
    const acceptedFinding = (category: 'review' | 'visual') =>
      store.failures.list(task.id).some((value) => {
        const decision = value.resolutions.at(-1)
        const source = value.source
        return (
          value.validation &&
          source.kind === 'finding' &&
          (source.category === category ||
            (category === 'review' && reviewers.some((r) => r.runId === source.runId))) &&
          !value.verifications?.length &&
          decision?.resolution === 'accepted' &&
          !value.invalidations.some((i) => i.requestId === decision.requestId)
        )
      })
    const acceptedReviewFailure = acceptedFinding('review')
    const acceptedVisualFailure = acceptedFinding('visual')
    const visual = judged?.visual ?? (acceptedVisualFailure ? { passed: false } : undefined)
    if (acceptedVisualFailure && visual?.passed)
      throw new RequestError(
        409,
        'Visual has an accepted failure; report --visual fail to keep its result factual',
      )
    const review =
      judged?.review ??
      (acceptedReviewFailure
        ? { passed: false }
        : reviewer !== undefined && outcome === 'passed'
          ? { passed: true }
          : undefined)
    if (acceptedReviewFailure && review?.passed)
      throw new RequestError(
        409,
        'Review has an accepted failure; report --review fail to keep its result factual',
      )
    store.judgeValidate({
      taskId: task.id,
      outcome,
      ...(checkRun !== undefined && { checkRunId: checkRun.id }),
      ...(review !== undefined && { review }),
      ...(visual !== undefined && { visual }),
      ...(reviewer !== undefined && {
        reviewer: {
          agent: reviewer.agent,
          ...(reviewer.unavailable !== undefined && { unavailable: reviewer.unavailable }),
        },
      }),
    })
  }

  function openSendBackAsk(task: Task): Comment | undefined {
    const asks = new Set(store.sendBackAsks(task.id).map((a) => a.commentId))
    return store
      .listComments(task.id)
      .find((c) => asks.has(c.id) && c.answer === undefined && c.stage === task.stage)
  }

  function live(ref: string): StoredTask {
    const task = find(ref)
    if (hierarchyBusy.has(task.id) || deleting.has(task.id))
      throw new RequestError(409, `${task.displayId} has a hierarchy operation underway; try again`)
    if (task.archived) throw new RequestError(409, `${task.displayId} is archived`)
    return task
  }

  function hierarchyRevision(factoryId: string): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          store
            .listTasks()
            .filter((task) => task.factoryId === factoryId)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((task) => [
              task.id,
              task.parentId,
              task.childIds,
              task.stage,
              task.archived,
              task.blockedBy,
              task.status,
              task.runs,
              task.updatedAt,
              task.merged,
            ]),
        ),
      )
      .digest('hex')
  }

  function hierarchy(ref: string, caller?: Caller): TaskHierarchy {
    const task = caller?.kind === 'run' ? ownTask(ref, caller).task : find(ref)
    return {
      parentId: task.parentId ?? null,
      childIds: store.childrenOf(task.id),
      revision: hierarchyRevision(task.factoryId),
    }
  }

  async function requestArchive(
    ref: string,
    caller: Caller,
    request: RequestArchiveRequest,
  ): Promise<Comment> {
    const { task, runId } = taskLead(ref, caller, 'asks to archive its Task')
    return holding(task, async () => {
      const now = find(task.id)
      if (now.archived) throw new RequestError(409, `${now.displayId} is already archived`)
      if (now.stage === 'done') throw new RequestError(409, `${now.displayId} is Done`)
      if (openRequests(now.id).some((c) => c.archive))
        throw new RequestError(409, `${now.displayId} already has an archive request waiting`)
      const open = publicTask(now.id).repos.flatMap((r) =>
        r.pullRequest && r.pullRequest.state !== 'closed' && r.pullRequest.state !== 'merged'
          ? [`${r.name} #${r.pullRequest.number}`]
          : [],
      )
      if (open.length > 0 && !request.pullRequests)
        throw new RequestError(
          400,
          `${now.displayId} has an open pull request (${open.join(', ')}); say whether to close it with --close-pull-requests "<why>" or --keep-pull-requests "<why>"`,
        )
      const archive: ArchiveAsk = {
        reason: redactSecrets(request.reason),
        ...(open.length > 0 &&
          request.pullRequests && {
            pullRequests: {
              recommend: request.pullRequests.recommend,
              why: redactSecrets(request.pullRequests.why),
            },
          }),
      }
      return store.postComment({
        taskId: now.id,
        kind: 'question',
        author: { kind: 'run', runId },
        title: `Archive ${now.displayId}?`,
        body: archive.reason,
        choices: [archiveChoice, keepArchiveChoice],
        archive,
      })
    })
  }

  function underToArchive(taskId: string): string[] {
    return descendants(taskId).filter((id) => !find(id).archived)
  }

  function descendants(taskId: string): string[] {
    const found: string[] = []
    const seen = new Set([taskId])
    const walk = (id: string) => {
      for (const child of store.childrenOf(id)) {
        if (seen.has(child)) throw new RequestError(409, 'Task hierarchy contains a cycle')
        seen.add(child)
        found.push(child)
        walk(child)
      }
    }
    walk(taskId)
    return found
  }

  function hierarchyMember(taskId: string, depth = 0): HierarchyMember {
    const task = find(taskId)
    return {
      displayId: task.displayId,
      title: task.title,
      stage: task.stage,
      merged: store.isMerged(task.id),
      archived: task.archived !== undefined,
      children:
        depth > 20 ? [] : store.childrenOf(task.id).map((id) => hierarchyMember(id, depth + 1)),
    }
  }

  function hierarchyView(taskId: string): HierarchyView {
    const task = find(taskId)
    const parentId = store.parentOf(task.id)
    return {
      displayId: task.displayId,
      parent: parentId === undefined ? undefined : hierarchyMember(parentId),
      children: store.childrenOf(task.id).map((id) => hierarchyMember(id)),
    }
  }

  function tellHierarchyChanged(ids: readonly (string | undefined)[]): void {
    for (const id of new Set(ids)) {
      if (id === undefined || !store.getTask(id) || !liveLead(find(id))) continue
      const text = hierarchyChangedText(hierarchyView(id))
      inBackground('tell the Task Lead its hierarchy changed', async () => {
        await deliver(find(id), text)
      })
    }
  }

  function hierarchyPreview(ref: string): TaskHierarchyPreview {
    const task = find(ref)
    return {
      revision: hierarchyRevision(task.factoryId),
      descendants: descendants(task.id).map((id) => {
        const child = find(id)
        return { id, displayId: child.displayId, title: child.title }
      }),
      archivedWith: task.archived ? archivedFamily(task.id) : [],
    }
  }

  function requireHierarchyRevision(task: StoredTask, revision?: string): void {
    if (!revision || revision !== hierarchyRevision(task.factoryId))
      throw new RequestError(
        409,
        'Hierarchy changed or was not confirmed; read the hierarchy preview and confirm again',
      )
  }

  function safeParent(task: StoredTask): void {
    const queued = store.queue().some((entry) => entry.id === task.id)
    if (
      task.archived ||
      task.stage === 'done' ||
      hasLiveRun(task) ||
      hierarchyBusy.has(task.id) ||
      deleting.has(task.id) ||
      advancing.has(task.id) ||
      beginning.has(task.id) ||
      holds.has(task.id) ||
      stoppingByHand.has(task.id) ||
      mergeWatcher.inFlight(task.id) ||
      store.mergePending(task.id) ||
      !(task.stage === 'backlog' || queued || task.stopped || task.waitsForBlockers)
    ) {
      throw new RequestError(
        409,
        `${task.displayId} cannot change its children now. ${task.stage === 'done' ? 'Done parents stay closed; use Unlink and restore for an archived child.' : task.archived ? 'Restore the parent first.' : 'Stop the parent and wait for its Runs, Checks and transitions to finish, then try again.'}`,
      )
    }
  }

  function requireHierarchyIdle(ids: readonly string[]): void {
    for (const id of ids) {
      if (hierarchyBusy.has(id) || deleting.has(id) || removingFactories.has(find(id).factoryId))
        throw new RequestError(
          409,
          `${find(id).displayId} has a hierarchy operation underway; try again`,
        )
    }
  }

  function holdParent(taskId: string): void {
    if (unmergedBlockers(taskId).length > 0 && store.queue().some((q) => q.id === taskId))
      store.waitForBlockers(taskId)
  }

  function releaseParent(taskId: string, wasBlocked: boolean): void {
    const task = find(taskId)
    if (!wasBlocked) return
    if (
      unmergedBlockers(taskId).length > 0 &&
      (task.preparation !== 'ready' || store.childrenOf(taskId).length > 0)
    )
      return
    if (
      unmergedBlockers(taskId).length === 0 &&
      store.madeParent(taskId) &&
      store.childrenOf(taskId).some((c) => store.isMerged(c))
    ) {
      wakeTask(taskId)
      return
    }
    if (task.stage === 'backlog') {
      if (task.startRequested) store.setStartRequested(taskId, false)
      store.stopTask(taskId, { runs: 0, why: 'blockers-removed' })
    } else if (
      (task.preparation === 'ready' ||
        task.waitsForBlockers ||
        store.queue().some((entry) => entry.id === taskId)) &&
      !liveLead(task) &&
      !task.archived
    )
      store.stopTask(taskId, { runs: 0, why: 'blockers-removed' })
  }

  function setParent(ref: string, input: SetTaskParentRequest): Task {
    const task = find(ref)
    requireHierarchyRevision(task, input.revision)
    const parent = input.parentId === null ? undefined : find(input.parentId)
    const old = task.parentId ? find(task.parentId) : undefined
    requireHierarchyIdle([task.id, ...[old, parent].flatMap((t) => (t ? [t.id] : []))])
    if (parent?.factoryId !== undefined && parent.factoryId !== task.factoryId)
      throw new RequestError(409, 'Parent and child must belong to the same Factory')
    if (parent?.id === task.id) throw new RequestError(409, 'A Task cannot parent itself')
    if (parent?.id === old?.id) return publicTask(task.id)
    if (old) safeParent(old)
    if (parent) {
      safeParent(parent)
      if (cycleFrom(task.id, parent.id))
        throw new RequestError(409, 'Parent link would create a hierarchy or blocker cycle')
    }
    const wasBlocked = old !== undefined && unmergedBlockers(old.id).length > 0
    store.setTaskParent(task.id, parent?.id ?? null)
    if (old) releaseParent(old.id, wasBlocked)
    if (parent) holdParent(parent.id)
    tellHierarchyChanged([task.id, old?.id, parent?.id])
    return publicTask(task.id)
  }

  function archivePlan(ref: string, revision?: string, detach = false) {
    const task = live(ref)
    const children = descendants(task.id)
    if (children.length > 0) requireHierarchyRevision(task, revision)
    const ids = [task.id, ...children]
    requireHierarchyIdle(ids)
    const parent = task.parentId ? find(task.parentId) : undefined
    if (parent && !store.isMerged(task.id)) safeParent(parent)
    return {
      task,
      ids: detach ? [task.id] : ids,
      direct: store.childrenOf(task.id).filter((id) => !find(id).archived),
      parent,
      wasBlocked: parent !== undefined && unmergedBlockers(parent.id).length > 0,
    }
  }

  function archiveHierarchy(
    ref: string,
    {
      closePullRequests = false,
      blocked = 'unblock',
      children: choice = 'archive',
      hierarchyRevision: revision,
    }: ArchiveTaskRequest = {},
  ): Task {
    const detach = choice === 'detach'
    const { task, ids, direct, parent, wasBlocked } = archivePlan(ref, revision, detach)
    const archived: string[] = []
    for (const id of [...ids].reverse()) {
      const current = find(id)
      if (current.archived) continue
      settleDependents(id, blocked)
      if (store.childrenOf(id).length > 0 && current.startRequested)
        store.setStartRequested(id, false)
      archiveNow(find(id), closePullRequests)
      archived.push(id)
    }
    if (detach) {
      for (const child of direct) store.setTaskParent(child, null)
      tellHierarchyChanged(direct)
    } else if (ids.length > 1) {
      store.recordTreeArchive(
        task.id,
        archived.filter((id) => id !== task.id),
      )
    }
    if (parent) releaseParent(parent.id, wasBlocked)
    wake()
    return publicTask(task.id)
  }

  function repairNotice(taskId: string, blockerId: string, explanation: string): void {
    const repair = store.failures
      .list(taskId)
      .flatMap((f) => f.resolutions)
      .find((r) => r.repairTask?.id === blockerId)?.repairTask
    if (!repair) return
    const body = `${repair.displayId} (“${repair.title}”) ${explanation} The original failure remains unresolved; this does not mean validation passed.`
    if (store.listComments(taskId).some((c) => c.author.kind === 'ted' && c.body === body)) return
    store.postComment({ taskId, author: { kind: 'ted' }, title: 'Repair Task changed', body })
    const brief = store.latestBrief(taskId)?.text
    if (brief)
      store.writeBrief({
        taskId,
        text: brief.replace('## Current state', `## Current state\n\n${body}\n`),
      })
  }

  function removeBlockers(
    taskId: string,
    caller: Caller,
    blockerId?: string,
    reason = 'was unblocked without merging. Use Resume when ready to reassess the failure.',
  ): void {
    const links = store.blockers(taskId).filter((link) => link.kind === undefined)
    const wasBlocked = links.some((l) => !l.merged)
    const runId = caller.kind === 'run' ? caller.runId : undefined
    for (const link of links) {
      if (blockerId === undefined || link.blockerId === blockerId) {
        if (!link.merged) repairNotice(taskId, link.blockerId, reason)
        store.removeBlocker(taskId, link.blockerId, runId)
      }
    }
    const current = find(taskId)
    if (caller.kind !== 'run' && wasBlocked && unmergedBlockers(taskId).length === 0) {
      if (current.stage === 'backlog' && current.startRequested) {
        store.setStartRequested(taskId, false)
      } else if (
        (current.waitsForBlockers ||
          (current.preparation === 'ready' && store.childrenOf(taskId).length > 0)) &&
        !liveLead(current) &&
        !current.archived
      ) {
        store.stopTask(taskId, { runs: 0, why: 'blockers-removed' })
      }
    }
  }

  function settleDependents(taskId: string, blocked: BlockedChoice, action = 'archived'): void {
    for (const dependent of store.blockedBy(taskId)) {
      const link = store.blockers(dependent).find((b) => b.blockerId === taskId)
      const reason = `was ${action} without merging. ${blocked === 'unblock' ? 'Its blocker was removed. Use Resume when ready to reassess the failure.' : 'Its blocker was kept; this Task is still waiting. Choose another repair or remove the blocker in Task details.'}`
      if (blocked === 'unblock') removeBlockers(dependent, { kind: 'app' }, taskId, reason)
      else if (!link?.merged) repairNotice(dependent, taskId, reason)
    }
  }

  function clearing(taskId: string): Promise<void> {
    const running = clearingAway.get(taskId)
    if (running) return running
    const work = clearAway(taskId).finally(() => clearingAway.delete(taskId))
    clearingAway.set(taskId, work)
    return work
  }

  function hasLiveRun(task: StoredTask): boolean {
    return (
      liveLead(task) !== undefined ||
      checking.has(task.id) ||
      starting.has(task.id) ||
      task.runs.some((r) => r.state !== 'finished')
    )
  }

  function archiveNow(task: StoredTask, closePullRequests: boolean, why?: string): Task {
    dropWaitingMove(task.id)
    browser.cancel(task.id)
    browserApps.delete(task.id)
    const closing = closePullRequests
      ? task.repos.flatMap((r) =>
          r.pullRequest && r.pullRequest.state !== 'closed' && r.pullRequest.state !== 'merged'
            ? [`${r.name} #${r.pullRequest.number}`]
            : [],
        )
      : []
    const archived = store.archiveTask(task.id, {
      closing,
      branches: task.repos.length,
      ...(why !== undefined && { why }),
    })
    options.planning?.()?.taskGone(task.id, 'archived')
    if (closing.length > 0) pullRequestWork(task.id, 'close')
    inBackground(`archive ${task.displayId}`, () => clearing(task.id))
    return archived
  }

  function archivedFamily(rootId: string): string[] {
    const together = new Set(store.archivedWith(rootId))
    const restored = new Set([rootId])
    const family: string[] = []
    for (const id of descendants(rootId)) {
      const parentId = store.parentOf(id)
      if (!together.has(id) || !find(id).archived || !parentId || !restored.has(parentId)) continue
      restored.add(id)
      family.push(id)
    }
    return family
  }

  async function restoreArchived(id: string): Promise<void> {
    await clearingAway.get(id)?.catch(() => undefined)
    await pullRequestQueue.get(id)
    const current = find(id)
    if (!current.archived || deleting.has(id)) {
      throw new RequestError(409, `${current.displayId} isn’t archived`)
    }
    const midFlow = current.stage !== 'backlog' && current.stage !== 'done'
    store.unarchiveTask(id, {
      queue: midFlow,
      waitForBlockers: midFlow && unmergedBlockers(id).length > 0,
    })
    if (midFlow && current.repos.some((r) => r.pullRequest?.state === 'closed')) {
      pullRequestWork(id, 'reopen')
    }
  }

  async function unarchive(ref: string, input: UnarchiveTaskRequest = {}): Promise<Task> {
    const task = find(ref)
    if (!task.archived || deleting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} isn’t archived`)
    }
    const parent = task.parentId ? find(task.parentId) : undefined
    const family = input.children === 'restore' ? archivedFamily(task.id) : []
    const affected = [task.id, ...(parent ? [parent.id] : []), ...family]
    requireHierarchyIdle(affected)
    if (parent && input.unlinkParent) {
      requireHierarchyRevision(task, input.hierarchyRevision)
      if (parent.stage !== 'done' && !parent.archived) safeParent(parent)
    }
    if (parent && !input.unlinkParent && !store.isMerged(task.id)) safeParent(parent)
    for (const id of affected) hierarchyBusy.add(id)
    try {
      if (parent && input.unlinkParent) {
        await clearingAway.get(task.id)?.catch(() => undefined)
        if (!find(task.id).archived) throw new RequestError(409, `${task.displayId} isn’t archived`)
        store.setTaskParent(task.id, null)
      }
      await restoreArchived(task.id)
      for (const id of family) await restoreArchived(id)
      for (const id of [...family].reverse()) holdParent(id)
      if (family.length > 0) holdParent(task.id)
      if (parent && !input.unlinkParent) holdParent(parent.id)
    } finally {
      for (const id of affected) hierarchyBusy.delete(id)
    }
    if (parent) tellHierarchyChanged([task.id])
    await pump()
    wake()
    return publicTask(task.id)
  }

  async function remove(ref: string, input: DeleteTaskRequest): Promise<void> {
    const task = find(ref)
    if (removingFactories.has(task.factoryId)) return removeOne(ref, input)
    const children = descendants(task.id)
    if (children.length > 0) {
      requireHierarchyRevision(task, input.hierarchyRevision)
      if (!input.children)
        throw new RequestError(
          409,
          'Choose whether to delete descendants or unparent direct children, or cancel',
        )
    }
    const parent = task.parentId ? find(task.parentId) : undefined
    if (parent) safeParent(parent)
    const ids = input.children === 'delete' ? [task.id, ...children] : [task.id]
    const affected = [...new Set([...ids, ...children, ...(parent ? [parent.id] : [])])]
    requireHierarchyIdle(affected)
    const wasBlocked = parent !== undefined && unmergedBlockers(parent.id).length > 0
    for (const id of affected) hierarchyBusy.add(id)
    try {
      if (parent) store.setTaskParent(task.id, null)
      if (input.children !== 'delete') {
        const direct = store.childrenOf(task.id)
        for (const id of direct) store.setTaskParent(id, null)
        tellHierarchyChanged(direct)
      }
      if (parent) releaseParent(parent.id, wasBlocked)
      for (const id of [...ids].reverse()) await removeOne(id, input)
    } finally {
      if (parent) releaseParent(parent.id, wasBlocked)
      for (const id of affected) hierarchyBusy.delete(id)
    }
    wake()
  }

  async function removeOne(ref: string, { blocked = 'unblock' }: DeleteTaskRequest): Promise<void> {
    const task = find(ref)
    if (deleting.has(task.id))
      throw new RequestError(409, `${task.displayId} is already being deleted`)
    deleting.add(task.id)
    try {
      options.planning?.()?.taskGone(task.id, 'deleted')
      settleDependents(task.id, blocked, 'deleted')
      const unsentFiles = store.messageDraftFiles(task.id)
      if (!find(task.id).archived) archiveNow(find(task.id), false)
      await clearing(task.id)
      await pullRequestQueue.get(task.id)
      const last = find(task.id)
      await lifecycle.cleanFolders(await execution.local(task.id))
      const runIds = store.taskRunList(task.id).map((r) => r.id)
      const files = [...store.taskFiles(task.id), ...unsentFiles]
      failures.forget(task.id)
      store.deleteTask(task.id)
      await store.persisted()
      await removeFiles(last, runIds, files)
    } finally {
      deleting.delete(task.id)
    }
    wake()
  }

  const resetRefusals: Record<ResetRefusal, string> = {
    archived: 'is archived',
    done: 'is Done',
    merged: 'has a merged pull request',
    'not-started': 'hasn’t started',
  }

  async function reset(ref: string): Promise<Task> {
    const { id, displayId } = find(ref)
    const checksRunning = () => {
      if (checking.has(id)) {
        throw new RequestError(409, `${displayId}’s Checks are running; try again when they finish`)
      }
    }
    checksRunning()
    await untilFree(id)
    const task = find(id)
    const refused = resetRefusal(publicTask(id))
    if (refused) {
      throw new RequestError(
        409,
        `${task.displayId} ${resetRefusals[refused]}, so it can’t be reset`,
      )
    }
    checksRunning()
    if (deleting.has(id)) {
      throw new RequestError(409, `${task.displayId} is being deleted or reset`)
    }
    await holding(task, async () => {
      deleting.add(id)
      try {
        if (!task.stopped) store.stopTask(id, { runs: task.runs.length, why: 'human' })
        dropWaitingMove(id)
        await mergeWatcher.settled(id)
        await pullRequestQueue.get(id)
        const open = (current: StoredTask) =>
          current.repos.filter(
            (r) =>
              r.pullRequest && r.pullRequest.state !== 'closed' && r.pullRequest.state !== 'merged',
          )
        if (resetRefusal(publicTask(id)) === 'merged') {
          throw new RequestError(409, `${task.displayId} has a merged pull request`)
        }
        if (open(find(id)).length > 0) {
          pullRequestWork(id, 'close')
          await pullRequestQueue.get(id)
        }
        const left = open(find(id))
        if (left.length > 0 || resetRefusal(publicTask(id)) === 'merged') {
          throw new RequestError(
            409,
            `TED couldn’t close ${left.map((r) => `${r.repo}#${r.pullRequest?.number}`).join(', ') || 'a merged pull request'}, so ${task.displayId} wasn’t reset. It is stopped and nothing was discarded.`,
          )
        }
        options.planning?.()?.taskGone(id, 'reset')
        browser.cancel(id)
        browserApps.delete(id)
        await clearing(id)
        const last = find(id)
        await removeBranches(last)
        await lifecycle.cleanFolders(await execution.local(id))
        const runIds = store.taskRunList(id).map((r) => r.id)
        const files = [...store.taskFiles(id), ...store.messageDraftFiles(id)]
        failures.forget(id)
        autoStartFailures.delete(id)
        continuationFailures.delete(id)
        for (const key of runUploads) if (key.startsWith(`${id}:`)) runUploads.delete(key)
        for (const repo of last.repos) baseTips.delete(baseTipKey(id, repo.name))
        store.resetTask(id)
        await store.persisted()
        await removeFiles(last, runIds, files)
      } finally {
        deleting.delete(id)
      }
    })
    if (task.setup) reportSetup(task.factoryId)
    if (await queueStart(id, undefined, false, true)) {
      await pump()
      await beginning.get(id)
    }
    return publicTask(id)
  }

  async function removeBranches(task: StoredTask): Promise<void> {
    const gh = options.gh
    const refuse = (where: string, branch: string, error: unknown) =>
      new RequestError(
        409,
        `TED couldn’t delete the branch ${branch} ${where}, so ${task.displayId} wasn’t reset: ${redactSecrets(error instanceof Error ? error.message : String(error))}. It is stopped and its thread is kept.`,
      )
    for (const repo of task.repos) {
      if (gh && (repo.pushed || repo.pullRequest)) {
        await deleteBranch(gh, repo).catch((error: unknown) => {
          const status = error instanceof GhError ? error.status : undefined
          const gone =
            status === 404 ||
            (status === 422 &&
              error instanceof Error &&
              /reference does not exist/i.test(error.message))
          if (!gone) throw refuse(`on ${repo.repo}`, repo.branch, error)
        })
      }
      await git.deleteBranch(clonePath(reposDir, repo), repo.branch).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error)
        if (!/not found/i.test(text)) throw refuse(`in ${repo.name}’s clone`, repo.branch, error)
      })
    }
  }

  async function removeFactoryTasks(
    factoryId: string,
    { closePullRequests }: { closePullRequests: boolean },
  ): Promise<void> {
    removingFactories.add(factoryId)
    try {
      for (;;) {
        const inFactory = store.listTasks().filter((t) => t.factoryId === factoryId)
        if (inFactory.length === 0) return
        const left = inFactory.filter((t) => !deleting.has(t.id))
        if (left.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          continue
        }
        for (const { id } of left) {
          if (deleting.has(id) || !store.getTask(id)) continue
          if (closePullRequests) {
            const task = find(id)
            if (task.archived) pullRequestWork(id, 'close')
            else {
              settleDependents(id, 'unblock')
              archiveNow(find(id), true)
            }
          }
          await remove(id, { blocked: 'unblock' })
        }
      }
    } catch (error) {
      removingFactories.delete(factoryId)
      throw error
    }
  }

  async function removeFiles(
    task: StoredTask,
    runIds: readonly string[],
    files: readonly Attachment[],
  ): Promise<void> {
    const gone = (root: string, name: string) =>
      removeInside(root, name).catch((error: unknown) =>
        console.error(`couldn’t remove ${name} for deleted ${task.displayId}:`, error),
      )
    const runsDir = options.runsDir
    if (runsDir) await Promise.all(runIds.map((id) => gone(runsDir, id)))
    await gone(path.join(logsDir, 'checks'), task.displayId)
    await Promise.all(
      task.repos.flatMap((r) =>
        (['setup', 'teardown'] as const).map((kind) =>
          gone(path.join(logsDir, 'worktrees'), path.basename(commandLog(task, kind, r.name))),
        ),
      ),
    )
    const stillUsed = store.filesInUse()
    await Promise.all(
      files
        .filter((a) => !stillUsed.has(a.hash))
        .map((a) => {
          const file = attachmentFile(a)
          return gone(path.dirname(file), path.basename(file))
        }),
    )
  }

  async function clearAway(taskId: string): Promise<void> {
    if (store.heldRuns().some((h) => h.taskId === taskId)) store.releaseTaskRun(taskId)
    checkWaits.get(taskId)?.abort()
    settingUp.get(taskId)?.abort()
    for (const [key, cancel] of repoSetups) if (key.startsWith(`${taskId}:`)) cancel.abort()
    await beginning.get(taskId)?.catch(() => undefined)
    settingUp.get(taskId)?.abort()
    subAgents.dropFor(taskId)
    const task = find(taskId)
    await Promise.all(task.runs.map((run) => runs.stop(run.id)))
    if (!task.repos.some((r) => !r.removed) && !task.worktree) return
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    await finish(find(taskId), resolution)
  }

  const creatingSetup = new Set<string>()

  function openSetupTask(factoryId: string): Task | undefined {
    const open = store
      .taskOutlines()
      .find((t) => t.factoryId === factoryId && t.setup && !t.archived && t.stage !== 'done')
    return open && store.tasksIn(new Set([open.id])).at(0)
  }

  async function makeSetupTask(factory: StoredFactory, byHand: boolean): Promise<Task> {
    if (removingFactories.has(factory.id)) {
      throw new RequestError(409, `${factory.name} is being removed`)
    }
    if (creatingSetup.has(factory.id)) {
      throw new RequestError(409, `TED is already creating ${factory.name}’s setup Task`)
    }
    creatingSetup.add(factory.id)
    try {
      return await createSetupTask(factory, byHand)
    } finally {
      creatingSetup.delete(factory.id)
    }
  }

  async function createSetupTask(factory: StoredFactory, byHand: boolean): Promise<Task> {
    const resolution = await resolveWorkflow(factory, { fetch: cloned(factory.id) }).catch(
      (error: unknown) => {
        console.error(`couldn’t read ${factory.repo}’s Workflow:`, error)
        return undefined
      },
    )
    const hasSettings = resolution
      ? resolution.layers.some((l) => l.layer === 'factory' && l.status !== 'absent')
      : factoryHasSettings(factory.id)
    const task = await store.createTask({
      title: `Set up ${factory.name}`,
      description: hasSettings ? laterSetupDescription : firstSetupDescription,
      priority: 'urgent',
      clarifyDepth: 'grilling',
      lead: { ...leadFrom(resolution?.workflow.settings), effortMode: 'stage' },
      factoryId: factory.id,
      setup: true,
    })
    reportSetup(factory.id)
    if (hasSettings && !byHand) return task
    return start(task.id)
  }

  function factoryHasSettings(factoryId: string): boolean {
    return store.lastValidWorkflowLayer(`factory:${factoryId}`) !== undefined
  }

  function reportSetup(factoryId: string): void {
    const factory = store.getFactory(factoryId)
    if (!factory) return
    const ref = { problem: setupProblem, factoryId }
    const setupTasks = store.taskOutlines().filter((t) => t.factoryId === factoryId && t.setup)
    const done =
      factoryHasSettings(factoryId) ||
      setupTasks.length === 0 ||
      setupTasks.some((t) => store.isMerged(t.id))
    if (done || factory.clonedAt === undefined) {
      if (store.getBanner(bannerId(ref))) banners.clear(ref)
      return
    }
    const open = openSetupTask(factoryId)
    banners.raise({
      ...ref,
      severity: 'warning',
      ...(open
        ? {
            text: `Setup isn’t finished · Tasks use TED’s defaults until ${open.displayId} merges`,
            action: { label: `Open ${open.displayId}`, opens: { kind: 'task', taskId: open.id } },
          }
        : {
            text: 'Setup isn’t finished · This Factory hasn’t been set up',
            action: { label: 'New setup Task' },
          }),
    })
  }

  async function start(
    ref: string,
    request: import('@ted/protocol').StartTaskRequest = {},
  ): Promise<Task> {
    const task = live(ref)
    autoStartFailures.delete(task.id)
    if (!(await queueStart(task.id, undefined, request.prepare))) return publicTask(task.id)
    await pump()
    await beginning.get(task.id)
    return publicTask(task.id)
  }

  async function queueAndAnswer(ref: string): Promise<Task> {
    const task = live(ref)
    autoStartFailures.delete(task.id)
    if (await queueStart(task.id)) void pump()
    return publicTask(task.id)
  }

  async function queueStart(
    ref: string,
    version?: number,
    prepare = false,
    keepRank = false,
  ): Promise<boolean> {
    const automatic = version !== undefined
    const task = live(ref)
    const factory = factoryOf(task)
    if (task.stage !== 'backlog' || starting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} has already started`)
    }
    if (unmergedBlockers(task.id).length > 0) {
      if (prepare) throw new RequestError(409, `${task.displayId} has unfinished blockers`)
      if (!automatic) store.setStartRequested(task.id, true)
      return false
    }
    starting.add(task.id)
    try {
      await clearingAway.get(task.id)?.catch(() => undefined)
      if (cloned(factory.id)) await ensureClone({ banners, reposDir }, factory)
      const resolution = await taskWorkflow(find(task.id), { fetch: false })
      const current = live(task.id)
      if (prepare) {
        if (current.setup) throw new RequestError(409, 'Factory setup Tasks cannot be prepared')
        checkPreparationWorkflow(resolution.workflow)
      }
      if (automatic) {
        const lead = current.lead ?? leadFrom(resolution.workflow.settings)
        if (
          closed ||
          store.newWorkHold() !== undefined ||
          version !== backlogVersion ||
          !backlogEligible(current, true) ||
          store.agentPauses()[lead.agent] !== undefined
        )
          return false
        const { use } = await slotUse([current.factoryId])
        if (
          closed ||
          store.newWorkHold() !== undefined ||
          version !== backlogVersion ||
          store.agentPauses()[(live(task.id).lead ?? lead).agent] !== undefined ||
          !backlogEligible(live(task.id), true) ||
          !startsNow(
            [
              ...revivesReady(),
              ...heldReady(),
              ...ready(),
              {
                id: current.id,
                kind: 'task',
                rank: current.rank,
                priority: current.priority,
                factoryId: current.factoryId,
              },
            ],
            use,
          ).some((entry) => entry.id === current.id)
        )
          return false
      }
      if (!current.lead)
        store.setTaskLead(task.id, {
          ...leadFrom(resolution.workflow.settings),
          effortMode: 'stage',
        })
      const planned = find(task.id).markers.some((m) => m.kind === 'needs-planning')
      const stage = resolution.workflow.next('backlog')
      if (planned) {
        const again = resolution.workflow.stages.includes('clarify') ? 'clarify' : stage
        store.startAfterPlanning(task.id, again, entryFor(resolution, again as AgentStageId), {
          prepare,
        })
      } else {
        store.queueTask(task.id, stage, { prepare, keepRank })
      }
    } finally {
      starting.delete(task.id)
    }
    return true
  }

  async function launchQueued(taskId: string): Promise<void> {
    await execution.local(taskId)
    const task = find(taskId)
    const factory = factoryOf(task)
    if (task.stage === 'cleanup') {
      const { workflow } = await taskWorkflow(task, { fetch: false })
      if (pendingCleanupCommands(task.id, workflow).length > 0) {
        store.dequeue(task.id)
        if (!checking.has(task.id)) await cleanupThen(task.id, workflow, cleanupRestartNote)
        return
      }
    }
    if (task.repos.some((r) => !r.removed)) {
      if (task.stage === 'work' && store.heldBeforeWork(task.id)) {
        const note = await adoptLatestBase(task)
        if (note !== undefined) baseNotes.set(task.id, note)
      }
      await leadLifecycle.prepare(task.id, { kind: 'existing' })
      store.dequeue(task.id)
      if (store.freshRunRequest(task.id)?.kind === 'github') {
        watch?.kick()
      }
      return
    }
    if (task.repos.length > 0) return reopenWorktree(task)
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    if (!task.lead)
      store.setTaskLead(task.id, { ...leadFrom(resolution.workflow.settings), effortMode: 'stage' })
    const stage = resolution.workflow.next('backlog') as AgentStageId
    const chosen = chosenEntries(
      find(task.id).chosenRepos,
      factoryRepos(resolution.workflow, factory),
    )
    const clones = await Promise.all(chosen.map((entry) => cloneFor(task, factory, entry)))
    for (const entry of chosen) await clearLeftover(task, factory, entry)
    const branch = await branchFor(clones, task)
    const opened: (NewWorktree & { branch: string; worktree: string })[] = []
    const unrecorded = new Set<(typeof opened)[number]>()
    try {
      for (const entry of chosen) {
        const made = await openWorktree(task, factory, entry, branch, true)
        opened.push(made)
        unrecorded.add(made)
      }
      const [first, ...rest] = opened
      if (!first) throw new Error(`${task.displayId}’s Factory has no repo`)
      const { branch: _, worktree, ...repo } = first
      store.startTask({
        taskId: task.id,
        stage,
        branch,
        worktree,
        entry: entryFor(resolution, stage),
        repo,
      })
      unrecorded.delete(first)
      for (const made of rest) {
        store.worktreeCreated(task.id, made)
        unrecorded.delete(made)
      }
    } catch (error) {
      for (const made of unrecorded) {
        const ref = await execution.local(task.id)
        await lifecycle
          .rollback({ ...made, handle: lifecycle.worktree(ref, made) })
          .catch(() => undefined)
      }
      throw error
    }
    const started = find(task.id)
    if (chosen.some((entry) => entry.setup !== undefined)) {
      inBackground(`set up ${task.displayId}’s worktree`, () =>
        leadLifecycle.prepare(started.id, { kind: 'created', resolution, entries: chosen }),
      )
    } else {
      await leadLifecycle.prepare(started.id, { kind: 'created', resolution, entries: chosen })
    }
  }

  async function reopenWorktree(task: StoredTask): Promise<void> {
    const factory = factoryOf(task)
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    const chosen = chosenEntries(task.chosenRepos, factoryRepos(resolution.workflow, factory))
    const fallback = task.branch ?? task.repos[0]?.branch
    if (fallback === undefined) return
    for (const entry of chosen) {
      const old = task.repos.findLast((r) => sameRepo(r.repo, entry.repo))
      const branch = old?.branch ?? fallback
      await clearLeftover(task, factory, entry, branch)
      store.worktreeCreated(task.id, await openWorktree(task, factory, entry, branch, false))
    }
    store.dequeue(task.id)
    const started = find(task.id)
    if (chosen.some((entry) => entry.setup !== undefined)) {
      inBackground(`set up ${task.displayId}’s worktree`, () =>
        leadLifecycle.prepare(started.id, { kind: 'restored', resolution, entries: chosen }),
      )
    } else {
      await leadLifecycle.prepare(started.id, { kind: 'restored', resolution, entries: chosen })
    }
  }

  function pendingPickUp(task: StoredTask): string | undefined {
    return store.freshRunRequest(task.id)?.pending ? freshRunNote(task) : undefined
  }

  function movedByApproval(task: StoredTask, answers: readonly Comment[]): boolean {
    if (task.stage === 'backlog' || task.stage === 'done') return false
    return answers.some((c) => c.gate && c.answer?.kind === 'approved' && c.stage !== task.stage)
  }

  function freshRunNote(task: StoredTask): string {
    const last = store.freshRunRequest(task.id)
    if (last?.kind === 'retried' || last?.kind === 'failure') {
      return fromTheBrief(task, freshAfterFailure(last))
    }
    if (last?.kind === 'unarchived') {
      return fromTheBrief(task, {
        heading: 'Picking up after unarchiving',
        why: 'The human archived this Task and has now unarchived it. TED made its worktree again from the branch, so anything that wasn’t committed is gone.',
      })
    }
    if (last?.kind === 'github') {
      const notices = last.notices
      return fromTheBrief(task, {
        heading: 'Picking up after activity on GitHub',
        why: freshRunReason(gitHubSummary(notices)),
      })
    }
    if (last?.kind === 'planning') {
      return fromTheBrief(task, {
        heading: 'Picking up after planning outside TED',
        why: afterPlanningWhy,
      })
    }
    if (last?.kind === 'overnight') {
      return fromTheBrief(task, {
        heading: 'Picking up after preparation',
        why: 'Preparation finished. Autopilot resumed this Task before Work. Continue from the brief and the approved design.',
      })
    }
    if (last?.kind === 'resumed') {
      return fromTheBrief(task, {
        heading: 'Picking up after a stop',
        why: 'The human resumed this Task after its Task Lead stopped.',
      })
    }
    const merged = store
      .blockers(task.id)
      .filter((b) => b.merged)
      .map((b) => b.displayId)
    return fromTheBrief(task, {
      heading: 'Picking up after a blocker',
      why: `This Task waited for ${joinIds(merged)}, which ${merged.length === 1 ? 'has' : 'have'} merged.`,
    })
  }

  function fromTheBrief(task: StoredTask, { heading, why }: { heading: string; why: string }) {
    const brief = store.latestBrief(task.id)
    const authors = { ted: 'TED', human: 'The human', run: 'Task Lead' } as const
    const notes = store
      .listComments(task.id)
      .filter((c) => !brief || c.createdAt > brief.createdAt)
      .filter((c) => (c.author.kind !== 'human' && !failureNotice(c)) || c.delivered !== undefined)
      .map(
        (c) => `- ${authors[c.author.kind]}, ${c.createdAt}: ${c.body.replace(/\s*\n\s*/g, ' ')}`,
      )
    return [
      `# ${heading}`,
      `${why} An earlier Run worked on it in this worktree and has stopped. Read the Task brief, the Comments since and the branch’s commits to see where it stopped, then carry on with this Stage.`,
      ...(brief ? [`## Task brief (version ${brief.version})\n\n${brief.text.trim()}`] : []),
      ...(notes.length > 0
        ? [`## ${brief ? 'Comments since the brief' : 'Comments'}\n\n${notes.join('\n')}`]
        : []),
    ].join('\n\n')
  }

  function automationCaller(caller: Caller) {
    if (caller.kind !== 'run') return undefined
    const firing = store.automations.firing(caller.runId)
    const automation = firing && store.automations.get(firing.automationId)
    const factory = automation && store.getFactory(automation.factoryId)
    if (!firing || !automation || !factory) {
      throw new RequestError(
        403,
        'Only an Automation Run creates Tasks with `ted task create`. Ask the human to create it.',
      )
    }
    if (firing.state !== 'started') throw new RequestError(409, 'this Automation Run has finished')
    return {
      name: automation.name,
      factoryKey: factory.key,
      factoryId: factory.id,
      link: { automationId: automation.id, firingId: firing.id },
      ...(automation.check && { check: { startTasks: automation.check.startTasks } }),
    }
  }

  function checkAgentCaller(caller: Caller, action: string) {
    const automation = caller.kind === 'run' ? automationCaller(caller) : undefined
    if (!automation?.check) {
      throw new RequestError(403, `Only a Scheduled Check’s agent Run can ${action}.`)
    }
    const run = store.getRun(automation.link.firingId)
    if (!run || run.state === 'finished') {
      throw new RequestError(409, 'this Automation Run has finished')
    }
    return { ...automation, check: automation.check }
  }

  function automationTask(ref: string, factoryId: string): StoredTask {
    const task = store.getTask(ref)
    if (!task || task.factoryId !== factoryId) {
      throw new RequestError(404, `no Task ${ref} in this Automation’s Factory`)
    }
    return task
  }

  function automationNote(ref: string, caller: Caller, body: string): TaskReference {
    const automation = checkAgentCaller(caller, 'add notes to Tasks')
    const task = automationTask(ref, automation.factoryId)
    if (store.automations.createdTask(task.id)?.automationId !== automation.link.automationId) {
      throw new RequestError(
        403,
        `${task.displayId} wasn’t created by this Automation; create a new Task instead`,
      )
    }
    if (task.archived || task.stage === 'done') {
      throw new RequestError(409, `${task.displayId} isn’t open; create a new Task instead`)
    }
    store.postAutomationNote(
      {
        taskId: task.id,
        kind: 'note',
        author: { kind: 'ted' },
        body: redactSecrets(`From the Automation “${automation.name}”:\n\n${body.trim()}`),
      },
      automation.link,
    )
    return { taskId: task.id, displayId: task.displayId }
  }

  async function automationStart(ref: string, caller: Caller): Promise<TaskReference> {
    const automation = checkAgentCaller(caller, 'start Tasks')
    if (!automation.check.startTasks) {
      throw new RequestError(
        403,
        'This Scheduled Check may not start Tasks. The human allows it with “Start the Tasks it creates” in the Automation’s settings; until then the Tasks wait in Backlog.',
      )
    }
    const task = automationTask(ref, automation.factoryId)
    const link = store.automations.createdTask(task.id)
    if (
      link?.automationId !== automation.link.automationId ||
      link.firingId !== automation.link.firingId
    ) {
      throw new RequestError(403, `${task.displayId} wasn’t created by this Run; only those start`)
    }
    if (task.setup) throw new RequestError(403, 'an Automation never starts a setup Task')
    if (task.archived) throw new RequestError(409, `${task.displayId} is archived`)
    if (task.stage !== 'backlog' || task.startRequested) {
      throw new RequestError(409, `${task.displayId} has already started`)
    }
    const resolution = await resolveWorkflow(factoryOf(task), { fetch: false }).catch(
      () => undefined,
    )
    if (!resolution || runsInBypass(resolution)) {
      throw new RequestError(
        409,
        `${task.displayId} stays in Backlog because this Factory runs in Bypass; the human starts it`,
      )
    }
    if (removingFactories.has(task.factoryId)) {
      throw new RequestError(409, 'this Factory is being removed')
    }
    if (!checkAgentCaller(caller, 'start Tasks').check.startTasks) {
      throw new RequestError(403, 'The human turned off “Start the Tasks it creates”.')
    }
    await queueAndAnswer(task.id)
    store.automations.taskStarted({
      taskId: task.id,
      automationId: automation.link.automationId,
      firingId: automation.link.firingId,
      name: automation.name,
    })
    return { taskId: task.id, displayId: task.displayId }
  }

  const isAsanaSource = (
    sourceUrl: string | undefined,
    parentRef: string | undefined,
  ): sourceUrl is string =>
    sourceUrl !== undefined && parseAsanaTaskUrl(sourceUrl) !== undefined && parentRef === undefined

  const runsInBypass = (resolution: WorkflowResolution | undefined) =>
    resolution?.workflow.settings.permissions === 'bypass'

  async function checkFailed(
    input: CheckFailureInput,
  ): Promise<{ created: string[]; updated: string[] }> {
    const factory = store.getFactory(input.factoryId)
    if (!factory || removingFactories.has(factory.id)) return { created: [], updated: [] }
    const open = new Map<string, string>()
    for (const { taskId, key } of store.automations.checkTasks(input.automationId)) {
      const task = store.getTask(taskId)
      if (task && !task.archived && task.stage !== 'done') open.set(key, taskId)
    }
    const resolution = await resolveWorkflow(factory, { fetch: false }).catch(() => undefined)
    const created: string[] = []
    const updated: string[] = []
    for (const failure of input.failures) {
      const existing = open.get(failure.key)
      if (existing !== undefined) {
        store.postComment({
          taskId: existing,
          kind: 'note',
          author: { kind: 'ted' },
          body: failure.note,
        })
        updated.push(existing)
        continue
      }
      const task = await store.createTask({
        title: failure.title,
        description: failure.description,
        factoryId: factory.id,
        lead: { ...leadFrom(resolution?.workflow.settings), effortMode: 'stage' },
        automation: { automationId: input.automationId, firingId: input.firingId },
        checkFailure: failure.key,
      })
      open.set(failure.key, task.id)
      created.push(task.id)
    }
    return { created, updated }
  }

  function holdInBacklog(taskId: string, automationName: string): Task {
    store.postComment({
      taskId,
      kind: 'note',
      author: { kind: 'ted' },
      body: `Created by ${automationName} · left in Backlog because this Factory runs in Bypass`,
    })
    return publicTask(taskId)
  }

  async function createFollowUp(
    ref: string,
    input: {
      title?: string
      description?: string
      sourceUrl?: string
      factoryId?: string
      automation?: { name: string; link: { automationId: string; firingId: string } }
      linearConsent: boolean
    },
  ): Promise<Task> {
    const original = find(ref)
    if (input.factoryId !== undefined && original.factoryId !== input.factoryId) {
      throw new RequestError(409, `${original.displayId} is in another Factory`)
    }
    if (original.archived) {
      throw new RequestError(409, `${original.displayId} is archived; it can’t be followed up`)
    }
    if (original.stage !== 'done') {
      throw new RequestError(
        409,
        `${original.displayId} isn’t Done; only a Done Task can be followed up`,
      )
    }
    const url = original.source?.url ?? input.sourceUrl
    if (
      input.sourceUrl !== undefined &&
      original.source !== undefined &&
      sourceKey(input.sourceUrl) !== sourceKey(original.source.url)
    ) {
      throw new RequestError(
        400,
        `a Follow-up shares ${original.displayId}’s source, ${original.source.url}`,
      )
    }
    const refuseOpen = () => {
      if (url === undefined) return
      const clash = sourceClash(sameSource(url), original.factoryId, url)
      if (clash?.kind === 'open') throw new RequestError(409, clashMessage(clash))
    }
    refuseOpen()
    const resolution =
      original.lead && !input.automation
        ? undefined
        : await taskWorkflow(original, {
            fetch: input.automation !== undefined && cloned(original.factoryId),
          })
    const lead = original.lead ?? leadFrom(resolution?.workflow.settings)
    const text = input.description?.trim() ?? ''
    refuseOpen()
    const intakeUnchanged = input.automation
      ? await verifyLinearIntake(store, options.linear, original.factoryId, url)
      : () => undefined
    refuseOpen()
    intakeUnchanged()
    const task = await store.createTask({
      ...followUpText(input.title, text, original.displayId),
      priority: original.priority,
      lead,
      factoryId: original.factoryId,
      ...(original.source
        ? { source: original.source }
        : url !== undefined && { source: taskSource(url, undefined) }),
      followUpOf: original.id,
      ...(input.automation && { automation: input.automation.link }),
      linearConsent: input.linearConsent,
    })
    const issue = input.automation && url !== undefined ? await linearIssue(url) : undefined
    if (input.automation && issue)
      linearConsent.askGroup(task.id, input.automation.name, issue.team)
    if (input.automation && runsInBypass(resolution)) {
      return holdInBacklog(task.id, input.automation.name)
    }
    return start(task.id)
  }

  function followUpNote(task: StoredTask): string | undefined {
    if (!task.followUpOf || store.latestBrief(task.id)) return undefined
    const original = store.getTask(task.followUpOf.id)
    const id = task.followUpOf.displayId
    if (!original) return undefined
    const brief = store.latestBrief(original.id)
    const pullRequests = original.repos.flatMap((r) =>
      r.pullRequest ? [`- ${r.name} #${r.pullRequest.number}: ${r.pullRequest.url}`] : [],
    )
    const merged = original.merged ? ` It merged at ${original.merged.at}.` : ''
    return [
      `# Follow-up to ${id}`,
      `This Task follows up ${id} · ${original.title.replace(/\s*\n\s*/g, ' ')}.${merged} ${id} is Done and is never reopened, so make the further change the human asked for in this Task. Start from ${id}’s Task brief and pull requests below. Where they already settle what Clarify or Design would decide, skip that Stage with \`ted outcome advance --skip\`.`,
      ...(brief
        ? [`## ${id}’s Task brief (version ${brief.version})\n\n${brief.text.trim()}`]
        : []),
      ...(pullRequests.length > 0
        ? [`## ${id}’s pull requests\n\n${pullRequests.join('\n')}`]
        : []),
    ].join('\n\n')
  }

  function cycleFrom(blockerId: string, taskId: string): string[] | undefined {
    const seen = new Set<string>()
    const walk = (id: string): string[] | undefined => {
      if (id === taskId) return [id]
      if (seen.has(id)) return undefined
      seen.add(id)
      for (const link of store.blockers(id)) {
        const rest = walk(link.blockerId)
        if (rest) return [id, ...rest]
      }
      return undefined
    }
    return walk(blockerId)
  }

  function unfinishedChildren(taskId: string): boolean {
    return store
      .blockers(taskId)
      .some((link) => link.kind === 'child' && !link.merged && !link.satisfied)
  }

  function unmergedBlockers(taskId: string) {
    return store.blockers(taskId).filter((b) => !b.merged && !b.satisfied)
  }

  function shouldStopForBlockers(task: StoredTask, run: Run): boolean {
    return (
      run.state === 'idle' &&
      task.stage !== 'backlog' &&
      task.stage !== 'done' &&
      unmergedBlockers(task.id).some((b) => b.setByRunId === run.id)
    )
  }

  async function stopLeadForChildren(taskId: string): Promise<void> {
    const run = liveLead(find(taskId))
    if (run) await runs.stop(run.id)
  }

  function waitForChildren(
    taskId: string,
    childIds: readonly string[],
    from: 'split' | 'plan-task',
  ): void {
    store.childTasksCreated(taskId, childIds, from)
    if (!find(taskId).waitsForBlockers) store.waitForBlockers(taskId)
  }

  async function stopForBlockers(taskId: string): Promise<void> {
    const task = store.getTask(taskId)
    const run = task && liveLead(task)
    if (!task || !run || stoppingForBlockers.has(taskId) || !shouldStopForBlockers(task, run)) {
      return
    }
    stoppingForBlockers.add(taskId)
    try {
      await runs.stop(run.id)
      store.waitForBlockers(taskId)
    } finally {
      stoppingForBlockers.delete(taskId)
    }
    wake()
  }

  function wake(): void {
    const queued = new Set(store.queue().map((q) => q.id))
    for (const id of store.openBlockedTasks()) wakeTask(id, queued)
  }

  function wakeTask(id: string, queued = new Set(store.queue().map((q) => q.id))): void {
    if (queued.has(id) || starting.has(id) || hierarchyBusy.has(id) || deleting.has(id)) return
    if (finishingParents.has(id) || unmergedBlockers(id).length > 0) return
    const task = store.getTask(id)
    if (!task || task.archived || task.stopped || task.stage === 'done') return
    const wakes =
      (task.stage === 'backlog' && task.startRequested && !task.snoozedUntil) ||
      (task.waitsForBlockers && !liveLead(task))
    if (
      wakes &&
      !parentsChecked.has(id) &&
      store.madeParent(id) &&
      store.childrenOf(id).some((c) => store.isMerged(c))
    ) {
      finishingParents.add(id)
      inBackground(`finish ${task.displayId} after its child Tasks`, () =>
        finishParent(id).finally(() => {
          finishingParents.delete(id)
          wakeTask(id)
        }),
      )
      return
    }
    if (task.stage === 'backlog' && task.startRequested && !task.snoozedUntil) {
      inBackground(`start ${task.displayId}`, async () => {
        await start(id)
      })
    } else if (task.waitsForBlockers && !liveLead(task)) {
      store.requeueAfterBlockers(id)
    }
  }

  async function hasOwnWork(task: StoredTask): Promise<boolean> {
    const resolution = await taskWorkflow(task, { fetch: false })
    const entries = factoryRepos(resolution.workflow, factoryOf(task))
    for (const repo of task.repos.filter((r) => !r.removed)) {
      if (!(await lstat(repo.worktree).catch(() => undefined))?.isDirectory()) continue
      const base = repoEntry(entries, repo)?.baseBranch ?? (await git.defaultBranch(repo.worktree))
      const changes = await git.workingChanges(repo.worktree, `origin/${base}`)
      if (changes.files.length > 0 || changes.head !== changes.mergeBase) return true
    }
    return false
  }

  async function finishParent(id: string): Promise<void> {
    const before = find(id)
    const working = await hasOwnWork(before).catch((error: unknown) => {
      console.error(redactSecrets(`couldn’t read ${before.displayId}’s own work: ${String(error)}`))
      return true
    })
    if (!working)
      await holding(before, async () => {
        const task = find(id)
        if (task.archived || task.stopped || task.stage === 'done' || liveLead(task)) return
        if (unmergedBlockers(id).length > 0) return
        const resolution = await gateWorkflow(task)
        await requireObligations(task, undefined, 'done')
        store.parentFinishedWithChildren(id)
        if (task.startRequested) store.setStartRequested(id, false)
        store.changeStage(id, 'done', entryFor(resolution, 'done'))
        inBackground(`finish ${task.displayId}`, () => finish(task, resolution))
      }).catch((error: unknown) => {
        console.error(redactSecrets(`couldn’t finish ${before.displayId}: ${String(error)}`))
      })
    parentsChecked.add(id)
  }

  function tellLead(blocker: StoredTask, run: Run): Promise<void> {
    const id = blocker.displayId
    return runs.send(
      run.id,
      `The human made this Task wait for ${id} (“${blocker.title}”). Before doing more work, explain whether you can still make useful progress and recommend waiting or continuing. Ask the human with \`ted comment --choice "Wait for blocker" --choice "Continue independent work" "<your explanation, recommendation and question>"\`, naming ${id}, then end your turn and wait for their answer. The Task shows Waiting on you while the question is open. If they choose Wait for blocker, write the Task brief with \`ted brief write\`, run \`ted task block --by ${id}\`, and end your turn: TED stops this Run, keeps the worktree and Stage, and starts a fresh Run from the brief when its blockers merge. If they choose Continue independent work, keep the blocker link and work only on independent parts; when you reach work that needs ${id} to merge first, write the brief, run \`ted task block --by ${id}\`, and end your turn. Don’t remove the blocker just to continue.`,
    )
  }

  function relaunch(taskId: string): void {
    if (relaunching.has(taskId)) return
    relaunching.add(taskId)
    const release = hold(taskId)
    inBackground(`continue ${taskId}`, () =>
      resume(taskId).finally(() => {
        relaunching.delete(taskId)
        release()
      }),
    )
  }

  async function stopByHand(ref: string): Promise<Task> {
    const task = live(ref)
    if (task.stage === 'done') throw new RequestError(409, `${task.displayId} is done`)
    const started =
      task.stage !== 'backlog' &&
      (task.preparation === 'ready' ||
        task.leadRunId !== undefined ||
        task.repos.length > 0 ||
        beginning.has(task.id))
    if (!started) {
      throw new RequestError(409, `${task.displayId} hasn’t started, so there’s nothing to stop`)
    }
    if ((task.stopped && task.preparation !== 'ready') || stoppingByHand.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is already stopped`)
    }
    stoppingByHand.add(task.id)
    try {
      if (store.heldRuns().some((h) => h.taskId === task.id)) store.releaseTaskRun(task.id)
      store.stopTask(task.id, { runs: task.runs.length, why: 'human' })
      dropWaitingMove(task.id)
      checkWaits.get(task.id)?.abort()
      subAgents.dropFor(task.id)
      settingUp.get(task.id)?.abort()
      await beginning.get(task.id)?.catch(() => undefined)
      settingUp.get(task.id)?.abort()
      await Promise.all(find(task.id).runs.map((run) => runs.stop(run.id)))
      closeIdleQuestion(task.id, 'The Task was stopped.')
    } finally {
      stoppingByHand.delete(task.id)
    }
    void pump()
    return publicTask(task.id)
  }

  function interrupted(task: StoredTask): boolean {
    return (
      task.canResume === true &&
      canStartFresh(task) &&
      !advancing.has(task.id) &&
      !leadLifecycle.pendingRevive(task.id) &&
      !leadLifecycle.recovering(task.leadRunId ?? '')
    )
  }

  function workingLead(run: Run): StoredTask | undefined {
    if (run.taskId === undefined || run.parentRunId !== undefined) return undefined
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.archived || task.stopped) return undefined
    if (task.stage === 'backlog' || task.stage === 'done' || task.stage === 'merge') {
      return undefined
    }
    return task
  }

  function stoppingForQuit(): void {
    for (const run of store.listRuns()) {
      if (run.state !== 'working') continue
      const task = workingLead(run)
      if (task) store.taskStoppedByTed(task.id, run.id, 'quit')
    }
  }

  async function answerTedStops({
    restart,
    leave,
  }: AnswerTedStopsRequest): Promise<TedStoppedTask[]> {
    const offered = new Set(store.tedStops().map((task) => task.id))
    for (const id of leave) {
      if (offered.has(id)) store.answerTedStop(id, 'leave')
    }
    for (const id of restart) {
      if (!offered.has(id)) continue
      store.answerTedStop(id, 'restart')
      const task = find(id)
      if (!interrupted(task) || stoppingByHand.has(id)) continue
      store.resumeTask(id, { waitForBlockers: unmergedBlockers(id).length > 0 })
    }
    await pump()
    return store.tedStops()
  }

  async function resumeByHand(
    ref: string,
    {
      comment,
      attachments = [],
      sendDrafts = true,
    }: { comment?: string; attachments?: Attachment[]; sendDrafts?: boolean } = {},
  ): Promise<Task> {
    const task = live(ref)
    if (!task.stopped && task.status?.kind !== 'failed' && !interrupted(task)) {
      throw new RequestError(409, `${task.displayId} isn’t stopped`)
    }
    if (stoppingByHand.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is still stopping; try again`)
    }
    const text = comment?.trim() ?? ''
    if (text !== '' || attachments.length > 0) {
      store.postComment({
        taskId: task.id,
        body: text,
        author: { kind: 'human' },
        attachments,
        ...(sendDrafts && { lineComments: drafts(task.id) }),
      })
    }
    const waitForBlockers = unmergedBlockers(task.id).length > 0
    if (task.status?.kind === 'failed') {
      const at = new Date().toISOString()
      for (const ask of openRequests(task.id).filter((c) => c.failed !== undefined)) {
        store.answerComment(ask.id, { kind: 'answered', at, choice: retryChoice })
      }
      store.retryTask(task.id, { waitForBlockers })
    } else {
      store.resumeTask(task.id, { waitForBlockers })
    }
    await pump()
    return publicTask(task.id)
  }

  function watchIdle(run: Run): void {
    const timer = nudgeTimers.get(run.id)
    if (run.state !== 'idle') {
      timer?.cancel()
      nudgeTimers.delete(run.id)
      if (run.state === 'working' && run.taskId !== undefined) {
        if (store.getTask(run.taskId)?.leadRunId === run.id) {
          closeIdleQuestion(run.taskId, 'The Task Lead carried on.')
        }
      }
      return
    }
    if (timer || run.taskId === undefined) return
    const next = clock.timeout(() => {
      nudgeTimers.delete(run.id)
      if (!closed) inBackground('nudge the Task Lead', () => nudgeIfIdle(run.id))
    }, nudgeAfterMs)
    next.unref()
    nudgeTimers.set(run.id, next)
  }

  async function nudgeIfIdle(runId: string): Promise<void> {
    const run = store.getRun(runId)
    if (run?.state !== 'idle' || run.problem !== undefined || run.taskId === undefined) return
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.archived || task.stopped) return
    if (task.stage === 'backlog' || task.stage === 'done' || task.stage === 'merge') return
    if (advancing.has(task.id)) return
    if (tedWorkingFor(task, run)) {
      watchIdle(run)
      return
    }
    if (
      merging.has(task.id) ||
      task.pendingLeadMessages.length > 0 ||
      queuedAnswers(task.id).length > 0
    )
      return
    if (store.heldRuns().some((h) => h.taskId === task.id)) return
    if (stoppingForBlockers.has(task.id) || shouldStopForBlockers(task, run)) return
    if (openRequests(task.id).some((c) => !isTrackerGroupAsk(c))) return
    if (planningInChat(task.id)) return
    const nudged = store.latestNudge(task.id, run.id)
    if (nudged === undefined || heardSince(task, nudged)) await sendNudge(task, run)
    else askAboutIdle(task, run)
  }

  function tedWorkingFor(task: StoredTask, lead: Run): boolean {
    return (
      task.runs.some((r) => r.id !== lead.id && r.state === 'working') ||
      store.subAgentRequests().some((r) => r.taskId === task.id) ||
      pendingLoopCheck(task.id) !== undefined ||
      store.listCheckRuns(task.id).some((c) => c.finishedAt === undefined)
    )
  }

  function heardSince(task: StoredTask, at: string): boolean {
    const comments = store.listComments(task.id)
    return (
      store.listStageEntries(task.id).some((e) => e.at > at) ||
      comments.some((c) => c.author.kind === 'human' && c.createdAt > at) ||
      comments.some((c) => c.answer !== undefined && c.answer.at > at)
    )
  }

  async function sendNudge(task: Task, run: Run): Promise<void> {
    await runs.send(run.id, nudgeMessage)
    store.leadNudged(task.id, run.id)
  }

  function askAboutIdle(task: StoredTask, run: Run): void {
    const agent = agents.get(run.agent)
    const spoke = runs.output.findLast(run.id, ({ line }) => {
      const text = agent.agentTextFrom(line)
      return text !== undefined && text.trim() !== ''
    })
    const said = spoke && agent.agentTextFrom(spoke.line)
    const quoted = said === undefined ? undefined : oneLine(said, 500)
    store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: idleTitle,
      purpose: { kind: 'idle-run' },
      body:
        quoted === undefined
          ? 'It went idle again after the nudge, with nothing open, and wrote no message.'
          : `It went idle again after the nudge, with nothing open. Its last message:\n\n> ${quoted}`,
      choices: [nudgeAgainChoice],
    })
  }

  function openRequests(taskId: string): Comment[] {
    return store.listComments(taskId).filter((c) => c.kind !== 'note' && c.answer === undefined)
  }

  function closeIdleQuestion(taskId: string, text: string): void {
    for (const question of openRequests(taskId).filter(isIdleQuestion)) {
      store.answerComment(question.id, { kind: 'answered', at: new Date().toISOString(), text })
    }
  }

  options.steering.addSource({
    pending(run) {
      if (run.state !== 'working' || run.taskId === undefined) return []
      const task = store.getTask(run.taskId)
      const mode = task?.autopilot?.enabled === true
      if (task?.leadRunId !== run.id || overnightSeen.get(run.id) === mode) return []
      return [
        {
          id: `overnight:${mode}`,
          text: overnightGuidance(mode, task.setup),
          at: task?.updatedAt ?? overnightChangedAt,
        },
      ]
    },
    delivered(run, ids) {
      overnightSeen.set(run.id, ids.includes('overnight:true'))
    },
  })

  options.steering.addSource({
    acknowledged: true,
    revocable: true,
    signal: stopping.signal,
    pending(run) {
      if (store.getRun(run.id)?.state !== 'working' || continuing.has(run.taskId ?? '')) return []
      const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
      if (!task || stoppingByHand.has(task.id) || availableTalkLead(task)?.id !== run.id) return []
      return store.pendingRoundTalks(run.id).map(({ messageId, round }) => ({
        id: messageId,
        text: talkLine(round),
        at: round.talk?.startedAt ?? round.createdAt,
      }))
    },
    delivered(run, ids) {
      const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
      if (!task || availableTalkLead(task)?.id !== run.id) return
      for (const { messageId, round } of store.pendingRoundTalks(run.id)) {
        if (ids.includes(messageId)) store.roundTalkNotified(round.id, run.id, messageId)
      }
    },
  })

  options.steering.addSource({
    pending(run) {
      const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
      if (!task || liveLead(task)?.id !== run.id) return []
      return waitingForRun(task.id)
        .comments.filter(
          (comment) =>
            !promptComments.has(comment.id) &&
            (!peers.isMessage(comment.id) ||
              (run.state === 'working' &&
                !task.stopped &&
                !task.archived &&
                task.stage !== 'done' &&
                task.stage !== 'merge' &&
                openRequests(task.id).length === 0)),
        )
        .map((comment) => ({
          id: comment.id,
          text:
            comment.author.kind === 'human'
              ? humanMessage(commentText(comment))
              : commentText(comment),
          at: comment.createdAt,
        }))
    },
    delivered(run, ids) {
      store.commentsDelivered(ids, run.id)
    },
  })

  runs.observe({
    authFailed(run) {
      leadLifecycle.authFailed(run)
      health.authFailed(run.agent)
    },
    usage(run, signal) {
      if (!signal.limited) {
        if (store.agentPauses()[run.agent] !== undefined) health.usable(run.agent)
        return
      }
      if (run.state !== 'finished') leadLifecycle.stoppedMidTurn(run.id)
      health.limited(run.agent, signal.resetsAt)
    },
    credential(run, report) {
      if (!health.credentialReported(run.agent, report) || run.state === 'finished') return
      leadLifecycle.stoppedMidTurn(run.id)
      runs.interrupt(run.id).catch((error: unknown) => console.error(error))
    },
    planUsage(run, windows) {
      health.planUsage(run.agent, windows)
    },
    autoMode(run, signal) {
      const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
      if (!task || run.permissions !== 'auto') return
      reportAutoMode(task.factoryId, signal)
    },
    settled: leadLifecycle.settled,
    accepted(run, texts) {
      acknowledgeLeadMessages(run)
      markAccepted(run, texts)
      const timer = nudgeTimers.get(run.id)
      timer?.cancel()
      nudgeTimers.delete(run.id)
      setImmediate(() => {
        if (closed) return
        const now = store.getRun(run.id)
        if (now) watchIdle(now)
      })
    },
    stoppedOutside(run, at) {
      const task = workingLead(run)
      if (task) store.taskStoppedByTed(task.id, run.id, 'ended-outside', at)
    },
    finished: leadLifecycle.finished,
  })

  health.onReady((agent) => {
    leadLifecycle.ready(agent)
    for (const run of store.liveRuns()) {
      if (
        run.agent === agent &&
        run.taskId !== undefined &&
        store.getTask(run.taskId)?.leadRunId === run.id
      ) {
        pendingTalks(run.taskId)
        inBackground('refresh reply delivery after agent recovery', () =>
          options.steering.refresh(run.id),
        )
      }
    }
  })
  health.onPaused((agent, state) => {
    if (state === 'offline') leadLifecycle.offline(agent)
  })
  options.steering.addSource({
    pending(run) {
      const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
      if (
        !task ||
        liveLead(task)?.id !== run.id ||
        task.stopped ||
        task.archived ||
        run.state !== 'working' ||
        continuing.has(task.id) ||
        store.agentPauses()[run.agent] !== undefined
      )
        return []
      return store
        .heldAnswers(task.id)
        .filter((comment) => comment.answerDelivery && !promptComments.has(comment.id))
        .map((comment) => ({
          id: comment.id,
          text: answerMessage(comment, linesText(comment)),
          at: comment.answerDelivery?.queuedAt ?? comment.createdAt,
        }))
    },
    delivered(run, ids) {
      store.answersDelivered(ids, run.id)
    },
  })

  health.onProbe(leadLifecycle.probe)

  const failures = createFailureCases({
    store,
    snapshot: (task, bindCi) => failureSnapshot(task, undefined, bindCi),
    assertLead: (task, runId) => {
      taskLead(task.id, { kind: 'run', runId }, 'manages failure cases')
    },
    drafts,
    onInvalidated: async (task) => {
      await sendWaiting(task.id)
    },
    onHold: async (task) => {
      const current = find(task.id)
      const split = mergeSplit(current)
      if (current.stage !== 'done' && split && !current.statuses.includes('partly-merged')) {
        store.mergeStoppedPartway(task.id, split)
        await store.persisted()
      }
      const stillOn = await mergeWatcher.disableAutoMerge(task.id)
      if (stillOn.length > 0) {
        const message = `Failure hold is saved, but GitHub auto-merge could not be disabled for ${stillOn.join(', ')}. GitHub may still merge it. TED will retry.`
        if (
          !store
            .listComments(task.id)
            .some((comment) => comment.author.kind === 'ted' && comment.body === message)
        ) {
          store.postComment({ taskId: task.id, author: { kind: 'ted' }, body: message })
          await store.persisted()
        }
        throw new RequestError(502, message)
      }
    },
    tell: async (task, comment) => {
      await deliverAnswer(
        task,
        comment,
        redactSecrets(
          withLines(
            failureText(
              `The human resolved failure request ${comment.id}: ${comment.answer?.kind === 'answered' ? comment.answer.choice : ''}. ${comment.answer && 'text' in comment.answer ? comment.answer.text : ''}`,
            ),
            comment,
          ),
        ),
      )
    },
  })

  const validation = createValidation({
    ...(options.testReportingEnv && { reportingEnv: options.testReportingEnv }),
    store,
    failures,
    find,
    // Coverage leaves out the login shell's environment: mise sets a new value on every read.
    context: (task) => checkContext(task, { inherited: false }),
    workflow: (task) => taskWorkflow(task, { fetch: false }),
    plan: checkPlan,
    checkSandbox: async (task) => {
      if (factoryPermissions(store, task.factoryId) !== 'bypass')
        await sandboxProblem(task.factoryId)
    },
    prepareLaunch: (task) => prepareCommandLaunch(task),
    env: () => options.env?.() ?? process.env,
    libraryDir: options.libraryDir ?? path.join(path.dirname(logsDir), 'library'),
    signal: stopping.signal,
    lowPriority: () => store.settings().lowPriorityWork,
    takeCheckSlot: async (taskId, checkRunId) => {
      const wait = new AbortController()
      checkWaits.set(taskId, wait)
      try {
        return await options.checkSlots.take({
          taskId,
          signal: AbortSignal.any([stopping.signal, wait.signal]),
          observe: (boundary, at) =>
            store.checkSlotBoundary(
              checkRunId,
              boundary === 'canceled' && stopping.signal.aborted ? 'interrupted' : boundary,
              at,
            ),
        })
      } finally {
        checkWaits.delete(taskId)
      }
    },
    checkLog,
    checkDir,
    findings: failedFindings,
    reportNotFound: (task, result) => reportNotFound(factoryOf(task).id, result),
    setChecking,
    isChecking: (id) => checking.has(id),
    deliver: (task, text) => deliver(task, text, true),
    notify: (task) => sendWaiting(task.id),
    instructions: async (task, resolution, message) => {
      const round = await validateRound(task, resolution.workflow)
      return [
        message ?? nextStageMessage(resolution.workflow, 'validate'),
        ...(round !== undefined ? [round] : []),
      ].join('\n\n')
    },
    apps: startSetupApps,
    fix: applyValidationFix,
    checkFix: (resolution, task) =>
      checkBack(resolution.workflow, task.stage as AgentStageId, 'work'),
    holding,
    background: inBackground,
  })

  leadLifecycle.restoreHealth()

  for (const task of store.listTasks()) {
    if (watched(store.getTask(task.id))) watchMerge(task.id)
  }

  const heldAtStart = new Set(store.heldRuns().map((h) => h.taskId))
  for (const task of store.listTasks()) {
    if (task.archived && task.repos.some((r) => !r.removed)) {
      inBackground(`finish archiving ${task.displayId}`, () => clearing(task.id))
      continue
    }
    if (
      task.markers.some((m) => m.kind === 'needs-planning') &&
      (task.runs.length > 0 || task.repos.some((r) => !r.removed))
    ) {
      inBackground(`move ${task.displayId} to Backlog for planning`, () => clearing(task.id))
      continue
    }
    if (heldAtStart.has(task.id)) continue
    if (task.leadRunId === undefined && task.repos.some((r) => !r.removed)) {
      inBackground(`resume ${task.displayId}`, () => resume(task.id))
    }
  }

  for (const task of store.listTasks()) {
    if (task.archived || task.leadRunId === undefined) continue
    for (const step of interruptedSetups(find(task.id))) {
      inBackground(`set up ${task.displayId}’s ${step.repo.name} worktree`, () =>
        setUpAdded(task.id, step, true),
      )
    }
  }

  for (const run of store.listRuns()) {
    if (run.state === 'idle' && run.taskId !== undefined) watchIdle(run)
  }

  leadLifecycle.recoverStartup()
  for (const task of store.listTasks()) {
    if (store.listComments(task.id).some((c) => c.talkRequested)) pendingTalks(task.id)
  }

  const interruptedHandOffs = store
    .listCheckRuns()
    .filter((r) => r.finishedAt === undefined && r.trigger === 'hand-off')
    .flatMap((r) => {
      const task = store.getTask(r.taskId)
      return task && !leftWork(task) ? [task] : []
    })
  validation.recover()
  for (const task of store.listTasks()) {
    if (task.stage !== 'cleanup' || find(task.id).stopped || task.archived) continue
    if (openCleanupFailure(task.id)) continue
    setChecking(task.id, true)
    inBackground(`run ${task.displayId}’s Cleanup commands again`, async () => {
      let workflow: ResolvedWorkflow
      try {
        workflow = (await taskWorkflow(find(task.id), { fetch: false })).workflow
      } finally {
        setChecking(task.id, false)
      }
      if (pendingCleanupCommands(task.id, workflow).length > 0) {
        await cleanupThen(task.id, workflow, cleanupRestartNote)
      } else if (
        cleanupSteps(workflow).every(isCommandStep) &&
        cleanupLeft(task.id, workflow) === 'nothing'
      ) {
        await afterCleanupCommands(task.id, workflow, cleanupRestartNote, [])
      }
    })
  }
  for (const task of store.listTasks()) {
    const lead = task.leadRunId && store.getRun(task.leadRunId)
    if (lead && lead.state !== 'finished') scheduleRepairChecks(task.id)
  }
  for (const task of interruptedHandOffs) {
    if (handOffHalted(task, task.leadRunId)) {
      inBackground(`tell ${task.displayId}’s Task Lead its Checks weren’t used`, () =>
        handOffUnused(task),
      )
      continue
    }
    setChecking(task.id, true)
    inBackground(`run ${task.displayId}’s Checks again`, () => handOffChecks(task.id))
  }

  for (const check of store.loopChecks().filter((c) => c.verdict === undefined)) {
    inBackground('wait for a loop check', () => awaitLoopCheck(check))
  }

  function snoozeNow(): number {
    return options.snoozes?.now?.().getTime() ?? clock.now()
  }
  let snoozeTimer: Timer | undefined
  let releaseSnoozeIdle: (() => void) | undefined
  function refreshSnoozes(): void {
    const pending =
      store.backlogTasks().some((task) => task.snoozed) || store.requestSnoozesPending()
    if (pending && !snoozeTimer) {
      releaseSnoozeIdle = options.idle?.hold()
      snoozeTimer = clock.interval(() => {
        store.returnDueRequests(snoozeNow())
        void pump()
      }, options.snoozes?.checkEveryMs ?? 30_000)
      snoozeTimer.unref()
    } else if (!pending && snoozeTimer) {
      snoozeTimer.cancel()
      snoozeTimer = undefined
      releaseSnoozeIdle?.()
      releaseSnoozeIdle = undefined
    }
  }
  store.returnDueRequests(snoozeNow())
  refreshSnoozes()
  const wakeSoon = coalesced(() => {
    if (!closed) wake()
  })
  const reportSetupSoon = coalesced((factoryId: string) => {
    if (!closed) reportSetup(factoryId)
  })
  const stopPumping = store.subscribe((event) => {
    if (
      event.type === 'comment-updated' ||
      event.type === 'task-updated' ||
      event.type === 'task-deleted'
    ) {
      const taskId =
        event.type === 'comment-updated'
          ? event.comment.taskId
          : event.type === 'task-updated'
            ? event.task.id
            : event.taskId
      const task = store.getTask(taskId)
      for (const run of store.listRuns().filter((run) => run.taskId === taskId)) {
        const ids =
          task && !task.stopped && !task.archived && task.leadRunId === run.id
            ? store.pendingRoundTalks(run.id).map(({ messageId }) => messageId)
            : []
        runs.retainRevocableInputs(run.id, ids)
      }
    }

    if (
      event.type === 'settings-changed' ||
      event.type === 'task-updated' ||
      event.type === 'comment-posted'
    ) {
      const ids =
        event.type === 'settings-changed'
          ? autopilotCandidates()
          : [event.type === 'task-updated' ? event.task.id : event.comment.taskId]
      for (const id of ids)
        setImmediate(() => {
          if (!closed) inBackground('handle Autopilot requests', () => processAutopilot(id))
        })
      if (event.type === 'task-updated') {
        const runId = event.task.leadRunId
        if (runId) options.steering.syncQueuedFlag(runId)
      }
    }
    if (
      event.type === 'inbox-changed' ||
      event.type === 'task-created' ||
      event.type === 'task-updated' ||
      event.type === 'task-deleted' ||
      event.type === 'factory-removed'
    )
      refreshSnoozes()

    if (event.type === 'settings-changed') {
      options.checkSlots.recheck()
      overnightChangedAt = new Date().toISOString()
      for (const run of store.listRuns()) {
        if (run.state === 'working') options.steering.syncQueuedFlag(run.id)
      }
    }
    if (event.type === 'settings-changed') continuationFailures.clear()
    if (event.type === 'run-updated') {
      if (event.run.taskId) continuationFailures.delete(event.run.taskId)
      if (event.run.taskId)
        setImmediate(() => {
          if (!closed)
            inBackground('handle Autopilot questions', () =>
              processAutopilot(event.run.taskId as string),
            )
        })
      if (event.run.state === 'finished') overnightSeen.delete(event.run.id)
      else if (event.run.state === 'working') options.steering.syncQueuedFlag(event.run.id)
    }

    if (
      event.type === 'task-created' ||
      event.type === 'task-updated' ||
      event.type === 'task-deleted' ||
      event.type === 'factory-removed' ||
      event.type === 'factory-updated' ||
      event.type === 'settings-changed'
    )
      backlogVersion++
    if (event.type === 'factory-updated') {
      for (const id of autoStartFailures) {
        if (store.getTask(id)?.factoryId === event.factory.id) autoStartFailures.delete(id)
      }
    }
    if (event.type === 'task-deleted') autoStartFailures.delete(event.taskId)
    if (event.type === 'factory-removed') {
      for (const id of autoStartFailures) if (!store.getTask(id)) autoStartFailures.delete(id)
    }
    if (event.type === 'run-updated' && event.run.state === 'idle' && event.run.taskId) {
      const taskId = event.run.taskId
      setImmediate(() => {
        if (!closed) inBackground('stop a blocked Task Lead', () => stopForBlockers(taskId))
      })
    }
    if (
      event.type === 'task-updated' &&
      (event.task.stage === 'done' || event.task.stage === 'cleanup')
    )
      wakeSoon()
    if (event.type === 'task-updated' && watch) {
      setImmediate(() => {
        if (!closed) watch.poke()
      })
    }
    if (
      event.type === 'run-updated' ||
      event.type === 'task-created' ||
      event.type === 'task-updated' ||
      event.type === 'task-deleted' ||
      event.type === 'factory-removed' ||
      event.type === 'settings-changed' ||
      event.type === 'factory-updated'
    ) {
      void pump()
    }
    if ((event.type === 'task-created' || event.type === 'task-updated') && event.task.setup) {
      reportSetupSoon(event.task.factoryId)
    }
  })
  banners.onAction(setupProblem, async ({ factoryId }) => {
    if (factoryId !== undefined && !openSetupTask(factoryId)) {
      const factory = store.getFactory(factoryId)
      if (factory) await makeSetupTask(factory, true)
    }
  })
  for (const factory of store.listFactories()) reportSetup(factory.id)
  void pump()
  wake()
  watch?.poke()
  for (const task of store.listTasks()) {
    setImmediate(() => {
      if (!closed) inBackground('recover Autopilot requests', () => processAutopilot(task.id))
    })
    inBackground('stop a blocked Task Lead', async () => {
      const current = find(task.id)
      const repair = store.failures
        .list(task.id)
        .some((f) => f.resolutions.at(-1)?.resolution === 'repair')
      if (current.stopped && repair) await stopRepairLead(task.id)
      else if (current.waitsForBlockers && repair) await finishRepairWait(task.id)
      else await stopForBlockers(task.id)
    })
  }

  const hashContext = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex')
  function failureCi(task: Task, read: PullRequestRead | undefined) {
    const prs = task.repos.filter((r) => !r.removed && r.pullRequest)
    let ci: string | undefined
    const ciFailures: string[] = []
    if (prs.length > 0) {
      if (!read) throw new RequestError(409, 'GitHub context is unavailable')
      ci = hashContext(
        prs.map((r) => {
          const pr = read.pulls.get(`${task.id}:${r.name}`)
          if (pr?.checksComplete !== true || pr.checks.some((c) => !c.identity))
            throw new RequestError(
              409,
              'GitHub Check attempt identity is unavailable or incomplete',
            )
          for (const check of pr.checks) {
            if (check.state === 'failed' && check.identity)
              ciFailures.push(
                ciFailureKey({
                  kind: 'github-ci',
                  repo: r.repo,
                  number: r.pullRequest?.number ?? 0,
                  head: pr.headRefOid,
                  attempt: check.identity,
                }),
              )
          }
          return {
            repo: r.repo,
            head: pr.headRefOid,
            checks: pr.checks
              .map((c) => ({ name: c.name, app: c.app, identity: c.identity, state: c.state }))
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          }
        }),
      )
    }
    return { ci, ciFailures }
  }
  async function checkContext(
    task: Task,
    { inherited = true }: { inherited?: boolean } = {},
  ): Promise<Pick<FailureContext, 'repos' | 'checks'>> {
    const resolution = await taskWorkflow(find(task.id), { fetch: false })
    const entries = factoryRepos(resolution.workflow, factoryOf(task))
    const checks = hashContext({
      checks: task.setup
        ? await approvedSetupChecks(find(task.id))
        : (resolution.workflow.settings.stages.validate?.checks ?? []),
      repos: entries.map((e) => ({
        repo: e.repo,
        name: e.name,
        baseBranch: e.baseBranch,
        env: Object.entries(
          checkEnv(task.displayId, e.env, inherited ? (options.env?.() ?? process.env) : {}),
        ).sort(([a], [b]) => a.localeCompare(b)),
      })),
    })
    const repos = await Promise.all(
      task.repos
        .filter((r) => !r.removed)
        .map(async (r) => {
          const entry = repoEntry(entries, r)
          const baseBranch = entry?.baseBranch ?? (await git.defaultBranch(r.worktree))
          const changes = await git.workingChanges(r.worktree, `origin/${baseBranch}`)
          return {
            repo: r.repo,
            head: changes.head,
            base: changes.base,
            tree: changes.tree,
            mergeBase: changes.mergeBase,
          }
        }),
    )
    if (repos.length === 0) throw new RequestError(409, 'tested context needs a Task worktree')
    return { repos: repos.sort((a, b) => a.repo.localeCompare(b.repo)), checks }
  }
  async function failureSnapshot(
    task: Task,
    observed?: PullRequestRead,
    bindCi?: () => void,
  ): Promise<FailureContext> {
    const read =
      observed ??
      (task.repos.some((repo) => !repo.removed && repo.pullRequest)
        ? await watch?.next({ now: true })
        : undefined)
    const { ci, ciFailures } = failureCi(task, read)
    bindCi?.()
    const local = await checkContext(task)
    const context = {
      version: 2 as const,
      ciFailures: ciFailures.sort(),
      ...local,
      ...(ci && { ci }),
    }
    return {
      ...context,
      id: randomUUID(),
      taskId: task.id,
      capturedAt: new Date().toISOString(),
      fingerprint: hashContext(context),
    }
  }
  async function requireObligations(
    task: Task,
    observed?: PullRequestRead,
    target?: string,
    mergedOnGitHub = false,
  ): Promise<void> {
    if (unfinishedChildren(task.id))
      throw new RequestError(
        409,
        `${task.displayId} must wait for its unfinished children to merge before moving on`,
      )
    let repair = false
    if (target && target !== 'done') {
      const workflow = (await taskWorkflow(find(task.id), { fetch: false })).workflow
      const validate = workflow.order.indexOf('validate')
      repair =
        validate >= 0 &&
        workflow.order.indexOf(target as AgentStageId) <= validate &&
        task.stage !== 'validate'
    }
    if (repair) {
      const result = await failures.obligations(task)
      if (result.blockers.every((id) => store.failures.get(id)?.validation)) return
    }
    await validation.requireCoverage(find(task.id), mergedOnGitHub)
    if (store.failures.list(task.id).length === 0) return
    const context = observed
      ? await failures
          .snapshot(task, (bindCi) => failureSnapshot(task, observed, bindCi))
          .catch(() => null)
      : undefined
    const result = await failures.obligations(task, context)
    if (!result.satisfied)
      throw new RequestError(
        409,
        `Unresolved failure cases hold this Task: ${result.blockers.map(shortReference).join(', ')}`,
      )
  }
  async function waitForRepair(task: StoredTask, id: string, input: ResolveFailureRequest) {
    if (input.repair?.kind === 'new')
      input = {
        ...input,
        repair: {
          ...input.repair,
          title: failureText(input.repair.title),
          description: failureText(input.repair.description),
        },
      }
    if (input.reason) input = { ...input, reason: failureText(input.reason) }
    const value = failures.get(task, id)
    id = value.id
    const prior = value.resolutions.find((r) => r.requestId === input.requestId)
    if (prior) {
      if (
        prior.resolution !== 'repair' ||
        JSON.stringify(prior.repair) !== JSON.stringify(input.repair)
      )
        throw new RequestError(409, 'this failure decision already has a different answer')
      await finishRepairWait(task.id)
      return failures.get(find(task.id), id)
    }
    if (!['validate', 'merge'].includes(task.stage) || task.archived || task.stopped)
      throw new RequestError(409, 'repair decisions require an active Validate or Merge Task')
    if (checking.has(task.id))
      throw new RequestError(409, 'wait for the running Checks before choosing a repair')
    await failures.obligations(task)
    const current = find(task.id)
    if (failures.get(current, id).resolutions.some((r) => r.requestId === input.requestId))
      return waitForRepair(current, id, input)
    if (
      current.archived ||
      current.stopped ||
      current.stage !== task.stage ||
      checking.has(task.id) ||
      removingFactories.has(task.factoryId)
    )
      throw new RequestError(409, 'the Task changed while preparing the repair; try again')
    const pending = failures.pendingDecision(current, id, input.requestId)
    const selection = input.repair
    if (!selection) throw new RequestError(400, 'choose an existing or new repair Task')
    const note = `Waiting for REPAIR_TASK_REFERENCE to merge. Original failure: ${shortReference(pending.value.id)}. Tested context: ${pending.decision.contextId ? shortReference(pending.decision.contextId) : 'unknown'}. The failure remains unresolved. Keep this Stage and worktree; incorporate the merged repair before fresh validation. Removing a blocker without merging requires explicit Resume and does not pass validation.`
    const previous = store.latestBrief(task.id)?.text
    const brief = previous?.includes('## Current state')
      ? previous.replace('## Current state', `## Current state\n\n${note}\n`)
      : `## Goal\n${task.title}\n\n## Decisions so far\nThe user approved waiting for a separate repair.\n\n## Current state\n${note}\n\n## Open questions\nThe original failure requires fresh verification.\n\n## Next step\nWait for the repair to merge, then incorporate it and revalidate.`
    const approval = { failure: pending.value, request: input, brief, drafts: drafts(task.id) }
    let repair: Task
    if (selection.kind === 'existing') {
      repair = find(selection.taskId)
      if (repair.factoryId !== task.factoryId || repair.archived || repair.stage === 'done')
        throw new RequestError(409, 'choose an open repair Task in the same Factory')
      if (repair.id === task.id || cycleFrom(repair.id, task.id))
        throw new RequestError(409, 'this repair would create a blocker cycle')
      store.approveRepair(approval, repair)
    } else {
      const resolution = await resolveWorkflow(factoryOf(task), { fetch: false })
      const current = find(task.id)
      if (failures.get(current, id).resolutions.some((r) => r.requestId === input.requestId))
        return waitForRepair(current, id, input)
      if (
        current.archived ||
        current.stopped ||
        current.stage !== task.stage ||
        checking.has(task.id) ||
        removingFactories.has(task.factoryId)
      )
        throw new RequestError(409, 'the Task changed while preparing the repair; try again')
      failures.pendingDecision(current, id, input.requestId)
      repair = await store.createTask({
        factoryId: task.factoryId,
        title: failureText(selection.title),
        description: failureText(selection.description),
        lead: { ...leadFrom(resolution.workflow.settings), effortMode: 'stage' },
        repairApproval: {
          ...approval,
          ...(selection.start && {
            startStage: resolution.workflow.next('backlog') as AgentStageId,
          }),
        },
      })
    }
    await store.persisted()
    await finishRepairWait(task.id)
    return failures.get(find(task.id), id)
  }

  async function incorporateRepairs(task: StoredTask): Promise<boolean> {
    let incorporated = false
    for (const value of store.failures.list(task.id)) {
      const decision = value.resolutions.at(-1)
      if (value.verifications?.length || decision?.resolution !== 'repair' || !decision.repairTask)
        continue
      const progress = value.repairProgress?.findLast((p) => p.requestId === decision.requestId)
      if (progress) {
        try {
          for (const repo of task.repos.filter(
            (r) => !r.removed && r.pullRequest?.state !== 'merged',
          )) {
            await worktreeFileScope(worktreesDir, repo.worktree)
            const recorded = progress.repos.find((r) => sameRepo(r.repo, repo.repo))
            if (
              !recorded ||
              !(await git.isAncestor(
                repo.worktree,
                recorded.head,
                await git.headCommit(repo.worktree),
              ))
            )
              throw new Error(`The recorded repair is missing from ${repo.repo}’s worktree`)
          }
          await taskWorkflow(find(task.id))
          incorporated = true
          continue
        } catch (error) {
          repairNotice(
            task.id,
            decision.repairTask.id,
            `incorporation could not be confirmed: ${redactSecrets(textOf(error))}. Restore the incorporated revision before retrying validation.`,
          )
          store.stopTask(task.id, { runs: find(task.id).runs.length, why: 'repair-incorporation' })
          await stopRepairLead(task.id)
          await store.persisted()
          throw error
        }
      }
      const repair = store.getTask(decision.repairTask.id)
      if (!repair || !store.isMerged(repair.id)) {
        repairNotice(
          task.id,
          decision.repairTask.id,
          'has not merged. Reassess the failure or select another repair; no repair was incorporated.',
        )
        continue
      }
      const resolution = await taskWorkflow(find(task.id), { fetch: false })
      const factory = factoryOf(task)
      const entries = factoryRepos(resolution.workflow, factory)
      const prepared: {
        repo: (typeof task.repos)[number]
        head: string
        commit: string
        onto: string
      }[] = []
      try {
        for (const repo of task.repos.filter(
          (r) => !r.removed && r.pullRequest?.state !== 'merged',
        )) {
          await worktreeFileScope(worktreesDir, repo.worktree)
          const entry = repoEntry(entries, repo)
          if (!entry) throw new Error(`No Factory settings for ${repo.repo}`)
          const base = repo.pullRequest?.base ?? entry.baseBranch ?? factory.defaultBranch
          const onto = await git.fetchBranch(repo.worktree, { url: entry.cloneUrl, branch: base })
          const repaired = repair.repos.find(
            (r) => !r.removed && r.repo.toLowerCase() === repo.repo.toLowerCase(),
          )
          if (repaired) {
            const repairHead = repaired.pullRequest?.signedOff ?? repaired.pushed?.commit
            if (!repairHead)
              throw new Error(`The merged repair’s commit for ${repo.repo} is unavailable`)
            const contains = await git.isAncestor(repo.worktree, repairHead, onto)
            if (!contains) {
              const from = await git.mergeBase(repo.worktree, repairHead, onto)
              const tree = await git.replayedTree(repo.worktree, { from, to: repairHead, onto })
              if (tree !== (await git.treeOf(repo.worktree, onto)))
                throw new Error(
                  `The target branch of ${repo.repo} does not yet contain the merged repair`,
                )
            }
          }
          prepared.push({ repo, onto, ...(await git.prepareIncorporation(repo.worktree, onto)) })
        }
        const current = store.getTask(task.id)
        if (!current || current.archived || current.stopped || stopping.signal.aborted) return false
        if (unmergedBlockers(task.id).length > 0) {
          store.waitForBlockers(task.id)
          throw new Error(
            'The Task is blocked again; wait for its blockers before incorporating the repair',
          )
        }
        for (const plan of prepared) {
          await worktreeFileScope(worktreesDir, plan.repo.worktree)
          if ((await git.headCommit(plan.repo.worktree)) !== plan.head)
            throw new Error('The worktree changed while incorporating the repair; try again')
          await git.moveBranchTo(plan.repo.worktree, plan.commit)
        }
        await taskWorkflow(find(task.id))
        const repos = prepared.map((p) => ({ repo: p.repo.repo, head: p.commit, onto: p.onto }))
        const previous = value.repairProgress?.findLast((p) => p.requestId === decision.requestId)
        if (JSON.stringify(previous?.repos) !== JSON.stringify(repos)) {
          store.failures.save(
            {
              ...value,
              repairProgress: [
                ...(value.repairProgress ?? []),
                {
                  requestId: decision.requestId,
                  at: new Date().toISOString(),
                  repos,
                },
              ],
            },
            'repair',
          )
          repairNotice(
            task.id,
            repair.id,
            'merged and was incorporated. Fresh validation is required; the original execution remains failed.',
          )
        }
        await failures.obligations(find(task.id))
        incorporated = true
      } catch (error) {
        const current = store.getTask(task.id)
        if (!current || current.archived || stopping.signal.aborted) return false
        repairNotice(
          task.id,
          repair.id,
          `merged, but incorporation is held: ${redactSecrets(textOf(error))}. Resolve this before validation and use Resume to try again.`,
        )
        store.stopTask(task.id, { runs: find(task.id).runs.length, why: 'repair-incorporation' })
        await stopRepairLead(task.id)
        await store.persisted()
        throw error
      }
    }
    await store.persisted()
    return incorporated
  }

  async function stopRepairLead(taskId: string) {
    subAgents.dropFor(taskId)
    if (store.heldRuns().some((h) => h.taskId === taskId)) store.releaseTaskRun(taskId)
    await Promise.all(find(taskId).runs.map((run) => runs.stop(run.id)))
    wake()
  }

  async function finishRepairWait(taskId: string) {
    if (store.getTask(taskId)?.waitsForBlockers) await stopRepairLead(taskId)
  }

  async function failureLead<T>(
    ref: string,
    caller: Caller,
    work: (task: StoredTask, runId: string) => Promise<T> | T,
  ): Promise<T> {
    const { task } = taskLead(ref, caller, 'manages failure cases')
    await untilFree(task.id)
    return holding(find(task.id), async () => {
      const { task: current, runId } = taskLead(ref, caller, 'manages failure cases')
      if (
        current.archived ||
        current.stopped ||
        current.stage === 'done' ||
        store.getRun(runId)?.state === 'finished'
      )
        throw new RequestError(409, 'failure cases cannot change on an archived or Done Task')
      return withoutCheckName(await work(current, runId))
    })
  }

  const checkCreates = new Map<string, Promise<void>>()

  async function createTask(
    {
      title,
      factory: givenKey,
      blockedBy = [],
      start: startNow,
      startInBackground,
      lead,
      source: sourceUrl,
      sentryId,
      followUp,
      parent: parentRef,
      ...fields
    }: CreateTaskInput,
    caller: Caller = { kind: 'app' },
  ): Promise<Task> {
    if (fields.draftRevision !== undefined && caller.kind !== 'app') {
      throw new RequestError(403, 'only the app can consume a New Task draft')
    }
    if (parentRef !== undefined && caller.kind !== 'app') {
      throw new RequestError(403, 'only the app can create a Task under a parent')
    }
    if (parentRef !== undefined && followUp !== undefined) {
      throw new RequestError(400, 'a follow-up Task can’t be created under a parent')
    }
    const automation = automationCaller(caller)
    const files = fields.attachments ?? []
    if (files.length > 0 && (followUp !== undefined || isAsanaSource(sourceUrl, parentRef))) {
      throw new RequestError(400, 'files can’t be attached to a Follow-up or an Asana import')
    }
    if (caller.kind === 'run') {
      const foreign = files.find((a) => !automationUploads.has(`${caller.runId}:${a.hash}`))
      if (foreign) {
        throw new RequestError(
          403,
          `${foreign.name} wasn’t uploaded by this Run; attach your own files with ted task create --attach`,
        )
      }
    }
    const key = automation?.factoryKey ?? givenKey
    if (automation && givenKey !== undefined && givenKey !== automation.factoryKey) {
      throw new RequestError(
        403,
        `this Automation creates Tasks only in ${automation.factoryKey}, its own Factory`,
      )
    }
    const factory = key === undefined ? undefined : store.listFactories().find((f) => f.key === key)
    if (key !== undefined && !factory) throw new RequestError(404, `no Factory with key ${key}`)
    if (
      automation &&
      followUp !== undefined &&
      parseAsanaTaskUrl(find(followUp).source?.url ?? sourceUrl ?? '') !== undefined
    ) {
      throw new RequestError(
        403,
        'An Automation can’t make a Follow-up of Asana work. TED imports each Asana task once; leave it for the existing Task.',
      )
    }
    if (automation?.check) {
      if (startNow === true) {
        throw new RequestError(
          403,
          'A Scheduled Check creates Tasks in Backlog. To start one, create it without --start, then run `ted automation start <Task ID>`.',
        )
      }
      if (followUp !== undefined || isAsanaSource(sourceUrl, parentRef)) {
        throw new RequestError(
          403,
          'A Scheduled Check creates plain Tasks; it can’t make a Follow-up or import from Asana.',
        )
      }
      const made = store.automations
        .createdTasks(automation.link.automationId)
        .filter((row) => row.firingId === automation.link.firingId).length
      if (made >= maxTasksPerFiring) {
        throw new RequestError(
          409,
          `This Run has already created ${maxTasksPerFiring} Tasks, the most a Scheduled Check makes in one firing. Group the remaining failures into those Tasks with \`ted automation note\`.`,
        )
      }
    }
    if (followUp !== undefined) {
      return createFollowUp(followUp, {
        ...(title !== undefined && { title }),
        ...(fields.description !== undefined && { description: fields.description }),
        ...(sourceUrl !== undefined && { sourceUrl }),
        ...(factory && { factoryId: factory.id }),
        ...(automation && { automation: { name: automation.name, link: automation.link } }),
        linearConsent: caller.kind === 'app',
      })
    }
    if (isAsanaSource(sourceUrl, parentRef)) {
      const imported = await importAsana(
        {
          url: sourceUrl,
          ...(key !== undefined && { factory: key }),
          ...(fields.priority !== undefined && { priority: fields.priority }),
          ...(startNow !== undefined && { start: startNow }),
        },
        caller,
      )
      if (!imported.root) throw new RequestError(409, 'the Asana import created no Task')
      return publicTask(imported.root.taskId)
    }
    const refuseTracked = () => {
      if (sourceUrl === undefined || !factory || caller.kind === 'app') return
      const clash = sourceClash(sameSource(sourceUrl), factory.id, sourceUrl)
      if (clash) throw new RequestError(409, clashMessage(clash))
    }
    refuseTracked()
    const issue = sourceUrl === undefined ? undefined : await linearIssue(sourceUrl)
    const linearFiles = await storedFiles(issue?.files ?? [])
    const given = title?.trim() || issue?.title
    const fromText = given ? undefined : titleFromText(fields.description ?? '')
    const name = given || fromText?.title || sourceUrl || ''
    if (name === '') throw new RequestError(400, 'a Task needs a title or a description')
    const blockers = [...new Set(blockedBy.map((ref) => find(ref).id))]
    const parentFor = () => {
      if (parentRef === undefined) return undefined
      const parent = find(parentRef)
      if (!factory || parent.factoryId !== factory.id)
        throw new RequestError(409, 'Parent and child must belong to the same Factory')
      requireHierarchyIdle([parent.id])
      safeParent(parent)
      if (blockers.some((id) => cycleFrom(id, parent.id)))
        throw new RequestError(409, 'Parent link would create a hierarchy or blocker cycle')
      return parent
    }
    parentFor()
    let failure: unknown
    const resolution = factory
      ? await resolveWorkflow(factory, { fetch: cloned(factory.id) }).catch((error: unknown) => {
          failure = error
          return undefined
        })
      : undefined
    refuseTracked()
    if (factory && removingFactories.has(factory.id)) {
      throw new RequestError(409, `${factory.name} is being removed`)
    }
    const held = automation !== undefined && (!resolution || runsInBypass(resolution))
    const intakeUnchanged =
      automation && factory
        ? await verifyLinearIntake(store, options.linear, factory.id, sourceUrl)
        : () => undefined
    refuseTracked()
    if (factory && removingFactories.has(factory.id)) {
      throw new RequestError(409, `${factory.name} is being removed`)
    }
    intakeUnchanged()
    const parent = parentFor()
    const task = await store.createTask({
      ...fields,
      ...(fields.description !== undefined && {
        description: fromText?.title ? fromText.description : fields.description.trim(),
      }),
      ...(linearFiles.length > 0 && {
        attachments: withoutRepeats([...(fields.attachments ?? []), ...linearFiles]),
      }),
      title: name,
      ...(fields.priority === undefined && issue && { priority: issue.priority }),
      ...(sourceUrl !== undefined && {
        source: {
          ...taskSource(sourceUrl, issue && withStoredFiles(issue, linearFiles)),
          ...(sentryId !== undefined && { sentry: { shortId: sentryId } }),
        },
      }),
      lead: lead ?? { ...leadFrom(resolution?.workflow.settings), effortMode: 'stage' },
      blockedBy: blockers,
      ...(parent && { parentId: parent.id }),
      startRequested: startNow === true && !held,
      ...(factory && { factoryId: factory.id }),
      ...(automation && { automation: automation.link }),
      linearConsent: caller.kind === 'app',
    })
    if (parent) {
      holdParent(parent.id)
      tellHierarchyChanged([parent.id])
    }
    if (issue) noteUnfetched(task.id, issue, linearFiles)
    if (automation && issue) linearConsent.askGroup(task.id, automation.name, issue.team)
    if (!factory) return task
    if (automation && runsInBypass(resolution)) return holdInBacklog(task.id, automation.name)
    if (!resolution) {
      console.error(
        `couldn’t read ${factory.repo}’s Workflow; ${task.displayId} waits in Backlog:`,
        failure,
      )
    }
    if (!resolution || unmergedBlockers(task.id).length > 0 || automation?.check) return task
    const hasBacklog = resolution.workflow.stages.includes('backlog')
    if (hasBacklog && startNow !== true) return task
    return startInBackground === true ? queueAndAnswer(task.id) : start(task.id)
  }

  return {
    failureContext(ref, id, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      const context =
        store.failures.context(id) ??
        store.failures.context(
          resolveReference(
            id,
            store.failures.contexts(task.id).map((value) => value.id),
            'tested context on this Task',
          ),
        )
      if (!context || context.taskId !== task.id)
        throw new RequestError(404, 'no tested context on this Task')
      return context
    },
    async listFailures(ref, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      const values = failures.list(task)
      return caller.kind === 'run' ? withoutCheckName(values) : values
    },
    async validationObligations(ref, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      await untilFree(task.id)
      return holding(find(task.id), async () => {
        const current = await validation.currentCoverage(find(task.id))
        const result = await failures.obligations(find(task.id))
        const progress = store.failures.progress(task.id)
        return {
          ...result,
          ...(progress && { progress }),
          satisfied:
            current &&
            result.satisfied &&
            (!progress || (!progress.pending && progress.next >= progress.checks.length)),
        }
      })
    },
    captureFailureContext: (ref, caller) =>
      failureLead(ref, caller, (task, runId) => failures.capture(task, runId)),
    recordFailure: (ref, caller, input) =>
      failureLead(ref, caller, (task, runId) => failures.record(task, runId, input)),
    addFailureEvidence: (ref, caller, id, evidence, contextId) =>
      failureLead(ref, caller, (task, runId) =>
        failures.evidence(task, id, runId, evidence, contextId),
      ),
    assessFailure: (ref, caller, id, input) =>
      failureLead(ref, caller, (task, runId) => failures.assess(task, id, runId, input)),
    verifyFailure: (ref, caller, id, evidence) =>
      failureLead(ref, caller, async (task) => {
        const value = failures.get(task, id)
        const repairedMergeFailure =
          task.stage === 'merge' &&
          ['finding', 'post-rebase-check'].includes(value.source.kind) &&
          value.resolutions.at(-1)?.resolution === 'repair' &&
          value.repairProgress?.some((p) => p.requestId === value.resolutions.at(-1)?.requestId)
        const own = !repairedMergeFailure && !value.validation && value.source.kind === 'finding'
        if (own) {
          if (!leadClosesFailures((await taskWorkflow(task, { fetch: false })).workflow))
            throw new RequestError(409, leadClosesRefusal)
          if (
            ['fixed', 'no-longer-applicable'].includes(value.resolutions.at(-1)?.resolution ?? '')
          )
            throw new RequestError(409, 'this case is closed; record a new failure')
          if (acceptedResolution(value))
            throw new RequestError(409, 'this failure already has current acceptance')
        } else if (
          !repairedMergeFailure &&
          (!value.validation ||
            !['finding', 'factory-check', 'post-rebase-check'].includes(value.source.kind) ||
            task.stage !== 'validate')
        )
          throw new RequestError(
            409,
            'verify a Validate failure or an incorporated repair’s Merge failure',
          )
        if (repairedMergeFailure && checking.has(task.id))
          throw new RequestError(409, 'wait for fresh Checks before verifying the repaired failure')
        if (!evidence.trim()) throw new RequestError(400, 'verification needs fresh evidence')
        if (
          !own &&
          ![
            'retry',
            'fix',
            ...(value.repairProgress?.some(
              (p) => p.requestId === value.resolutions.at(-1)?.requestId,
            )
              ? ['repair']
              : []),
          ].includes(value.resolutions.at(-1)?.resolution ?? '') &&
          value.assessments.at(-1)?.assessment !== 'regression'
        )
          throw new RequestError(
            409,
            'repeat verification after Retry or repair before closing the Finding',
          )
        const safeEvidence = failureText(evidence)
        if (value.verifications?.length)
          throw new RequestError(409, 'this failure already has verification evidence')
        const result =
          value.source.kind === 'factory-check' || value.source.kind === 'post-rebase-check'
            ? await validation.verifyRepair(task, value, safeEvidence)
            : failures.verifyResult(task, id, safeEvidence)
        store.postComment({
          taskId: task.id,
          author: { kind: 'run', runId: task.leadRunId ?? '' },
          title: 'Failure repair verified',
          body: `Failure ${shortReference(result.id)}\n\n${result.verifications?.at(-1)?.evidence}`,
        })
        return result
      }),
    requestFailureDecision: (ref, caller, id) =>
      failureLead(ref, caller, (task, runId) => failures.request(task, id, runId)),
    async resolveFailure(ref, id, input) {
      const task = find(ref)
      await untilFree(task.id)
      while (input.resolution === 'repair' && advancing.has(task.id)) await untilFree(task.id)
      return holding(find(task.id), () =>
        input.resolution === 'repair'
          ? waitForRepair(find(task.id), id, input)
          : validation.resolve(find(task.id), id, input),
      )
    },
    deliveryAllowed(runId) {
      const run = store.getRun(runId)
      const task = run?.taskId === undefined ? undefined : store.getTask(run.taskId)
      if (!run || !task || task.leadRunId !== runId) return true
      return (
        !leadLifecycle.applying(task.id) &&
        !task.leadRestartPending &&
        !leadLifecycle.restartWaiting(task.id) &&
        task.pendingLeadMessages.length === 0
      )
    },

    create(input, caller = { kind: 'app' }) {
      const firing = caller.kind === 'run' ? store.automations.firing(caller.runId) : undefined
      if (!firing || !store.automations.check(firing.automationId)) return createTask(input, caller)
      const next = (checkCreates.get(firing.id) ?? Promise.resolve()).then(() =>
        createTask(input, caller),
      )
      const settled = next.then(
        () => undefined,
        () => undefined,
      )
      checkCreates.set(firing.id, settled)
      void settled.then(() => {
        if (checkCreates.get(firing.id) === settled) checkCreates.delete(firing.id)
      })
      return next
    },

    asanaPreview,
    checkFailed,
    automationNote,
    automationStart,
    importAsana: (input, caller) => importAsana(input, caller),
    asanaIntake,

    async setUpFactory(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory || store.listTasks().some((t) => t.factoryId === factoryId && t.setup)) {
        return undefined
      }
      return makeSetupTask(factory, false)
    },

    async newSetupTask(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, 'no such Factory')
      const open = openSetupTask(factoryId)
      if (open) {
        throw new RequestError(409, `${open.displayId} is already setting up ${factory.name}`)
      }
      return makeSetupTask(factory, true)
    },

    async defaults(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, `no Factory ${factoryId}`)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      const depth = resolution.workflow.settings.stages.clarify?.depth
      const choices = resolveAgentChoices(
        resolution.workflow.settings,
        {
          claude: agents.installed('claude'),
          antigravity: agents.installed('antigravity'),
          codex: agents.installed('codex'),
        },
        store.settings().enabledAgents,
      )
      return {
        lead: { ...choices.lead, effortMode: 'stage' },
        planner: choices.planner,
        clarifyDepth: clarifyDepths.find((d) => d === depth) ?? 'auto',
      }
    },

    async board(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, `no Factory ${factoryId}`)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      return { stages: boardStages(resolution.workflow, store.settings().overnightMode) }
    },

    start,
    stop: stopByHand,
    resume: resumeByHand,
    stoppingForQuit,
    tedStops: () => store.tedStops(),
    answerTedStops,

    moveToBacklog(ref) {
      const task = find(ref)
      if (task.leadRunId !== undefined || task.repos.length > 0 || holds.has(task.id)) {
        throw new RequestError(
          409,
          `${task.displayId} has had a Run, so it can’t go back to Backlog`,
        )
      }
      if (!store.queue().some((q) => q.id === task.id)) {
        throw new RequestError(409, `${task.displayId} isn’t queued`)
      }
      return store.moveToBacklog(task.id)
    },

    move(ref, { after, before }) {
      const task = live(ref)
      if (after === undefined && before === undefined) {
        throw new RequestError(400, 'a move needs a Task to go after or before')
      }
      const neighbour = (other: string | undefined) => {
        if (other === undefined) return undefined
        const found = find(other)
        if (found.id === task.id) throw new RequestError(400, 'a Task can’t move next to itself')
        return found
      }
      const below = neighbour(after)
      const above = neighbour(before)
      const placed = placeBetween(task.priority, {
        ...(below && { after: below }),
        ...(above && { before: above }),
      })
      return store.rankTask(task.id, placed.rank, placed.priority)
    },

    setTaskSnooze(ref, until) {
      const task = live(ref)
      if (task.stage !== 'backlog' || task.archived || task.setup || starting.has(task.id)) {
        throw new RequestError(409, 'Only an unstarted Backlog Task can be snoozed')
      }
      if (
        until !== null &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until) ||
          !Number.isFinite(Date.parse(until)) ||
          new Date(until).toISOString() !== until ||
          Date.parse(until) <= snoozeNow())
      ) {
        throw new RequestError(400, 'Choose a future date and time')
      }
      autoStartFailures.delete(task.id)
      return store.setTaskSnooze(task.id, until)
    },
    snoozeRequest(requestId, until) {
      if (until !== null && Date.parse(until) <= snoozeNow()) {
        throw new RequestError(400, 'Choose a future date and time')
      }
      const request = store.snoozeRequest(requestId, until)
      if (!request) throw new RequestError(404, 'No open request has that ID')
      refreshSnoozes()
      return request
    },
    setPriority(ref, priority) {
      return store.setPriority(live(ref).id, priority)
    },

    async edit(ref, { title, description }) {
      const task = live(ref)
      const before = store.descriptionVersions(task.id).at(-1)?.text ?? task.description
      const edited = store.editTask(task.id, {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
      })
      const renamed = edited.title !== task.title
      const changed = edited.description !== task.description
      if ((renamed || changed) && liveLead(find(task.id))) {
        await deliver(task, editMessage(task, edited, before, renamed, changed))
      }
      return edited
    },

    descriptions(ref) {
      return store.descriptionVersions(find(ref).id)
    },

    allowLinearSync(ref) {
      const task = live(ref)
      const link = task.source && parseLinearUrl(task.source.url)
      if (!link) throw new RequestError(400, `${task.displayId} doesn’t come from a Linear issue`)
      linearConsent.allowTask(task)
      return publicTask(task.id)
    },

    async allowAsanaSync(ref) {
      const task = live(ref)
      const link = task.source && parseAsanaTaskUrl(task.source.url)
      if (!link || !task.source?.asana)
        throw new RequestError(400, `${task.displayId} wasn’t imported from Asana`)
      const account = await asanaSync?.refresh()
      if (account === undefined)
        throw new RequestError(409, 'Connect Asana in Settings → Integrations first.')
      if (!asanaSyncAllowable(store.getTask(task.id)?.asanaSync)) return publicTask(task.id)
      store.trackerSyncAllowed(task.id, asanaTracker, link.gid, account)
      return publicTask(task.id)
    },

    asanaStatusSeen(status) {
      if (asanaSync)
        store.setAsanaConnection(status.state === 'connected' ? status.user?.gid : undefined)
    },

    allowLinearTeam(factoryId, team) {
      if (!store.getFactory(factoryId)) throw new RequestError(404, `no Factory ${factoryId}`)
      return linearConsent.allowGroup(factoryId, team.toUpperCase())
    },

    async asanaProjects() {
      const asana = options.asana
      if (!asana || !asanaSync || (await asanaSync.refresh()) === undefined)
        throw new RequestError(409, 'Connect Asana in Settings → Integrations first.')
      return listAsanaProjects(retryingRead(asana.read))
    },

    async allowAsanaProject(factoryId, project) {
      if (!store.getFactory(factoryId)) throw new RequestError(404, `no Factory ${factoryId}`)
      const asana = options.asana
      if (!asana || !asanaSync || (await asanaSync.refresh()) === undefined)
        throw new RequestError(409, 'Connect Asana in Settings → Integrations first.')
      await confirmAsanaProject(retryingRead(asana.read), project)
      if (!store.getFactory(factoryId) || removingFactories.has(factoryId))
        throw new RequestError(404, `no Factory ${factoryId}`)
      return asanaSync.consent.allowGroup(factoryId, project)
    },

    async forgetAsanaProject(factoryId, project, list) {
      if (!store.getFactory(factoryId)) throw new RequestError(404, `no Factory ${factoryId}`)
      if (!asanaSync) throw new RequestError(409, 'Asana isn’t set up on this computer')
      if (list === 'allowed') await asanaSync.refresh().catch(() => undefined)
      return asanaSync.consent.forgetGroup(factoryId, project, list)
    },

    hierarchy,
    hierarchyPreview,
    setParent,
    archive: archiveHierarchy,
    requestArchive,

    unarchive,
    delete: remove,
    reset,
    removeFactoryTasks,

    archiveDone(key) {
      const factory = store.listFactories().find((f) => f.key === key || f.id === key)
      if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
      const done = store
        .listTasks()
        .filter(
          (t) =>
            t.factoryId === factory.id &&
            t.stage === 'done' &&
            !t.archived &&
            descendants(t.id).every((id) => find(id).archived),
        )
      for (const task of done) archiveNow(find(task.id), false)
      if (done.length > 0) wake()
      return { archived: done.length }
    },

    async followUp(ref, { comment = '', attachments = [] }) {
      const original = find(ref)
      if (original.archived) {
        throw new RequestError(409, `${original.displayId} is archived; unarchive it to follow up`)
      }
      if (original.stage !== 'done') {
        throw new RequestError(
          409,
          `${original.displayId} isn’t Done; only a Done Task can be followed up`,
        )
      }
      const text = comment.trim()
      const lead =
        original.lead ??
        leadFrom((await taskWorkflow(original, { fetch: false })).workflow.settings)
      const task = await store.createTask({
        ...followUpText(undefined, text, original.displayId),
        priority: original.priority,
        lead,
        factoryId: original.factoryId,
        ...(original.source && { source: original.source }),
        followUpOf: original.id,
        ...(attachments.length > 0 && { attachments }),
        linearConsent: true,
      })
      const carried = drafts(original.id)
      if (carried.length > 0) {
        store.postComment({
          taskId: task.id,
          body: '',
          author: { kind: 'human' },
          lineComments: carried,
        })
      }
      return start(task.id)
    },

    async block(ref, caller, by) {
      const task =
        caller.kind === 'run' ? taskLead(ref, caller, 'changes blockers').task : find(ref)
      await beginning.get(task.id)?.catch(() => undefined)
      const blocker = find(by)
      if (blocker.id === task.id) {
        throw new RequestError(409, `${task.displayId} can’t block itself`)
      }
      if (task.stage === 'done') throw new RequestError(409, `${task.displayId} is done`)
      const cycle = cycleFrom(blocker.id, task.id)
      if (cycle) {
        const ids = [task.id, ...cycle].map((id) => store.getTask(id)?.displayId ?? id)
        throw new RequestError(
          409,
          `${blocker.displayId} can’t block ${task.displayId}: that makes a cycle, ${ids.join(' → ')}`,
        )
      }
      const current = find(task.id)
      const runId = caller.kind === 'run' ? caller.runId : undefined
      const existing = store
        .blockers(task.id)
        .find((b) => b.kind === undefined && b.blockerId === blocker.id)
      if (existing && (runId === undefined || existing.setByRunId === runId)) {
        return publicTask(task.id)
      }
      const unmerged = !store.isMerged(blocker.id)
      const queued = store.queue().some((q) => q.id === task.id)
      const midFlow = current.repos.some((r) => !r.removed)
      const then = !unmerged || !queued ? undefined : midFlow ? 'wait' : 'backlog'
      const updated = store.addBlocker(task.id, blocker.id, {
        ...(runId !== undefined && { runId }),
        ...(then !== undefined && { then }),
      })
      const run = liveLead(current)
      if (unmerged && run && caller.kind !== 'run' && !existing) await tellLead(blocker, run)
      return updated
    },

    unblock(ref, caller, by) {
      const task =
        caller.kind === 'run' ? taskLead(ref, caller, 'changes blockers').task : find(ref)
      const links = store.blockers(task.id).filter((link) => link.kind === undefined)
      const deleted = links.find(
        (l) => l.ended === 'deleted' && (l.blockerId === by || l.displayId === by),
      )
      const blocker = by === undefined || deleted ? undefined : find(by)
      if (blocker && !links.some((l) => l.blockerId === blocker.id)) {
        throw new RequestError(404, `${task.displayId} isn’t blocked by ${blocker.displayId}`)
      }
      removeBlockers(task.id, caller, deleted?.blockerId ?? blocker?.id)
      return publicTask(task.id)
    },

    slots,
    publishedSlots: () => publishedSlots,
    mergesInFlight: () => mergeWatcher.inFlightCount(),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async uploadForCreate(caller, save) {
      if (caller.kind !== 'run') return save()
      automationCaller(caller)
      const saved = await save()
      automationUploads.add(`${caller.runId}:${saved.hash}`)
      return saved
    },

    async upload(ref, caller, save) {
      if (caller.kind !== 'run') return save()
      const { task } = ownTask(ref, caller)
      const saved = await save()
      runUploads.add(`${task.id}:${saved.hash}`)
      return saved
    },

    async comment(
      ref,
      caller,
      {
        body,
        choices = [],
        round,
        proposal,
        sizeCheck,
        supersedes,
        attachments = [],
        tutorial = false,
      },
    ) {
      if (caller.kind !== 'run') {
        if (choices.length > 0) throw new RequestError(400, 'only a Run can ask a question')
        if (round !== undefined) throw new RequestError(403, 'only the Task Lead posts a round')
        if (proposal !== undefined) {
          throw new RequestError(403, 'only the Task Lead proposes a split')
        }
        if (sizeCheck !== undefined) {
          throw new RequestError(403, 'only the Task Lead asks the size check')
        }
        if (supersedes !== undefined) {
          throw new RequestError(403, 'only a Run can supersede a request')
        }
        const task = find(ref)
        requireCommentable(task)
        return humanComment(task, body, attachments)
      }
      const { task, runId } = ownTask(ref, caller)
      checkOwnFiles(task, attachments)
      if (tutorial) {
        if (!task.setup || task.leadRunId !== runId) {
          throw new RequestError(403, 'only a setup Task’s Task Lead posts tutorial Comments')
        }
        if (choices.length > 0 || round !== undefined || supersedes !== undefined) {
          throw new RequestError(400, 'a tutorial Comment is a plain note')
        }
        return store.postComment({
          taskId: task.id,
          body,
          author: { kind: 'run', runId },
          attachments,
          tutorial: true,
        })
      }
      if (task.leadRunId !== runId) {
        if (
          choices.length > 0 ||
          round !== undefined ||
          proposal !== undefined ||
          sizeCheck !== undefined ||
          supersedes !== undefined
        ) {
          throw new RequestError(
            403,
            'a sub-agent can post only plain notes; tell the Task Lead what to ask in your final message',
          )
        }
      }
      if (round !== undefined) return postRound(task, runId, round, supersedes)
      if (proposal !== undefined) return postProposal(task, runId, proposal, supersedes)
      if (sizeCheck !== undefined) return postSizeCheck(task, runId, sizeCheck, supersedes)
      if (supersedes === undefined) {
        return store.postComment({
          taskId: task.id,
          body,
          author: { kind: 'run', runId },
          ...(choices.length > 0 && { kind: 'question', choices }),
          attachments,
        })
      }
      const old = store.getComment(supersedes)
      if (!old || old.taskId !== task.id) {
        throw new RequestError(404, `no request ${supersedes} on ${task.displayId}`)
      }
      if (old.kind === 'note') throw new RequestError(400, 'a note isn’t a request')
      if (old.kind === 'round') throw new RequestError(400, 'replace a round with another round')
      if (old.kind === 'proposal') {
        throw new RequestError(400, 'replace a proposal with `ted task propose --supersedes`')
      }
      if (old.sizeCheck) {
        throw new RequestError(400, 'replace a size check with `ted clarify too-big --supersedes`')
      }
      if (old.gate) throw new RequestError(409, 'a sign-off request can’t be superseded')
      if (old.archive) throw new RequestError(409, 'an archive request can’t be superseded')
      if (!postedBy(old, task, runId)) {
        throw new RequestError(403, 'a Run can supersede only its own requests')
      }
      return holding(task, async () => {
        if (store.getComment(old.id)?.answer) {
          throw new RequestError(409, 'that request has already been answered')
        }
        return store.supersedeComment(old.id, {
          taskId: task.id,
          kind: old.kind,
          body,
          author: { kind: 'run', runId },
          ...(choices.length > 0 && { choices }),
        })
      })
    },

    async setTaskAutopilot(ref, caller, request) {
      if (caller.kind !== 'app')
        throw new RequestError(403, 'only the TED app can change Autopilot')
      const id = find(ref).id
      await untilFree(id)
      const task = await holding(find(id), async () => {
        const current = find(id)
        if (current.archived || current.stage === 'done')
          throw new RequestError(409, 'This Task has finished')
        return store.setTaskAutopilot(id, request.choice)
      })
      await processAutopilot(id)
      return publicTask(task.id)
    },

    async answerAutopilot(ref, id, caller, request) {
      const { task, runId } = taskLead(ref, caller, 'answers an Autopilot question')
      const comment = store.getComment(id)
      if (
        !comment ||
        comment.taskId !== task.id ||
        comment.kind !== 'question' ||
        comment.archive !== undefined ||
        !ordinaryAutopilotRequest(comment) ||
        request.action !== 'answer'
      )
        throw new RequestError(403, 'only an ordinary question on this Task may be answered')
      await guardAutopilotAnswer(comment)
      const text = redactSecrets(request.text?.trim() ?? '')
      if (!text || text.length > 10000)
        throw new RequestError(400, 'give a decision and explanation of at most 10000 characters')
      return answerAs(id, { ...request, text }, false, undefined, true, runId)
    },

    async taskGates(ref) {
      return gatesFor(find(ref).id)
    },

    async setTaskGates(ref, caller, request) {
      if (caller.kind !== 'app')
        throw new RequestError(403, 'only the TED app can change Task sign-offs')
      const id = find(ref).id
      await untilFree(id)
      return holding(find(id), async () => {
        const before = await gatesFor(id)
        if (before.revision !== request.revision) {
          throw new RequestError(
            409,
            'Task sign-offs changed while you were editing. Reopen the editor and try again.',
          )
        }
        const keys = new Set([...Object.keys(before.overrides), ...Object.keys(request.overrides)])
        for (const key of keys) {
          const stage = key as AgentStageId
          if (before.overrides[stage] === request.overrides[stage]) continue
          const row = before.rows.find((row) => row.stage === stage)
          if (!row || row.locked)
            throw new RequestError(
              409,
              `${stageTitle(stage)}: ${row?.locked ?? 'Stage is not in this Workflow'}`,
            )
        }
        if (find(id).archived || find(id).stage === 'done')
          throw new RequestError(409, 'This Task has finished')
        const overrides: TaskGateOverrides = {}
        for (const stage of agentStageIds)
          if (request.overrides[stage] !== undefined) overrides[stage] = request.overrides[stage]
        store.setTaskGates(id, overrides)
        return gatesFor(id)
      })
    },

    async setClarifyDepth(ref, caller, { depth, why }) {
      if (caller.kind !== 'run') {
        const task = find(ref)
        if (task.archived || task.stage === 'done') {
          throw new RequestError(409, `${task.displayId} has finished; its Clarify depth is fixed`)
        }
        if (clarifyIsOver(task.stage)) {
          throw new RequestError(
            409,
            `Clarify is over for ${task.displayId}, so changing its Clarify depth would do nothing`,
          )
        }
        const set = store.setClarifyDepth(task.id, { depth, by: 'human' })
        if (liveLead(find(task.id))) {
          await deliver(
            task,
            depth === 'auto'
              ? 'The human set Clarify depth back to Auto. Pick one yourself at Clarify.'
              : `The human set Clarify depth to ${depthNames[depth]}. Use it at Clarify instead of picking one.`,
          )
        }
        return set
      }
      const { task, runId } = taskLead(ref, caller, 'picks the Clarify depth')
      if (task.stage !== 'clarify') {
        throw new RequestError(
          409,
          `pick the Clarify depth at Clarify; ${task.displayId} is in ${stageTitle(task.stage)}`,
        )
      }
      if (depth === 'auto') throw new RequestError(400, 'pick none, few or grilling')
      const floor = humanDepth(task.id)
      if (floor !== undefined && depthOrder.indexOf(depth) < depthOrder.indexOf(floor)) {
        throw new RequestError(
          403,
          `the human set the Clarify depth to ${depthNames[floor]}; you can only raise it`,
        )
      }
      return store.setClarifyDepth(task.id, {
        depth,
        by: 'task-lead',
        runId,
        ...(why !== undefined && { why }),
      })
    },

    markRead(ref) {
      const task = find(ref)
      const unread = store
        .listComments(task.id)
        .filter((c) => c.author.kind !== 'human' && c.readAt === undefined && !c.held)
      store.commentsRead(unread.map((c) => c.id))
      return unread.length
    },

    threadEvents(ref) {
      const task = find(ref)
      return taskThreadEvents(store, task.id, {
        comments: store.listComments(task.id),
        displayIdOf: (id) => store.getTask(id)?.displayId ?? id,
        waitingFor: unmergedBlockers(task.id).map((b) => b.displayId),
        descriptions: store.descriptionVersions(task.id),
        planTitleOf: (planId) => store.plans.get(planId)?.title,
      })
    },

    writeBrief(ref, caller, text) {
      const { task, runId } = taskLead(ref, caller, 'writes the Task brief')
      if (!hasBriefHeadings(text)) {
        throw new RequestError(
          400,
          `the Task brief needs these headings, in order: ${briefHeadings.join(', ')}`,
        )
      }
      const cases = store.failures.list(task.id).filter((f) => f.validation)
      if (cases.length) {
        const details = cases
          .map((value) => {
            const decision = value.resolutions.at(-1)
            const accepted =
              decision?.resolution === 'accepted' &&
              !value.invalidations.some((i) => i.requestId === decision.requestId)
            return `${failureCaseFindings(value)}\n\nDecision: ${accepted ? 'failed, accepted by you' : (decision?.resolution ?? 'unresolved')}${decision?.reason ? ` · ${decision.reason}` : ''}${value.verifications?.length ? `\nLater verification: ${value.verifications.at(-1)?.evidence}` : ''}`
          })
          .join('\n\n')
        text = text.replace(
          '## Current state',
          `## Current state\n\nValidation failure history:\n\n${details}`,
        )
      }
      return store.writeBrief({ taskId: task.id, text, runId })
    },

    brief(ref, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      const brief = store.latestBrief(task.id)
      if (!brief) throw new RequestError(404, `${task.displayId} has no Task brief yet`)
      return brief
    },

    peers,

    inbox() {
      const requests = store.listOpenRequests()
      return waitingItems(requests, store.tasksIn(new Set(requests.map((r) => r.taskId))))
    },

    answered() {
      const now = new Date()
      const requests = store.listAnsweredRequests(answeredSince(now), byHuman)
      return answeredItems(requests, store.tasksIn(new Set(requests.map((r) => r.taskId))), now)
    },

    talkThrough: (id, request) => talkThrough(id, request),
    doneTalking: (id) => doneTalking(id),
    closeRound: (ref, caller, summary) => closeRound(ref, caller, summary),

    isFailureDecision: (id) => failures.findDecision(id) !== undefined,
    answer: (id, request) => answerAs(id, request, true),

    coordinatorAnswer: (id, request, mark) => answerAs(id, request, false, mark),

    coordinatorResume: (ref, comment) =>
      resumeByHand(ref, { ...(comment !== undefined && { comment }), sendDrafts: false }),

    coordinatorCreate(factoryId, input, operation) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, 'no such Factory')
      return this.create(
        { ...input, factory: factory.key, coordinatorOperation: operation },
        { kind: 'file' },
      )
    },

    async coordinatorTell(ref, body) {
      const task = find(ref)
      requireCommentable(task)
      return humanComment(task, body, [], false)
    },

    setActivity(ref, caller, text) {
      const { task, runId } = ownTask(ref, caller)
      return store.setActivity(task.id, text, runId)
    },

    async reportOutcome(ref, caller, outcome) {
      const report = async (): Promise<OutcomeResult> => {
        const asked = taskLead(ref, caller, 'reports outcomes').task
        await untilFree(asked.id)
        const { task, runId } = taskLead(ref, caller, 'reports outcomes')
        if (task.stage !== asked.stage) {
          throw new RequestError(
            409,
            `${task.displayId} changed Stage while this outcome waited; read the Task again before reporting`,
          )
        }
        if (task.stage === 'backlog' || task.stage === 'done') {
          throw new RequestError(409, `${task.displayId} isn’t in a Stage that has an outcome`)
        }
        if (checking.has(task.id)) {
          throw new RequestError(
            409,
            `TED is running ${task.displayId}’s Checks; wait for their results before reporting an outcome`,
          )
        }
        if (outcome.outcome !== 'ask') {
          if (outcome.judged !== undefined && task.stage !== 'validate') {
            throw new RequestError(400, 'only Validate reports the review and visual results')
          }
          if (
            outcome.outcome === 'back' &&
            outcome.severity !== undefined &&
            task.stage !== 'validate'
          ) {
            throw new RequestError(400, 'only Validate declares a Finding’s severity')
          }
          if (outcome.outcome === 'advance' && outcome.design) {
            if (task.stage !== 'design') {
              throw new RequestError(400, 'only Design posts a design review')
            }
            checkOwnFiles(task, designFiles(outcome.design))
            if (outcome.design.setup && !task.setup) {
              throw new RequestError(400, 'only a setup Task proposes TED settings')
            }
          }
          if (
            task.setup &&
            task.stage === 'design' &&
            outcome.outcome === 'advance' &&
            outcome.skip !== true &&
            !outcome.design?.setup
          ) {
            throw new RequestError(
              400,
              'a setup Task posts its proposal with `ted outcome advance --design <file>` and a setup section; see the setup instructions for Design',
            )
          }
          if (pendingLoopCheck(task.id)) {
            throw new RequestError(
              409,
              'TED is checking whether Validate’s rounds are converging; wait for its verdict before reporting an outcome',
            )
          }
          const asked = openSendBackAsk(task)
          if (asked) {
            throw new RequestError(
              409,
              handOffAsks(task.id).some((c) => c.id === asked.id)
                ? `TED asked the human about ${task.displayId}’s failing Checks (request ${asked.id}); wait for their answer before reporting an outcome`
                : `TED asked the human whether to keep sending ${task.displayId} back (request ${asked.id}); wait for their answer before reporting an outcome`,
            )
          }
        }
        return holding(task, async () => {
          const current = find(task.id)
          const stage = current.stage as AgentStageId
          if (outcome.outcome === 'ask') {
            const request = store.postComment({
              taskId: task.id,
              kind: 'question',
              body: outcome.question,
              author: { kind: 'run', runId },
              ...(outcome.choices && outcome.choices.length > 0 && { choices: outcome.choices }),
            })
            return {
              task: publicTask(task.id),
              message: `Asked the human (request ${request.id}). TED sends you their answer.`,
              request,
            }
          }
          if (stage === 'cleanup' && outcome.outcome === 'back')
            throw new RequestError(409, cleanupNoBack)
          const resolution =
            outcome.outcome === 'advance'
              ? await gateWorkflow(current)
              : await taskWorkflow(current)
          const { workflow } = resolution
          if (outcome.outcome === 'advance')
            await requireObligations(current, undefined, workflow.next(stage))
          const changesAsked =
            (stage === 'review' || stage === 'merge') && lastChangesRequested(current) !== ''
          if (outcome.outcome === 'back') {
            if (changesAsked && outcome.to !== 'work' && outcome.to !== 'design') {
              throw new RequestError(
                409,
                `the human asked for changes at the ${stageTitle(stage)} sign-off; send the Task back to Work or Design`,
              )
            }
            const declared =
              outcome.cause === 'base-conflict' &&
              !changesAsked &&
              outcome.to === 'work' &&
              (stage === 'validate' || stage === 'review')
            if (declared) checkBack(workflow, stage, outcome.to)
            const conflict = declared ? await baseConflict(current) : undefined
            let failedCheck: string | undefined
            if (stage === 'validate') {
              const blockers = conflict ? [] : (await failures.obligations(current)).blockers
              for (const value of store.failures
                .list(task.id)
                .filter((f) => f.validation && blockers.includes(f.id))) {
                const assessment = value.assessments.at(-1)
                if (
                  value.resolutions.at(-1)?.resolution !== 'fix' &&
                  (assessment?.assessment !== 'regression' ||
                    assessment.evidenceCount !== value.additions.length)
                )
                  throw new RequestError(
                    409,
                    'substantiate a regression assessment before sending back; unrelated or uncertain failures need the human’s decision',
                  )
                if (
                  value.source.kind === 'factory-check' ||
                  value.source.kind === 'post-rebase-check'
                )
                  failedCheck = value.source.checkRunId
              }
              checkBack(workflow, stage, outcome.to)
              if (
                outcome.judged?.review?.passed === false ||
                outcome.judged?.visual?.passed === false
              )
                failedCheck = undefined
              if (!conflict && (failedCheck === undefined || outcome.severity !== undefined))
                await declareSeverity(current, workflow, runId, outcome.severity)
              judge(current, 'sent-back', outcome.judged)
            }
            if (conflict) {
              const findings = `${outcome.findings.trim()}\n\n${conflictChecked(conflict, manyRepos(current))}`
              return sendBack(current, resolution, stage, { ...outcome, findings }, undefined, {
                counted: false,
                cause: 'base-conflict',
                conflict: foundConflict(current, conflict),
              })
            }
            const sent = await sendBack(current, resolution, stage, outcome, failedCheck)
            return declared
              ? { ...sent, message: `${sent.message.replace(/\.$/, '')}. ${noConflictFound}` }
              : sent
          }
          if (changesAsked) {
            throw new RequestError(
              409,
              `the human asked for changes at the ${stageTitle(stage)} sign-off; send the Task back to Work or Design with \`ted outcome back --to work|design --findings <file>\``,
            )
          }
          if (stage === 'cleanup') return finishCleanup(current, resolution)
          if (stage === 'merge') {
            const mode = mergeMode(current, workflow)
            throw new RequestError(
              409,
              mode === 'off'
                ? `Merge is off for this Factory: the human merges ${task.displayId}’s pull requests on GitHub and TED moves it to Done when it sees the merge; there’s no outcome to report at Merge`
                : mode === 'gate'
                  ? `TED posts the Merge sign-off for ${task.displayId} once CI passes, then merges; there’s no outcome to report at Merge`
                  : `TED merges ${task.displayId}’s pull requests and moves it to Done when they’ve merged; there’s no outcome to report at Merge`,
            )
          }
          if (
            stage === 'work' ||
            ((stage === 'validate' || stage === 'review') &&
              workflow.stages.includes('work') &&
              workflow.order.indexOf('work') < workflow.order.indexOf(stage))
          ) {
            const conflict = await baseConflict(current)
            if (conflict) {
              store.recordBaseConflict(task.id, foundConflict(current, conflict))
              throw new RequestError(409, conflictRefusal(current, conflict, manyRepos(current)))
            }
          }
          const moved = stage === 'validate' ? await movedSinceReview(current) : undefined
          if (moved !== undefined) throw new RequestError(409, moved)
          const waiting = stage === 'clarify' ? openRound(current) : undefined
          if (waiting) {
            throw new RequestError(
              409,
              `Round ${waiting.round?.number ?? ''} is still waiting on the human; TED sends you their answers`,
            )
          }
          if (outcome.skip === true) {
            if (!skippableStages.includes(stage)) {
              throw new RequestError(
                409,
                `only Clarify and Design can skip themselves; ${stageTitle(stage)} can’t`,
              )
            }
            if (current.setup) {
              throw new RequestError(409, 'a setup Task always goes through Clarify and Design')
            }
            const since = visitStart(current)
            if (store.listComments(task.id).some((c) => c.gate && c.createdAt >= since)) {
              throw new RequestError(
                409,
                `${stageTitle(stage)} has already posted its sign-off request, so it can’t skip itself`,
              )
            }
            store.postComment({
              taskId: task.id,
              body: `The Task Lead skipped ${stageTitle(stage)}: it had nothing to do.${
                gateOn(current, workflow, stage) ? ' Its sign-off was skipped too.' : ''
              }`,
              author: { kind: 'ted' },
            })
          }
          const gate = gateOn(current, workflow, stage) && outcome.skip !== true
          if (!gate && stage === 'work' && workflow.next(stage) === 'validate') {
            await execution.local(task.id)
            const heads = await liveHeads(current)
            const coverage = await validation.coverage(current)
            const started = await validation.begin(current, resolution, 'hand-off')
            if (started) {
              setChecking(task.id, true)
              inBackground(`run ${task.displayId}’s Checks`, () =>
                handOffChecks(task.id, { started, coverage, heads, lead: runId }),
              )
              return {
                task: publicTask(task.id),
                message: `TED is running the Factory’s Checks before ${task.displayId} leaves Work. If they pass, TED moves it to Validate; if one fails, it stays in Work and TED sends you the output. Wait for TED’s message.`,
              }
            }
          }
          if (!gate) {
            if (
              outcome.skip !== true &&
              workflow.overnightGates?.includes(stage) &&
              !gateSkipped(current)
            ) {
              store.gateSkippedOvernight(task.id, stage)
            }
            if (outcome.design) {
              store.postComment({
                taskId: task.id,
                body: designNote(outcome.design, briefGoal(store.latestBrief(task.id)?.text ?? '')),
                author: { kind: 'run', runId },
                attachments: designFiles(outcome.design),
              })
            }
            const next = workflow.next(stage) as AgentStageId | 'done'
            if (stage === 'validate') {
              judge(current, 'passed', outcome.judged)
              pullRequestWork(task.id, 'again')
            }
            const moved = await move(
              current,
              resolution,
              next,
              next === 'done' ? undefined : nextStageMessage(workflow, next),
            )
            return { task: moved, message: `${task.displayId} moved to ${stageTitle(next)}` }
          }
          const name = stage === 'clarify' ? 'Clarify sign-off' : `${stageTitle(stage)} sign-off`
          if (openGateRequest(current)) {
            throw new RequestError(409, `${task.displayId} is already waiting at the ${name}`)
          }
          const brief = store.latestBrief(task.id)
          const since = latest(visitStart(current), lastChangesRequested(current))
          if (!brief || brief.createdAt < since) {
            throw new RequestError(
              409,
              `write the Task brief with \`ted brief write\` before passing the ${name}`,
            )
          }
          if (stage === 'validate') judge(current, 'passed', outcome.judged)
          const leadsToMerge =
            stage !== 'design' &&
            stage !== 'clarify' &&
            (workflow.next(stage) === 'merge' || workflow.next(stage) === 'done')
          const changes = leadsToMerge
            ? await signOffChanges(current, outcome.changes?.trim())
            : undefined
          const design = outcome.design
          const requestedFor =
            stage === 'review' ? await requestCommit(current, workflow) : undefined
          const kept = workflow.overnightKept
          if (kept?.stages.includes(stage) && !gateKept(current)) {
            store.gateKeptOvernight(task.id, stage, kept.reason)
          }
          const request = store.postComment({
            taskId: task.id,
            kind: stage === 'design' ? 'review' : 'signoff',
            title: design?.title ?? briefGoal(brief.text) ?? name,
            body: brief.text,
            author: { kind: 'run', runId },
            gate: { ...gateButtons(workflow, stage), ...(changes && { changes }) },
            ...(design && { attachments: designFiles(design) }),
            ...(design && hasDesign(storedDesign(design)) && { design: storedDesign(design) }),
          })
          if (requestedFor) {
            store.gateRequestedFor(task.id, request.id, requestedFor.name, requestedFor.commit)
          }
          if (stage === 'validate') pullRequestWork(task.id, 'again')
          if (stage === 'review' || workflow.next(stage) === 'merge') {
            pullRequestWork(task.id, 'ready')
          }
          return {
            task: publicTask(task.id),
            message: `Waiting for the human at the ${name}. TED sends you their answer.`,
            request,
          }
        })
      }
      if (outcome.outcome !== 'advance') return report()
      const id = taskLead(ref, caller, 'reports outcomes').task.id
      return checksFirst(id, report, () => ({
        task: publicTask(id),
        message: `TED is running the Checks on ${find(id).displayId}’s current code before moving it on. It moves the Task when they pass and tells you if one fails. End your turn.`,
      }))
    },

    setLead(ref, lead) {
      const task = store.setTaskLead(find(ref).id, lead)
      inBackground('apply the Task Lead setting', () => applyLead(task.id))
      const held = store.heldRuns().find((h) => h.taskId === task.id)
      if (held && held.agent !== lead.agent) void pump()
      return task
    },

    useDefaultModel,
    restartLead,
    cancelMerge,
    markDone,

    async reportCleanupStep(ref, caller, report) {
      const { task, runId } = taskLead(ref, caller, 'reports Cleanup steps')
      return holding(task, async () => {
        const current = find(task.id)
        if (current.stage !== 'cleanup')
          throw new RequestError(409, `${current.displayId} isn’t in Cleanup`)
        if (openCleanupFailure(current.id))
          throw new RequestError(
            409,
            'TED asked the user what to do about the failed Cleanup steps; wait for their answer',
          )
        const { workflow } = await taskWorkflow(current, { fetch: false })
        const steps = cleanupSteps(workflow)
        const step = steps.find((s) => s.name === report.step)
        if (!step)
          throw new RequestError(
            400,
            `“${report.step}” isn’t one of the Cleanup steps: ${steps.map((s) => `“${s.name}”`).join(', ')}`,
          )
        if (isCommandStep(step)) throw new RequestError(409, cleanupCommandReportRefusal(step.name))
        store.reportCleanupStep(current.id, runId, { ...report, text: redactSecrets(report.text) })
        await store.persisted()
        return store.cleanupReports(current.id)
      })
    },

    async leadDone(ref, caller) {
      const { task } = taskLead(ref, caller, 'marks its Task done')
      await untilFree(task.id)
      taskLead(ref, caller, 'marks its Task done')
      return markDone(task.id, 'lead')
    },

    setRepos,

    repoSetup: (ref, name, caller) => repoSetup(ref, caller, name),

    async setupLog(ref, name) {
      const task = find(ref)
      if (!task.repos.some((r) => r.name === name)) {
        throw new RequestError(404, `${task.displayId} has no worktree for ${name}`)
      }
      return redactSecrets(await readFile(commandLog(task, 'setup', name), 'utf8').catch(() => ''))
    },

    async worktreeAccess(ref, name) {
      const task = find(ref)
      const repo = task.repos.find((r) => r.name === name && !r.removed)
      if (!repo) throw new RequestError(404, `${task.displayId} has no worktree for ${name}`)
      let fileScope: WorktreeFileScope
      try {
        fileScope = await worktreeFileScope(worktreesDir, repo.worktree)
      } catch {
        throw new RequestError(
          409,
          `${task.displayId}’s worktree for ${name} isn’t on disk or has a linked folder`,
        )
      }
      const env =
        store.recordedSetup(task.id, repo.name)?.env ??
        repoEntry(await entriesOf(factoryOf(task)), repo)?.env ??
        {}
      return {
        taskId: task.id,
        repo: repo.name,
        worktree: repo.worktree,
        fileScope,
        env: commandEnv(task, env),
      }
    },

    async pullRequestChanges(ref, name) {
      const repo = find(ref).repos.find((r) => r.name === name)
      if (!options.gh) throw new RequestError(503, 'GitHub is unavailable.')
      if (!repo?.pullRequest) throw new RequestError(404, 'This repo has no pull request.')
      const key = `${repo.name}:${repo.pullRequest.url}`
      const current = pullRequestChangeReads.get(key)
      if (current) return current
      const reading = readPullRequestChanges(options.gh, repo).finally(() =>
        pullRequestChangeReads.delete(key),
      )
      pullRequestChangeReads.set(key, reading)
      return reading
    },

    async changes(ref) {
      const task = find(ref)
      return taskChanges(task.id, await pullRequestTargets(task))
    },

    async files(ref) {
      const task = find(ref)
      const repos = []
      for (const repo of task.repos.filter((r) => !r.removed)) {
        try {
          const { worktree, fileScope } = await this.worktreeAccess(ref, repo.name)
          repos.push(await listTaskFiles(worktree, fileScope, repo.name))
        } catch {
          repos.push({
            repo: repo.name,
            paths: [],
            partial: false,
            unavailable: 'Worktree files are unavailable. Refresh to try again.',
          })
        }
      }
      return { taskId: task.id, repos }
    },

    async file(ref, name, relative) {
      const { fileScope } = await this.worktreeAccess(ref, name)
      return readTaskFile(fileScope, relative)
    },

    async commits(ref, ids) {
      return taskCommits(
        find(ref).repos.filter((r) => !r.removed),
        ids,
      )
    },

    async commitChanges(ref, id) {
      const task = find(ref)
      const changes = await commitChanges(
        task.repos.filter((r) => !r.removed),
        id,
      )
      if (!changes) throw new RequestError(404, `${task.displayId}’s repos have no such commit`)
      return changes
    },

    async fileDiffs(ref, name, file) {
      const task = find(ref)
      const target = (await pullRequestTargets(task)).find((t) => t.name === name)
      if (!target) throw new RequestError(404, `${task.displayId} has no worktree for ${name}`)
      return fileDiffs(target, file)
    },

    async lineComments(ref) {
      const task = find(ref)
      const all = store.taskLineComments(task.id)
      if (all.length === 0) return []
      return markOutdated(all, await pullRequestTargets(task))
    },

    async draftLineComment(ref, { repo, path: file, from, to, body }) {
      const task = find(ref)
      if (task.archived) {
        throw new RequestError(409, `${task.displayId} is archived; unarchive it to comment`)
      }
      const target = (await pullRequestTargets(task)).find((t) => t.name === repo)
      if (!target) throw new RequestError(404, `${task.displayId} has no worktree for ${repo}`)
      const diff = (await fileDiffs(target, file))[0]
      if (!diff || diff.binary) throw new RequestError(409, `${file} has no lines to comment on`)
      const anchored = anchorIn(diff, from, to)
      return store.draftLineComment({
        taskId: task.id,
        repo,
        path: diff.path,
        commit: diff.head,
        ...anchored,
        body,
      })
    },

    editLineComment(id, body) {
      return store.editLineComment(draftOf(id).id, body)
    },

    deleteLineComment(id) {
      const draft = draftOf(id)
      store.deleteLineComments(draft.taskId, [draft.id])
    },

    discardLineComments(ref) {
      const task = find(ref)
      store.deleteLineComments(task.id, drafts(task.id))
    },

    async sendLineComments(ref) {
      const task = find(ref)
      if (drafts(task.id).length === 0) {
        throw new RequestError(409, `${task.displayId} has no line comments to send`)
      }
      if (task.archived) {
        throw new RequestError(409, `${task.displayId} is archived; unarchive it to comment`)
      }
      if (task.stage === 'done') {
        throw new RequestError(
          409,
          `${task.displayId} is done; its line comments go with a Follow up`,
        )
      }
      if (publicTask(task.id).commentBox === 'merge-pending') {
        throw new RequestError(
          409,
          `TED is merging ${task.displayId}’s pull requests. Sending a Comment now cancels the merge and counts as Request changes; use Send and cancel merge.`,
        )
      }
      return humanComment(task, '', [])
    },

    async runChecks(ref, caller, only) {
      const { task } = taskLead(ref, caller, 'runs Checks')
      if (advancing.has(task.id))
        throw new RequestError(
          409,
          `${task.displayId} is already moving; try Checks again when it finishes`,
        )
      if (task.stage === 'backlog' || task.stage === 'done' || task.repos.every((r) => r.removed)) {
        throw new RequestError(409, `${task.displayId} has no worktree to run Checks in`)
      }
      if (checking.has(task.id)) {
        throw new RequestError(409, `TED is already running ${task.displayId}’s Checks`)
      }
      setChecking(task.id, true)
      try {
        const resolution = await gateWorkflow(find(task.id), { fetch: false })
        const problem = runsInBypass(resolution) ? undefined : await sandboxProblem(task.factoryId)
        if (problem !== undefined) throw new RequestError(409, problem)
        const listed = task.setup
          ? await approvedSetupChecks(task)
          : (resolution.workflow.settings.stages.validate?.checks ?? [])
        if (
          only !== undefined &&
          only !== tedSettingsCheck &&
          !listed.some((c) => c.name === only)
        ) {
          const names = listed.map((c) => c.name).join(', ')
          throw new RequestError(
            404,
            listed.length === 0
              ? 'this Factory has no Checks'
              : `no Check named “${only}”; this Factory’s Checks are ${names}`,
          )
        }
        const started = await validation.begin(find(task.id), resolution, 'agent', only)
        if (!started) {
          throw new RequestError(
            409,
            only === undefined ? 'this Factory has no Checks' : `no Check named “${only}” applies`,
          )
        }
        inBackground(`run ${task.displayId}’s Checks`, () =>
          started.done
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => setChecking(task.id, false)),
        )
        return started.checkRun
      } catch (error) {
        setChecking(task.id, false)
        throw error
      }
    },

    async checkRun(id, caller) {
      const checkRun = store.getCheckRun(id)
      if (!checkRun) throw new RequestError(404, `no Check run ${id}`)
      if (caller.kind === 'run') ownTask(checkRun.taskId, caller)
      return {
        checkRun,
        ...(checkRun.finishedAt !== undefined && { report: await report(checkRun) }),
      }
    },

    async checkOutput(id, position) {
      const checkRun = store.getCheckRun(id)
      const check = checkRun?.checks[position]
      if (!checkRun || !check) throw new RequestError(404, `no Check ${position} in run ${id}`)
      const log = checkLog(find(checkRun.taskId), id, position)
      return { text: await readOutput(log), log }
    },

    wake(factoryId) {
      if (closed) return
      continuationFailures.clear()
      if (factoryId !== undefined) caps.delete(factoryId)
      void pump()
      const live = new Set(store.liveRuns().flatMap((run) => run.taskId ?? []))
      for (const { id } of store.taskOutlines()) {
        if (live.has(id)) {
          applyLead(id).catch((error: unknown) =>
            console.error(
              `couldn’t apply ${store.getTask(id)?.displayId ?? id}’s Task Lead:`,
              error,
            ),
          )
        }
      }
    },

    startSubAgent: (ref, caller, input) => subAgents.request(ref, caller, input),
    waitForSubAgent: (runId, caller, timeoutMs) => subAgents.wait(runId, caller, timeoutMs),
    sendSubAgent: (runId, caller, text) => subAgents.send(runId, caller, text),
    stopSubAgent: (runId, caller) => subAgents.stop(runId, caller),
    addQueueSource(source) {
      sources.push(source)
      void pump()
      return () => void pump()
    },
    planApproved,
    stopLeadForChildren,
    planEnded,

    async close() {
      closed = true
      browser.close()
      browserApps.clear()
      runBrowsers.closeAll()
      subAgents.close()
      heldRequests.close()
      leadLifecycle.close()
      snoozeTimer?.cancel()
      releaseSnoozeIdle?.()
      stopLoadTimer()
      for (const timer of nudgeTimers.values()) timer.cancel()
      nudgeTimers.clear()
      unsubscribe()
      stopPumping()
      watch?.close()
      linearSync?.close()
      asanaSync?.close()
      await pumping
      stopping.abort()
      await Promise.all(background)
      await apps.close()
    },
    async browserApp(ref, caller, app) {
      return (await browserApp(ref, caller, app)).app
    },
    async browserCommand(ref, caller, request) {
      if (runOnlyBrowserActions.includes(request.action))
        throw new RequestError(400, `${request.action} works only in an Automation Run’s browser`)
      const { task, app } = await browserApp(ref, caller, request.app)
      if (store.newWorkHold() !== undefined) throw new RequestError(507, 'New work is on hold')
      const result = await browser.request({
        taskId: task.id,
        app,
        request,
        ...(caller.kind === 'run' && { runId: caller.runId }),
      })
      const current = await browserApp(task.id, caller, app)
      if (current.app.startedAt !== app.startedAt || current.app.url !== app.url) {
        throw new RequestError(409, 'The App changed while the browser command ran')
      }
      browserApps.set(task.id, { name: app.name, repo: app.repo })
      if (result.attachment && caller.kind === 'run')
        runUploads.add(`${task.id}:${result.attachment.hash}`)
      return result
    },
    browserCaptureAccess(ref, caller, hash) {
      const { task } = appCaller(ref, caller)
      const capture = store.browserCaptures(task.id).find((capture) => capture.hash === hash)
      if (!capture) throw new RequestError(404, 'No browser capture on this Task')
      return capture
    },
    async browserPoll(session) {
      const command = await browser.poll(session)
      if (command && !command.canceled) {
        try {
          const current = await browserApp(
            command.taskId,
            command.runId ? { kind: 'run', runId: command.runId } : { kind: 'app' },
            command.app,
          )
          if (
            current.app.startedAt !== command.app.startedAt ||
            current.app.url !== command.app.url
          ) {
            throw new RequestError(409, 'The App restarted')
          }
          browser.command(session, command.id)
        } catch {
          browser.rejectCommand(session, command.id)
          return null
        }
      }
      return command
    },
    browserReply: (session, id, reply) => browser.reply(session, id, reply),
    async browserCapture(session, id, save) {
      const command = browser.command(session, id)
      if (command.request.action !== 'screenshot')
        throw new RequestError(400, 'Not a screenshot command')
      await browserApp(command.taskId, { kind: 'app' }, command.app)
      const attachment = await save()
      try {
        store.recordBrowserCapture(command.taskId, attachment)
        await store.persisted()
        browser.reply(session, id, { result: { attachment } })
        return attachment
      } catch (error) {
        if (!store.filesInUse().has(attachment.hash)) {
          const file = attachmentFile(attachment)
          await removeInside(path.dirname(file), path.basename(file))
        }
        throw error
      }
    },
    listApps(ref, caller) {
      return apps.list(appCaller(ref, caller).task.id)
    },
    startApp(ref, caller, { shutDown, reason, ...app }) {
      const { task, by, runId } = runnableApps(ref, caller)
      return apps.start(task.id, app, by, {
        ...(runId !== undefined && { runId }),
        ...(runId === undefined && shutDown !== undefined && { shutDown }),
        ...(runId !== undefined && reason !== undefined && { reason }),
      })
    },
    async showApp(ref, app) {
      return apps.show(find(ref).id, app)
    },
    async screenshotApp(ref, caller, app) {
      const { task, runId } = runnableApps(ref, caller)
      const { file, app: shown } = await apps.screenshot(task.id, app)
      const attachment = await saveCapture(
        task,
        runId,
        file,
        `${shown.name} screenshot.png`,
        'image/png',
        `Screenshot of ${shown.name}`,
      )
      return { attachment, recording: shown.simulator?.recording === true }
    },
    async recordApp(ref, caller, { action, ...app }) {
      const { task, runId } = runnableApps(ref, caller)
      const { file, app: shown } = await apps.record(task.id, app, action)
      if (file === undefined) return { recording: shown.simulator?.recording === true }
      const attachment = await saveCapture(
        task,
        runId,
        file,
        `${shown.name} recording.mov`,
        'video/quicktime',
        `Recording of ${shown.name}`,
      )
      return { attachment, recording: false }
    },
    simulators: () => apps.simulators(),
    emulators: () => apps.emulators(),
    setRunAppOwner(owner) {
      runAppOwner = owner
      ownerSet(owner)
    },
    async listRunApps(runId, caller) {
      await ownedRun(runId, caller)
      return apps.list(runId)
    },
    async startRunApp(runId, caller, { shutDown: _, reason: __, ...app }) {
      await ownedRun(runId, caller)
      if (caller.kind !== 'run')
        throw new RequestError(403, 'Only the Automation’s Run starts its Apps')
      if (runAppOwner?.live(runId) !== true) throw new RequestError(409, 'This Run has ended')
      return apps.start(runId, app, 'automation', { runId })
    },
    async stopRunApp(runId, caller, app) {
      await ownedRun(runId, caller)
      return apps.stop(runId, app)
    },
    async showRunApp(runId, caller, app) {
      await ownedRun(runId, caller)
      return apps.show(runId, app)
    },
    async runAppLog(runId, caller, app) {
      await ownedRun(runId, caller)
      return apps.log(runId, app)
    },
    stopRunApps(runId) {
      runBrowsers.close(runId)
      return apps.stopTask(runId)
    },
    async runBrowserCommand(runId, caller, request) {
      await ownedRun(runId, caller)
      if (caller.kind !== 'run')
        throw new RequestError(403, 'Only the Automation’s Run uses its browser')
      if (runAppOwner?.live(runId) !== true) throw new RequestError(409, 'This Run has ended')
      if (store.newWorkHold() !== undefined) throw new RequestError(507, 'New work is on hold')
      const selected = request.app ?? runBrowsers.opened(runId)
      if (!selected) throw new RequestError(409, 'Open an App with ted browser open first')
      const matches = (await apps.list(runId)).filter(
        (a) =>
          a.name === selected.name && (selected.repo === undefined || a.repo === selected.repo),
      )
      const shown = matches.length === 1 ? matches[0] : undefined
      if (!shown) throw new RequestError(409, 'Choose a running App this Run started, and its repo')
      const web = shown.kind === 'web' && !!shown.url && isLoopbackUrl(shown.url)
      const desktop =
        shown.kind === 'command' &&
        shown.electron === true &&
        !!shown.port &&
        shown.startedBy !== 'human'
      if (shown.state !== 'running' || shown.removed || !(web || desktop))
        throw new RequestError(
          409,
          'Choose a running web or Electron App this Run started, and its repo',
        )
      const { capture, ...result } = await runBrowsers.command(runId, shown, request)
      if (!capture) return result
      if (!options.saveAttachment) throw new RequestError(503, 'TED can’t save files here')
      const dir = path.join(path.dirname(worktreesDir), 'browsers')
      const file = path.join(dir, `capture-${randomUUID()}.png`)
      await writeFile(file, capture, { mode: 0o600 })
      return { ...result, attachment: await saveRunCapture(runId, file, shown.name) }
    },
    async runDeviceCommand(runId, caller, request) {
      await ownedRun(runId, caller)
      if (caller.kind !== 'run')
        throw new RequestError(403, 'Only the Automation’s Run uses its Apps this way')
      if (runAppOwner?.live(runId) !== true) throw new RequestError(409, 'This Run has ended')
      if (store.newWorkHold() !== undefined) throw new RequestError(507, 'New work is on hold')
      if (request.action !== 'screenshot') return { text: await apps.control(runId, request) }
      if (!options.saveAttachment) throw new RequestError(503, 'TED can’t save files here')
      const { file, app } = await apps.screenshot(runId, request.app)
      const attachment = await saveRunCapture(runId, file, app.name)
      return { text: `Took a screenshot of ${app.name}.`, attachment }
    },
    runBrowserCapture(runId, caller, hash) {
      if (caller.kind === 'run' && caller.runId !== runId)
        throw new RequestError(403, 'A Run can reach only its own browser')
      const capture = store.automations
        .browserCaptures([runId])
        .get(runId)
        ?.find((c) => c.hash === hash)
      if (!capture) throw new RequestError(404, 'No browser capture on this Run')
      return capture
    },
    stopApp(ref, app) {
      browser.cancel(find(ref).id, app)
      return apps.stop(find(ref).id, app)
    },
    restartApp(ref, app) {
      const { task, by } = runnableApps(ref, { kind: 'app' })
      browser.cancel(task.id, app)
      return apps.restart(task.id, app, by)
    },
    appLog(ref, app) {
      return apps.log(find(ref).id, app)
    },
  }
}

const skippableStages: readonly StageId[] = ['clarify', 'design']

const mergeOffMessage =
  'Merge is off for this Factory: the human merges the pull requests on GitHub, and TED moves the Task to Done when it sees the merge. There’s nothing for you to do or report.'

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const idleTitle = 'The Task Lead stopped without saying why'
const nudgeAgainChoice = 'Nudge again'

function isIdleQuestion(comment: Comment): boolean {
  return comment.purpose?.kind === 'idle-run' && comment.answer === undefined
}

const useDefaultChoice = 'Use the default model'
function verdictIn(text: string): LoopVerdict | undefined {
  const found = [...text.matchAll(/verdict:\s*\**\s*(converging|looping)/gi)].at(-1)?.[1]
  return found === undefined ? undefined : (found.toLowerCase() as LoopVerdict)
}

function reasonIn(text: string): string {
  const reason = text
    .split('\n')
    .filter((line) => !/verdict:/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine(redactSecrets(reason === '' ? 'no reason given' : reason), 300)
}

function latest(a: string, b: string): string {
  return a > b ? a : b
}

function designFiles(design: DesignSubmission): Attachment[] {
  const files = [
    ...(design.screenshots ?? []),
    ...(design.video ? [design.video] : []),
    ...(design.prototype ? [design.prototype] : []),
  ]
  return files
    .filter((f, i) => files.findIndex((g) => g.hash === f.hash && g.name === f.name) === i)
    .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))
}

function designNote(design: DesignSubmission, goal: string | undefined): string {
  const title = design.title ?? goal
  return [
    ...(title !== undefined ? [title] : []),
    ...(design.summary !== undefined ? [design.summary] : []),
    ...(design.worthYourEye
      ? [`Worth your eye:\n${design.worthYourEye.map((p) => `- ${p}`).join('\n')}`]
      : []),
    ...(design.figma ? [`Figma: ${design.figma.url}`] : []),
  ].join('\n\n')
}

function hasDesign(design: DesignReview): boolean {
  return Object.keys(design).length > 0
}

function storedDesign({ title: _, ...design }: DesignSubmission): DesignReview {
  const file = ({ hash, name, caption }: DesignSubmissionFile): DesignFile => ({
    hash,
    name,
    ...(caption !== undefined && { caption }),
  })
  return {
    ...(design.summary !== undefined && { summary: design.summary }),
    ...(design.screenshots && { screenshots: design.screenshots.map(file) }),
    ...(design.video && { video: file(design.video) }),
    ...(design.prototype && { prototype: file(design.prototype) }),
    ...(design.figma && { figma: design.figma }),
    ...(design.worthYourEye && { worthYourEye: design.worthYourEye }),
    ...(design.setup && { setup: design.setup }),
  }
}

function gateName(comment: Comment): string {
  if (comment.stage === 'clarify') return 'Clarify sign-off'
  return `${stageTitle(comment.stage ?? '')} sign-off`
}

function gateButtons(workflow: ResolvedWorkflow, stage: StageId): NonNullable<Comment['gate']> {
  if (stage === 'merge') return { approveLabel: 'Merge' }
  if (stage === 'clarify') return { approveLabel: 'Approve', caption: clarifySignoffCaption }
  if (stage !== 'review') return { approveLabel: 'Approve' }
  if (!workflow.stages.includes('merge')) {
    return {
      approveLabel: 'Approve',
      caption: 'Merge is off for this Factory. You’ll merge on GitHub.',
    }
  }
  return { approveLabel: workflow.settings.stages.merge?.gate ? 'Approve' : 'Approve and merge' }
}

const headingLine = /^#{1,6}\s+(.*?)\s*#*\s*$/

function headings(text: string): { title: string; line: number }[] {
  return text.split('\n').flatMap((line, i) => {
    const match = headingLine.exec(line.trim())
    return match?.[1] ? [{ title: match[1].toLowerCase(), line: i }] : []
  })
}

function briefSection(text: string, title: string): string | undefined {
  const lines = text.split('\n')
  const found = headings(text)
  const start = found.find((h) => h.title === title)
  if (!start) return undefined
  const end = found.find((h) => h.line > start.line)?.line ?? lines.length
  return (
    lines
      .slice(start.line + 1, end)
      .join('\n')
      .trim() || undefined
  )
}

function hasBriefHeadings(text: string): boolean {
  let next = 0
  for (const { title } of headings(text)) {
    if (title === briefHeadings[next]?.toLowerCase()) next++
  }
  return next === briefHeadings.length
}

function briefGoal(text: string): string | undefined {
  const lines = text.split('\n')
  const found = headings(text)
  const goal = found.find((h) => h.title === 'goal')
  if (!goal) return undefined
  const end = found.find((h) => h.line > goal.line)?.line ?? lines.length
  return firstLine(lines.slice(goal.line + 1, end).join('\n')) || undefined
}

function editMessage(
  task: Task,
  edited: Task,
  before: string,
  renamed: boolean,
  changed: boolean,
): string {
  const marks = { context: '  ', added: '+ ', removed: '- ' } as const
  const diff = diffTexts('description', before, edited.description)
  return [
    `The human edited this Task’s ${renamed && changed ? 'title and description' : renamed ? 'title' : 'description'}. Work from the new version from now on.`,
    ...(renamed ? [`Title was: ${task.title}\nTitle now: ${edited.title}`] : []),
    ...(changed
      ? [
          'Changes to the description (lines starting “- ” were removed, “+ ” were added):',
          [
            ...diff.lines.map((line) => `${marks[line.kind]}${line.text}`),
            ...(diff.truncated ? ['(longer than shown; read the full description below)'] : []),
          ].join('\n'),
          `The description now reads:\n\n${edited.description}`,
        ]
      : []),
  ].join('\n\n')
}

function humanMessage(body: string): string {
  return `The human posted a Comment in this Task’s Thread. This is a message to you, the Task Lead. Answer questions in the Thread with ted comment; for a status question, give a brief progress update, then continue your work.\n\n${body}`
}

function flat(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}

function answerText(comment: Comment): string | undefined {
  const { answer } = comment
  if (!answer) return undefined
  if (answer.kind === 'approved' && answer.created && comment.proposal) {
    return splitApprovedSummary(answer.created, answer.text)
  }
  if (answer.kind === 'approved')
    return answer.text === undefined ? 'approved' : `approved, adding: ${answer.text}`
  if (answer.kind === 'changes-requested') return `asked for changes: ${answer.text}`
  if (answer.kind === 'answered' && answer.answers) {
    return roundAnswerSummary(comment, answer.answers)
  }
  if (answer.kind === 'answered') {
    return [answer.choice, answer.text].filter((part) => part !== undefined).join(' · ')
  }
  return undefined
}

function followUpText(
  title: string | undefined,
  text: string,
  displayId: string,
): { title: string; description: string } {
  const given = title?.trim()
  if (given) return { title: given, description: text }
  const split = titleFromText(text)
  return split.title ? split : { title: `Follow-up to ${displayId}`, description: text }
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

function joinIds(ids: readonly string[]): string {
  if (ids.length <= 1) return ids[0] ?? ''
  return `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`
}

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function setupFailure(command: string, result: CommandResult, output: string): string {
  const how =
    result.outcome === 'timed-out'
      ? 'it timed out'
      : `it failed${result.exitCode !== undefined ? ` with exit code ${result.exitCode}` : ''}`
  return [
    result.problem === undefined
      ? `# Setup failed\n\nTED ran this worktree’s setup command, \`${command}\`, before starting you, and ${how}. Its output:`
      : `# Setup failed\n\nTED couldn’t run this worktree’s setup command, \`${command}\`, before starting you:`,
    `\`\`\`\n${(result.problem ?? output).trimEnd()}\n\`\`\``,
  ].join('\n\n')
}

function taskSource(url: string, issue: LinearIssue | undefined): TaskSource {
  if (!issue) return { url }
  const { identifier, title, branchName, description } = issue
  return {
    url,
    linear: {
      identifier,
      title,
      ...(branchName !== undefined && { branchName }),
      ...(description !== undefined && { description }),
    },
  }
}

function slug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (words === '') return ''
  if (words.length <= slugLength) return `-${words}`
  const cut = words.slice(0, slugLength + 1)
  const boundary = cut.lastIndexOf('-')
  return `-${boundary > 0 ? cut.slice(0, boundary) : words.slice(0, slugLength)}`
}

function joinAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const setupProblem = 'setup-unfinished'

const firstSetupDescription =
  'Set up TED for this Factory. Read its repos, ask how the human works, try candidate Checks and Apps on the default branch, and propose Factory notes, Stage overrides and `.ted/workflow.yaml` in a design review. Once it’s approved, write the files on this Task’s branch; they merge through Review like any change.'

const laterSetupDescription =
  'Propose changes to this Factory’s TED settings in `.ted/`. Read the repos and the current files, ask how the human works now, try changed Checks and Apps on the default branch, and show each change against the current files as a diff in the design review. Once it’s approved, write the changes on this Task’s branch; they merge through Review like any change.'
