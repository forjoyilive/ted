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
  bannerOrder,
  type CheckResult,
  type CheckRun,
  type CheckRunOutcome,
  type CheckRunTrigger,
  type CheckState,
  type ClarifyDepth,
  type Comment,
  type CommentAnswer,
  type CommentAuthor,
  type CommentKind,
  type ConversationEntry,
  type ConversationTab,
  type CopySkip,
  type DaemonEvent,
  defaultMachineSettings,
  type Effort,
  type Factory,
  type LayerKind,
  type LayerUse,
  type MachineSettings,
  type PermissionMode,
  type Priority,
  type Run,
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
import { eventCount, eventlogFile, storeId } from './files.ts'
import { countMaterialized } from './progress.ts'
import {
  agentPauses,
  banners,
  checkResults,
  checkRuns,
  comments,
  conversationEntries,
  conversationTabs,
  events,
  factories,
  factoryRepos,
  heldRuns,
  localFolders,
  machineSettings,
  machineSettingValues,
  runMessages,
  runs,
  schema,
  sendBackResets,
  sendBacks,
  stageEntries,
  taskAttachments,
  taskBlockers,
  taskBriefs,
  taskLog,
  taskQueue,
  taskRepos,
  taskSources,
  tasks,
  workflowLayers,
} from './schema.ts'

export const placeholderFactory = { id: 'dev', key: 'DEV' }

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
  gate?: NonNullable<Comment['gate']>
}

export type PlannedCheck = Omit<CheckResult, 'exitCode' | 'durationMs'>

export interface LoggedEvent {
  id: string
  name: string
  data: Record<string, unknown>
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
  setLocalFolder(repo: string, path: string): void
  localFolder(repo: string): string | undefined
  queueTask(taskId: string, stage: StageId): Task
  moveToBacklog(taskId: string): Task
  rankTask(taskId: string, rank: number, priority: Priority): Task
  setPriority(taskId: string, priority: Priority): Task
  archiveTask(taskId: string): Task
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
  changeStage(taskId: string, stage: StageId, entry?: NewStageEntry): Task
  listStageEntries(taskId: string): StageEntry[]
  acceptWorkflowLayer(layer: string, accepted: Omit<AcceptedLayer, 'acceptedAt'>): void
  lastValidWorkflowLayer(layer: string): AcceptedLayer | undefined
  setTaskLead(taskId: string, lead: TaskLead): Task
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
    permissions?: PermissionMode
  }): Run
  recordRunOutput(runId: string, output: RunOutput): void
  permissionTarget(commentId: string): PermissionTarget | undefined
  answerPermission(commentId: string, answer: CommentAnswer): Comment
  restartRun(runId: string, flags: RunFlags): Run
  getRun(id: string): Run | undefined
  listRuns(): Run[]
  runReadOffset(id: string): number
  conversation(runId: string): ConversationEntry[]
  taskRunList(taskId: string): Run[]
  recordRunMessage(input: { runId: string; text: string; lead: boolean }): RunMessage
  runMessages(runId: string): RunMessage[]
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
  holdNewWork(reason: string | undefined): void
  newWorkHold(): string | undefined
  onWriteResult(listener: (error?: unknown) => void): () => void
  close(): Promise<void>
}

function pick(values: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.includes(name)))
}

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

  const allFactories = queryDb(factories.orderBy('createdAt', 'asc'))
  const allTasks = queryDb(tasks.orderBy('number', 'asc'))
  const allRuns = queryDb(runs.orderBy('startedAt', 'asc'))

  const allFactoryRepos = queryDb(factoryRepos.orderBy('position', 'asc'))
  const listFactories = (): StoredFactory[] => {
    const repos = store.query(allFactoryRepos)
    return store.query(allFactories).map(({ clonedAt, ...row }) => ({
      ...row,
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

  const taskRuns = (taskId: string) =>
    store.query(queryDb(runs.where({ taskId }).orderBy('startedAt', 'desc')))

  const toTaskRepo = (row: typeof taskRepos.Type): TaskRepo => ({
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

  const blockerRows = (taskId: string) =>
    store.query(queryDb(taskBlockers.where({ taskId }).orderBy('at', 'asc')))

  const blockersOf = (taskId: string) => blockerRows(taskId).map((row) => row.blockerId)

  const blockerLinks = (taskId: string): BlockerLink[] =>
    blockerRows(taskId).map((row) => {
      const blocker = taskRow(row.blockerId)
      return {
        blockerId: row.blockerId,
        displayId: blocker ? `${factoryKey(blocker.factoryId)}-${blocker.number}` : row.blockerId,
        merged: blocker?.stage === 'done',
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
    branch,
    worktree,
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
    ...row
  }: typeof tasks.Type): StoredTask => {
    const stage = row.stage as StageId
    const all = taskRuns(row.id)
    const lead = all.at(0)
    const live = all.filter((r) => r.state !== 'finished')
    const entries = entryRows(row.id)
    const blockedBy = blockersOf(row.id)
    const repos = reposOf(row.id)
    const waitingOn = blockedBy.flatMap((id) => {
      const blocker = taskRow(id)
      return blocker && blocker.stage !== 'done'
        ? [`${factoryKey(blocker.factoryId)}-${blocker.number}`]
        : []
    })
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
    const facts: TaskFacts = {
      ...(archivedAt !== null && { archived: true }),
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
      ...(stoppedAt === null &&
        place === 0 &&
        repos.some((r) => !r.removed && r.setup?.state === 'running') && { settingUp: true }),
      ...(checking && { tedWorking: true }),
      ...(checkingNow && { checking: checkingNow }),
      ...(activity !== null && activityEntries === entries.length && { agentActivity: activity }),
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
                name: 'Task Lead',
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
      return { kind: 'stopped', stage }
    }
    const source = sourceOf(row.id)
    return {
      ...row,
      priority: row.priority as Priority,
      clarifyDepth: row.clarifyDepth as ClarifyDepth,
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
        .sort((a, b) => Number(b.id === lead?.id) - Number(a.id === lead?.id))
        .map((r) => {
          const reason = paused[r.agent as AgentKind]
          return {
            id: r.id,
            agent: r.agent as AgentKind,
            state: r.state as RunState,
            ...(reason !== undefined && { paused: reason }),
          }
        }),
      createdBy: 'human',
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
    permissions,
    manualPermissions,
    ...row
  }: typeof runs.Type): Run => ({
    ...row,
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
  })

  const toComment = ({
    authorKind,
    authorRunId,
    stage,
    title,
    choices,
    gate,
    answer,
    deliveredRunId,
    deliveredAt,
    readAt,
    permission,
    answerHeld: _,
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
    ...(gate !== null && { gate: JSON.parse(gate) as NonNullable<Comment['gate']> }),
    ...(permission !== null && { permission: publicPermission(permission) }),
    ...(answer !== null && { answer: JSON.parse(answer) as CommentAnswer }),
    ...(deliveredRunId !== null &&
      deliveredAt !== null && { delivered: { runId: deliveredRunId, at: deliveredAt } }),
    ...(readAt !== null && { readAt }),
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
    { taskId, body, author, kind = 'note', title, choices, gate }: NewComment,
    createdAt: string,
  ) => {
    const id = randomUUID()
    const event = events.commentPostedV2({
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
    })
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
    return {
      waitingOnYou: active.filter((run) => run.state === 'waiting').length,
      runs: {
        working: active.filter((run) => run.state === 'working').length,
        active: active.length + held,
        queued: 0,
      },
      automationsOn: 0,
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

  return {
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
    }) {
      const inFactory = listTasks().filter((t) => t.factoryId === factoryId)
      const number = Math.max(0, ...inFactory.map((t) => t.number)) + 1
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
      )
      const row = taskRow(id)
      if (!row) throw new Error(`no Task ${id}`)
      const task = toPublicTask(toTask(row))
      emit({ type: 'task-created', task })
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
    setPriority(taskId, priority) {
      commit(events.taskPriorityChanged({ taskId, priority, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    archiveTask(taskId) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, archived: true }
      commit(
        events.taskArchived({ taskId, at }),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
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
    setLocalFolder(repo, path) {
      commit(events.localFolderSet({ repo, path, at: new Date().toISOString() }))
    },
    localFolder: (repo) => store.query(queryDb(localFolders.where({ repo }))).at(0)?.path,
    changeStage(taskId, stage, entry) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId).filter(
        (row) => row.gate !== null && row.stage !== stage,
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
    startRun({ taskId, sessionId, model, effort, permissions = 'auto', ...input }) {
      const row = {
        ...input,
        sessionId: sessionId ?? '',
        taskId: taskId ?? null,
        model: model ?? null,
        effort: effort ?? null,
        startedAt: new Date().toISOString(),
      }
      commit(
        events.runStartedV3(row),
        events.runPermissionsSet({ runId: row.id, permissions, at: row.startedAt }),
      )
      const run = toRun({
        ...row,
        usesDefaultModel: false,
        problem: null,
        permissions,
        manualPermissions: false,
        state: 'working',
        readOffset: 0,
      })
      emit({ type: 'run-updated', run })
      if (taskId !== undefined) updatedTask(taskId)
      noteActivity()
      return run
    },
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
      if (asked.length > 0 || withdrawnOnce.length > 0) {
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
    runMessages: (runId) =>
      store.query(queryDb(runMessages.where({ runId }).orderBy('at', 'asc'))).map((row) => row),
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
