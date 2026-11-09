import { randomUUID } from 'node:crypto'
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
  type ClarifyDepth,
  type Comment,
  type CommentAnswer,
  type CommentAuthor,
  type CommentKind,
  type ConversationEntry,
  type CopySkip,
  type DaemonEvent,
  defaultMachineSettings,
  type Effort,
  type Factory,
  type LayerKind,
  type LayerUse,
  type MachineSettings,
  type Priority,
  type Run,
  type RunProblem,
  type RunState,
  type StageEntry,
  type StageId,
  type Task,
  type TaskBrief,
  type TaskLead,
  type TaskRepo,
  type TrackStage,
  type WorktreeCommandOutcome,
} from '@ted/protocol'
import { Effect } from 'effect'
import { isDiskFullError } from '../disk.ts'
import { type QueueEntry, queueOrder } from '../tasks/queue.ts'
import { type TaskFacts, taskActivity, taskMarkers, taskStatus } from '../tasks/status.ts'
import { eventCount, eventlogFile, storeId } from './files.ts'
import { countMaterialized } from './progress.ts'
import {
  agentPauses,
  banners,
  comments,
  conversationEntries,
  events,
  factories,
  heldRuns,
  localFolders,
  machineSettings,
  machineSettingValues,
  runs,
  schema,
  sendBackResets,
  sendBacks,
  stageEntries,
  taskAttachments,
  taskBlockers,
  taskBriefs,
  taskQueue,
  taskRepos,
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
}

export interface RunFlags {
  model?: string
  effort?: Effort
  usesDefaultModel?: boolean
}

export interface StoredFactory extends Factory {
  cloneUrl: string
}

export interface StoredTask extends Task {
  worktree?: string
  startRequested: boolean
}

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

export interface HeldRun {
  taskId: string
  agent: AgentKind
  sessionId?: string
}

export interface TedStore {
  addFactory(input: Omit<StoredFactory, 'id' | 'createdAt'>): StoredFactory
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
  queue(): QueuedTask[]
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
  listOpenRequests(): Comment[]
  writeBrief(input: { taskId: string; text: string; runId?: string }): TaskBrief
  latestBrief(taskId: string): TaskBrief | undefined
  recordSendBack(input: {
    taskId: string
    from: StageId
    to: StageId
    findings: string
    counted: boolean
  }): void
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
  }): Run
  recordRunOutput(runId: string, output: RunOutput): void
  restartRun(runId: string, flags: RunFlags): Run
  getRun(id: string): Run | undefined
  listRuns(): Run[]
  runReadOffset(id: string): number
  conversation(runId: string): ConversationEntry[]
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

  const listFactories = (): StoredFactory[] => [...store.query(allFactories)]
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

  const blockersOf = (taskId: string) =>
    store
      .query(queryDb(taskBlockers.where({ taskId }).orderBy('at', 'asc')))
      .map((row) => row.blockerId)

  const attachmentsOf = (taskId: string): Attachment[] =>
    store
      .query(queryDb(taskAttachments.where({ taskId }).orderBy('at', 'asc')))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

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
    const paused = pauses()
    const held = heldRow(row.id)
    const place = queue().findIndex((q) => q.id === row.id) + 1
    const pausedReason =
      (held && paused[held.agent as AgentKind]) ??
      live.map((r) => paused[r.agent as AgentKind]).find((reason) => reason !== undefined) ??
      (place > 0 && leadAgent !== null ? paused[leadAgent as AgentKind] : undefined)
    const facts: TaskFacts = {
      stage,
      ...(place > 0 && { queue: newWorkHeld === undefined ? { place } : { hold: newWorkHeld } }),
      runs: live.map((r) => r.state as RunState),
      openRequests: openRequestRows(row.id).length,
      ...(pausedReason !== undefined && { paused: pausedReason }),
      ...(waitingOn.length > 0 && { blockedBy: waitingOn }),
      ...(repos.some((r) => !r.removed && r.setup?.state === 'running') && { settingUp: true }),
      ...(activity !== null && activityEntries === entries.length && { agentActivity: activity }),
    }
    const status = taskStatus(facts)
    const shown = taskActivity(facts)
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
      repos,
      attachments: attachmentsOf(row.id),
      stage,
      displayId: `${factoryKey(row.factoryId)}-${row.number}`,
      ...(branch !== null && { branch }),
      ...(worktree !== null && { worktree }),
      ...(lead !== undefined && { leadRunId: lead.id }),
      ...(status !== undefined && { status }),
      markers: taskMarkers(facts, status),
      ...(shown !== undefined && { activity: shown }),
      track: track(stage, entries),
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
    }
  }

  const toPublicTask = ({ worktree: _, startRequested: __, ...task }: StoredTask): Task => task

  const toRun = ({
    readOffset: _,
    taskId,
    sessionId,
    model,
    effort,
    usesDefaultModel,
    problem,
    ...row
  }: typeof runs.Type): Run => ({
    ...row,
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
    ...(answer !== null && { answer: JSON.parse(answer) as CommentAnswer }),
  })

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

  const taskRow = (id: string) => store.query(queryDb(tasks.where({ id }))).at(0)
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
      const { cloneUrl: _, ...factory } = row
      emit({ type: 'factory-added', factory })
      return row
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
        ...blockedBy.map((blockerId) => events.taskBlockerAdded({ taskId: id, blockerId, at })),
        ...attachments.map((attachment) =>
          events.taskAttachmentAdded({ taskId: id, ...attachment, at }),
        ),
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
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      commit(events.taskQueued({ taskId, stage, rank, at: new Date().toISOString() }))
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
    queue,
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
    postComment({ taskId, body, author, kind = 'note', title, choices, gate }) {
      const id = randomUUID()
      commit(
        events.commentPostedV2({
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
          createdAt: new Date().toISOString(),
        }),
      )
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
      if (kind !== 'note') updatedTask(taskId)
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
    recordSendBack({ taskId, from, to, findings, counted }) {
      commit(
        events.taskSentBack({
          id: randomUUID(),
          taskId,
          from,
          to,
          findings,
          counted,
          at: new Date().toISOString(),
        }),
      )
    },
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
    startRun({ taskId, sessionId, model, effort, ...input }) {
      const row = {
        ...input,
        sessionId: sessionId ?? '',
        taskId: taskId ?? null,
        model: model ?? null,
        effort: effort ?? null,
        startedAt: new Date().toISOString(),
      }
      commit(events.runStartedV3(row))
      const run = toRun({
        ...row,
        usesDefaultModel: false,
        problem: null,
        state: 'working',
        readOffset: 0,
      })
      emit({ type: 'run-updated', run })
      if (taskId !== undefined) updatedTask(taskId)
      noteActivity()
      return run
    },
    recordRunOutput(runId, { toOffset, entries, state, sessionId, problem }) {
      const current = runRow(runId)
      if (!current) throw new Error(`no Run ${runId}`)
      const at = new Date().toISOString()
      const newProblem = problem !== undefined && current.problem === null
      const holding = (current.problem !== null || newProblem) && state === 'idle'
      const target = holding ? 'waiting' : state
      const stateChanged = target !== undefined && target !== current.state
      commit(
        events.runOutputRead({ runId, toOffset, entries }),
        ...(sessionId !== undefined && sessionId !== current.sessionId
          ? [events.runSessionIdentified({ runId, sessionId })]
          : []),
        ...(newProblem ? [events.runProblemFound({ runId, problem, at })] : []),
        ...(stateChanged && target !== undefined
          ? [events.runStateChanged({ runId, state: target, at })]
          : []),
      )
      if (newProblem || stateChanged) {
        const row = runRow(runId)
        if (row) emit({ type: 'run-updated', run: toRun(row) })
        const taskId = taskIdOfRun(runId)
        if (taskId !== undefined) updatedTask(taskId)
      }
      if (stateChanged) noteActivity()
    },
    restartRun(runId, { model, effort, usesDefaultModel = false }) {
      commit(
        events.runRestarted({
          runId,
          model: model ?? null,
          effort: effort ?? null,
          usesDefaultModel,
          at: new Date().toISOString(),
        }),
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
    getRun(id) {
      const row = runRow(id)
      return row && toRun(row)
    },
    listRuns: () => store.query(allRuns).map(toRun),
    runReadOffset: (id) => runRow(id)?.readOffset ?? 0,
    conversation: (runId) =>
      store
        .query(queryDb(conversationEntries.where({ runId }).orderBy('offset', 'asc')))
        .map(({ offset, line }) => ({ offset, line })),
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
