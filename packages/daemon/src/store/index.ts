import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb, StoreInternalsSymbol } from '@livestore/livestore'
import {
  type Activity,
  type AgentKind,
  type AgentStageId,
  type Appearance,
  type Attachment,
  agentStageIds,
  type Banner,
  type BannerAction,
  type BannerSeverity,
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
  type ConversationEntry,
  type ConversationTab,
  type CopySkip,
  type DaemonEvent,
  type DescriptionVersion,
  defaultMachineSettings,
  type Effort,
  type Factory,
  type GitHubWait,
  type LayerKind,
  type LayerUse,
  type MachineSettings,
  type MergeMethod,
  type PermissionMode,
  type Priority,
  type PullRequestPreview,
  type Round,
  type Run,
  type RunEnding,
  type RunMessage,
  type RunProblem,
  type RunState,
  type SendBack,
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
  type WorktreeCommandOutcome,
} from '@ted/protocol'
import { Effect } from 'effect'
import { isDiskFullError } from '../disk.ts'
import { type QueueEntry, queueOrder } from '../tasks/queue.ts'
import {
  commentBox,
  type TaskFacts,
  taskActivity,
  taskMarkers,
  taskStatus,
  taskStatuses,
} from '../tasks/status.ts'
import { type AutomationStore, createAutomationStore } from './automations.ts'
import { eventCount, eventlogFile, storeId } from './files.ts'
import { countMaterialized } from './progress.ts'
import {
  agentPauses,
  automationComments,
  automations,
  automationTasks,
  banners,
  checkResults,
  checkRuns,
  comments,
  conversationEntries,
  conversationTabs,
  deletedTasks,
  events,
  factories,
  factoryOrder,
  factoryRepos,
  heldRuns,
  localFolders,
  loopChecks,
  machineSettings,
  machineSettingValues,
  pullRequests,
  reviewers,
  runInterrupts,
  runMessages,
  runs,
  schema,
  sendBackAsks,
  sendBackResets,
  sendBacks,
  stageEntries,
  subAgentRequests,
  taskAttachments,
  taskBlockers,
  taskBriefs,
  taskDescriptions,
  taskLog,
  taskQueue,
  taskRepos,
  taskSources,
  tasks,
  workflowLayers,
} from './schema.ts'

export const placeholderFactory = { id: 'dev', key: 'DEV' }

export interface GitHubNoticeRecord {
  key: string
  sig: string
  kind: string
  where: string
}

export interface RunOutput {
  toOffset: number
  entries: ConversationEntry[]
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
  worktree?: string
  startRequested: boolean
  waitsForBlockers: boolean
  stopped: boolean
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
  automation?: { automationId: string; firingId: string }
}

export interface PlannedStage {
  stage: AgentStageId
  enabled: boolean
}

export type NewStageEntry = Pick<StageEntry, 'stageFile' | 'layers'> & {
  order: PlannedStage[]
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
  kind: 'task'
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
  gate?: NonNullable<Comment['gate']>
}

export type PlannedCheck = Omit<CheckResult, 'exitCode' | 'durationMs'>

export interface LoggedEvent {
  id: string
  name: string
  data: Record<string, unknown>
  at: string
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

export interface TedStore {
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
  mergeCanceled(taskId: string, commentId: string): void
  mergePending(taskId: string): boolean
  isMerged(taskId: string): boolean
  setLocalFolder(repo: string, path: string): void
  clearLocalFolder(repo: string): void
  renameFactory(factoryId: string, name: string): StoredFactory
  reorderFactories(factoryIds: readonly string[]): StoredFactory[]
  removeFactory(factoryId: string): void
  changeFactoryRepos(factoryId: string, repos: StoredFactoryRepo[]): StoredFactory
  localFolder(repo: string): string | undefined
  queueTask(taskId: string, stage: StageId): Task
  moveToBacklog(taskId: string): Task
  rankTask(taskId: string, rank: number, priority: Priority): Task
  setPriority(taskId: string, priority: Priority): Task
  editTask(taskId: string, edit: { title?: string; description?: string }): Task
  descriptionVersions(taskId: string): DescriptionVersion[]
  archiveTask(taskId: string, record?: { closing: string[]; branches: number }): Task
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
  setStartRequested(taskId: string, startRequested: boolean): Task
  waitForBlockers(taskId: string): Task
  requeueAfterBlockers(taskId: string): Task
  stopTask(taskId: string, input: { runs: number; why: StopReason }): Task
  resumeTask(taskId: string, options: { waitForBlockers: boolean }): Task
  leadNudged(taskId: string, runId: string): void
  leadFailed(failure: LeadFailure): Task
  retryTask(taskId: string, options: { waitForBlockers: boolean }): Task
  changeStage(taskId: string, stage: StageId, entry?: NewStageEntry): Task
  listStageEntries(taskId: string): StageEntry[]
  acceptWorkflowLayer(layer: string, accepted: Omit<AcceptedLayer, 'acceptedAt'>): void
  lastValidWorkflowLayer(layer: string): AcceptedLayer | undefined
  setTaskLead(taskId: string, lead: TaskLead): Task
  setClarifyDepth(
    taskId: string,
    input: { depth: ClarifyDepth; by: ClarifyDepthChooser; runId?: string; why?: string },
  ): Task
  setActivity(taskId: string, text: string, runId?: string): Task
  postComment(input: NewComment): Comment
  listComments(taskId: string): Comment[]
  getComment(id: string): Comment | undefined
  answerComment(id: string, answer: CommentAnswer): Comment
  commentsDelivered(ids: readonly string[], runId: string): void
  commentsRead(ids: readonly string[]): void
  holdAnswer(id: string): void
  heldAnswers(taskId: string): Comment[]
  answersDelivered(ids: readonly string[], runId: string): void
  taskLog(taskId: string): LoggedEvent[]
  supersedeComment(id: string, input: NewComment): Comment
  listOpenRequests(): Comment[]
  listAnsweredRequests(): Comment[]
  writeBrief(input: { taskId: string; text: string; runId?: string }): TaskBrief
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
  }): SendBack
  listSendBacks(taskId: string): SendBack[]
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
  restartRun(runId: string, flags: RunFlags): Run
  reviveRun(runId: string): Run
  lastOutputAt(runId: string): string | undefined
  getRun(id: string): Run | undefined
  listRuns(): Run[]
  runReadOffset(id: string): number
  conversation(runId: string): ConversationEntry[]
  taskRunList(taskId: string): Run[]
  recordRunMessage(input: { runId: string; text: string; lead: boolean }): RunMessage
  queueRunMessage(input: { runId: string; text: string }): RunMessage
  deliverRunMessages(runId: string, ids: readonly string[], lead: boolean): void
  deleteRunMessage(runId: string, id: string): RunMessage | undefined
  recordTurnInterrupted(runId: string, hold: boolean): RunInterrupt
  runMessages(runId: string): RunMessage[]
  runInterrupts(runId: string): RunInterrupt[]
  openTab(taskId: string, runId: string): Task
  closeTab(taskId: string, runId: string): Task
  settings(): MachineSettings
  activity(): Activity
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
  onWriteResult(listener: (error?: unknown) => void): () => void
  automations: AutomationStore
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
  const waitingOnSubAgents = new Set<string>()
  const tellWriters = (error?: unknown) => {
    for (const listener of writeListeners) listener(error)
  }
  const commit = ((...args: unknown[]) => {
    try {
      const result = (store.commit as (...a: unknown[]) => unknown)(...args)
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
                kind: 'task' as const,
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

  const mergePendingFor = (
    taskId: string,
    entries: readonly (typeof stageEntries.Type)[],
    repos: readonly TaskRepo[],
  ): boolean => {
    const since = entries.findLast((e) => e.stage === 'merge')?.at ?? ''
    const open = repos.some((r) => !r.removed && r.pullRequest && r.pullRequest.state !== 'merged')
    if (!open) return false
    const last = store
      .query(queryDb(taskLog.where({ taskId })))
      .filter(
        (e) => (e.name === 'v1.MergeStarted' || e.name === 'v1.MergeCanceled') && e.at >= since,
      )
      .sort((a, b) => sequence(a.id) - sequence(b.id))
      .at(-1)
    return last?.name === 'v1.MergeStarted'
  }

  const mergeCanceledFor = (
    taskId: string,
    entries: readonly (typeof stageEntries.Type)[],
  ): boolean => {
    const since = entries.findLast((e) => e.stage === 'merge')?.at ?? ''
    return store
      .query(queryDb(taskLog.where({ taskId, name: 'v1.MergeCanceled' })))
      .some((e) => e.at >= since)
  }

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

  const attachmentsOf = (taskId: string): Attachment[] =>
    store
      .query(queryDb(taskAttachments.where({ taskId }).orderBy('at', 'asc')))
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
    }
  }

  const entryRows = (taskId: string) =>
    store.query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc')))

  const pauses = (): Partial<Record<AgentKind, string>> =>
    Object.fromEntries(store.query(queryDb(agentPauses)).map((row) => [row.agent, row.reason]))

  const heldRow = (taskId: string) => store.query(queryDb(heldRuns.where({ taskId }))).at(0)

  const toTask = ({
    clarifyDepthBy,
    branch,
    worktree,
    chosenRepos,
    activity,
    activityEntries,
    leadAgent,
    leadModel,
    leadEffort,
    rank,
    changedAt,
    archivedAt,
    waitsForBlockers,
    stoppedAt,
    stoppedRuns,
    stoppedWhy,
    failedAt,
    followUpOf,
    partlyMergedAt,
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
    const mergeWaits = stage === 'merge' && mergePendingFor(row.id, entries, repos)
    const autoMergeLeft =
      stage === 'merge' &&
      !mergeWaits &&
      repos.some(
        (r) =>
          !r.removed && r.pullRequest?.autoMerge !== undefined && r.pullRequest.state !== 'merged',
      ) &&
      mergeCanceledFor(row.id, entries)
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
    const opened = repos.filter((r) => !r.removed && r.pullRequest !== undefined)
    const mergedRepos = opened.filter((r) => r.pullRequest?.state === 'merged')
    const openRepos = opened.filter((r) => r.pullRequest?.state !== 'merged')
    const partlyMerged =
      partlyMergedAt !== null && mergedRepos.length > 0 && openRepos.length > 0
        ? { merged: mergedRepos.map((r) => r.name), open: openRepos.map((r) => r.name) }
        : undefined
    const facts: TaskFacts = {
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
      ...(place > 0 && { queue: newWorkHeld === undefined ? { place } : { hold: newWorkHeld } }),
      runs: live.map((r) => r.state as RunState),
      openRequests: openRequestRows(row.id).length,
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
      ...(checking && { tedWorking: true }),
      ...(checkingNow && { checking: checkingNow }),
      ...(activity !== null && activityEntries === entries.length && { agentActivity: activity }),
      ...(live.some((r) => r.retrying) && { retrying: true }),
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
    const merged =
      stage === 'done'
        ? {
            at: entries.findLast((e) => e.stage === 'done')?.at ?? row.createdAt,
            pullRequests: repos.flatMap((r) =>
              r.pullRequest?.state === 'merged' ? [r.pullRequest.number] : [],
            ),
          }
        : undefined
    return {
      ...row,
      priority: row.priority as Priority,
      clarifyDepth: row.clarifyDepth as ClarifyDepth,
      ...(clarifyDepthBy !== null
        ? { clarifyDepthBy: clarifyDepthBy as ClarifyDepthChooser }
        : row.clarifyDepth !== 'auto' && { clarifyDepthBy: 'human' as const }),
      ...(leadAgent !== null && {
        lead: {
          agent: leadAgent as AgentKind,
          ...(leadModel !== null && { model: leadModel }),
          ...(leadEffort !== null && { effort: leadEffort as Effort }),
        },
      }),
      blockedBy,
      waitsForBlockers,
      stopped: stoppedAt !== null,
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
      createdBy:
        followUpOf !== null
          ? 'follow-up'
          : store.query(queryDb(automationTasks.where({ taskId: row.id }))).length > 0
            ? 'automation'
            : 'human',
      ...(followUpOf !== null && {
        followUpOf: {
          id: followUpOf,
          displayId: original ? `${factoryKey(original.factoryId)}-${original.number}` : followUpOf,
        },
      }),
      ...(merged && { merged }),
      updatedAt,
      ...(archivedAt !== null && { archived: { at: archivedAt, ended: ended() } }),
    }
  }

  const toPublicTask = ({
    worktree: _,
    startRequested: __,
    waitsForBlockers: ___,
    stopped: ____,
    ...task
  }: StoredTask): Task => task

  const toRun = ({
    readOffset: _,
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
    gate,
    answer,
    deliveredRunId,
    deliveredAt,
    readAt,
    permission,
    answerHeld: _,
    failedRunId,
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
    ...(gate !== null && { gate: JSON.parse(gate) as NonNullable<Comment['gate']> }),
    ...(permission !== null && { permission: publicPermission(permission) }),
    ...(answer !== null && { answer: JSON.parse(answer) as CommentAnswer }),
    ...(deliveredRunId !== null &&
      deliveredAt !== null && { delivered: { runId: deliveredRunId, at: deliveredAt } }),
    ...(readAt !== null && { readAt }),
    ...(failedRunId !== null && { failed: { runId: failedRunId } }),
  })

  const openPermissionRows = (runId: string, requestId?: string) =>
    store
      .query(queryDb(comments.where({ authorRunId: runId, kind: 'permission' })))
      .filter(
        (row) =>
          row.answer === null &&
          row.permission !== null &&
          (requestId === undefined || storedPermission(row.permission).requestId === requestId),
      )

  const permissionWait = (taskId: string, leadId: string | undefined) => {
    const asking = openRequestRows(taskId).filter((r) => r.kind === 'permission')
    if (asking.length === 0) return {}
    return {
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
    events.taskStageEnteredV2({
      id: randomUUID(),
      taskId,
      stage,
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
    at: row.at,
  })

  const taskRow = (id: string) => store.query(queryDb(tasks.where({ id }))).at(0)
  const lastCommentAt = (taskId: string) =>
    store
      .query(queryDb(comments.where({ taskId })))
      .flatMap((c) => [
        c.createdAt,
        ...(c.answer === null ? [] : [(JSON.parse(c.answer) as CommentAnswer).at]),
      ])
      .reduce<string | undefined>((a, b) => (a === undefined || b > a ? b : a), undefined)
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
  const requireComment = (id: string) => {
    const comment = getComment(id)
    if (!comment) throw new Error(`no Comment ${id}`)
    return comment
  }
  const commentPosted = (
    { taskId, body, author, kind = 'note', title, choices, round, gate }: NewComment,
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
      round === undefined
        ? events.commentPostedV2(fields)
        : events.commentPostedV3({ ...fields, round: JSON.stringify(round) })
    return { id, event }
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

  const activity = (): Activity => {
    const active = store.query(allRuns).filter((run) => run.state !== 'finished')
    const held = store.query(queryDb(heldRuns)).length
    const factoryIds = new Set(store.query(allFactories).map((f) => f.id))
    const liveAutomations = store
      .query(queryDb(automations.select()))
      .filter((a) => factoryIds.has(a.factoryId))
    const liveIds = new Set(liveAutomations.map((a) => a.id))
    return {
      waitingOnYou:
        active.filter((run) => run.state === 'waiting').length +
        store
          .query(queryDb(automationComments.where({ kind: 'question', answer: null })))
          .filter((c) => liveIds.has(c.automationId)).length,
      runs: {
        working: active.filter((run) => run.state === 'working').length,
        active: active.length + held,
        queued: 0,
      },
      automationsOn: liveAutomations.filter((a) => a.on).length,
      factoriesSettingUp: store.query(allFactories).filter((f) => f.clonedAt === null).length,
      checksRunning: store.query(queryDb(checkRuns.where({ finishedAt: null }))).length,
    }
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
  })

  return {
    automations: automationStore,
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
      title,
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
      automation,
    }) {
      const inFactory = listTasks().filter((t) => t.factoryId === factoryId)
      const deleted = store.query(queryDb(deletedTasks.where({ factoryId })))
      const number =
        Math.max(0, ...inFactory.map((t) => t.number), ...deleted.map((t) => t.number)) + 1
      const id = randomUUID()
      const at = new Date().toISOString()
      commit(
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
            ]
          : []),
        ...(followUpOf !== undefined
          ? [
              events.taskFollowsUp({ taskId: id, originalId: followUpOf, at }),
              events.taskFollowedUp({ taskId: followUpOf, followUpId: id, at }),
            ]
          : []),
        ...(automation ? [events.automationTaskCreated({ ...automation, taskId: id, at })] : []),
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
      return row ? toTask(row) : listTasks().find((t) => t.displayId === ref)
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
      const row = taskRow(taskId)
      if (!row) throw new Error(`no Task ${taskId}`)
      const title = edit.title !== undefined && edit.title !== row.title ? edit.title : null
      const description =
        edit.description !== undefined && edit.description !== row.description
          ? edit.description
          : null
      if (title === null && description === null) return toPublicTask(toTask(row))
      const versions = descriptionRows(taskId)
      const latest = versions.at(-1)
      commit(
        events.taskEdited({
          taskId,
          title,
          description,
          version: description === null ? null : (latest?.version ?? 1) + 1,
          previous: description === null || latest ? null : row.description,
          previousAt: description === null || latest ? null : row.createdAt,
          at: new Date().toISOString(),
        }),
      )
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
    archiveTask(taskId, { closing, branches } = { closing: [], branches: 0 }) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, archived: true }
      commit(
        events.taskArchivedV2({ taskId, closing, branches, at }),
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
      const at = new Date().toISOString()
      commit(
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
    setStartRequested(taskId, startRequested) {
      commit(
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
    mergeCanceled(taskId, commentId) {
      commit(events.mergeCanceled({ taskId, commentId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    mergePending(taskId) {
      const task = taskRow(taskId)
      return task?.stage === 'merge' && mergePendingFor(taskId, entryRows(taskId), reposOf(taskId))
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
    setTaskLead(taskId, { agent, model, effort }) {
      commit(
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
    postComment(input) {
      const { id, event } = commentPosted(input, new Date().toISOString())
      commit(event)
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
      if (comment.kind !== 'note') updatedTask(input.taskId)
      return comment
    },
    supersedeComment(oldId, input) {
      const at = new Date().toISOString()
      const { id, event } = commentPosted(input, at)
      const answer: CommentAnswer = { kind: 'superseded', at, by: id }
      commit(event, events.commentAnswered({ id: oldId, answer: JSON.stringify(answer), at }))
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
      emitComment(oldId)
      updatedTask(input.taskId)
      return comment
    },
    listComments: (taskId) =>
      store.query(queryDb(comments.where({ taskId }).orderBy('createdAt', 'asc'))).map(toComment),
    getComment,
    answerComment(id, answer) {
      commit(events.commentAnswered({ id, answer: JSON.stringify(answer), at: answer.at }))
      const comment = emitComment(id)
      updatedTask(comment.taskId)
      return comment
    },
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
    taskLog: (taskId) =>
      store
        .query(queryDb(taskLog.where({ taskId })))
        .map(({ id, name, data, at }) => ({
          id,
          name,
          data: JSON.parse(data) as Record<string, unknown>,
          at,
        }))
        .sort((a, b) => sequence(a.id) - sequence(b.id)),
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
      return toBrief(brief)
    },
    latestBrief(taskId) {
      const row = briefRows(taskId).at(-1)
      return row && toBrief(row)
    },
    recordSendBack({ taskId, from, to, findings, counted, round, limit, checkRunId }) {
      const id = randomUUID()
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
          at: new Date().toISOString(),
        }),
      )
      const row = store.query(queryDb(sendBacks.where({ id }))).at(0)
      if (!row) throw new Error(`no send-back ${id}`)
      const sendBack = toSendBack(row)
      emit({ type: 'sent-back', sendBack })
      return sendBack
    },
    listSendBacks: (taskId) =>
      store.query(queryDb(sendBacks.where({ taskId }).orderBy('at', 'asc'))).map(toSendBack),
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
        usesDefaultModel: false,
        problem: null,
        failure: null,
        permissions,
        manualPermissions: false,
        state: 'working',
        readOffset: 0,
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
    judgeValidate({ taskId, outcome, checkRunId, review, visual, reviewer }) {
      const judged = (j: { passed: boolean; notes?: number } | undefined) =>
        j === undefined ? null : { passed: j.passed, notes: j.notes ?? null }
      commit(
        events.validateJudged({
          id: randomUUID(),
          taskId,
          outcome,
          checkRunId: checkRunId ?? null,
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
        entries,
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
        events.runOutputReadV2({
          runId,
          toOffset,
          entries: entries.map((entry) => ({ ...entry, at: entry.at ?? at })),
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
      if (entries.length > 0) emit({ type: 'run-output', runId })
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
    reviveRun(runId) {
      const at = new Date().toISOString()
      commit(events.runRevived({ runId, taskId: taskIdOfRun(runId) ?? null, at }))
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
      store
        .query(queryDb(conversationEntries.where({ runId }).orderBy('offset', 'desc').limit(1)))
        .at(0)?.at ?? undefined,
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
    runReadOffset: (id) => runRow(id)?.readOffset ?? 0,
    conversation: (runId) =>
      store
        .query(queryDb(conversationEntries.where({ runId }).orderBy('offset', 'asc')))
        .map(({ offset, line, at }) => ({ offset, line, ...(at !== null && { at }) })),
    taskRunList: (taskId) => taskRuns(taskId).map(toRun),
    recordRunMessage({ runId, text, lead }) {
      const taskId = taskIdOfRun(runId) ?? null
      const message = { id: randomUUID(), runId, text, at: new Date().toISOString() }
      commit(events.runMessageSent({ ...message, taskId, lead: lead && taskId !== null }))
      emit({ type: 'run-output', runId })
      if (taskId !== null && lead) updatedTask(taskId)
      return message
    },
    queueRunMessage({ runId, text }) {
      const taskId = taskIdOfRun(runId) ?? null
      const message = { id: randomUUID(), runId, text, at: new Date().toISOString() }
      commit(events.runMessageQueued({ ...message, taskId }))
      emit({ type: 'run-output', runId })
      return { ...message, queued: true }
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
        .map(({ id, text, at, queued }) => ({ id, runId, text, at, ...(queued && { queued }) })),
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
    onWriteResult(listener) {
      writeListeners.add(listener)
      return () => writeListeners.delete(listener)
    },
    close: () => store.shutdownPromise(),
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
