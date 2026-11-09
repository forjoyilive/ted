import { randomUUID } from 'node:crypto'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb } from '@livestore/livestore'
import {
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
  type RunState,
  type StageEntry,
  type StageId,
  type Task,
  type TaskLead,
  type TaskRepo,
  type TrackStage,
  type WorktreeCommandOutcome,
} from '@ted/protocol'
import { type TaskFacts, taskActivity, taskMarkers, taskStatus } from '../tasks/status.ts'
import {
  banners,
  comments,
  conversationEntries,
  events,
  factories,
  localFolders,
  machineSettings,
  machineSettingValues,
  runs,
  schema,
  stageEntries,
  taskAttachments,
  taskBlockers,
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
  changeStage(taskId: string, stage: StageId, entry?: NewStageEntry): Task
  listStageEntries(taskId: string): StageEntry[]
  acceptWorkflowLayer(layer: string, accepted: Omit<AcceptedLayer, 'acceptedAt'>): void
  lastValidWorkflowLayer(layer: string): AcceptedLayer | undefined
  setActivity(taskId: string, text: string, runId?: string): Task
  postComment(input: { taskId: string; body: string; authorRunId: string }): Comment
  listComments(taskId: string): Comment[]
  subscribe(listener: (event: DaemonEvent) => void): () => void
  startRun(input: {
    id: string
    agent: AgentKind
    sessionId?: string
    prompt: string
    cwd: string
    taskId?: string
  }): Run
  recordRunOutput(runId: string, output: RunOutput): void
  getRun(id: string): Run | undefined
  listRuns(): Run[]
  runReadOffset(id: string): number
  conversation(runId: string): ConversationEntry[]
  settings(): MachineSettings
  updateSettings(changes: Partial<MachineSettings>): MachineSettings
  raiseBanner(input: NewBanner): Banner
  dismissBanner(id: string, until: string): Banner | undefined
  clearBanner(id: string): void
  getBanner(id: string): Banner | undefined
  listBanners(): Banner[]
  close(): Promise<void>
}

function pick(values: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.includes(name)))
}

export type NewBanner = Omit<Banner, 'raisedAt' | 'dismissedUntil'>

export async function openStore({ directory }: { directory: string }): Promise<TedStore> {
  const store = await createStorePromise({
    schema,
    storeId: 'ted',
    adapter: makeAdapter({ storage: { type: 'fs', baseDirectory: directory } }),
    disableDevtools: true,
  })

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
    const waitingOn = blockedBy.flatMap((id) => {
      const blocker = taskRow(id)
      return blocker && blocker.stage !== 'done'
        ? [`${factoryKey(blocker.factoryId)}-${blocker.number}`]
        : []
    })
    const facts: TaskFacts = {
      stage,
      runs: live.map((r) => r.state as RunState),
      ...(waitingOn.length > 0 && { blockedBy: waitingOn }),
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
      repos: reposOf(row.id),
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
        .map((r) => ({ id: r.id, agent: r.agent as AgentKind, state: r.state as RunState })),
    }
  }

  const toPublicTask = ({ worktree: _, startRequested: __, ...task }: StoredTask): Task => task

  const toRun = ({ readOffset: _, taskId, sessionId, ...row }: typeof runs.Type): Run => ({
    ...row,
    agent: row.agent as AgentKind,
    state: row.state as RunState,
    ...(sessionId !== '' && { sessionId }),
    ...(taskId !== null && { taskId }),
  })

  const toComment = ({ authorRunId, ...row }: typeof comments.Type): Comment => ({
    ...row,
    kind: 'note',
    author: { kind: 'run', runId: authorRunId },
  })

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

  const updatedTask = (taskId: string): Task => {
    const row = taskRow(taskId)
    if (!row) throw new Error(`no Task ${taskId}`)
    const task = toPublicTask(toTask(row))
    emit({ type: 'task-updated', task })
    return task
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
      store.commit(events.factoryAdded(row))
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
      store.commit(
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
      store.commit(
        events.taskStarted({ taskId, stage, branch, worktree, at }),
        events.taskWorktreeCreated({ taskId, ...repo, branch, worktree, at }),
        stageEntered(taskId, stage, entry, at),
      )
      return updatedTask(taskId)
    },
    worktreeSetupStarted(taskId, name, { command, timeoutMs, env }) {
      store.commit(
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
      store.commit(
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
      store.commit(
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
      store.commit(events.localFolderSet({ repo, path, at: new Date().toISOString() }))
    },
    localFolder: (repo) => store.query(queryDb(localFolders.where({ repo }))).at(0)?.path,
    changeStage(taskId, stage, entry) {
      const at = new Date().toISOString()
      store.commit(
        events.taskStageChanged({ taskId, stage, at }),
        ...(entry ? [stageEntered(taskId, stage, entry, at)] : []),
      )
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
      store.commit(
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
    setActivity(taskId, text, runId) {
      store.commit(
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
    postComment({ taskId, body, authorRunId }) {
      const row = {
        id: randomUUID(),
        taskId,
        kind: 'note',
        body,
        authorRunId,
        createdAt: new Date().toISOString(),
      }
      store.commit(events.commentPosted(row))
      const comment = toComment(row)
      emit({ type: 'comment-posted', comment })
      return comment
    },
    listComments: (taskId) =>
      store.query(queryDb(comments.where({ taskId }).orderBy('createdAt', 'asc'))).map(toComment),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    startRun({ taskId, sessionId, ...input }) {
      const row = {
        ...input,
        sessionId: sessionId ?? '',
        taskId: taskId ?? null,
        startedAt: new Date().toISOString(),
      }
      store.commit(events.runStartedV2(row))
      if (taskId !== undefined) updatedTask(taskId)
      return toRun({ ...row, state: 'working', readOffset: 0 })
    },
    recordRunOutput(runId, { toOffset, entries, state, sessionId }) {
      const current = runRow(runId)
      if (!current) throw new Error(`no Run ${runId}`)
      store.commit(
        events.runOutputRead({ runId, toOffset, entries }),
        ...(sessionId !== undefined && sessionId !== current.sessionId
          ? [events.runSessionIdentified({ runId, sessionId })]
          : []),
        ...(state && state !== current.state
          ? [events.runStateChanged({ runId, state, at: new Date().toISOString() })]
          : []),
      )
      const taskId = taskIdOfRun(runId)
      if (state && state !== current.state && taskId !== undefined) updatedTask(taskId)
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
    updateSettings(changes) {
      const current = settings()
      const changed = Object.fromEntries(
        Object.entries(changes).filter(
          ([name, value]) =>
            value !== undefined && current[name as keyof MachineSettings] !== value,
        ),
      )
      if (Object.keys(changed).length > 0) {
        store.commit(
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
      store.commit(
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
      store.commit(events.bannerDismissed({ id, until, at: new Date().toISOString() }))
      const banner = requireBanner(id)
      emit({ type: 'banner-updated', banner })
      return banner
    },
    clearBanner(id) {
      if (!bannerRow(id)) return
      store.commit(events.bannerCleared({ id, at: new Date().toISOString() }))
      emit({ type: 'banner-cleared', id })
    },
    getBanner,
    listBanners: () => store.query(queryDb(banners)).map(toBanner).sort(bannerOrder),
    close: () => store.shutdownPromise(),
  }
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
