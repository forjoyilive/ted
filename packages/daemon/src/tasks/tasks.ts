import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  AgentKind,
  AgentStageId,
  AnswerRequest,
  AppCapture,
  AppLog,
  AppRef,
  AppStarter,
  ArchiveDoneResult,
  ArchiveTaskRequest,
  AssessFailureRequest,
  Attachment,
  BlockedChoice,
  CheckRun,
  CheckRunReport,
  CheckRunTrigger,
  ClarifyDepth,
  Comment,
  CommentAnswer,
  DaemonEvent,
  DeleteTaskRequest,
  DescriptionVersion,
  DesignFile,
  DesignReview,
  DraftLineCommentRequest,
  EditTaskRequest,
  Effort,
  FactoryBoard,
  FailureCase,
  FailureContext,
  FileDiff,
  GitHubWait,
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
  RecordAppRequest,
  RecordFailureRequest,
  ReportOutcomeRequest,
  RepoSetupReport,
  ResolveFailureRequest,
  RoundInput,
  Run,
  RunSlots,
  SetClarifyDepthRequest,
  SetTaskGatesRequest,
  SetTaskReposRequest,
  SetupProposal,
  SignOffChanges,
  SimulatorSlots,
  SizeCheckInput,
  SlotHolder,
  StageId,
  StartAppRequest,
  StartSubAgentRequest,
  SubAgent,
  SubAgentWait,
  Task,
  TaskApp,
  TaskBrief,
  TaskChanges,
  TaskDefaults,
  TaskGateOverrides,
  TaskGates,
  TaskLead,
  TaskRepo,
  TaskReposResult,
  TaskSource,
  ThreadEvent,
  ValidateJudgments,
  ValidationObligations,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import {
  agentStageIds,
  bannerId,
  briefHeadings,
  clarifyDepths,
  clarifyIsOver,
  failureChoices,
  parseLinearUrl,
  sizeChoices,
} from '@ted/protocol'
import type { AutoModeSignal } from '../agents/agent.ts'
import { diffTexts } from '../agents/diff.ts'
import type { Agents } from '../agents/index.ts'
import { type AppsOptions, type AppTask, createApps, type SimulatorOptions } from '../apps/apps.ts'
import { type AppDeclaration, appDeclarations } from '../apps/declared.ts'
import type { Banners } from '../banners.ts'
import { worktreeCommandEnv } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import { type Gh, GhError } from '../github/gh.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { IdleTimer } from '../idle.ts'
import { linkedFilesRewritten } from '../linear/files.ts'
import type { Linear } from '../linear/linear.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { Steering } from '../runs/steering.ts'
import type { Sandbox, SandboxScope } from '../sandbox.ts'
import type {
  LoopCheck,
  LoopVerdict,
  NewTask,
  NewWorktree,
  RecordedSetup,
  RunFlags,
  StoredFactory,
  StoredTask,
  TedStore,
} from '../store/index.ts'
import { messageOf } from '../text.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import {
  type CheckSettings,
  checkLayer,
  githubRepoOf,
  type WorkflowSettings,
} from '../workflow/check.ts'
import { readGitLayer } from '../workflow/layers.ts'
import {
  boardStages,
  onDefaultBranch,
  type ResolvedWorkflow,
  setupWorkflow,
  withForcedGates,
  withTaskGates,
} from '../workflow/resolve.ts'
import {
  backStageMessage,
  loopCheckInstructions,
  nextStageMessage,
  setupInstructions,
  stageTitle,
  taskLeadPrompt,
} from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'
import { fileDiffs, taskChanges } from './changes.ts'
import {
  type CheckRunnerResult,
  checkEnv,
  failureFindings,
  lastLines,
  planChecks,
  readOutput,
  runChecks,
  summary,
  tedSettingsCheck,
} from './checks.ts'
import { type CommandSandbox, runTaskCommand } from './command.ts'
import {
  ciFailureKey,
  createFailureCases,
  failureNoticeTitle,
  failureText,
} from './failure-cases.ts'
import {
  alreadyFailed,
  asksForFreshRun,
  endingReason,
  failedAsk,
  freshAfterFailure,
  recentFailures,
  retryChoice,
  revivedMessage,
  silentReason,
} from './failures.ts'
import {
  activityMessage,
  checkList,
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
import { answered as answeredItems, waiting as waitingItems } from './inbox.ts'
import { anchorIn, lineCommentsText, markOutdated } from './line-comments.ts'
import { createLinearSync, type LinearClosed, type LinearSyncApi } from './linear-sync.ts'
import {
  chooseMethod,
  ciState,
  defaultHost,
  deleteBranch,
  disableAutoMerge,
  type MergeTarget,
  mergePullRequest,
  nextStep,
  type PullRequestRead,
  type PullRequestRef,
  type RemotePullRequest,
  rebasePullRequest,
  relevantChecks,
  reviewMissing,
} from './merge.ts'
import { placeBetween } from './order.ts'
import { overnightGuidance } from './overnight.ts'
import { createPeers, type Peers } from './peers.ts'
import { approvedShape, createProposalTasks } from './proposal-tasks.ts'
import {
  createPullRequests,
  type PullRequestTarget,
  type PullRequestTask,
} from './pull-requests.ts'
import { type QueueEntry, type QueueSource, queueOrder, type SlotUse, startsNow } from './queue.ts'
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
  clarifySignoffCaption,
  depthNames,
  depthOrder,
  pickDepth,
  roundAnswerMessage,
  roundAnswerSummary,
  roundAnswers,
} from './rounds.ts'
import { clashMessage, sourceClash, sourceKey } from './sources.ts'
import {
  afterPlanningWhy,
  grillAnywayMessage,
  planApprovedLeadMessage,
  planEndedLeadMessage,
  planInChatMessage,
  planOutsideNote,
  proposalChangesMessage,
  sizeCheckTitle,
  splitApprovedMessage,
  splitApprovedSummary,
  splitChosenMessage,
} from './split.ts'
import { createSubAgents, type ReviewerChoice } from './sub-agents.ts'
import { nudgeMessage, threadEvents } from './thread.ts'
import { type CommandResult, copyFiles, outputTail } from './worktree.ts'

export type Caller = { kind: 'app' } | { kind: 'file' } | { kind: 'run'; runId: string }

export interface TaskPlanning {
  fromTask(input: { taskId: string; sizeCheckId: string; text: string }): Promise<{
    id: string
    title: string
  }>
  taskGone(taskId: string, reason: 'archived' | 'deleted'): void
}

export interface PlanApproval {
  planId: string
  planTitle: string
  narrowed: { title: string; description: string; priority: Priority }
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
  > {
  title?: string
  source?: string
  sentryId?: string
  followUp?: string
  factory?: string
  blockedBy?: string[]
  attachments?: Attachment[]
  start?: boolean
}

export interface WorktreeAccess {
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

export interface Tasks {
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
  requestFailureDecision(ref: string, caller: Caller, id: string): Promise<FailureCase>
  resolveFailure(ref: string, id: string, input: ResolveFailureRequest): Promise<FailureCase>
  create(input: CreateTaskInput, caller?: Caller): Promise<Task>
  cancelMerge(ref: string, comment: string, attachments?: Attachment[]): Promise<Comment>
  defaults(factoryId: string): Promise<TaskDefaults>
  setUpFactory(factoryId: string): Promise<Task | undefined>
  newSetupTask(factoryId: string): Promise<Task>
  board(factoryId: string): Promise<FactoryBoard>
  start(ref: string): Promise<Task>
  moveToBacklog(ref: string): Task
  stop(ref: string): Promise<Task>
  resume(ref: string, input?: { comment?: string; attachments?: Attachment[] }): Promise<Task>
  move(ref: string, request: MoveTaskRequest): Task
  setPriority(ref: string, priority: Priority): Task
  edit(ref: string, request: EditTaskRequest): Promise<Task>
  descriptions(ref: string): DescriptionVersion[]
  archive(ref: string, options?: ArchiveTaskRequest): Task
  allowLinearSync(ref: string): Task
  allowLinearTeam(factoryId: string, team: string): MachineSettings
  archiveDone(factory: string): ArchiveDoneResult
  followUp(ref: string, request: { comment?: string; attachments?: Attachment[] }): Promise<Task>
  unarchive(ref: string): Promise<Task>
  delete(ref: string, options: DeleteTaskRequest): Promise<void>
  removeFactoryTasks(factoryId: string, options: { closePullRequests: boolean }): Promise<void>
  block(ref: string, caller: Caller, by: string): Promise<Task>
  unblock(ref: string, caller: Caller, by?: string): Task
  slots(): Promise<RunSlots>
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
  taskGates(ref: string): Promise<TaskGates>
  setTaskGates(ref: string, caller: Caller, request: SetTaskGatesRequest): Promise<TaskGates>
  setClarifyDepth(ref: string, caller: Caller, request: SetClarifyDepthRequest): Promise<Task>
  markRead(ref: string): number
  threadEvents(ref: string): ThreadEvent[]
  setActivity(ref: string, caller: Caller, text: string): Task
  reportOutcome(ref: string, caller: Caller, outcome: OutcomeInput): Promise<OutcomeResult>
  answer(commentId: string, answer: AnswerRequest): Promise<Comment>
  talkThrough(commentId: string): Promise<Comment>
  doneTalking(commentId: string): Promise<Comment>
  closeRound(ref: string, caller: Caller, summary: string): Promise<Comment>
  writeBrief(ref: string, caller: Caller, text: string): TaskBrief
  brief(ref: string, caller: Caller): TaskBrief
  peers: Peers
  inbox(): InboxItem[]
  answered(): InboxItem[]
  setLead(ref: string, lead: TaskLead): Task
  useDefaultModel(ref: string): Promise<Task>
  setupLog(ref: string, repo: string): Promise<string>
  worktreeAccess(ref: string, repo: string): Promise<WorktreeAccess>
  changes(ref: string): Promise<TaskChanges>
  fileDiffs(ref: string, repo: string, path?: string): Promise<FileDiff[]>
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
  listApps(ref: string, caller: Caller): Promise<TaskApp[]>
  startApp(ref: string, caller: Caller, app: StartAppRequest): Promise<TaskApp>
  stopApp(ref: string, app: AppRef): Promise<TaskApp>
  restartApp(ref: string, app: AppRef): Promise<TaskApp>
  appLog(ref: string, app: AppRef): Promise<AppLog>
  showApp(ref: string, app: AppRef): Promise<TaskApp>
  screenshotApp(ref: string, caller: Caller, app: AppRef): Promise<AppCapture>
  recordApp(ref: string, caller: Caller, request: RecordAppRequest): Promise<AppCapture>
  simulators(): SimulatorSlots
  planApproved(taskId: string, input: PlanApproval): Promise<void>
  planEnded(taskId: string, input: PlanEnd): Promise<void>
  close(): Promise<void>
}

const slugLength = 40

function withoutRepeats(files: readonly Attachment[]): Attachment[] {
  const seen = new Map<string, Attachment>()
  for (const { hash, name, size, mediaType } of files) {
    seen.set(`${hash}:${name}`, { hash, name, size, mediaType })
  }
  return [...seen.values()]
}

export function createTasks(options: {
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
  linear?: Pick<Linear, 'issueFor'> & Partial<LinearSyncApi>
  linearSyncMs?: number
  isCloned?: (factoryId: string) => boolean
  idle?: IdleTimer
  gh?: Gh
  env?: () => NodeJS.ProcessEnv
  nudgeAfterMs?: number
  mergePollMs?: number
  ciStuckMs?: { noChecks: number; pending: number }
  stallAfterMs?: number
  appsDir?: string
  apps?: Pick<AppsOptions, 'pollMs' | 'readyTimeoutMs' | 'stopGraceMs' | 'logBytes'>
  simulators?: Omit<SimulatorOptions, 'dir' | 'banners'> & { dir?: string }
  saveAttachment?: (file: string, name: string, mediaType: string) => Promise<Attachment>
  planning?: () => TaskPlanning | undefined
  sandbox: Sandbox
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
  const peers = createPeers(store, (id) => options.steering.syncQueuedFlag(id))
  const starting = new Set<string>()
  const promptComments = new Set<string>()
  const relaunching = new Set<string>()
  const interrupted = new Set<string>()
  const signedOutAt = new Map<string, string>()
  const turnEnding = new Set<string>()
  const readyMidTurn = new Set<string>()
  const advancing = new Set<string>()
  const released = new Map<string, Promise<void>>()
  const humanWaitMs = 15_000
  const applying = new Set<string>()
  const asked = new Map<string, string>()
  const stoppingForBlockers = new Set<string>()
  const runUploads = new Set<string>()
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
  const drafts = (taskId: string): string[] => store.lineCommentDrafts(taskId).map((c) => c.id)
  const stoppingByHand = new Set<string>()
  const nudgeTimers = new Map<string, NodeJS.Timeout>()
  const nudgeAfterMs = options.nudgeAfterMs ?? 60_000
  const stallAfterMs = options.stallAfterMs ?? 30 * 60_000
  const silent = new Map<string, string>()
  const pausedAt = new Map<string, number>()
  const recovering = new Set<string>()
  const overnightSeen = new Map<string, boolean>()
  let overnightChangedAt = new Date().toISOString()
  const awaitingRevive = new Set<string>()
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
  function setChecking(taskId: string, on: boolean): void {
    if (on) checking.add(taskId)
    else checking.delete(taskId)
    store.setTaskChecking(taskId, on)
  }
  const sandboxDir = path.join(path.dirname(worktreesDir), 'sandbox')
  const pullRequests = options.gh && createPullRequests({ store, gh: options.gh })
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
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
    keep(taskId) {
      const task = store.getTask(taskId)
      return task !== undefined && !task.archived && task.stage !== 'done'
    },
    task: appTask,
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

  function sandboxScope(
    task: StoredTask,
    repos: readonly TaskRepo[] = task.repos,
  ): Omit<SandboxScope, 'tmp'> {
    const live = repos.filter((r) => !r.removed)
    return {
      writable: [...new Set(live.map((r) => r.worktree))],
      readable: [...new Set(live.map((r) => clonePath(reposDir, r)))],
      cache: path.join(sandboxDir, task.displayId, 'cache'),
    }
  }

  async function lifecycleSandbox(
    task: StoredTask,
    repos: readonly TaskRepo[] = task.repos,
  ): Promise<CommandSandbox | undefined> {
    if (runsInBypass(await taskWorkflow(task, { fetch: false }))) return undefined
    await sandboxProblem(task.factoryId)
    return {
      sandbox: options.sandbox,
      scope: sandboxScope(task, repos),
      tmpRoot: path.join(sandboxDir, task.displayId),
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
    const bypass = runsInBypass(await taskWorkflow(task, { fetch: false }))
    return {
      displayId: task.displayId,
      factoryId: task.factoryId,
      ...(!bypass && {
        sandbox: sandboxScope(task),
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
  const removingFactories = new Set<string>()
  const merging = new Set<string>()
  const mergeInFlight = new Map<string, Promise<unknown>>()
  const rebaseAsked = new Map<string, { from: string; to: string }>()
  const autoMergeTried = new Set<string>()
  const mergePollMs = options.mergePollMs ?? 30_000
  const ciStuckMs = options.ciStuckMs ?? { noChecks: 10 * 60_000, pending: 60 * 60_000 }
  const watch =
    options.gh &&
    createPullRequestWatch({
      gh: options.gh,
      everyMs: mergePollMs,
      refs: watchedPullRequests,
      onRead: reactToGitHub,
      inBackground: (what, work) => inBackground(what, work),
    })
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
      everyMs: options.linearSyncMs ?? 60_000,
      closed: (taskId, issue) => linearIssueClosed(taskId, issue),
      settled: (taskId, why) => withdrawLinearQuestions(taskId, why),
      inBackground: (what, work) => inBackground(what, work),
    })
  const sources: QueueSource[] = []
  let pumping: Promise<void> | undefined
  let again = false
  let shownSlots = ''
  const autoStartFailures = new Set<string>()
  let backlogVersion = 0

  function hold(taskId: string): () => void {
    holds.set(taskId, (holds.get(taskId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (holds.get(taskId) ?? 1) - 1
      if (left > 0) holds.set(taskId, left)
      else holds.delete(taskId)
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
    options?: { fetch?: boolean; inheritedGates?: boolean },
  ): Promise<WorkflowResolution> {
    const factory = factoryOf(task)
    const resolution = await resolveWorkflow(factory, options)
    const forced = withForcedGates(
      withTaskGates(resolution.workflow, options?.inheritedGates ? {} : task.gateOverrides),
      task.forcedGates,
    )
    const workflow = task.changesSettings ? onDefaultBranch(forced) : forced
    if (!task.setup) return { ...resolution, workflow }
    const instructions = await setupInstructions(factory.showTutorial)
    return { ...resolution, workflow: setupWorkflow(workflow, instructions) }
  }

  async function gatesFor(taskId: string): Promise<TaskGates> {
    const { workflow } = await taskWorkflow(find(taskId), { fetch: false, inheritedGates: true })
    const task = find(taskId)
    const overrides = task.gateOverrides ?? {}
    const position = workflow.order.indexOf(task.stage as AgentStageId)
    const rows = workflow.order
      .filter((stage) => workflow.stages.includes(stage))
      .map((stage) => {
        const required = task.forcedGates.includes(stage)
          ? 'Required by TED for this Task'
          : task.setup && ['clarify', 'design', 'review'].includes(stage)
            ? 'Required for Factory setup'
            : stage === 'clarify' && task.clarifyDepth === 'grilling'
              ? 'Required at grilling depth'
              : undefined
        const posted = store
          .listComments(task.id)
          .some(
            (comment) =>
              comment.gate && comment.stage === stage && comment.createdAt >= visitStart(task),
          )
        const locked =
          task.archived || task.stage === 'done'
            ? 'This Task has finished'
            : (required ??
              (stage === 'merge' && task.stage === 'merge'
                ? 'Merge has started'
                : workflow.order.indexOf(stage) < position
                  ? 'Stage already passed'
                  : stage === task.stage && posted
                    ? 'Sign-off has been requested; answer it in the thread'
                    : undefined))
        const inherited = required !== undefined || workflow.settings.stages[stage]?.gate === true
        return {
          stage,
          inherited,
          effective: required !== undefined || (overrides[stage] ?? inherited),
          required: required !== undefined,
          ...(overrides[stage] !== undefined && { override: overrides[stage] }),
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

  async function slotUse(factoryIds: readonly string[]) {
    const all = store.listTasks()
    const holders = all.flatMap((task) => {
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
    for (const { factoryId, runs } of others) {
      byFactory[factoryId] = (byFactory[factoryId] ?? 0) + runs
    }
    const capsNow: Record<string, number | undefined> = {}
    for (const id of new Set([
      ...factoryIds,
      ...holders.map((h) => h.task.factoryId),
      ...others.map((h) => h.factoryId),
    ])) {
      capsNow[id] = await capOf(id)
    }
    const use: SlotUse = {
      limit: store.settings().maxWorkingRuns,
      working:
        holders.reduce((sum, h) => sum + h.slots, 0) + others.reduce((sum, h) => sum + h.runs, 0),
      byFactory,
      caps: capsNow,
    }
    return { use, holders, others, all }
  }

  const cloned = (factoryId: string) => options.isCloned?.(factoryId) ?? true
  const ready = (): QueueEntry[] =>
    queueOrder<QueueEntry>([
      ...subAgents.queued(),
      ...runnable(store.queue()).filter((q) => q.factoryId === undefined || cloned(q.factoryId)),
      ...sources.flatMap((source) =>
        source
          .queued()
          .filter(
            (q) => source.runnable(q.id) && (q.factoryId === undefined || cloned(q.factoryId)),
          ),
      ),
    ]).filter((q) => q.kind !== 'sub-agent' || subAgentRunnable(q.id))

  function subAgentRunnable(id: string): boolean {
    const request = store.subAgentRequests().find((r) => r.id === id)
    return request !== undefined && store.agentPauses()[request.agent] === undefined
  }

  function heldReady(): QueueEntry[] {
    const paused = store.agentPauses()
    return store.heldRuns().flatMap((held) => {
      const task = store.getTask(held.taskId)
      const agent = task?.lead?.agent ?? held.agent
      if (!task || paused[agent] !== undefined || holds.has(task.id)) return []
      if (task.waitsForBlockers || task.stopped) return []
      return [{ id: task.id, kind: 'task' as const, rank: -1, factoryId: task.factoryId }]
    })
  }

  function revivesReady(): QueueEntry[] {
    const paused = store.agentPauses()
    return [...awaitingRevive].flatMap((taskId) => {
      const pending = pendingRevive(taskId)
      if (!pending) {
        awaitingRevive.delete(taskId)
        return []
      }
      if (paused[pending.run.agent] !== undefined || holds.has(taskId)) return []
      return [{ id: taskId, kind: 'task' as const, rank: -1, factoryId: pending.task.factoryId }]
    })
  }

  function backlogEligible(task: StoredTask, preparing = false): boolean {
    return (
      task.stage === 'backlog' &&
      !task.archived &&
      !task.setup &&
      !task.stopped &&
      !task.statuses.includes('failed') &&
      (preparing || !starting.has(task.id)) &&
      !holds.has(task.id) &&
      !autoStartFailures.has(task.id) &&
      !deleting.has(task.id) &&
      !removingFactories.has(task.factoryId) &&
      cloned(task.factoryId) &&
      (store.settings().overnightMode ||
        store.getFactory(task.factoryId)?.autoStartBacklog === true) &&
      unmergedBlockers(task.id).length === 0
    )
  }

  async function fill(): Promise<void> {
    if (closed || store.newWorkHold() !== undefined) return
    const version = backlogVersion
    const backlog = queueOrder<QueueEntry>(
      store
        .listTasks()
        .flatMap((task) => {
          const stored = store.getTask(task.id)
          return stored && backlogEligible(stored) ? [stored] : []
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
    if (queued.length === 0 && held.length === 0 && revives.length === 0 && backlog.length === 0)
      return
    const { use } = await slotUse(
      [...revives, ...held, ...queued, ...backlog].flatMap((q) => q.factoryId ?? []),
    )
    if (closed || store.newWorkHold() !== undefined) return
    const heldIds = new Set(held.map((h) => h.id))
    const reviveIds = new Set(revives.map((r) => r.id))
    const sourceOf = new Map(
      sources.flatMap((source) => source.queued().map((q) => [q.id, source] as const)),
    )
    for (const entry of startsNow<QueueEntry>([...revives, ...held, ...ready()], use)) {
      if (reviveIds.has(entry.id)) {
        awaitingRevive.delete(entry.id)
        inBackground('resume a Task Lead session', () => reviveLead(entry.id))
      } else if (heldIds.has(entry.id)) relaunch(entry.id)
      else if (entry.kind === 'sub-agent') subAgents.begin(entry.id)
      else if (sourceOf.has(entry.id)) sourceOf.get(entry.id)?.begin(entry.id)
      else if (!holds.has(entry.id)) begin(entry.id)
    }
    for (const entry of backlog) {
      if (closed || store.newWorkHold() !== undefined) return
      const task = store.getTask(entry.id)
      if (!task || !backlogEligible(task)) continue
      try {
        const { use } = await slotUse([task.factoryId])
        if (version !== backlogVersion) return
        const before = [...revivesReady(), ...heldReady(), ...ready()]
        if (!startsNow([...before, entry], use).some((q) => q.id === entry.id)) continue
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
      const agent = store.getTask(entry.id)?.lead?.agent
      return agent === undefined || paused[agent] === undefined
    })
  }

  function pump(): Promise<void> {
    again = true
    if (closed) return Promise.resolve()
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
    const { use, holders, others, all } = await slotUse(factoryIds)
    const byId = new Map(all.map((t) => [t.id, t]))
    const requests = new Map(store.subAgentRequests().map((r) => [r.id, r]))
    const sourceOf = new Map(
      sources.flatMap((source) => source.queued().map((q) => [q.id, source] as const)),
    )
    const ordered = queueOrder<QueueEntry>([
      ...subAgents.queued(),
      ...store.queue(),
      ...sources.flatMap((source) => source.queued()),
    ])
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
    }
  }

  async function publishSlots(): Promise<void> {
    if (closed) return
    const current = await slots().catch(() => undefined)
    const shown = JSON.stringify(current)
    if (!current || closed || shown === shownSlots) return
    const first = shownSlots === ''
    shownSlots = shown
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
          store.setActivity(taskId, oneLine(`Couldn’t start: ${message}`))
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

  function inBackground(what: string, work: () => Promise<void>): void {
    const release = options.idle?.hold()
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

  async function beginChecks(
    task: StoredTask,
    resolution: WorkflowResolution,
    trigger: CheckRunTrigger,
    only?: string,
  ): Promise<{ checkRun: CheckRun; done: Promise<CheckRunnerResult> } | undefined> {
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
    const plan = await planChecks({
      checks: task.setup
        ? await approvedSetupChecks(task)
        : (resolution.workflow.settings.stages.validate?.checks ?? []),
      repos,
      primary: entries[0]?.name ?? '',
      ...(only !== undefined && { only }),
    })
    if (plan.length === 0) return undefined
    const sandbox = runsInBypass(resolution)
      ? undefined
      : {
          sandbox: options.sandbox,
          scope: sandboxScope(task),
          tmpRoot: path.join(sandboxDir, task.displayId),
        }
    if (sandbox !== undefined) await sandboxProblem(factory.id)
    const checkRun = store.startChecks({
      taskId: task.id,
      trigger,
      stage: task.stage,
      checks: plan.map((p) => p.check),
    })
    const done = (async () => {
      const result = await runChecks({
        checks: plan,
        taskDisplayId: task.displayId,
        libraryDir: options.libraryDir ?? path.join(path.dirname(logsDir), 'library'),
        env: options.env?.() ?? process.env,
        logFor: (position) => checkLog(task, checkRun.id, position),
        ...(sandbox !== undefined && { sandbox }),
        signal: stopping.signal,
        onStart: (position) => store.checkStarted(checkRun.id, position),
        onFinish: (position, finished) => store.checkFinished(checkRun.id, position, finished),
      }).catch((error: unknown) => {
        console.error(`couldn’t run ${task.displayId}’s Checks:`, error)
        return { outcome: 'interrupted' as const, notFound: [] }
      })
      if (result.outcome === 'interrupted' && stopping.signal.aborted) return result
      store.finishChecks(checkRun.id, result.outcome)
      reportNotFound(factory.id, result)
      return result
    })()
    return { checkRun, done }
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

  async function validateChecks(taskId: string, message?: string): Promise<void> {
    setChecking(taskId, true)
    try {
      const task = find(taskId)
      const resolution = await taskWorkflow(task, { fetch: false })
      const { workflow } = resolution
      const instructions = message ?? nextStageMessage(workflow, 'validate')
      const started = await beginChecks(task, resolution, 'validate')
      const withApps = async (text: string) => {
        const current = find(taskId)
        const apps = current.setup ? await startSetupApps(current) : undefined
        return apps === undefined ? text : `${text}\n\n${apps}`
      }
      if (!started) {
        await deliver(task, await withApps(instructions))
        return
      }
      const result = await started.done
      const checkRun = store.getCheckRun(started.checkRun.id) ?? started.checkRun
      const current = find(taskId)
      if (result.outcome === 'interrupted' || current.stage !== 'validate') return
      if (result.outcome === 'passed') {
        await deliver(
          current,
          await withApps(
            `${instructions}\n\n# Checks\n\nTED ran the Factory’s Checks before handing you this Stage. None failed:\n\n${summary(checkRun.checks)}`,
          ),
        )
        return
      }
      const findings = (await failedFindings(current, checkRun)) ?? summary(checkRun.checks)
      await writeFile(path.join(checkDir(current, checkRun.id), 'findings.md'), findings, {
        mode: 0o600,
      })
      const canSendBack =
        workflow.stages.includes('work') &&
        workflow.order.indexOf('work') < workflow.order.indexOf('validate')
      if (!canSendBack) {
        await deliver(
          current,
          `${instructions}\n\n# A Check failed\n\nTED ran the Factory’s Checks and one failed. Work isn’t before Validate in this Workflow, so TED couldn’t send the Task back.\n\n${findings}`,
        )
        return
      }
      const outcome = await holding(current, () =>
        sendBack(
          current,
          resolution,
          'validate',
          { outcome: 'back', to: 'work', findings },
          checkRun.id,
        ),
      )
      if (outcome.request || outcome.pending) {
        await deliver(
          current,
          `${instructions}\n\n# A Check failed\n\nTED ran the Factory’s Checks and one failed. ${outcome.message}\n\n${findings}`,
        )
      }
    } finally {
      setChecking(taskId, false)
    }
  }

  async function pullRequestTargets(task: StoredTask): Promise<PullRequestTarget[]> {
    const factory = factoryOf(task)
    const { workflow } = await taskWorkflow(task, { fetch: false })
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

  type MergeCycle = 'done' | 'wait' | 'busy'
  type MergeWork = MergeTarget & { url: string; worktree: string }

  type MergeMode = 'off' | 'gate' | 'merge' | 'canceled'

  function mergeMode(task: Task, workflow: ResolvedWorkflow): MergeMode | undefined {
    if (task.stage !== 'merge' || task.archived) return undefined
    if (!workflow.stages.includes('merge')) return 'off'
    const since = visitStart(task)
    if (lastChangesRequested(task) !== '') return 'canceled'
    if (workflow.settings.stages.merge?.gate !== true) return 'merge'
    const approved = store
      .listComments(task.id)
      .some(
        (c) =>
          c.gate && c.stage === 'merge' && c.answer?.kind === 'approved' && c.createdAt >= since,
      )
    return approved ? 'merge' : 'gate'
  }

  function tedMerges(task: Task, workflow: ResolvedWorkflow): boolean {
    return mergeMode(task, workflow) === 'merge'
  }

  function startMerging(task: Task): void {
    const since = visitStart(task)
    const started = store
      .taskLog(task.id)
      .some((e) => e.name === 'v1.MergeStarted' && e.at >= since)
    if (!started) store.mergeStarted(task.id)
  }

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
      (c) => !isCiStuck(c) && !isLinearQuestion(c) && !isLinearTeamAsk(c),
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
    return store.listTasks().flatMap((task) =>
      task.archived
        ? []
        : task.repos.flatMap((repo) => {
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

  async function reactToGitHub(read: PullRequestRead): Promise<void> {
    if (closed) return
    for (const task of store.listTasks()) {
      if (task.archived || task.stage === 'done') continue
      let ci: string | null | undefined
      try {
        ci = failureCi(task, read).ci
      } catch {
        ci = null
      }
      const effects = failures.observeCi(task, ci)
      inBackground(`apply ${task.displayId}’s failure observation`, () => effects)
    }
    for (const { id } of store.listTasks()) {
      if (closed) return
      const task = store.getTask(id)
      if (!task || task.archived) continue
      try {
        recordPullRequests(task, read)
        if (
          task.stage !== 'done' &&
          store.failures.list(task.id).length > 0 &&
          !advancing.has(task.id) &&
          !mergeInFlight.has(task.id)
        ) {
          inBackground(`verify ${task.displayId}’s failure context`, () =>
            holding(task, async () => {
              const context = await failures.snapshot(find(task.id)).catch(() => null)
              if (!closed) await failures.obligations(find(task.id), context)
            }),
          )
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
        ? mergeMode(task, (await taskWorkflow(task, { fetch: false })).workflow)
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

  function watchMerge(taskId: string): void {
    if (merging.has(taskId) || closed) return
    merging.add(taskId)
    const name = find(taskId).displayId
    const canAct = () => {
      const current = store.getTask(taskId)
      return !current?.stopped && !checking.has(taskId) && !holdsMerge(taskId)
    }
    inBackground(`merge ${name}’s pull requests`, async () => {
      try {
        let urgent = true
        while (!closed) {
          if (!watched(store.getTask(taskId))) return
          await pullRequestQueue.get(taskId)
          let next: MergeCycle = 'wait'
          let read: PullRequestRead | undefined
          if (canAct() && watch) {
            read = await watch.next({ now: urgent })
            if (closed || !watched(store.getTask(taskId))) return
          }
          if (canAct()) {
            const cycle = mergeCycle(taskId, read).catch((error: unknown) => {
              if (error instanceof RequestError && error.status === 409) return 'busy' as const
              console.error(`couldn’t merge ${name}’s pull requests:`, redactSecrets(textOf(error)))
              return 'wait' as const
            })
            mergeInFlight.set(taskId, cycle)
            next = await cycle.finally(() => mergeInFlight.delete(taskId))
          }
          if (next === 'done') return
          urgent = next === 'busy'
          if (next === 'busy' || read === undefined) {
            await sleep(next === 'busy' ? 100 : mergePollMs, undefined, {
              signal: stopping.signal,
            }).catch(() => undefined)
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

  function setWait(taskId: string, name: string, on: GitHubWait | undefined): void {
    const repo = find(taskId).repos.find((r) => r.name === name)
    if (repo?.pullRequest && repo.pullRequest.waiting !== on) {
      store.pullRequestWaiting(taskId, name, on)
    }
  }

  function mergeChecksPending(task: StoredTask): boolean {
    const since = visitStart(task)
    const rebasedAt = store
      .taskLog(task.id)
      .findLast((e) => e.name === 'v1.TaskBranchRebased' && e.at >= since)?.at
    if (rebasedAt === undefined) return false
    return !store
      .listCheckRuns()
      .some(
        (r) =>
          r.taskId === task.id &&
          r.trigger === 'merge' &&
          r.outcome === 'passed' &&
          r.startedAt >= rebasedAt,
      )
  }

  async function mergeChecks(taskId: string, resolution: WorkflowResolution): Promise<boolean> {
    setChecking(taskId, true)
    try {
      const started = await beginChecks(find(taskId), resolution, 'merge')
      if (!started) return true
      const result = await started.done
      if (result.outcome === 'passed') return true
      if (result.outcome === 'interrupted') return false
      const checkRun = store.getCheckRun(started.checkRun.id) ?? started.checkRun
      const current = find(taskId)
      const findings = (await failedFindings(current, checkRun)) ?? summary(checkRun.checks)
      await writeFile(path.join(checkDir(current, checkRun.id), 'findings.md'), findings, {
        mode: 0o600,
      })
      setChecking(taskId, false)
      await mergeSendBack(taskId, findings, checkRun.id)
      return false
    } finally {
      setChecking(taskId, false)
    }
  }

  async function mergeSendBack(
    taskId: string,
    findings: string,
    checkRunId?: string,
    toValidate = false,
    options: { counted?: boolean } = {},
  ): Promise<MergeCycle> {
    const task = find(taskId)
    if (task.stage !== 'merge') return 'done'
    const split = mergeSplit(task)
    if (split && !task.statuses.includes('partly-merged')) {
      store.mergeStoppedPartway(taskId, split)
    }
    const told = split ? `${findings}\n\n${partwayFindings(split)}` : findings
    const resolution = await taskWorkflow(task, { fetch: false })
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
    const resolution = await taskWorkflow(task, { fetch: false })
    await holding(task, async () => {
      const current = find(taskId)
      if (current.stage === 'merge') await move(current, resolution, 'done', undefined)
    })
    return 'done'
  }

  const partwayFindings = ({ merged, open }: { merged: string[]; open: string[] }) =>
    `The merge stopped partway: ${joinAnd(merged)} already merged and TED doesn’t revert it. Fix only ${joinAnd(open)}; don’t change ${joinAnd(merged)}. The Task comes back through Validate for a short re-sign-off, then TED merges the rest.`

  const needsSignOff = (target: MergeWork, why: string) =>
    `${why} TED merges only the commits the human signed off (${target.expectedHead || 'none recorded'} on ${target.repo}#${target.number}). Bring the Task back through Validate for a new sign-off.`

  async function adoptRebase(
    task: StoredTask,
    target: MergeWork,
    head: string,
  ): Promise<MergeCycle> {
    rebaseAsked.delete(`${task.id}:${target.name}`)
    const signedOff = target.expectedHead
    const fetched = await git.fetchBranch(target.worktree, {
      url: target.url,
      branch: target.branch,
      haves: [signedOff],
    })
    const baseTip = await git.fetchBranch(target.worktree, {
      url: target.url,
      branch: target.base,
      haves: [signedOff],
    })
    const oldBase = await git.mergeBase(target.worktree, signedOff, baseTip)
    const pureRebase =
      fetched === head &&
      (await git.isAncestor(target.worktree, baseTip, head)) &&
      (await git.replayedTree(target.worktree, {
        from: oldBase,
        to: signedOff,
        onto: baseTip,
      })) === (await git.treeOf(target.worktree, head))
    if (!pureRebase) {
      return mergeSendBack(
        task.id,
        needsSignOff(
          target,
          `The branch on GitHub after TED’s rebase isn’t the signed-off work rebased onto ${target.base}.`,
        ),
        undefined,
        true,
      )
    }
    if ((await git.headCommit(target.worktree)) !== signedOff) {
      return mergeSendBack(
        task.id,
        needsSignOff(
          target,
          `The worktree for ${target.name} has commits that weren’t signed off.`,
        ),
        undefined,
        true,
      )
    }
    await git.moveBranchTo(target.worktree, head)
    store.branchRebased(task.id, target.name, { commit: head, onto: target.base })
    return 'busy'
  }

  async function enableAutoMerge(
    gh: Gh,
    task: StoredTask,
    target: MergeWork,
    pr: RemotePullRequest,
  ): Promise<void> {
    const key = `${task.id}:${target.name}:${target.expectedHead}`
    const method = chooseMethod(target.method, pr.allowed)
    if (!method || autoMergeTried.has(key)) return
    try {
      await holding(find(task.id), async () => {
        await requireObligations(find(task.id))
        autoMergeTried.add(key)
        await mergePullRequest(gh, target, method, { auto: true })
        store.autoMergeEnabled(task.id, target.name, { method, requested: target.method })
        await store.persisted()
      })
    } catch (error) {
      console.error(
        `couldn’t turn on auto-merge for ${target.repo}#${target.number}:`,
        redactSecrets(textOf(error)),
      )
    }
  }

  async function removeMergedBranch(gh: Gh, target: MergeWork, pr: RemotePullRequest) {
    if (pr.deleteBranchOnMerge) return
    await deleteBranch(gh, target).catch((error: unknown) =>
      console.error(
        `couldn’t delete the branch ${target.branch} on ${target.repo}:`,
        redactSecrets(textOf(error)),
      ),
    )
  }

  function ciStuckQuestions(task: Task): Comment[] {
    const since = visitStart(task)
    return store.listComments(task.id).filter((c) => isCiStuck(c) && c.createdAt >= since)
  }

  function lastPushAt(task: Task): string {
    return task.repos
      .flatMap((r) => (r.removed || !r.pushed ? [] : [r.pushed.at]))
      .reduce(latest, visitStart(task))
  }

  function mergeAnyway(task: Task): boolean {
    const pushed = lastPushAt(task)
    return ciStuckQuestions(task).some(
      (c) =>
        c.createdAt >= pushed &&
        c.answer?.kind === 'answered' &&
        c.answer.choice === mergeAnywayChoice,
    )
  }

  async function watchCi(
    task: StoredTask,
    waiting: readonly { target: MergeWork; pr: RemotePullRequest }[],
  ): Promise<void> {
    const asked = ciStuckQuestions(task)
    const open = asked.filter((c) => c.answer === undefined)
    if (waiting.length === 0) {
      const at = new Date().toISOString()
      for (const c of open) store.answerComment(c.id, { kind: 'withdrawn', at, ciReported: true })
      return
    }
    if (open.length > 0) return
    const pushed = lastPushAt(task)
    const answeredAt = asked
      .filter((c) => c.createdAt >= pushed)
      .flatMap((c) => (c.answer ? [c.answer.at] : []))
      .reduce(latest, '')
    const now = Date.now()
    const stuck = waiting.find(({ pr }) => {
      const from = answeredAt !== '' ? answeredAt : pushed
      const wait =
        answeredAt === '' && pr.checks.length === 0 ? ciStuckMs.noChecks : ciStuckMs.pending
      return now - Date.parse(from) >= wait
    })
    if (!stuck) return
    const { target, pr } = stuck
    const pending = relevantChecks(pr).filter((c) => c.state === 'pending')
    const requiredPending = pr.checks.some((c) => c.required && c.state === 'pending')
    const where = `${target.repo}#${target.number}`
    const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`
    const what =
      pr.checks.length === 0
        ? `No CI check has appeared on ${where} ${minutes(answeredAt === '' ? ciStuckMs.noChecks : ciStuckMs.pending)} after ${answeredAt === '' ? 'TED pushed' : 'you said to keep waiting'}.`
        : `${checkList(pr, pending)} ${pending.length === 1 ? 'is' : 'are'} still queued or pending on ${where} after ${minutes(ciStuckMs.pending)}.`
    store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: pr.checks.length === 0 ? `CI hasn’t started on ${where}` : `CI is stuck on ${where}`,
      body: [
        what,
        `**${sendToLeadChoice}** sends the Task back to Work so the Task Lead can find out why. **${keepWaitingChoice}** waits another ${minutes(ciStuckMs.pending)}.${
          requiredPending
            ? ' A required check is still pending, so TED can’t merge without it.'
            : ` **${mergeAnywayChoice}** merges without waiting for the checks.`
        }`,
      ].join('\n\n'),
      choices: [
        sendToLeadChoice,
        keepWaitingChoice,
        ...(requiredPending ? [] : [mergeAnywayChoice]),
      ],
    })
  }

  async function answerCiStuck(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment> {
    const answered = await holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn: CI reported before you answered')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      if (choice === mergeAnywayChoice) await requireObligations(find(task.id))
      return store.answerComment(comment.id, {
        kind: 'answered',
        at: new Date().toISOString(),
        ...(choice !== undefined && { choice }),
        ...(text !== '' && { text }),
      })
    })
    if (choice === sendToLeadChoice) {
      await mergeSendBack(
        task.id,
        [
          `TED asked the human about CI at Merge: ${comment.title ?? ''}.`,
          comment.body.split('\n\n')[0] ?? '',
          'The human sent it to you. Find out why CI hasn’t reported (a workflow that doesn’t run on this branch, a missing runner, a check that hangs), fix what belongs in this Task, and say what you found in the brief. The Task comes back through Validate for a short re-sign-off.',
          ...(text !== '' ? [`The human added: ${text}`] : []),
        ].join('\n\n'),
        undefined,
        false,
        { counted: false },
      )
    } else if (choice === undefined && text !== '') {
      await deliverAnswer(task, answered, `The human answered “${comment.title ?? ''}”:\n\n${text}`)
    }
    return store.getComment(comment.id) ?? answered
  }

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
    const log = store.taskLog(task.id)
    const targets = await pullRequestTargets(current)
    const repos: SignOffChanges['repos'] = []
    for (const target of targets) {
      const repo = current.repos.find((r) => r.name === target.name)
      const to = repo?.pullRequest?.signedOff ?? repo?.pushed?.commit
      const approved = log.find(
        (e) =>
          e.name === 'v1.PullRequestSignedOff' &&
          e.at >= approvedAt &&
          e.data.name === target.name &&
          typeof e.data.commit === 'string',
      )?.data.commit as string | undefined
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
    await mergeInFlight.get(task.id)
    const stillOn = await turnOffAutoMerge(task.id)
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

  async function turnOffAutoMerge(taskId: string): Promise<string[]> {
    const gh = options.gh
    const stillOn: string[] = []
    for (const repo of find(taskId).repos) {
      const pr = repo.pullRequest
      if (repo.removed || !pr || pr.autoMerge === undefined || pr.state === 'merged') continue
      const where = `${repo.repo}#${pr.number}`
      if (!gh) {
        stillOn.push(where)
        continue
      }
      try {
        await disableAutoMerge(gh, { repo: repo.repo, number: pr.number })
        store.autoMergeDisabled(taskId, repo.name)
      } catch (error) {
        console.error(`couldn’t turn off auto-merge for ${where}:`, redactSecrets(textOf(error)))
        stillOn.push(where)
      }
    }
    return stillOn
  }

  function remoteOf(
    taskId: string,
    targets: readonly { name: string }[],
    read: PullRequestRead,
  ): Map<string, RemotePullRequest> {
    const found = new Map<string, RemotePullRequest>()
    for (const target of targets) {
      const key = `${taskId}:${target.name}`
      const host = read.hostOf.get(key)
      const failure = host === undefined ? undefined : read.failed.get(host)
      if (failure !== undefined) throw failure
      const pr = read.pulls.get(key)
      if (pr) found.set(target.name, pr)
    }
    return found
  }

  async function watchOnlyCycle(
    taskId: string,
    read: PullRequestRead | undefined,
  ): Promise<MergeCycle> {
    const task = find(taskId)
    const open = task.repos.filter(
      (r) => !r.removed && r.pullRequest !== undefined && r.pullRequest.state !== 'merged',
    )
    if (open.length === 0) return task.stage === 'merge' ? finishMerge(taskId) : 'done'
    if (!read) return 'wait'
    const targets = open.flatMap((r) =>
      r.pullRequest
        ? [
            {
              name: r.name,
              repo: r.repo,
              number: r.pullRequest.number,
              branch: r.branch,
              base: r.pullRequest.base,
              expectedHead: '',
              hasCi: false,
              method: 'squash' as const,
            },
          ]
        : [],
    )
    let remote: Map<string, RemotePullRequest>
    try {
      remote = remoteOf(taskId, targets, read)
    } catch (error) {
      if (error instanceof GhError && (error.kind === 'auth' || error.kind === 'missing')) {
        if (task.stage === 'merge') {
          for (const target of targets) setWait(taskId, target.name, 'sign-in')
        }
      }
      throw error
    }
    let left = 0
    for (const target of targets) {
      const pr = remote.get(target.name)
      if (pr?.state === 'MERGED') {
        store.pullRequestMerged(taskId, target.name, { noCi: false, byTed: false })
        continue
      }
      left++
      if (task.stage === 'merge') setWait(taskId, target.name, 'merge')
    }
    if (left > 0) return 'wait'
    return task.stage === 'merge' ? finishMerge(taskId) : 'done'
  }

  async function mergeCycle(
    taskId: string,
    read: PullRequestRead | undefined,
  ): Promise<MergeCycle> {
    if (store.failures.list(taskId).length > 0) await untilFree(taskId)
    const task = find(taskId)
    if (advancing.has(taskId)) return 'busy'
    if (task.stage === 'done') return watchOnlyCycle(taskId, read)
    if (store.failures.list(task.id).length > 0) {
      if (read) recordPullRequests(task, read)
      try {
        await holding(task, async () => {
          read = await watch?.next({ now: true })
          await requireObligations(find(task.id), read)
        })
      } catch {
        return 'wait'
      }
    }
    const resolution = await taskWorkflow(task, { fetch: false })
    const mode = mergeMode(task, resolution.workflow)
    if (mode === undefined) return 'done'
    if (mode === 'canceled') return (await turnOffAutoMerge(taskId)).length > 0 ? 'wait' : 'done'
    if (mode === 'off') return watchOnlyCycle(taskId, read)
    if (mode === 'merge') startMerging(task)
    if (mergeChecksPending(task) && !(await mergeChecks(taskId, resolution))) return 'wait'
    const targets = await mergeTargets(find(taskId), resolution)
    if (targets.length === 0) return finishMerge(taskId)
    const unsigned = targets.find((t) => t.expectedHead === '')
    if (unsigned) {
      return mergeSendBack(
        taskId,
        needsSignOff(
          unsigned,
          `TED has no signed-off commit for ${unsigned.name}: its branch couldn’t be pushed at sign-off.`,
        ),
        undefined,
        true,
      )
    }
    const gh = options.gh
    if (!gh || !read) return 'wait'
    let remote: Map<string, RemotePullRequest>
    try {
      remote = remoteOf(taskId, targets, read)
    } catch (error) {
      if (error instanceof GhError && (error.kind === 'auth' || error.kind === 'missing')) {
        for (const target of targets) setWait(taskId, target.name, 'sign-in')
      }
      throw error
    }
    const ready: { target: MergeWork; pr: RemotePullRequest; noCi: boolean }[] = []
    const waitingForCi: { target: MergeWork; pr: RemotePullRequest }[] = []
    const anyway = mergeAnyway(task)
    let open = 0
    for (const target of targets) {
      const pr = remote.get(target.name)
      if (!pr) {
        open++
        continue
      }
      const key = `${taskId}:${target.name}`
      const step = nextStep(target, pr, { mergeAnyway: anyway })
      if (step.kind !== 'merged') open++
      switch (step.kind) {
        case 'merged': {
          rebaseAsked.delete(key)
          const method = find(taskId).repos.find((r) => r.name === target.name)?.pullRequest
            ?.autoMerge
          store.pullRequestMerged(taskId, target.name, {
            ...(method !== undefined && { method }),
            noCi: false,
            byTed: false,
          })
          await removeMergedBranch(gh, target, pr)
          break
        }
        case 'closed':
          setWait(taskId, target.name, 'merge')
          break
        case 'changed': {
          const asked = rebaseAsked.get(key)
          if (asked?.from === target.expectedHead && asked.to === step.head) {
            return adoptRebase(task, target, step.head)
          }
          return mergeSendBack(
            taskId,
            needsSignOff(
              target,
              `The pull request’s branch changed on GitHub after sign-off: it’s at ${step.head}.`,
            ),
            undefined,
            true,
          )
        }
        case 'ready':
          return mergeSendBack(
            taskId,
            needsSignOff(target, `${target.repo}#${target.number} is still a draft.`),
            undefined,
            true,
          )
        case 'conflict':
          return mergeSendBack(taskId, conflictFindings(target))
        case 'behind':
          if (rebaseAsked.get(key)?.from !== target.expectedHead) {
            try {
              const to = await holding(find(taskId), async () => {
                await requireObligations(find(taskId))
                return rebasePullRequest(gh, pr)
              })
              if (to !== undefined) rebaseAsked.set(key, { from: target.expectedHead, to })
            } catch (error) {
              if (/conflict/i.test(textOf(error))) {
                return mergeSendBack(taskId, conflictFindings(target))
              }
              throw error
            }
          }
          setWait(taskId, target.name, 'ci')
          break
        case 'ci-failed':
          return mergeSendBack(
            taskId,
            `CI failed on ${target.repo}#${target.number} at Merge: ${checkList(
              pr,
              relevantChecks(pr).filter((c) => c.state === 'failed'),
            )}. Fix it, and the Task comes back through Validate for a short re-sign-off.`,
          )
        case 'wait':
          if (
            mode === 'gate' &&
            step.on === 'review' &&
            ciState(target, pr, { mergeAnyway: anyway }) === 'passed' &&
            pr.mergeable === 'MERGEABLE'
          ) {
            ready.push({ target, pr, noCi: !target.hasCi })
            break
          }
          setWait(taskId, target.name, step.on)
          if (ciState(target, pr, { mergeAnyway: anyway }) === 'pending') {
            waitingForCi.push({ target, pr })
          }
          if (step.autoMerge && mode === 'merge' && targets.length === 1)
            await enableAutoMerge(gh, task, target, pr)
          break
        case 'merge':
          ready.push({ target, pr, noCi: step.noCi })
          break
      }
    }
    await watchCi(task, waitingForCi)
    if (ready.length === 0 || ready.length !== open) {
      return open === 0 ? finishMerge(taskId) : 'wait'
    }
    if (mode === 'gate') {
      for (const { target } of ready) setWait(taskId, target.name, undefined)
      await holding(find(taskId), () => postMergeGate(find(taskId), ready))
      return 'wait'
    }
    for (const { target, pr, noCi } of ready) {
      if (mergeMode(find(taskId), resolution.workflow) !== 'merge') return 'done'
      const method = chooseMethod(target.method, pr.allowed)
      if (!method) {
        console.error(`GitHub allows no merge method on ${target.repo}`)
        setWait(taskId, target.name, 'merge')
        return 'wait'
      }
      try {
        await holding(find(taskId), async () => {
          await requireObligations(find(taskId))
          await mergePullRequest(gh, target, method, { auto: false })
        })
      } catch (error) {
        if (error instanceof RequestError && error.status === 409) throw error
        if (error instanceof GhError && (error.kind === 'auth' || error.kind === 'missing')) {
          setWait(taskId, target.name, 'sign-in')
          throw error
        }
        const reread = watch && (await watch.next({ now: true }))
        const now = reread
          ? (() => {
              try {
                return remoteOf(taskId, [target], reread).get(target.name)
              } catch {
                return undefined
              }
            })()
          : undefined
        if (now?.state !== 'MERGED') {
          if (!mergeSplit(find(taskId))) throw error
          return mergeSendBack(
            taskId,
            `TED couldn’t merge ${target.repo}#${target.number}: ${redactSecrets(textOf(error))}`,
          )
        }
      }
      store.pullRequestMerged(taskId, target.name, {
        method,
        requested: target.method,
        noCi,
        byTed: true,
      })
      await removeMergedBranch(gh, target, pr)
    }
    return finishMerge(taskId)
  }

  const leadFrom = (settings?: WorkflowSettings) =>
    resolveAgentChoices(settings, {
      claude: agents.installed('claude'),
      codex: agents.installed('codex'),
    }).lead

  const subAgents = createSubAgents({
    store,
    runs,
    agents,
    find: (ref) => find(ref),
    async leadFor(task) {
      if (task.lead) return task.lead
      return leadFrom((await taskWorkflow(task, { fetch: false })).workflow.settings)
    },
    reviewerFor: (task) => reviewerFor(task),
    async envFor(task, repo) {
      const appVars = await apps.envFor(task.id)
      const recorded = store.recordedSetup(task.id, repo.name)?.env
      if (recorded) return { ...recorded, ...appVars }
      return { ...(repoEntry(await entriesOf(factoryOf(task)), repo)?.env ?? {}), ...appVars }
    },
    async permissionsFor(task) {
      const resolution = await taskWorkflow(task, { fetch: false })
      return resolution.workflow.settings.permissions === 'bypass' ? 'bypass' : 'auto'
    },
    clonePathFor: (repo) => clonePath(reposDir, repo),
    runFolder: async (task) => runFolderOf(find(task.id), await entriesOf(factoryOf(task))),
    worktreesDir,
    pump: () => void pump(),
    inBackground: (what, work) => inBackground(what, work),
  })

  async function reviewerFor(task: StoredTask): Promise<ReviewerChoice> {
    const { settings } = (await taskWorkflow(task, { fetch: false })).workflow
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
    const other: AgentKind = lead.agent === 'claude' ? 'codex' : 'claude'
    const canRun = async (kind: AgentKind) =>
      agents.installed(kind) &&
      store.agentPauses()[kind] === undefined &&
      (await health.ready(kind))
    const agent = (await canRun(other)) ? other : (await canRun(lead.agent)) ? lead.agent : other
    return { lead: { agent, ...tuned }, ...(agent !== other && { unavailable: other }) }
  }

  const sameChoice = (lead: TaskLead, run: Run) =>
    lead.agent === run.agent && lead.model === run.model && lead.effort === run.effort

  const atIdlePoint = (run: Run) =>
    run.state === 'idle' || (run.problem !== undefined && run.state === 'waiting')

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
    if (task.archived) throw new RequestError(409, `${task.displayId} is archived`)
    if (task.stage === 'done') throw new RequestError(409, `${task.displayId} is done`)
    const factory = factoryOf(task)
    const resolution = await taskWorkflow(task, { fetch: false })
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
        await git.removeWorktree(clonePath(reposDir, repo), repo.worktree).catch((error) => {
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

  async function setUpAdded(taskId: string, step: SetupStep, tellLead: boolean): Promise<void> {
    const key = `${taskId}:${step.repo.name}`
    if (repoSetups.has(key)) return
    const cancel = new AbortController()
    repoSetups.set(key, cancel)
    try {
      const task = find(taskId)
      const signal = AbortSignal.any([stopping.signal, cancel.signal])
      const finished = await runSetup(task, step.repo, step.setup, signal, { untilStopped: false })
      if (!finished || !tellLead) return
      const run = liveLead(find(taskId))
      if (!run) return
      await runs.send(
        run.id,
        finished.report ??
          `TED finished setting up the ${step.repo.name} worktree: \`${step.setup.command}\` passed.`,
      )
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

  function liveLead(task: StoredTask): Run | undefined {
    if (!task.leadRunId || task.stage === 'backlog' || task.stage === 'done') return undefined
    const run = store.getRun(task.leadRunId)
    return run && run.state !== 'finished' ? run : undefined
  }

  async function applyLead(taskId: string): Promise<void> {
    if (applying.has(taskId)) return
    const task = store.getTask(taskId)
    const run = task && liveLead(task)
    if (!task?.lead || !run || sameChoice(task.lead, run) || !atIdlePoint(run)) return
    applying.add(taskId)
    try {
      const lead = task.lead
      if (lead.agent !== run.agent) {
        if (store.newWorkHold() !== undefined) return
        await freshLead(task, run)
      } else {
        await restartLead(run, {
          ...(lead.model !== undefined && { model: lead.model }),
          ...(lead.effort !== undefined && { effort: lead.effort }),
          usesDefaultModel: run.usesDefaultModel === true && run.model === lead.model,
        })
      }
    } finally {
      applying.delete(taskId)
    }
    await applyLead(taskId)
  }

  async function restartLead(run: Run, flags: RunFlags): Promise<void> {
    await runs.restart(run.id, flags)
    if (run.problem === 'model-unavailable') {
      const now = flags.usesDefaultModel ? 'the CLI’s default model' : `the model ${flags.model}`
      await runs.send(
        run.id,
        `TED restarted you on ${now} because ${run.model} isn’t available. Your last message got no answer; carry on from where you were.`,
      )
    }
  }

  async function freshLead(task: StoredTask, run: Run): Promise<void> {
    const factory = factoryOf(task)
    if (!task.repos.some((r) => !r.removed)) throw new Error(`${task.displayId} has no worktree`)
    const resolution = await taskWorkflow(task, { fetch: false })
    const env = leadEnv(task, factoryRepos(resolution.workflow, factory))
    await runs.stop(run.id)
    await launch(task, resolution, env)
  }

  function leadEnv(task: StoredTask, entries: readonly FactoryRepoEntry[]): Record<string, string> {
    const repo = task.repos.find((r) => !r.removed)
    if (!repo) return {}
    return store.recordedSetup(task.id, repo.name)?.env ?? repoEntry(entries, repo)?.env ?? {}
  }

  function askAboutModel(run: Run): void {
    if (run.problem !== 'model-unavailable') {
      const id = asked.get(run.id)
      asked.delete(run.id)
      if (id !== undefined && store.getComment(id)?.answer === undefined) {
        store.answerComment(id, {
          kind: 'answered',
          at: new Date().toISOString(),
          text: 'The Task Lead no longer waits on this model.',
        })
      }
      return
    }
    const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || asked.has(run.id)) return
    const question = store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: `${run.model} isn’t in your plan`,
      body: `The Task Lead asked for the model “${run.model}”, which your plan doesn’t include. TED won’t switch models on its own, so the Run is waiting. Choose Use the default model to run this Run on the CLI’s default model, or Change setting to pick another model in the Task Lead field.`,
      choices: [useDefaultChoice, 'Change setting'],
    })
    asked.set(run.id, question.id)
  }

  async function useDefaultModel(ref: string): Promise<Task> {
    const task = find(ref)
    const run = liveLead(task)
    if (run?.problem !== 'model-unavailable' || applying.has(task.id)) {
      throw new RequestError(409, `${task.displayId}’s Task Lead isn’t waiting on its model`)
    }
    applying.add(task.id)
    try {
      await restartLead(run, {
        ...(run.model !== undefined && { model: run.model }),
        ...(run.effort !== undefined && { effort: run.effort }),
        usesDefaultModel: true,
      })
    } finally {
      applying.delete(task.id)
    }
    return publicTask(task.id)
  }

  let closed = false
  const unsubscribe = store.subscribe((event) => {
    if (event.type !== 'run-updated' || event.run.taskId === undefined) return
    const { run } = event
    setImmediate(() => {
      if (closed) return
      watchIdle(run)
      askAboutModel(run)
      if (run.taskId !== undefined) {
        const taskId = run.taskId
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
    const clone = clonePath(reposDir, factory)
    const live = task.repos.filter((r) => !r.removed)
    const clones = [clone, ...live.map((r) => clonePath(reposDir, r))]
    for (const worktree of subAgents.ownWorktrees(task)) {
      await removeFromAny(clones, worktree).catch((error: unknown) => {
        console.error(`couldn’t remove a sub-agent worktree of ${task.displayId}:`, error)
      })
    }
    const entries = factoryRepos(resolution.workflow, factory)
    const removed: { name: string; teardown?: TeardownRecord }[] = []
    for (const [index, repo] of live.entries()) {
      const teardown = await tearDown(task, repo, repoEntry(entries, repo), live.slice(index))
      await git.removeWorktree(clonePath(reposDir, repo), repo.worktree)
      removed.push({ name: repo.name, ...(teardown && { teardown }) })
    }
    if (task.repos.length === 0 && task.worktree) await git.removeWorktree(clone, task.worktree)
    await rm(path.join(worktreesDir, task.displayId), { recursive: true, force: true })
    await removeInside(sandboxDir, task.displayId)
    for (const { name, teardown } of removed) store.worktreeRemoved(task.id, name, teardown)
  }

  type TeardownRecord = { command: string; outcome: WorktreeCommandOutcome }

  async function removeFromAny(clones: readonly string[], worktree: string): Promise<void> {
    let failure: unknown
    for (const clone of new Set(clones)) {
      try {
        await git.removeWorktree(clone, worktree)
        return
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }

  async function tearDown(
    task: StoredTask,
    repo: TaskRepo,
    entry: FactoryRepoEntry | undefined,
    remainingRepos?: readonly TaskRepo[],
  ): Promise<TeardownRecord | undefined> {
    const teardown = entry?.teardown
    if (!teardown) return undefined
    const current = find(task.id)
    const sandbox = await lifecycleSandbox(current, remainingRepos ?? current.repos)
    const result: CommandResult = await runTaskCommand({
      label: 'teardown',
      ...(sandbox !== undefined && { sandbox }),
      command: teardown,
      cwd: repo.worktree,
      env: commandEnv(task, entry.env),
      log: commandLog(task, 'teardown', repo.name),
      signal: stopping.signal,
    }).catch((error: unknown) => {
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

  function cloneFor(factory: StoredFactory, entry: FactoryRepoEntry): Promise<string> {
    return ensureClone(
      { banners, reposDir },
      entry.primary ? factory : { ...factory, repo: entry.repo, cloneUrl: entry.cloneUrl },
    )
  }

  async function openWorktree(
    task: StoredTask,
    factory: StoredFactory,
    entry: FactoryRepoEntry,
    branch: string,
    fresh: boolean,
  ): Promise<NewWorktree & { branch: string; worktree: string }> {
    const clone = await cloneFor(factory, entry)
    await git.fetch(clone)
    const base = entry.baseBranch ?? (await git.defaultBranch(clone))
    const worktree = path.join(worktreesDir, task.displayId, entry.name)
    await mkdir(path.dirname(worktree), { recursive: true })
    const add = fresh ? git.addWorktree : git.restoreWorktree
    await add(clone, { path: worktree, branch, from: `origin/${base}` }).catch((error: unknown) => {
      throw new RequestError(
        409,
        `couldn’t make ${task.displayId}’s ${entry.name} worktree from origin/${base}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    const copy = await copyFiles(store.localFolder(entry.repo), worktree, entry.copy).catch(
      async (error: unknown) => {
        await git.removeWorktree(clone, worktree).catch(() => undefined)
        if (fresh) await git.deleteBranch(clone, branch).catch(() => undefined)
        throw new RequestError(
          409,
          `couldn’t copy files into ${task.displayId}’s ${entry.name} worktree: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    )
    return { name: entry.name, repo: entry.repo, branch, worktree, ...copy }
  }

  function setupSteps(task: StoredTask, entries: readonly FactoryRepoEntry[]): SetupStep[] {
    return entries.flatMap((entry) => {
      const repo = task.repos.find((r) => !r.removed && sameRepo(r.repo, entry.repo))
      const setup = entry.setup
      return repo && setup
        ? [{ repo, setup: { command: setup.run, timeoutMs: setup.timeoutMs, env: entry.env } }]
        : []
    })
  }

  function interruptedSetups(task: StoredTask): SetupStep[] {
    return task.repos.flatMap((repo) => {
      const recorded = store.recordedSetup(task.id, repo.name)
      return !repo.removed && recorded && repo.setup?.state === 'running'
        ? [{ repo, setup: recorded }]
        : []
    })
  }

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

  async function launch(
    task: StoredTask,
    resolution: WorkflowResolution,
    env: Record<string, string>,
    setupReport?: string,
    { resumeSession, pickUp }: { resumeSession?: string; pickUp?: string } = {},
  ): Promise<void> {
    const current = find(task.id)
    if (current.archived || current.stopped) return
    const lead = task.lead ?? leadFrom(resolution.workflow.settings)
    const agent = lead.agent
    const note = pickUp ?? (resumeSession === undefined ? pendingPickUp(current) : undefined)
    const followUp = resumeSession === undefined ? followUpNote(current) : undefined
    if (!(await health.ready(agent))) {
      store.holdTaskRun({
        taskId: task.id,
        agent,
        ...(resumeSession !== undefined && { sessionId: resumeSession }),
      })
      return
    }
    const waiting = waitingForRun(task.id)
    const since = sinceLastRun(task.id, waiting, resumeSession === undefined && note === undefined)
    const entries = factoryRepos(resolution.workflow, factoryOf(current))
    const cwd = runFolderOf(current, entries)
    if (cwd === undefined) throw new Error(`${task.displayId} has no worktree`)
    const overnightMode = store.settings().overnightMode
    const prompt = [
      overnightGuidance(overnightMode),
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
            ...(followUp !== undefined ? [followUp] : []),
            ...(note !== undefined ? [note] : []),
          ]
        : [continueMessage, ...editedSince(current)]),
      ...(since !== undefined ? [since] : []),
      ...(resumeSession !== undefined && movedByApproval(current, waiting.answers)
        ? [nextStageMessage(resolution.workflow, current.stage as AgentStageId)]
        : []),
    ].join('\n\n')
    let run: Run
    for (const comment of waiting.comments) promptComments.add(comment.id)
    try {
      run = await runs.start({
        agent,
        prompt,
        cwd,
        taskId: task.id,
        env: { ...env, ...(await apps.envFor(task.id)), TED_TASK: task.displayId },
        permissions: resolution.workflow.settings.permissions === 'bypass' ? 'bypass' : 'auto',
        ...(resumeSession !== undefined && { resume: resumeSession }),
        ...(lead.model !== undefined && { model: lead.model }),
        ...(lead.effort !== undefined && { effort: lead.effort }),
      })
      overnightSeen.set(run.id, overnightMode)
      store.commentsDelivered(
        waiting.comments.map((c) => c.id),
        run.id,
      )
    } finally {
      for (const comment of waiting.comments) promptComments.delete(comment.id)
    }
    store.answersDelivered(
      waiting.answers.map((c) => c.id),
      run.id,
    )
    store.releaseTaskRun(task.id)
    await sendWaiting(task.id)
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
    const edited = store
      .taskLog(task.id)
      .some((e) => e.name === 'v1.TaskEdited' && e.at >= run.startedAt)
    if (!edited) return []
    const current = find(task.id)
    return [
      `The human edited this Task while your session was running or stopped. Work from this version:\n\nTitle: ${current.title}\n\n${current.description || '(no description)'}`,
    ]
  }

  const failureNotice = (comment: Comment) =>
    comment.author.kind === 'ted' && comment.title === failureNoticeTitle

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
        const answer = answerText(c)
        return answer === undefined
          ? []
          : [
              {
                at: c.answer?.at ?? c.createdAt,
                line: withLines(
                  `- ${c.answer?.at ?? c.createdAt}: the human answered “${c.title ?? firstLine(c.body)}”: ${flat(answer)}`,
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
    if (waitingForRun(taskId).comments.length > 0) await sendComment(run.id)
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
    const set = store
      .taskLog(taskId)
      .findLast(
        (e) =>
          (e.name === 'v1.ClarifyDepthSet' && e.data.by === 'human') || e.name === 'v2.TaskCreated',
      )
    const depth = (set?.data.depth ?? set?.data.clarifyDepth) as ClarifyDepth | undefined
    return depth === 'auto' ? undefined : depth
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
        'a split needs at least two rows: row 1 is this Task, and the rest become new Tasks',
      )
    }
    if ((input.tasks[0]?.blockedBy ?? []).length > 0) {
      throw new RequestError(
        400,
        'row 1 is this Task, which carries on now, so it can’t be blocked',
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

  function unanswered(comment: Comment): void {
    const current = store.getComment(comment.id)
    if (current?.answer?.kind === 'withdrawn') {
      throw new RequestError(409, 'this request was withdrawn')
    }
    if (current?.answer?.kind === 'superseded') {
      throw new RequestError(409, 'this request was replaced by a newer one')
    }
    if (current?.answer) throw new RequestError(409, 'this request has already been answered')
  }

  async function answerProposal(
    task: StoredTask,
    comment: Comment,
    request: AnswerRequest,
  ): Promise<Comment> {
    const proposal = comment.proposal
    if (!proposal) throw new RequestError(409, 'this proposal has no rows')
    const text = 'text' in request ? (request.text?.trim() ?? '') : ''
    if (request.action === 'request-changes') {
      if (text === '') throw new RequestError(400, 'Request changes needs your comment')
      return holding(task, async () => {
        unanswered(comment)
        const at = new Date().toISOString()
        const answered = answerRequest(task, comment, { kind: 'changes-requested', at, text })
        await deliverAnswer(task, comment, proposalChangesMessage(text))
        return answered
      })
    }
    if (request.action !== 'approve') {
      throw new RequestError(400, 'answer a proposal with Create Tasks or Request changes')
    }
    const { skip, shape: plan } = approvedShape(
      proposal,
      request.proposal?.skip,
      proposal.firstPiece && { name: 'this Task' },
    )
    const startUnblocked = request.proposal?.startUnblocked === true
    const first = proposal.rows[0]
    const result = await holding(task, async () => {
      unanswered(comment)
      const current = find(task.id)
      if (current.archived) throw new RequestError(409, `${task.displayId} is archived`)
      const created = await createProposalTasks(store, proposal, plan, {
        firstPieceId: proposal.firstPiece ? task.id : undefined,
        factoryId: current.factoryId,
        fields: () => ({ ...(current.lead && { lead: current.lead }), splitFrom: task.id }),
      })
      const narrowed =
        proposal.firstPiece && first
          ? { title: first.title, description: first.description ?? first.scope }
          : undefined
      if (narrowed) {
        store.taskSplit(task.id, {
          pieceIds: created.map((c) => c.id),
          narrowedTo: narrowed.title,
          description: narrowed.description,
        })
        if (first && first.priority !== current.priority) {
          store.setPriority(task.id, first.priority)
        }
      }
      const outcome = { tasks: created, skipped: skip, startUnblocked }
      const answered = answerRequest(task, comment, {
        kind: 'approved',
        at: new Date().toISOString(),
        ...(text !== '' && { text }),
        created: outcome,
      })
      await deliverAnswer(
        task,
        comment,
        splitApprovedMessage({
          displayId: task.displayId,
          proposal,
          created: outcome,
          ...(narrowed && { narrowed }),
          text,
        }),
      )
      return { answered, created }
    })
    if (startUnblocked) {
      for (const piece of result.created) {
        if (!plan.unblocked.includes(piece.row)) continue
        await start(piece.id).catch((error: unknown) => {
          console.error(`couldn’t start ${piece.displayId}:`, error)
        })
      }
    }
    wake()
    return store.getComment(comment.id) ?? result.answered
  }

  async function answerSizeCheck(
    task: StoredTask,
    comment: Comment,
    choice: string,
    text: string,
  ): Promise<Comment> {
    if (choice === sizeChoices.chat) return planInChat(task, comment, text)
    return holding(task, async () => {
      unanswered(comment)
      const at = new Date().toISOString()
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at,
        choice,
        ...(text !== '' && { text }),
      })
      if (choice === sizeChoices.split) {
        await deliverAnswer(task, comment, splitChosenMessage(text))
      } else if (choice === sizeChoices.grill) {
        store.setClarifyDepth(task.id, { depth: 'grilling', by: 'human' })
        await deliverAnswer(task, comment, grillAnywayMessage(text))
      } else {
        planOutside(find(task.id), comment)
      }
      return store.getComment(comment.id) ?? answered
    })
  }

  function planningInChat(taskId: string): boolean {
    return store.plans
      .list()
      .some((p) => p.fromTask?.taskId === taskId && !p.fromTask.gone && p.state !== 'ended')
  }

  async function planInChat(task: StoredTask, comment: Comment, text: string): Promise<Comment> {
    const planning = options.planning?.()
    if (!planning) throw new RequestError(503, 'Planning chats aren’t ready yet. Try again.')
    return holding(task, async () => {
      unanswered(comment)
      if (find(task.id).stage !== 'clarify') {
        throw new RequestError(409, `${task.displayId} has left Clarify`)
      }
      const plan = await planning.fromTask({ taskId: task.id, sizeCheckId: comment.id, text })
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at: new Date().toISOString(),
        choice: sizeChoices.chat,
        ...(text !== '' && { text }),
        planId: plan.id,
      })
      await deliverAnswer(task, comment, planInChatMessage(plan.title))
      return store.getComment(comment.id) ?? answered
    })
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
        displayId: task.displayId,
        planTitle,
        narrowed: { title: task.title, description: task.description },
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
    store.taskSplit(task.id, {
      pieceIds: input.created.tasks.map((c) => c.id),
      narrowedTo: input.narrowed.title,
      description: input.narrowed.description,
    })
    if (input.narrowed.priority !== task.priority) {
      store.setPriority(task.id, input.narrowed.priority)
    }
    store.taskPlanEnded(task.id, input.planId, 'approved')
    await tellLeadAboutPlan(
      task.id,
      input.planId,
      planApprovedLeadMessage({ displayId: task.displayId, ...input }),
    )
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

  async function humanComment(
    task: StoredTask,
    body: string,
    attachments: readonly Attachment[],
  ): Promise<Comment> {
    const posted = store.postComment({
      taskId: task.id,
      body,
      author: { kind: 'human' },
      attachments,
      ...(task.stage !== 'done' && { lineComments: drafts(task.id) }),
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

  async function setUpAndLaunch(
    task: StoredTask,
    resolution: WorkflowResolution,
    steps: readonly SetupStep[],
    env: Record<string, string>,
    pickUp?: string,
  ): Promise<void> {
    const release = hold(task.id)
    try {
      await setUpThenLaunch(task, resolution, steps, env, pickUp)
    } finally {
      release()
    }
  }

  async function setUpThenLaunch(
    task: StoredTask,
    resolution: WorkflowResolution,
    steps: readonly SetupStep[],
    env: Record<string, string>,
    pickUp?: string,
  ): Promise<void> {
    const before = find(task.id)
    if (before.stopped || before.archived) return
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
    await launch(
      find(task.id),
      resolution,
      env,
      reports.length > 0 ? reports.join('\n\n') : undefined,
      { ...(pickUp !== undefined && { pickUp }) },
    )
  }

  async function runSetup(
    task: StoredTask,
    repo: TaskRepo,
    setup: RecordedSetup,
    signal: AbortSignal,
    { untilStopped }: { untilStopped: boolean },
  ): Promise<{ result: CommandResult; report?: string } | undefined> {
    store.worktreeSetupStarted(task.id, repo.name, setup)
    const log = commandLog(task, 'setup', repo.name)
    const sandbox = await lifecycleSandbox(find(task.id))
    const result = await runTaskCommand({
      label: 'setup',
      ...(sandbox !== undefined && { sandbox }),
      command: { run: setup.command, timeoutMs: setup.timeoutMs },
      cwd: repo.worktree,
      env: commandEnv(task, setup.env),
      log,
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

  async function resume(taskId: string): Promise<void> {
    const release = hold(taskId)
    try {
      await resumeTask(taskId)
    } finally {
      release()
    }
  }

  async function resumeTask(taskId: string): Promise<void> {
    const task = find(taskId)
    const repo = task.repos.find((r) => !r.removed)
    const held = store.heldRuns().find((h) => h.taskId === taskId)
    const leadLive = task.runs.some((r) => r.id === task.leadRunId)
    if (
      !repo ||
      task.archived ||
      task.stopped ||
      task.stage === 'backlog' ||
      task.stage === 'done'
    ) {
      if (held) store.releaseTaskRun(taskId)
      return
    }
    if (held ? leadLive : task.leadRunId) return
    if (held?.sessionId !== undefined && (task.lead?.agent ?? held.agent) === held.agent) {
      const resolution = await taskWorkflow(task, { fetch: false })
      const env = store.recordedSetup(task.id, repo.name)?.env ?? {}
      return launch(task, resolution, env, undefined, { resumeSession: held.sessionId })
    }
    const factory = factoryOf(task)
    const resolution = await taskWorkflow(task, { fetch: false })
    const env = leadEnv(task, factoryRepos(resolution.workflow, factory))
    const interrupted = interruptedSetups(task)
    if (interrupted.length > 0) return setUpAndLaunch(task, resolution, interrupted, env)
    const reports = await failedSetupReports(task)
    await launch(task, resolution, env, reports.length > 0 ? reports.join('\n\n') : undefined)
  }

  function entryFor({ workflow, layers }: WorkflowResolution, stage: AgentStageId | 'done') {
    const file = stage === 'done' ? undefined : workflow.stageFile(stage)
    const order = workflow.order.map((id) => ({
      stage: id,
      enabled: workflow.stages.includes(id),
    }))
    return { ...(file && { stageFile: { layer: file.layer, path: file.path } }), layers, order }
  }

  function publicTask(id: string): Task {
    const task = store.listTasks().find((t) => t.id === id)
    if (!task) throw new RequestError(404, `no Task ${id}`)
    return task
  }

  async function holding<T>(task: Task, work: () => Promise<T>): Promise<T> {
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
    }
  }

  async function untilFree(taskId: string): Promise<void> {
    const deadline = Date.now() + humanWaitMs
    for (let held = released.get(taskId); held; held = released.get(taskId)) {
      const left = deadline - Date.now()
      if (left <= 0) return
      const timer = new AbortController()
      await Promise.race([held, sleep(left, undefined, { signal: timer.signal }).catch(() => {})])
      timer.abort()
    }
  }

  async function deliver(task: Task, text: string): Promise<boolean> {
    const runId = find(task.id).leadRunId
    const run = runId === undefined ? undefined : store.getRun(runId)
    if (!run || run.state === 'finished') return false
    const mode = store.settings().overnightMode
    await runs.send(run.id, `${text}\n\n${overnightGuidance(mode)}`)
    overnightSeen.set(run.id, mode)
    return true
  }

  async function deliverAnswer(task: Task, comment: Comment, text: string): Promise<void> {
    if (!(await deliver(task, text))) store.holdAnswer(comment.id)
  }

  async function answerRound(task: Task, comment: Comment, request: AnswerRequest) {
    if (!comment.round) throw new RequestError(409, 'this round has no questions')
    const answers = roundAnswers(comment.round, request)
    return holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (current?.answer?.kind === 'superseded') {
        throw new RequestError(409, 'this request was replaced by a newer one')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at: new Date().toISOString(),
        answers,
      })
      await deliverAnswer(
        task,
        comment,
        roundAnswerMessage(comment, answers, find(task.id).clarifyDepth),
      )
      return answered
    })
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
    const human = store.runMessages(runId).filter((m) => m.queued !== true && within(m.at))
    const agent = agents
      .get(run.agent)
      .chat(store.conversation(runId), run.cwd)
      .filter((entry) => entry.kind === 'agent' && within(entry.at))
    return human.length + agent.length
  }

  async function talkThrough(commentId: string): Promise<Comment> {
    const { task, round } = openTalkRound(commentId)
    const run = talkLead(task)
    if (round.talk?.runId === run.id) return round
    const talking = store.startRoundTalk(round.id, run.id)
    await deliver(
      task,
      `The human wants to talk Round ${round.round?.number ?? ''} “${round.title ?? ''}” through with you here; when it’s settled, post a summary with \`ted ask --close --summary <file>\`.`,
    )
    return talking
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

  async function move(
    task: StoredTask,
    resolution: WorkflowResolution,
    to: AgentStageId | 'done',
    given: string | undefined,
    { signedOff = false }: { signedOff?: boolean } = {},
  ): Promise<Task> {
    if (
      to === 'done' ||
      resolution.workflow.order.indexOf(to) >
        resolution.workflow.order.indexOf(task.stage as AgentStageId)
    )
      await requireObligations(task)
    const mergeOff =
      to === 'done' && task.stage !== 'merge' && !resolution.workflow.stages.includes('merge')
    const next = mergeOff ? 'merge' : to
    const message = mergeOff ? mergeOffMessage : given
    const moved = store.changeStage(task.id, next, entryFor(resolution, next))
    if (task.stage === 'merge' && next !== 'done') {
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
    } else if (next === 'validate' && message !== undefined) {
      setChecking(task.id, true)
      inBackground(`run ${task.displayId}’s Checks`, () => validateChecks(task.id, message))
    } else if (message !== undefined) {
      await deliver(task, message)
    }
    if (next === 'merge') {
      if (tedMerges(moved, resolution.workflow)) startMerging(moved)
      watchMerge(task.id)
    }
    return moved
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
    const answered = store.answerComment(comment.id, answer, lineComments)
    if (comment.stage !== undefined) store.resetSendBacks(task.id, comment.stage)
    return answered
  }

  async function answerPermission(
    task: Task,
    comment: Comment,
    request: AnswerRequest,
    text: string,
  ): Promise<Comment> {
    if (request.action !== 'approve' && request.action !== 'deny') {
      throw new RequestError(400, 'answer a permission request with Approve or Deny')
    }
    const target = store.permissionTarget(comment.id)
    if (!target) throw new RequestError(409, 'this request can’t be answered')
    return holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      if (store.getRun(target.runId)?.state === 'finished') {
        throw new RequestError(409, 'the Run that asked has stopped')
      }
      const approved = request.action === 'approve'
      const at = new Date().toISOString()
      const answered = store.answerPermission(comment.id, {
        kind: approved ? 'approved' : 'denied',
        at,
        ...(text !== '' && { text }),
      })
      const said = permissionMessage(approved, target.command, text)
      await runs.answerPermission(target.runId, target.generation, {
        requestId: target.requestId,
        approved,
        ...(target.input !== undefined && { input: target.input }),
        ...(said !== undefined && { text: said }),
      })
      return answered
    })
  }

  function visitStart(task: Task): string {
    return store.listStageEntries(task.id).findLast((e) => e.stage === task.stage)?.at ?? ''
  }

  function lastChangesRequested(task: Task): string {
    const since = visitStart(task)
    const canceled =
      task.stage === 'merge'
        ? store
            .taskLog(task.id)
            .filter((e) => e.name === 'v1.MergeCanceled')
            .map((e) => e.at)
        : []
    return store
      .listComments(task.id)
      .flatMap((c) =>
        c.gate && c.stage === task.stage && c.answer?.kind === 'changes-requested'
          ? [c.answer.at]
          : [],
      )
      .concat(canceled)
      .filter((at) => at >= since)
      .reduce(latest, '')
  }

  function openGateRequest(task: Task): Comment | undefined {
    return store
      .listComments(task.id)
      .find((c) => c.gate && c.stage === task.stage && c.answer === undefined)
  }

  function checkBack(workflow: ResolvedWorkflow, from: AgentStageId, to: AgentStageId): void {
    if (!workflow.stages.includes(to)) {
      throw new RequestError(409, `${stageTitle(to)} isn’t on in this Factory’s Workflow`)
    }
    if (workflow.order.indexOf(to) >= workflow.order.indexOf(from)) {
      throw new RequestError(
        409,
        `\`back\` goes only to an earlier Stage; ${stageTitle(to)} isn’t before ${stageTitle(from)}`,
      )
    }
  }

  async function sendBack(
    task: StoredTask,
    resolution: WorkflowResolution,
    from: AgentStageId,
    request: Extract<ReportOutcomeRequest, { outcome: 'back' }>,
    checkRunId?: string,
    options: { counted?: boolean } = {},
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
        const request = askAboutLoop(task, workflow, {
          to,
          findings,
          title: `Validate has sent this Task back ${times}, its limit`,
          intro: `Validate has sent this Task back to ${stageTitle(to)} ${times}, its limit (max_back: ${limit}), and wants to send it back again. These are each round’s blocking Findings.`,
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
        body: `${stageTitle(from)} has sent this Task back ${times}, its limit (max_back: ${limit}). Its Findings this time:\n\n${findings}`,
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
    store.recordSendBack({
      taskId: task.id,
      from,
      to,
      findings,
      counted,
      ...(counted && { round: count + 1 }),
      ...(counted && limit !== undefined && { limit }),
      ...(checkRunId !== undefined && { checkRunId }),
    })
    if (from === 'review') store.resetSendBacks(task.id, 'validate')
    const moved = await move(task, resolution, to, backStageMessage(workflow, to, from, findings))
    return { task: moved, message: `${task.displayId} moved back to ${stageTitle(to)}` }
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
      checkRunId?: string
    },
  ): Comment {
    const rounds = [...countedValidateSendBacks(task.id).map((b) => b.findings), input.findings]
    const request = store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: input.title,
      body: [
        input.intro,
        ...rounds.map((findings, i) => `Round ${i + 1}:\n${findings.trim()}`),
      ].join('\n\n'),
      choices: loopChoices(workflow),
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
    if (verdict === 'converging') {
      store.recordSendBack({
        taskId: task.id,
        from: 'validate',
        to: check.to,
        findings: check.findings,
        counted: true,
        round: check.round,
        ...(check.limit !== undefined && { limit: check.limit }),
        ...(check.checkRunId !== undefined && { checkRunId: check.checkRunId }),
      })
      await move(
        task,
        resolution,
        check.to,
        [
          backStageMessage(workflow, check.to, 'validate', check.findings),
          `# Loop check\n\nTED checked Validate’s ${check.round} rounds of Findings and the changes between them. Verdict: converging. ${reason}`,
        ].join('\n\n'),
      )
      return
    }
    const looping = verdict === 'looping'
    const request = askAboutLoop(task, workflow, {
      to: check.to,
      findings: check.findings,
      title: looping
        ? 'Validate and Work are going round in circles'
        : `Validate has sent this Task back ${check.round} times`,
      intro: looping
        ? `TED’s loop check read Validate’s ${check.round} rounds of Findings and the changes between them, and found they’re looping: ${reason}`
        : `TED couldn’t tell whether Validate’s ${check.round} rounds are converging (${reason}), so it’s asking you.`,
      ...(check.checkRunId !== undefined && { checkRunId: check.checkRunId }),
    })
    await deliver(
      task,
      `TED’s loop check ${looping ? 'found Validate’s rounds are looping' : 'gave no verdict'}, so TED asked the human what to do (request ${request.id}). The Task stays in Validate; TED sends you their answer.`,
    )
  }

  function judge(
    task: StoredTask,
    outcome: 'passed' | 'sent-back',
    judged: ValidateJudgments | undefined,
  ): void {
    const since = visitStart(task)
    const checkRun = store
      .listCheckRuns(task.id)
      .filter((r) => r.trigger === 'validate' && r.startedAt >= since)
      .at(-1)
    const reviewer = store
      .reviewers(task.id)
      .filter((r) => r.purpose === 'review' && r.at >= since)
      .at(-1)
    const review =
      judged?.review ??
      (reviewer !== undefined && outcome === 'passed' ? { passed: true } : undefined)
    store.judgeValidate({
      taskId: task.id,
      outcome,
      ...(checkRun !== undefined && { checkRunId: checkRun.id }),
      ...(review !== undefined && { review }),
      ...(judged?.visual !== undefined && { visual: judged.visual }),
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

  async function answerLoopAsk(
    task: StoredTask,
    comment: Comment,
    choice: string,
    text: string,
    at: string,
  ): Promise<Comment | undefined> {
    const ask = store.sendBackAsk(comment.id)
    if (!ask?.loop) return undefined
    const current = find(task.id)
    if (current.stage !== 'validate') return undefined
    const resolution = await taskWorkflow(current)
    const { workflow } = resolution
    const next = workflow.next('validate') as AgentStageId | 'done'
    const choices = loopChoices(workflow)
    if (!choices.includes(choice)) return undefined
    if (choice === tryAgainChoice) checkBack(workflow, 'validate', ask.to)
    if (choice === backToDesignChoice) checkBack(workflow, 'validate', 'design')
    if (choice !== tryAgainChoice && choice !== backToDesignChoice)
      await requireObligations(current)
    const added = text === '' ? '' : `\n\nThe human added:\n\n${text}`
    const answered = answerRequest(task, comment, {
      kind: 'answered',
      at,
      choice,
      ...(text !== '' && { text }),
    })
    if (choice === tryAgainChoice) {
      const limit = workflow.settings.stages.validate?.max_back
      store.recordSendBack({
        taskId: task.id,
        from: 'validate',
        to: ask.to,
        findings: ask.findings,
        counted: true,
        round: 1,
        ...(limit !== undefined && { limit }),
        ...(ask.checkRunId !== undefined && { checkRunId: ask.checkRunId }),
      })
      await move(
        current,
        resolution,
        ask.to,
        `The human chose Try again, so Validate’s count of send-backs starts over.${added}\n\n${backStageMessage(workflow, ask.to, 'validate', ask.findings)}`,
      )
    } else if (choice === backToDesignChoice) {
      store.recordSendBack({
        taskId: task.id,
        from: 'validate',
        to: 'design',
        findings: ask.findings,
        counted: false,
      })
      await move(
        current,
        resolution,
        'design',
        `The human sent this Task back to Design from Validate.${added}\n\n${backStageMessage(workflow, 'design', 'validate', ask.findings)}`,
      )
    } else {
      pullRequestWork(task.id, 'again')
      const open = `# Open Findings\n\nThe human chose “${choice}” with Validate’s blocking Findings still open. Put them in the Task brief under “Current state” so the human sees them at ${stageTitle(next)}:\n\n${ask.findings}`
      await move(
        current,
        resolution,
        next,
        next === 'done'
          ? undefined
          : `The human moved this Task on from Validate.${added}\n\n${nextStageMessage(workflow, next)}\n\n${open}`,
      )
    }
    return answered
  }

  function live(ref: string): StoredTask {
    const task = find(ref)
    if (task.archived) throw new RequestError(409, `${task.displayId} is archived`)
    return task
  }

  function removeBlockers(taskId: string, caller: Caller, blockerId?: string): void {
    const links = store.blockers(taskId)
    const wasBlocked = links.some((l) => !l.merged)
    const runId = caller.kind === 'run' ? caller.runId : undefined
    for (const link of links) {
      if (blockerId === undefined || link.blockerId === blockerId) {
        store.removeBlocker(taskId, link.blockerId, runId)
      }
    }
    const current = find(taskId)
    if (caller.kind !== 'run' && wasBlocked && unmergedBlockers(taskId).length === 0) {
      if (current.stage === 'backlog' && current.startRequested) {
        store.setStartRequested(taskId, false)
      } else if (current.waitsForBlockers && !liveLead(current) && !current.archived) {
        store.stopTask(taskId, { runs: 0, why: 'blockers-removed' })
      }
    }
  }

  function settleDependents(taskId: string, blocked: BlockedChoice): void {
    if (blocked !== 'unblock') return
    for (const dependent of store.blockedBy(taskId)) {
      removeBlockers(dependent, { kind: 'app' }, taskId)
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

  function linearQuestions(taskId: string): Comment[] {
    return openRequests(taskId).filter(isLinearQuestion)
  }

  async function linearIssueClosed(taskId: string, issue: LinearClosed): Promise<void> {
    const task = store.getTask(taskId)
    if (!task || task.archived || task.stage === 'done' || deleting.has(taskId)) return
    const marked = `${issue.identifier} was marked ${issue.state} in Linear`
    const pastSignOff = task.stage === 'merge'
    if (!pastSignOff && !hasLiveRun(task)) {
      settleDependents(task.id, 'unblock')
      archiveNow(task, false, marked)
      wake()
      return
    }
    if (linearQuestions(taskId).length > 0) return
    store.postComment({
      taskId,
      kind: 'question',
      author: { kind: 'ted' },
      title: marked,
      body: pastSignOff
        ? `Someone marked ${issue.identifier} ${issue.state} in Linear after you signed off on this Task. TED keeps going until you choose.`
        : `Someone marked ${issue.identifier} ${issue.state} in Linear while this Task is still being worked on. TED keeps going until you choose.`,
      choices: [linearArchiveChoice, linearKeepChoice],
    })
  }

  function openTeamAsks(factoryId: string, team: string): Comment[] {
    return store
      .listOpenRequests()
      .filter(
        (c) =>
          isLinearTeamAsk(c) &&
          c.linearTeam?.key === team &&
          store.getTask(c.taskId)?.factoryId === factoryId,
      )
  }

  function askLinearTeam(taskId: string, automationName: string, issue: LinearIssue): void {
    const task = store.getTask(taskId)
    const factory = task && store.getFactory(task.factoryId)
    const link = task?.source && parseLinearUrl(task.source.url)
    if (!task || !factory || !link || !issue.team || task.linearSync !== 'ask') return
    const team = issue.team
    const settings = store.settings()
    if (!settings.linearSync) return
    if ((settings.linearSyncTeams[factory.id] ?? []).includes(team.key)) return
    if ((settings.linearSyncDeclined[factory.id] ?? []).includes(team.key)) return
    if (openTeamAsks(factory.id, team.key).length > 0) return
    const named = team.name === team.key ? team.key : `${team.name} (${team.key})`
    store.postComment({
      taskId,
      kind: 'question',
      author: { kind: 'ted' },
      title: `Sync ${named} issues with Linear for Automations in ${factory.name}?`,
      body: [
        `${automationName} made ${task.displayId} from ${link.identifier}. TED doesn’t change Linear issues for Tasks an Automation makes until you allow it for the issue’s team.`,
        `If you allow ${team.key} for ${factory.name}, TED moves each issue to In Progress when its Task starts, to review at the sign-off before Merge, and to Done when the Task merges, and attaches the Task’s pull requests. It does this for ${team.key} Tasks Automations already made in ${factory.name}, too.`,
        'Not now keeps them as they are, and TED won’t ask about this team again. You can change either in Settings → Integrations.',
      ].join('\n\n'),
      choices: [linearAllowChoice, linearNotNowChoice],
      linearTeam: team,
    })
  }

  function allowLinearTeam(factoryId: string, team: string): MachineSettings {
    const consents = store.listTasks().flatMap((task) => {
      if (task.factoryId !== factoryId || task.archived || task.linearSync !== 'ask') return []
      const link = task.source && parseLinearUrl(task.source.url)
      const seen = store.linearSync(task.id).seen
      return link && seen?.team === team ? [{ taskId: task.id, identifier: link.identifier }] : []
    })
    const settings = store.allowLinearTeam(factoryId, team, consents)
    closeTeamAsks(factoryId, team, linearAllowChoice)
    return settings
  }

  function declineLinearTeam(factoryId: string, team: string): void {
    const declined = store.settings().linearSyncDeclined
    const listed = declined[factoryId] ?? []
    if (!listed.includes(team)) {
      store.updateSettings({ linearSyncDeclined: { ...declined, [factoryId]: [...listed, team] } })
    }
    closeTeamAsks(factoryId, team, linearNotNowChoice)
  }

  function answerLinearTeam(
    task: Task,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Comment {
    if (comment.answer?.kind === 'withdrawn') {
      throw new RequestError(409, 'this request was withdrawn')
    }
    if (comment.answer) throw new RequestError(409, 'this request has already been answered')
    const team = comment.linearTeam?.key
    if (team === undefined) throw new RequestError(400, 'this question isn’t about a Linear team')
    if (text !== '') {
      throw new RequestError(
        400,
        `answer with ${linearAllowChoice} or ${linearNotNowChoice}; this question doesn’t reach the Task Lead`,
      )
    }
    if (choice === linearAllowChoice) allowLinearTeam(task.factoryId, team)
    else if (choice === linearNotNowChoice) declineLinearTeam(task.factoryId, team)
    else throw new RequestError(400, `answer with ${linearAllowChoice} or ${linearNotNowChoice}`)
    return store.getComment(comment.id) ?? comment
  }

  function closeTeamAsks(factoryId: string, team: string, choice: string): void {
    const at = new Date().toISOString()
    for (const ask of openTeamAsks(factoryId, team)) {
      store.answerComment(ask.id, { kind: 'answered', at, choice })
    }
  }

  function withdrawLinearQuestions(taskId: string, why: 'reopened' | 'done'): void {
    for (const question of linearQuestions(taskId)) {
      store.answerComment(question.id, {
        kind: 'withdrawn',
        at: new Date().toISOString(),
        linear: why,
      })
    }
  }

  function archiveNow(task: StoredTask, closePullRequests: boolean, why?: string): Task {
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

  async function unarchive(ref: string): Promise<Task> {
    const task = find(ref)
    if (!task.archived || deleting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} isn’t archived`)
    }
    await clearingAway.get(task.id)?.catch(() => undefined)
    await pullRequestQueue.get(task.id)
    const current = find(task.id)
    if (!current.archived || deleting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} isn’t archived`)
    }
    const midFlow = current.stage !== 'backlog' && current.stage !== 'done'
    store.unarchiveTask(task.id, {
      queue: midFlow,
      waitForBlockers: midFlow && unmergedBlockers(task.id).length > 0,
    })
    if (midFlow && current.repos.some((r) => r.pullRequest?.state === 'closed')) {
      pullRequestWork(task.id, 'reopen')
    }
    await pump()
    wake()
    return publicTask(task.id)
  }

  async function remove(ref: string, { blocked = 'unblock' }: DeleteTaskRequest): Promise<void> {
    const task = find(ref)
    if (deleting.has(task.id))
      throw new RequestError(409, `${task.displayId} is already being deleted`)
    deleting.add(task.id)
    try {
      options.planning?.()?.taskGone(task.id, 'deleted')
      settleDependents(task.id, blocked)
      if (!find(task.id).archived) archiveNow(find(task.id), false)
      await clearing(task.id)
      await pullRequestQueue.get(task.id)
      const last = find(task.id)
      const runIds = store.taskRunList(task.id).map((r) => r.id)
      const files = store.taskFiles(task.id)
      failures.forget(task.id)
      store.deleteTask(task.id)
      await store.persisted()
      await removeFiles(last, runIds, files)
    } finally {
      deleting.delete(task.id)
    }
    wake()
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
    await gone(worktreesDir, task.displayId)
    await gone(sandboxDir, task.displayId)
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
    settingUp.get(taskId)?.abort()
    for (const [key, cancel] of repoSetups) if (key.startsWith(`${taskId}:`)) cancel.abort()
    await beginning.get(taskId)?.catch(() => undefined)
    settingUp.get(taskId)?.abort()
    subAgents.dropFor(taskId)
    const task = find(taskId)
    await Promise.all(task.runs.map((run) => runs.stop(run.id)))
    if (!task.repos.some((r) => !r.removed) && !task.worktree) return
    const resolution = await taskWorkflow(task, { fetch: false })
    await finish(find(taskId), resolution)
  }

  const creatingSetup = new Set<string>()

  function openSetupTask(factoryId: string): Task | undefined {
    return store
      .listTasks()
      .find((t) => t.factoryId === factoryId && t.setup && !t.archived && t.stage !== 'done')
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
      lead: leadFrom(resolution?.workflow.settings),
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
    const setupTasks = store.listTasks().filter((t) => t.factoryId === factoryId && t.setup)
    const open = openSetupTask(factoryId)
    const done =
      factoryHasSettings(factoryId) ||
      setupTasks.length === 0 ||
      setupTasks.some((t) => store.isMerged(t.id))
    if (done || factory.clonedAt === undefined) {
      if (store.getBanner(bannerId(ref))) banners.clear(ref)
      return
    }
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

  async function start(ref: string): Promise<Task> {
    const task = live(ref)
    autoStartFailures.delete(task.id)
    if (!(await queueStart(task.id))) return publicTask(task.id)
    await pump()
    await beginning.get(task.id)
    return publicTask(task.id)
  }

  async function queueStart(ref: string, version?: number): Promise<boolean> {
    const automatic = version !== undefined
    const task = live(ref)
    const factory = factoryOf(task)
    if (task.stage !== 'backlog' || starting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} has already started`)
    }
    if (unmergedBlockers(task.id).length > 0) {
      if (!automatic) store.setStartRequested(task.id, true)
      return false
    }
    starting.add(task.id)
    try {
      await clearingAway.get(task.id)?.catch(() => undefined)
      if (cloned(factory.id)) await ensureClone({ banners, reposDir }, factory)
      const resolution = await taskWorkflow(task, { fetch: false })
      const current = live(task.id)
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
      if (!current.lead) store.setTaskLead(task.id, leadFrom(resolution.workflow.settings))
      const planned = find(task.id).markers.some((m) => m.kind === 'needs-planning')
      const stage = resolution.workflow.next('backlog')
      if (planned) {
        const again = resolution.workflow.stages.includes('clarify') ? 'clarify' : stage
        store.startAfterPlanning(task.id, again, entryFor(resolution, again as AgentStageId))
      } else {
        store.queueTask(task.id, stage)
      }
    } finally {
      starting.delete(task.id)
    }
    return true
  }

  async function launchQueued(taskId: string): Promise<void> {
    const task = find(taskId)
    const factory = factoryOf(task)
    if (task.repos.some((r) => !r.removed)) {
      const resolution = await taskWorkflow(task, { fetch: false })
      const env = leadEnv(task, factoryRepos(resolution.workflow, factory))
      const pickUp = freshRunNote(task)
      const interrupted = interruptedSetups(task)
      if (interrupted.length > 0) {
        await setUpAndLaunch(find(task.id), resolution, interrupted, env, pickUp)
      } else {
        await launch(find(task.id), resolution, env, undefined, { pickUp })
      }
      store.dequeue(task.id)
      if (store.taskLog(task.id).findLast(asksForFreshRun)?.name === 'v1.GitHubActivityQueued') {
        watch?.kick()
      }
      return
    }
    if (task.repos.length > 0) return reopenWorktree(task)
    const resolution = await taskWorkflow(task, { fetch: false })
    if (!task.lead) store.setTaskLead(task.id, leadFrom(resolution.workflow.settings))
    const stage = resolution.workflow.next('backlog') as AgentStageId
    const chosen = chosenEntries(
      find(task.id).chosenRepos,
      factoryRepos(resolution.workflow, factory),
    )
    const clones = await Promise.all(chosen.map((entry) => cloneFor(factory, entry)))
    const branch = await branchFor(clones, task)
    const opened: (NewWorktree & { branch: string; worktree: string })[] = []
    try {
      for (const entry of chosen)
        opened.push(await openWorktree(task, factory, entry, branch, true))
    } catch (error) {
      for (const made of opened) {
        const clone = clonePath(reposDir, made)
        await git.removeWorktree(clone, made.worktree).catch(() => undefined)
        await git.deleteBranch(clone, branch).catch(() => undefined)
      }
      throw error
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
    for (const made of rest) store.worktreeCreated(task.id, made)
    const started = find(task.id)
    const env = chosen[0]?.env ?? {}
    const steps = setupSteps(started, chosen)
    if (steps.length > 0) {
      inBackground(`set up ${task.displayId}’s worktree`, () =>
        setUpAndLaunch(started, resolution, steps, env),
      )
    } else {
      await launch(started, resolution, env)
    }
  }

  async function reopenWorktree(task: StoredTask): Promise<void> {
    const factory = factoryOf(task)
    const resolution = await taskWorkflow(task, { fetch: false })
    const chosen = chosenEntries(task.chosenRepos, factoryRepos(resolution.workflow, factory))
    const fallback = task.branch ?? task.repos[0]?.branch
    if (fallback === undefined) return
    for (const entry of chosen) {
      const old = task.repos.findLast((r) => sameRepo(r.repo, entry.repo))
      store.worktreeCreated(
        task.id,
        await openWorktree(task, factory, entry, old?.branch ?? fallback, false),
      )
    }
    store.dequeue(task.id)
    const started = find(task.id)
    const pickUp = freshRunNote(started)
    const env = chosen[0]?.env ?? {}
    const steps = setupSteps(started, chosen)
    if (steps.length > 0) {
      inBackground(`set up ${task.displayId}’s worktree`, () =>
        setUpAndLaunch(started, resolution, steps, env, pickUp),
      )
    } else {
      await launch(started, resolution, env, undefined, { pickUp })
    }
  }

  function pendingPickUp(task: StoredTask): string | undefined {
    const log = store.taskLog(task.id)
    const asked = log.findLastIndex(asksForFreshRun)
    const started = log.findLastIndex(
      (e) => e.name === 'v2.RunStarted' || e.name === 'v3.RunStarted',
    )
    return asked > started ? freshRunNote(task) : undefined
  }

  function movedByApproval(task: StoredTask, answers: readonly Comment[]): boolean {
    if (task.stage === 'backlog' || task.stage === 'done') return false
    return answers.some((c) => c.gate && c.answer?.kind === 'approved' && c.stage !== task.stage)
  }

  function freshRunNote(task: StoredTask): string {
    const last = store.taskLog(task.id).findLast(asksForFreshRun)
    if (last?.name === 'v1.TaskRetried' || last?.name === 'v1.TaskLeadFailed') {
      return fromTheBrief(task, freshAfterFailure(last))
    }
    if (last?.name === 'v1.TaskUnarchived') {
      return fromTheBrief(task, {
        heading: 'Picking up after unarchiving',
        why: 'The human archived this Task and has now unarchived it. TED made its worktree again from the branch, so anything that wasn’t committed is gone.',
      })
    }
    if (last?.name === 'v1.GitHubActivityQueued') {
      const notices = Array.isArray(last.data.notices) ? (last.data.notices as GitHubNotice[]) : []
      return fromTheBrief(task, {
        heading: 'Picking up after activity on GitHub',
        why: freshRunReason(gitHubSummary(notices)),
      })
    }
    if (last?.name === 'v1.TaskStartedAfterPlanning') {
      return fromTheBrief(task, {
        heading: 'Picking up after planning outside TED',
        why: afterPlanningWhy,
      })
    }
    if (last?.name === 'v1.TaskResumed') {
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
      link: { automationId: automation.id, firingId: firing.id },
    }
  }

  const runsInBypass = (resolution: WorkflowResolution | undefined) =>
    resolution?.workflow.settings.permissions === 'bypass'

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
      const clash = sourceClash(store.listTasks(), original.factoryId, url)
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
    const task = await store.createTask({
      title: input.title?.trim() || firstLine(text) || `Follow-up to ${original.displayId}`,
      description: text,
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
    if (input.automation && issue) askLinearTeam(task.id, input.automation.name, issue)
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

  function unmergedBlockers(taskId: string) {
    return store.blockers(taskId).filter((b) => !b.merged)
  }

  function shouldStopForBlockers(task: StoredTask, run: Run): boolean {
    return (
      run.state === 'idle' &&
      task.stage !== 'backlog' &&
      task.stage !== 'done' &&
      unmergedBlockers(task.id).some((b) => b.setByRunId === run.id)
    )
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
    for (const { id } of store.listTasks()) {
      const task = store.getTask(id)
      if (!task || task.blockedBy.length === 0 || queued.has(id) || starting.has(id)) continue
      if (task.archived || task.stopped) continue
      if (unmergedBlockers(id).length > 0) continue
      if (task.stage === 'backlog' && task.startRequested) {
        inBackground(`start ${task.displayId}`, async () => {
          await start(id)
        })
      } else if (task.waitsForBlockers && !liveLead(task)) {
        store.requeueAfterBlockers(id)
      }
    }
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

  async function leadStopped(run: Run, signedOut?: string): Promise<void> {
    if (run.taskId === undefined) return
    const silence = silent.get(run.id)
    silent.delete(run.id)
    pausedAt.delete(run.id)
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.stage === 'backlog' || task.stage === 'done') {
      return
    }
    const [checked] = await health.check([run.agent])
    if (checked?.state === 'ready' && signedOut === undefined) {
      const ended = store.getRun(run.id)?.ended
      if (silence !== undefined || (ended !== undefined && ended.how !== 'stopped')) {
        await leadFailed(run.id, silence)
      }
      return
    }
    const now = store.getTask(task.id)
    if (!now || now.leadRunId !== run.id || now.stage === 'done') return
    if (now.waitsForBlockers || now.stopped) return
    if (signedOut !== undefined) {
      const held = new Set(store.heldAnswers(task.id).map((c) => c.id))
      for (const comment of store.listComments(task.id)) {
        const at = comment.answer?.at
        const unread = at !== undefined && at >= signedOut && answerText(comment) !== undefined
        if (unread && !held.has(comment.id)) store.holdAnswer(comment.id)
      }
    }
    store.holdTaskRun({
      taskId: task.id,
      agent: run.agent,
      ...(run.sessionId !== undefined && { sessionId: run.sessionId }),
    })
    void pump()
  }

  async function leadFailed(runId: string, silence?: string): Promise<void> {
    if (recovering.has(runId)) return
    recovering.add(runId)
    try {
      await recover(runId, silence)
    } finally {
      recovering.delete(runId)
    }
  }

  async function recover(runId: string, silence?: string): Promise<void> {
    const run = store.getRun(runId)
    if (!run?.taskId || run.state !== 'finished') return
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.archived || task.stopped) return
    if (task.stage === 'backlog' || task.stage === 'done' || task.waitsForBlockers) return
    if (task.status?.kind === 'failed' || stoppingByHand.has(task.id)) return
    if (stoppingForBlockers.has(task.id) || store.queue().some((q) => q.id === task.id)) return
    if (store.heldRuns().some((h) => h.taskId === task.id)) return
    const log = store.taskLog(task.id)
    if (alreadyFailed(log, run.id, run.revivedAt ?? run.startedAt)) return
    const ended = run.ended
    const reason = silence ?? endingReason(ended)
    const resumeFailed = silence === undefined && ended?.resumeFailed === true
    const now = Date.now()
    const earlier = recentFailures(log, now)
    const canResume =
      run.sessionId !== undefined &&
      (task.lead?.agent ?? run.agent) === run.agent &&
      store.newWorkHold() === undefined
    const recovery = resumeFailed
      ? 'fresh'
      : earlier.length > 0
        ? 'failed'
        : canResume
          ? 'resume'
          : 'fresh'
    const first = earlier[0]
    store.leadFailed({
      taskId: task.id,
      runId: run.id,
      reason,
      recovery,
      resumeFailed,
      ...(recovery === 'failed' && {
        ask: failedAsk(run.agent, first ? log.slice(log.indexOf(first)) : [], reason, ended, now),
      }),
    })
    if (recovery === 'resume') awaitingRevive.add(task.id)
    void pump()
  }

  function pendingRevive(
    taskId: string,
  ): { task: StoredTask; run: Run; reason: string } | undefined {
    const task = store.getTask(taskId)
    if (!task || task.archived || task.stopped || task.waitsForBlockers) return undefined
    if (task.stage === 'backlog' || task.stage === 'done') return undefined
    const last = store.taskLog(taskId).findLast((e) => e.name === 'v1.TaskLeadFailed')
    if (last?.data.recovery !== 'resume') return undefined
    const run = store.getRun(String(last.data.runId))
    if (run?.state !== 'finished' || task.leadRunId !== run.id) return undefined
    if (run.revivedAt !== undefined && run.revivedAt >= last.at) return undefined
    return { task, run, reason: String(last.data.reason) }
  }

  async function reviveLead(taskId: string): Promise<void> {
    const release = hold(taskId)
    const pending = pendingRevive(taskId)
    if (!pending) return release()
    const { task, run, reason } = pending
    try {
      const repo = task.repos.find((r) => !r.removed)
      const env = (repo && store.recordedSetup(task.id, repo.name)?.env) ?? {}
      await runs.revive(run.id, {
        prompt: [
          overnightGuidance(store.settings().overnightMode),
          revivedMessage(reason),
          ...editedSince(task),
        ].join('\n\n'),
        env: { ...env, TED_TASK: task.displayId },
      })
      await sendWaiting(task.id)
    } catch (error) {
      console.error(`couldn’t resume ${task.displayId}’s Task Lead session:`, error)
      const now = store.getTask(task.id)
      if (now && !now.stopped && !now.archived && store.getRun(run.id)?.state === 'finished') {
        store.leadFailed({
          taskId: task.id,
          runId: run.id,
          reason,
          recovery: 'fresh',
          resumeFailed: true,
        })
      }
    } finally {
      release()
    }
  }

  function checkSilence(): void {
    if (closed) return
    const paused = store.agentPauses()
    const now = Date.now()
    for (const run of store.listRuns()) {
      if (run.state !== 'working' || run.taskId === undefined || silent.has(run.id)) {
        if (run.state === 'waiting') pausedAt.set(run.id, now)
        else if (run.state !== 'working') pausedAt.delete(run.id)
        continue
      }
      if (store.getTask(run.taskId)?.leadRunId !== run.id) continue
      if (paused[run.agent] !== undefined) {
        pausedAt.set(run.id, now)
        continue
      }
      const heard = [store.lastOutputAt(run.id), run.revivedAt, run.startedAt]
        .flatMap((at) => (at === undefined ? [] : [Date.parse(at)]))
        .concat(pausedAt.get(run.id) ?? [], runs.lastHeard(run.id) ?? [])
      if (now - Math.max(...heard) < stallAfterMs) continue
      silent.set(run.id, silentReason(stallAfterMs))
      inBackground('stop a silent Task Lead', () => runs.stop(run.id))
    }
  }

  async function stopByHand(ref: string): Promise<Task> {
    const task = live(ref)
    if (task.stage === 'done') throw new RequestError(409, `${task.displayId} is done`)
    const started =
      task.stage !== 'backlog' &&
      (task.leadRunId !== undefined || task.repos.length > 0 || beginning.has(task.id))
    if (!started) {
      throw new RequestError(409, `${task.displayId} hasn’t started, so there’s nothing to stop`)
    }
    if (task.stopped || stoppingByHand.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is already stopped`)
    }
    stoppingByHand.add(task.id)
    try {
      if (store.heldRuns().some((h) => h.taskId === task.id)) store.releaseTaskRun(task.id)
      store.stopTask(task.id, { runs: task.runs.length, why: 'human' })
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

  async function resumeByHand(
    ref: string,
    { comment, attachments = [] }: { comment?: string; attachments?: Attachment[] } = {},
  ): Promise<Task> {
    const task = live(ref)
    const interrupted =
      task.canResume &&
      canStartFresh(task) &&
      !advancing.has(task.id) &&
      !pendingRevive(task.id) &&
      !recovering.has(task.leadRunId ?? '')
    if (!task.stopped && task.status?.kind !== 'failed' && !interrupted) {
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
        lineComments: drafts(task.id),
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
      if (timer) clearTimeout(timer)
      nudgeTimers.delete(run.id)
      if (run.state === 'working' && run.taskId !== undefined) {
        if (store.getTask(run.taskId)?.leadRunId === run.id) {
          closeIdleQuestion(run.taskId, 'The Task Lead carried on.')
        }
      }
      return
    }
    if (timer || run.taskId === undefined) return
    const next = setTimeout(() => {
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
    if (task.stage === 'backlog' || task.stage === 'done' || advancing.has(task.id)) return
    if (merging.has(task.id)) return
    if (store.heldRuns().some((h) => h.taskId === task.id)) return
    if (stoppingForBlockers.has(task.id) || shouldStopForBlockers(task, run)) return
    if (openRequests(task.id).some((c) => !isLinearTeamAsk(c))) return
    if (planningInChat(task.id)) return
    const nudged = store
      .taskLog(task.id)
      .findLast((e) => e.name === 'v1.TaskLeadNudged' && e.data.runId === run.id)?.at
    if (nudged === undefined || heardSince(task, nudged)) await sendNudge(task, run)
    else askAboutIdle(task, run)
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
    const said = store
      .conversation(run.id)
      .map(({ line }) => agent.agentTextFrom(line))
      .findLast((text) => text !== undefined && text.trim() !== '')
    const quoted = said === undefined ? undefined : oneLine(said, 500)
    store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: idleTitle,
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

  const stoppedMidTurn = (runId: string) => {
    interrupted.add(runId)
    turnEnding.add(runId)
  }

  options.steering.addSource({
    pending(run) {
      if (run.state !== 'working' || run.taskId === undefined) return []
      const task = store.getTask(run.taskId)
      const mode = store.settings().overnightMode
      if (task?.leadRunId !== run.id || overnightSeen.get(run.id) === mode) return []
      return [
        {
          id: `overnight:${mode}`,
          text: overnightGuidance(mode),
          at: overnightChangedAt,
        },
      ]
    },
    delivered(run, ids) {
      overnightSeen.set(run.id, ids.includes('overnight:true'))
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
      if (!signedOutAt.has(run.id)) signedOutAt.set(run.id, new Date().toISOString())
      if (run.state !== 'finished') stoppedMidTurn(run.id)
      health.authFailed(run.agent)
    },
    usage(run, signal) {
      if (!signal.limited) {
        if (store.agentPauses()[run.agent] !== undefined) health.usable(run.agent)
        return
      }
      if (run.state !== 'finished') stoppedMidTurn(run.id)
      health.limited(run.agent, signal.resetsAt)
    },
    credential(run, report) {
      if (!health.credentialReported(run.agent, report) || run.state === 'finished') return
      stoppedMidTurn(run.id)
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
    settled(run) {
      if (!interrupted.has(run.id)) signedOutAt.delete(run.id)
      turnEnding.delete(run.id)
      if (!readyMidTurn.delete(run.id) || store.agentPauses()[run.agent] !== undefined) return
      if (!interrupted.delete(run.id)) return
      runs.send(run.id, continueMessage).catch((error: unknown) => console.error(error))
    },
    accepted(run, texts) {
      markAccepted(run, texts)
      const timer = nudgeTimers.get(run.id)
      if (timer) clearTimeout(timer)
      nudgeTimers.delete(run.id)
      setImmediate(() => {
        if (closed) return
        const now = store.getRun(run.id)
        if (now) watchIdle(now)
      })
    },
    finished(run) {
      interrupted.delete(run.id)
      turnEnding.delete(run.id)
      readyMidTurn.delete(run.id)
      const signedOut = signedOutAt.get(run.id)
      signedOutAt.delete(run.id)
      inBackground(`check why Run ${run.id} stopped`, () => leadStopped(run, signedOut))
    },
  })

  health.onReady((agent) => {
    void pump()
    for (const runId of [...interrupted]) {
      const run = store.getRun(runId)
      if (run && run.state !== 'finished' && run.agent !== agent) continue
      if (run?.state === 'working' && turnEnding.has(runId)) {
        readyMidTurn.add(runId)
        continue
      }
      interrupted.delete(runId)
      if (run && run.state !== 'finished' && run.state !== 'working') {
        runs.send(runId, continueMessage).catch((error: unknown) => console.error(error))
      }
    }
  })

  health.onPaused((agent, state) => {
    if (state !== 'offline') return
    for (const run of store.listRuns()) {
      if (run.agent === agent && run.state === 'working') interrupted.add(run.id)
    }
  })

  health.onProbe((agent) => {
    const run = [...interrupted]
      .map((id) => store.getRun(id))
      .find((r) => r !== undefined && r.agent === agent && r.state !== 'finished')
    if (!run) return false
    interrupted.delete(run.id)
    runs.send(run.id, continueMessage).catch((error: unknown) => console.error(error))
    return true
  })

  const paused = store.agentPauses()
  for (const run of store.listRuns()) {
    if (run.state === 'finished') continue
    const agent = agents.get(run.agent)
    const recent = store.conversation(run.id).slice(-5)
    const limit = recent.map(({ line }) => agent.usageFrom(line)).findLast((u) => u !== undefined)
    if (limit?.limited) {
      interrupted.add(run.id)
      health.limited(run.agent, limit.resetsAt)
      continue
    }
    if (paused[run.agent] === undefined) continue
    if (recent.some(({ line }) => agent.authErrorFrom(line))) interrupted.add(run.id)
  }

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

  for (const task of store.listTasks()) {
    if (pendingRevive(task.id)) {
      awaitingRevive.add(task.id)
      continue
    }
    const run = task.leadRunId === undefined ? undefined : store.getRun(task.leadRunId)
    if (run?.state === 'finished' && run.ended && run.ended.how !== 'stopped') {
      inBackground(`check why Run ${run.id} stopped`, () => leadStopped(run))
    }
  }

  const silenceTimer = setInterval(checkSilence, Math.min(60_000, Math.max(50, stallAfterMs / 4)))
  silenceTimer.unref()

  for (const checkRun of store.listCheckRuns().filter((r) => r.finishedAt === undefined)) {
    const task = store.getTask(checkRun.taskId)
    const restart = checkRun.trigger === 'validate' && task?.stage === 'validate'
    if (restart) setChecking(task.id, true)
    store.finishChecks(checkRun.id, 'interrupted')
    if (restart) {
      inBackground(`run ${task.displayId}’s Checks again`, () => validateChecks(task.id))
    }
  }

  for (const check of store.loopChecks().filter((c) => c.verdict === undefined)) {
    inBackground('wait for a loop check', () => awaitLoopCheck(check))
  }

  const stopPumping = store.subscribe((event) => {
    if (event.type === 'settings-changed') {
      overnightChangedAt = new Date().toISOString()
      for (const run of store.listRuns()) {
        if (run.state === 'working') options.steering.syncQueuedFlag(run.id)
      }
    }
    if (event.type === 'run-updated') {
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
    if (event.type === 'task-updated' && event.task.stage === 'done') {
      setImmediate(() => {
        if (!closed) wake()
      })
    }
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
      const { factoryId } = event.task
      setImmediate(() => {
        if (!closed) reportSetup(factoryId)
      })
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
    inBackground('stop a blocked Task Lead', () => stopForBlockers(task.id))
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
        env: Object.entries(checkEnv(task.displayId, e.env, options.env?.() ?? process.env)).sort(
          ([a], [b]) => a.localeCompare(b),
        ),
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
    const context = {
      version: 2 as const,
      ciFailures: ciFailures.sort(),
      repos: repos.sort((a, b) => a.repo.localeCompare(b.repo)),
      checks,
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
      const stillOn = await turnOffAutoMerge(task.id)
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
  async function requireObligations(task: Task, observed?: PullRequestRead): Promise<void> {
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
        `Unresolved failure cases hold this Task: ${result.blockers.join(', ')}`,
      )
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
      return work(current, runId)
    })
  }

  return {
    failureContext(ref, id, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      const context = store.failures.context(id)
      if (!context || context.taskId !== task.id)
        throw new RequestError(404, 'no tested context on this Task')
      return context
    },
    async listFailures(ref, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      return failures.list(task)
    },
    async validationObligations(ref, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      await untilFree(task.id)
      return holding(find(task.id), () => failures.obligations(find(task.id)))
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
    requestFailureDecision: (ref, caller, id) =>
      failureLead(ref, caller, (task, runId) => failures.request(task, id, runId)),
    async resolveFailure(ref, id, input) {
      const task = find(ref)
      await untilFree(task.id)
      return holding(find(task.id), () => failures.resolve(find(task.id), id, input))
    },
    async create(
      {
        title,
        factory: givenKey,
        blockedBy = [],
        start: startNow,
        lead,
        source: sourceUrl,
        sentryId,
        followUp,
        ...fields
      },
      caller = { kind: 'app' },
    ) {
      if (fields.draftRevision !== undefined && caller.kind !== 'app') {
        throw new RequestError(403, 'only the app can consume a New Task draft')
      }
      const automation = automationCaller(caller)
      const key = automation?.factoryKey ?? givenKey
      if (automation && givenKey !== undefined && givenKey !== automation.factoryKey) {
        throw new RequestError(
          403,
          `this Automation creates Tasks only in ${automation.factoryKey}, its own Factory`,
        )
      }
      const factory =
        key === undefined ? undefined : store.listFactories().find((f) => f.key === key)
      if (key !== undefined && !factory) throw new RequestError(404, `no Factory with key ${key}`)
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
      const refuseTracked = () => {
        if (sourceUrl === undefined || !factory || caller.kind === 'app') return
        const clash = sourceClash(store.listTasks(), factory.id, sourceUrl)
        if (clash) throw new RequestError(409, clashMessage(clash))
      }
      refuseTracked()
      const issue = sourceUrl === undefined ? undefined : await linearIssue(sourceUrl)
      const linearFiles = await storedFiles(issue?.files ?? [])
      const name =
        title?.trim() || issue?.title || firstLine(fields.description ?? '') || sourceUrl || ''
      if (name === '') throw new RequestError(400, 'a Task needs a title or a description')
      const blockers = [...new Set(blockedBy.map((ref) => find(ref).id))]
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
      const task = await store.createTask({
        ...fields,
        ...(fields.description !== undefined && { description: fields.description.trim() }),
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
        lead: lead ?? leadFrom(resolution?.workflow.settings),
        blockedBy: blockers,
        startRequested: startNow === true && !held,
        ...(factory && { factoryId: factory.id }),
        ...(automation && { automation: automation.link }),
        linearConsent: caller.kind === 'app',
      })
      if (issue) noteUnfetched(task.id, issue, linearFiles)
      if (automation && issue) askLinearTeam(task.id, automation.name, issue)
      if (!factory) return task
      if (automation && runsInBypass(resolution)) return holdInBacklog(task.id, automation.name)
      if (!resolution) {
        console.error(
          `couldn’t read ${factory.repo}’s Workflow; ${task.displayId} waits in Backlog:`,
          failure,
        )
      }
      if (!resolution || unmergedBlockers(task.id).length > 0) return task
      const hasBacklog = resolution.workflow.stages.includes('backlog')
      return hasBacklog && startNow !== true ? task : start(task.id)
    },

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
      const choices = resolveAgentChoices(resolution.workflow.settings, {
        claude: agents.installed('claude'),
        codex: agents.installed('codex'),
      })
      return {
        lead: choices.lead,
        planner: choices.planner,
        clarifyDepth: clarifyDepths.find((d) => d === depth) ?? 'auto',
      }
    },

    async board(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, `no Factory ${factoryId}`)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      return { stages: boardStages(resolution.workflow) }
    },

    start,
    stop: stopByHand,
    resume: resumeByHand,

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
      if (task.linearSync === 'on') return publicTask(task.id)
      store.linearSyncAllowed(task.id, link.identifier)
      return publicTask(task.id)
    },

    allowLinearTeam(factoryId, team) {
      if (!store.getFactory(factoryId)) throw new RequestError(404, `no Factory ${factoryId}`)
      return allowLinearTeam(factoryId, team.toUpperCase())
    },

    archive(ref, { closePullRequests = false, blocked = 'unblock' } = {}) {
      const task = live(ref)
      if (deleting.has(task.id)) throw new RequestError(409, `${task.displayId} is being deleted`)
      settleDependents(task.id, blocked)
      const archived = archiveNow(find(task.id), closePullRequests)
      wake()
      return archived
    },

    unarchive,
    delete: remove,
    removeFactoryTasks,

    archiveDone(key) {
      const factory = store.listFactories().find((f) => f.key === key || f.id === key)
      if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
      const done = store
        .listTasks()
        .filter((t) => t.factoryId === factory.id && t.stage === 'done' && !t.archived)
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
        title: firstLine(text) || `Follow-up to ${original.displayId}`,
        description: text,
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
      const existing = store.blockers(task.id).find((b) => b.blockerId === blocker.id)
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
      const links = store.blockers(task.id)
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
    mergesInFlight: () => mergeInFlight.size,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
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
        if (task.archived) {
          throw new RequestError(409, `${task.displayId} is archived; unarchive it to comment`)
        }
        if (publicTask(task.id).commentBox === 'merge-pending') {
          throw new RequestError(
            409,
            `TED is merging ${task.displayId}’s pull requests. Sending a Comment now cancels the merge and counts as Request changes; use Send and cancel merge.`,
          )
        }
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
      if (old.gate) throw new RequestError(409, 'a Gate request can’t be superseded')
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

    async taskGates(ref) {
      return gatesFor(find(ref).id)
    },

    async setTaskGates(ref, caller, request) {
      if (caller.kind !== 'app')
        throw new RequestError(403, 'only the TED app can change Task Gates')
      const id = find(ref).id
      await untilFree(id)
      return holding(find(id), async () => {
        const before = await gatesFor(id)
        if (before.revision !== request.revision) {
          throw new RequestError(
            409,
            'Task Gates changed while you were editing. Reopen the editor and try again.',
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
        .filter((c) => c.author.kind !== 'human' && c.readAt === undefined)
      store.commentsRead(unread.map((c) => c.id))
      return unread.length
    },

    threadEvents(ref) {
      const task = find(ref)
      return threadEvents(task.id, store.taskLog(task.id), {
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
      return waitingItems(store.listOpenRequests(), store.listTasks())
    },

    answered() {
      return answeredItems(store.listAnsweredRequests(), store.listTasks(), new Date())
    },

    talkThrough: (id) => talkThrough(id),
    doneTalking: (id) => doneTalking(id),
    closeRound: (ref, caller, summary) => closeRound(ref, caller, summary),

    async answer(id, request) {
      const answering = store.getComment(id)
      if (answering) await untilFree(answering.taskId)
      const comment = store.getComment(id)
      if (!comment) throw new RequestError(404, `no Comment ${id}`)
      if (comment.kind === 'note') throw new RequestError(400, 'a note has nothing to answer')
      const task = find(comment.taskId)
      const failure = failures.findDecision(id)
      if (failure) {
        if (comment.answer)
          throw new RequestError(409, 'this failure decision is stale or already answered')
        if (request.action === 'answer' && request.choice === undefined && request.text?.trim()) {
          await holding(task, () =>
            humanComment(find(task.id), failureText(request.text ?? ''), []),
          )
          return store.getComment(id) as Comment
        }
        if (request.action !== 'answer' || request.choice === undefined)
          throw new RequestError(400, 'choose a failure resolution')
        const resolution = (Object.keys(failureChoices) as (keyof typeof failureChoices)[]).find(
          (key) => failureChoices[key] === request.choice,
        )
        if (!resolution) throw new RequestError(400, 'choose a failure resolution')
        return holding(task, async () => {
          await failures.resolve(find(task.id), failure.id, {
            requestId: id,
            resolution,
            ...(request.text !== undefined && { reason: request.text }),
          })
          return store.getComment(id) as Comment
        })
      }
      if (comment.kind === 'round') return answerRound(task, comment, request)
      if (comment.kind === 'proposal') return answerProposal(task, comment, request)
      if (request.action === 'answer-round' || request.action === 'accept-recommended') {
        throw new RequestError(400, `a ${comment.kind} request isn’t a round`)
      }
      const text = request.text?.trim() ?? ''
      if (comment.simulator) {
        return holding(task, () => apps.answerSimulator(comment, request, text))
      }
      if (comment.kind === 'permission') return answerPermission(task, comment, request, text)
      if (comment.gate) {
        if (request.action === 'request-changes') {
          if (text === '') throw new RequestError(400, 'Request changes needs your comment')
        } else if (request.action !== 'approve') {
          throw new RequestError(400, 'answer a Gate request with Approve or Request changes')
        }
      } else if (comment.kind !== 'question') {
        throw new RequestError(400, `TED can’t answer a ${comment.kind} request yet`)
      } else if (request.action !== 'answer') {
        throw new RequestError(400, 'answer a question with a choice or your own words')
      } else if (request.choice !== undefined && !comment.choices?.includes(request.choice)) {
        throw new RequestError(400, `“${request.choice}” isn’t one of the question’s choices`)
      } else if (request.choice === undefined && text === '') {
        throw new RequestError(400, 'pick a choice or write an answer')
      }
      if (isLinearTeamAsk(comment) && request.action === 'answer') {
        return answerLinearTeam(task, comment, request.choice, text)
      }
      if (
        comment.sizeCheck &&
        comment.answer === undefined &&
        request.action === 'answer' &&
        request.choice !== undefined
      ) {
        return answerSizeCheck(task, comment, request.choice, text)
      }
      if (isCiStuck(comment) && comment.answer === undefined && request.action === 'answer') {
        return answerCiStuck(task, comment, request.choice, text)
      }
      if (comment.failed !== undefined && comment.answer === undefined) {
        if (request.action === 'answer' && request.choice === retryChoice) {
          await resumeByHand(task.id, { comment: text })
        } else {
          await humanComment(find(task.id), text, [])
        }
        return store.getComment(id) ?? comment
      }
      return holding(task, async () => {
        const current = store.getComment(id)
        if (current?.answer?.kind === 'withdrawn') {
          throw new RequestError(409, 'this request was withdrawn')
        }
        if (current?.answer?.kind === 'superseded') {
          throw new RequestError(409, 'this request was replaced by a newer one')
        }
        if (current?.answer) throw new RequestError(409, 'this request has already been answered')
        const at = new Date().toISOString()
        if (request.action === 'request-changes') {
          const answered = answerRequest(
            task,
            comment,
            { kind: 'changes-requested', at, text },
            drafts(task.id),
          )
          const picksStage = comment.stage === 'review' || comment.stage === 'merge'
          const lines = linesText(answered)
          await deliverAnswer(
            task,
            comment,
            [
              `The human asked for changes at the ${gateName(comment)}:`,
              text,
              ...(lines !== undefined ? [lines] : []),
              picksStage
                ? `Decide whether the fix belongs in Work or in Design, write the human’s request into a Findings file, and send the Task back with \`ted outcome back --to work --findings <file>\` (or \`--to design\`). The fix passes Validate again and comes back with a new sign-off.`
                : comment.stage === 'clarify'
                  ? 'The Task stays in Clarify. Ask another round about it with `ted ask --round <file>`. When it’s answered, write the Task brief again with `ted brief write`, then run `ted outcome advance` for a new sign-off.'
                  : `The Task stays in ${stageTitle(comment.stage ?? '')}. Make the changes, write the Task brief again with \`ted brief write\`, then run \`ted outcome advance\`.`,
            ].join('\n\n'),
          )
          return answered
        }
        if (request.action === 'approve') {
          const now = find(task.id)
          const resolution = await taskWorkflow(now)
          const next = resolution.workflow.next(now.stage) as AgentStageId | 'done'
          await requireObligations(now)
          const answered = answerRequest(task, comment, {
            kind: 'approved',
            at,
            ...(text !== '' && { text }),
          })
          if (!liveLead(now)) store.holdAnswer(comment.id)
          const approved =
            text === ''
              ? `The human approved the ${gateName(comment)}.`
              : `The human approved the ${gateName(comment)} and added:\n\n${text}\n\n`
          if (now.stage === 'merge') {
            startMerging(find(task.id))
            watchMerge(task.id)
            await deliver(
              now,
              `${approved}${text === '' ? ' ' : ''}TED merges the pull requests now and moves the Task to Done when they’ve merged. There’s nothing for you to report.`,
            )
            return answered
          }
          const signedOff = next === 'merge'
          if (signedOff) pullRequestWork(task.id, 'signoff')
          await move(
            now,
            resolution,
            next,
            next === 'done'
              ? undefined
              : `${approved}${text === '' ? ' ' : ''}${nextStageMessage(resolution.workflow, next)}`,
            { signedOff },
          )
          return answered
        }
        const choice = request.choice
        if (choice !== undefined) {
          const answered = await answerLoopAsk(find(task.id), comment, choice, text, at)
          if (answered) return answered
        }
        if (isLinearQuestion(comment) && choice !== undefined) {
          const answered = answerRequest(task, comment, {
            kind: 'answered',
            at,
            choice,
            ...(text !== '' && { text }),
          })
          if (choice === linearArchiveChoice && !find(task.id).archived) {
            settleDependents(task.id, 'unblock')
            archiveNow(find(task.id), false)
            wake()
          }
          return answered
        }
        if (isIdleQuestion(comment) && choice === nudgeAgainChoice) {
          const answered = answerRequest(task, comment, { kind: 'answered', at, choice })
          const run = liveLead(find(task.id))
          if (run) await sendNudge(task, run)
          return answered
        }
        const aboutModel = [...asked.values()].includes(comment.id)
        if (aboutModel && choice === useDefaultChoice) await useDefaultModel(task.id)
        const answered = answerRequest(
          task,
          comment,
          {
            kind: 'answered',
            at,
            ...(choice !== undefined && { choice }),
            ...(text !== '' && { text }),
          },
          text !== '' && !aboutModel ? drafts(task.id) : undefined,
        )
        if (aboutModel) return answered
        const lines = linesText(answered)
        await deliverAnswer(
          task,
          comment,
          [
            `The human answered “${comment.title ?? firstLine(comment.body)}”:`,
            ...(choice !== undefined ? [choice] : []),
            ...(text !== '' ? [text] : []),
            ...(lines !== undefined ? [lines] : []),
          ].join('\n\n'),
        )
        return answered
      })
    },

    setActivity(ref, caller, text) {
      const { task, runId } = ownTask(ref, caller)
      return store.setActivity(task.id, text, runId)
    },

    async reportOutcome(ref, caller, outcome) {
      const { task, runId } = taskLead(ref, caller, 'reports outcomes')
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
            `TED asked the human whether to keep sending ${task.displayId} back (request ${asked.id}); wait for their answer before reporting an outcome`,
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
        if (outcome.outcome === 'advance') await requireObligations(current)
        const resolution = await taskWorkflow(current)
        const { workflow } = resolution
        const changesAsked =
          (stage === 'review' || stage === 'merge') && lastChangesRequested(current) !== ''
        if (outcome.outcome === 'back') {
          if (changesAsked && outcome.to !== 'work' && outcome.to !== 'design') {
            throw new RequestError(
              409,
              `the human asked for changes at the ${stageTitle(stage)} Gate; send the Task back to Work or Design`,
            )
          }
          if (stage === 'validate') {
            checkBack(workflow, stage, outcome.to)
            judge(current, 'sent-back', outcome.judged)
          }
          return sendBack(current, resolution, stage, outcome)
        }
        if (changesAsked) {
          throw new RequestError(
            409,
            `the human asked for changes at the ${stageTitle(stage)} Gate; send the Task back to Work or Design with \`ted outcome back --to work|design --findings <file>\``,
          )
        }
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
              `${stageTitle(stage)} has already posted its Gate request, so it can’t skip itself`,
            )
          }
          store.postComment({
            taskId: task.id,
            body: `The Task Lead skipped ${stageTitle(stage)}: it had nothing to do.${
              workflow.settings.stages[stage]?.gate === true ? ' Its Gate was skipped too.' : ''
            }`,
            author: { kind: 'ted' },
          })
        }
        const gate =
          (workflow.settings.stages[stage]?.gate === true ||
            (stage === 'clarify' && current.clarifyDepth === 'grilling')) &&
          outcome.skip !== true
        if (!gate) {
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
        const name = stage === 'clarify' ? 'Clarify sign-off' : `${stageTitle(stage)} Gate`
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
    },

    setLead(ref, lead) {
      const task = store.setTaskLead(find(ref).id, lead)
      inBackground('apply the Task Lead setting', () => applyLead(task.id))
      const held = store.heldRuns().find((h) => h.taskId === task.id)
      if (held && held.agent !== lead.agent) void pump()
      return task
    },

    useDefaultModel,
    cancelMerge,

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
      const real = await realpath(repo.worktree).catch(() => undefined)
      const root = await realpath(worktreesDir).catch(() => worktreesDir)
      if (real === undefined || !(await stat(real)).isDirectory()) {
        throw new RequestError(409, `${task.displayId}’s worktree for ${name} isn’t on disk`)
      }
      if (!real.startsWith(`${root}${path.sep}`)) {
        throw new RequestError(
          409,
          `${task.displayId}’s worktree for ${name} isn’t in TED’s folder`,
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
        env: commandEnv(task, env),
      }
    },

    async changes(ref) {
      const task = find(ref)
      return taskChanges(task.id, await pullRequestTargets(task))
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
      if (task.stage === 'backlog' || task.stage === 'done' || task.repos.every((r) => r.removed)) {
        throw new RequestError(409, `${task.displayId} has no worktree to run Checks in`)
      }
      if (checking.has(task.id)) {
        throw new RequestError(409, `TED is already running ${task.displayId}’s Checks`)
      }
      setChecking(task.id, true)
      try {
        const resolution = await taskWorkflow(task, { fetch: false })
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
        const started = await beginChecks(find(task.id), resolution, 'agent', only)
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
      if (factoryId !== undefined) caps.delete(factoryId)
      void pump()
      for (const task of store.listTasks()) {
        if (task.runs.length > 0) {
          applyLead(task.id).catch((error: unknown) =>
            console.error(`couldn’t apply ${task.displayId}’s Task Lead:`, error),
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
    planEnded,

    async close() {
      closed = true
      subAgents.close()
      clearInterval(silenceTimer)
      for (const timer of nudgeTimers.values()) clearTimeout(timer)
      nudgeTimers.clear()
      unsubscribe()
      stopPumping()
      watch?.close()
      linearSync?.close()
      await pumping
      stopping.abort()
      await Promise.all(background)
      await apps.close()
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
    stopApp(ref, app) {
      return apps.stop(find(ref).id, app)
    },
    restartApp(ref, app) {
      const { task, by } = runnableApps(ref, { kind: 'app' })
      return apps.restart(task.id, app, by)
    },
    appLog(ref, app) {
      return apps.log(find(ref).id, app)
    },
  }
}

const skippableStages: readonly StageId[] = ['clarify', 'design']
const sendToLeadChoice = 'Send to Task Lead'
const keepWaitingChoice = 'Keep waiting'
const mergeAnywayChoice = 'Merge anyway'
const mergeOffMessage =
  'Merge is off for this Factory: the human merges the pull requests on GitHub, and TED moves the Task to Done when it sees the merge. There’s nothing for you to do or report.'

function isCiStuck(comment: Comment): boolean {
  return (
    comment.author.kind === 'ted' &&
    comment.kind === 'question' &&
    comment.stage === 'merge' &&
    comment.choices?.includes(keepWaitingChoice) === true
  )
}

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function conflictFindings(target: { repo: string; number: number; base: string }): string {
  return `${target.repo}#${target.number} conflicts with ${target.base}, so TED couldn’t rebase it. Rebase onto origin/${target.base} and resolve the conflicts; the Task then comes back through Validate for a short re-sign-off.`
}
const linearArchiveChoice = 'Archive'
const linearKeepChoice = 'Keep going'
const linearAllowChoice = 'Allow'
const linearNotNowChoice = 'Not now'

function isLinearTeamAsk(comment: Comment): boolean {
  return (
    comment.author.kind === 'ted' && comment.kind === 'question' && comment.linearTeam !== undefined
  )
}

function isLinearQuestion(comment: Comment): boolean {
  return (
    comment.author.kind === 'ted' &&
    comment.kind === 'question' &&
    comment.title?.endsWith(' in Linear') === true &&
    comment.choices?.includes(linearArchiveChoice) === true &&
    comment.choices.includes(linearKeepChoice)
  )
}

const idleTitle = 'The Task Lead stopped without saying why'
const nudgeAgainChoice = 'Nudge again'

function isIdleQuestion(comment: Comment): boolean {
  return (
    comment.author.kind === 'ted' && comment.title === idleTitle && comment.answer === undefined
  )
}
const useDefaultChoice = 'Use the default model'
const tryAgainChoice = 'Try again'
const backToDesignChoice = 'Back to Design'

function loopChoices(workflow: ResolvedWorkflow): string[] {
  const next = workflow.next('validate')
  const design =
    workflow.stages.includes('design') &&
    workflow.order.indexOf('design') < workflow.order.indexOf('validate')
  return [
    tryAgainChoice,
    ...(design ? [backToDesignChoice] : []),
    `Move to ${stageTitle(next)} anyway`,
  ]
}

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
  return oneLine(reason === '' ? 'no reason given' : reason, 300)
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
  return `${stageTitle(comment.stage ?? '')} Gate`
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

const continueMessage =
  'TED paused you because your agent couldn’t run (a usage limit, no connection, or a sign-in, version or credential problem). It can run again now. Carry on where you left off.'

function permissionMessage(approved: boolean, command: string, text: string): string | undefined {
  if (approved) {
    return text === ''
      ? undefined
      : `The human approved your permission request for \`${oneLine(command)}\` and added:\n\n${text}`
  }
  return text === ''
    ? 'The human denied this request. Don’t retry it; find another way or ask with `ted ask`.'
    : `The human denied this request and said:\n\n${text}`
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
    return splitApprovedSummary(comment.proposal, answer.created, answer.text)
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

type SetupStep = { repo: TaskRepo; setup: RecordedSetup }

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
