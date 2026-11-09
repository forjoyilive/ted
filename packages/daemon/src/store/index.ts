import { randomUUID } from 'node:crypto'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb } from '@livestore/livestore'
import {
  type AgentKind,
  type Appearance,
  type Attachment,
  type Banner,
  type BannerAction,
  type BannerSeverity,
  bannerOrder,
  type ClarifyDepth,
  type Comment,
  type ConversationEntry,
  type DaemonEvent,
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
  type TaskLead,
} from '@ted/protocol'
import {
  banners,
  comments,
  conversationEntries,
  events,
  factories,
  machineSettings,
  runs,
  schema,
  stageEntries,
  taskAttachments,
  taskBlockers,
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

export type NewStageEntry = Pick<StageEntry, 'stageFile' | 'layers'>

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
  }): Task
  changeStage(taskId: string, stage: StageId, entry?: NewStageEntry): Task
  listStageEntries(taskId: string): StageEntry[]
  acceptWorkflowLayer(layer: string, accepted: Omit<AcceptedLayer, 'acceptedAt'>): void
  lastValidWorkflowLayer(layer: string): AcceptedLayer | undefined
  setTaskLead(taskId: string, lead: TaskLead): Task
  postComment(input: { taskId: string; body: string; authorRunId: string }): Comment
  postTedComment(input: { taskId: string; kind: Comment['kind']; body: string }): Comment
  listComments(taskId: string): Comment[]
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
  updateSettings(changes: Partial<MachineSettings>): MachineSettings
  raiseBanner(input: NewBanner): Banner
  dismissBanner(id: string, until: string): Banner | undefined
  clearBanner(id: string): void
  getBanner(id: string): Banner | undefined
  listBanners(): Banner[]
  close(): Promise<void>
}

export type NewBanner = Omit<Banner, 'raisedAt' | 'dismissedUntil'>

const defaultSettings: MachineSettings = { appearance: 'system' }

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

  const leadRunId = (taskId: string) =>
    store.query(queryDb(runs.where({ taskId }).orderBy('startedAt', 'desc'))).at(0)?.id

  const blockersOf = (taskId: string) =>
    store
      .query(queryDb(taskBlockers.where({ taskId }).orderBy('at', 'asc')))
      .map((row) => row.blockerId)

  const attachmentsOf = (taskId: string): Attachment[] =>
    store
      .query(queryDb(taskAttachments.where({ taskId }).orderBy('at', 'asc')))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const toTask = ({
    branch,
    worktree,
    leadAgent,
    leadModel,
    leadEffort,
    ...row
  }: typeof tasks.Type): StoredTask => {
    const lead = leadRunId(row.id)
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
      blockedBy: blockersOf(row.id),
      attachments: attachmentsOf(row.id),
      stage: row.stage as StageId,
      displayId: `${factoryKey(row.factoryId)}-${row.number}`,
      ...(branch !== null && { branch }),
      ...(worktree !== null && { worktree }),
      ...(lead !== undefined && { leadRunId: lead }),
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

  const toComment = ({ authorRunId, ...row }: typeof comments.Type): Comment => ({
    ...row,
    kind: row.kind as Comment['kind'],
    author: authorRunId === null ? { kind: 'ted' } : { kind: 'run', runId: authorRunId },
  })

  const stageEntered = (taskId: string, stage: StageId, entry: NewStageEntry, at: string) =>
    events.taskStageEntered({
      id: randomUUID(),
      taskId,
      stage,
      stageFileLayer: entry.stageFile?.layer ?? null,
      stageFilePath: entry.stageFile?.path ?? null,
      layers: JSON.stringify(entry.layers),
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
    const row = store.query(queryDb(machineSettings.where({ id: 'machine' }))).at(0)
    return row ? { appearance: row.appearance as Appearance } : { ...defaultSettings }
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
    startTask({ taskId, stage, branch, worktree, entry }) {
      const at = new Date().toISOString()
      store.commit(
        events.taskStarted({ taskId, stage, branch, worktree, at }),
        stageEntered(taskId, stage, entry, at),
      )
      return updatedTask(taskId)
    },
    changeStage(taskId, stage, entry) {
      const at = new Date().toISOString()
      store.commit(
        events.taskStageChanged({ taskId, stage, at }),
        ...(entry ? [stageEntered(taskId, stage, entry, at)] : []),
      )
      return updatedTask(taskId)
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
    setTaskLead(taskId, { agent, model, effort }) {
      store.commit(
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
    postTedComment({ taskId, kind, body }) {
      const row = { id: randomUUID(), taskId, kind, body, createdAt: new Date().toISOString() }
      store.commit(events.tedCommentPosted(row))
      const comment = toComment({ ...row, authorRunId: null })
      emit({ type: 'comment-posted', comment })
      return comment
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
    startRun({ taskId, sessionId, model, effort, ...input }) {
      const row = {
        ...input,
        sessionId: sessionId ?? '',
        taskId: taskId ?? null,
        model: model ?? null,
        effort: effort ?? null,
        startedAt: new Date().toISOString(),
      }
      store.commit(events.runStartedV3(row))
      const run = toRun({
        ...row,
        usesDefaultModel: false,
        problem: null,
        state: 'working',
        readOffset: 0,
      })
      emit({ type: 'run-updated', run })
      if (taskId !== undefined) updatedTask(taskId)
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
      store.commit(
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
      }
    },
    restartRun(runId, { model, effort, usesDefaultModel = false }) {
      store.commit(
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
    updateSettings({ appearance }) {
      if (appearance !== undefined && appearance !== settings().appearance) {
        store.commit(events.appearanceChanged({ appearance, at: new Date().toISOString() }))
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
