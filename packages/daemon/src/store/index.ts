import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb } from '@livestore/livestore'
import {
  type Activity,
  type AgentKind,
  type Appearance,
  type Banner,
  type BannerAction,
  type BannerSeverity,
  bannerOrder,
  type Comment,
  type ConversationEntry,
  type DaemonEvent,
  defaultSettings,
  type Factory,
  type LayerKind,
  type LayerUse,
  type MachineSettings,
  type Run,
  type RunState,
  type StageEntry,
  type StageId,
  type Task,
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
  settingValues,
  stageEntries,
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
  createTask(input: { title: string; factoryId?: string }): Promise<Task>
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
  activity(): Activity
  updateSettings(changes: Partial<MachineSettings>): MachineSettings
  raiseBanner(input: NewBanner): Banner
  dismissBanner(id: string, until: string): Banner | undefined
  clearBanner(id: string): void
  getBanner(id: string): Banner | undefined
  listBanners(): Banner[]
  close(): Promise<void>
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

  const leadRunId = (taskId: string) =>
    store.query(queryDb(runs.where({ taskId }).orderBy('startedAt', 'desc'))).at(0)?.id

  const toTask = ({ branch, worktree, ...row }: typeof tasks.Type): StoredTask => {
    const lead = leadRunId(row.id)
    return {
      ...row,
      stage: row.stage as StageId,
      displayId: `${factoryKey(row.factoryId)}-${row.number}`,
      ...(branch !== null && { branch }),
      ...(worktree !== null && { worktree }),
      ...(lead !== undefined && { leadRunId: lead }),
    }
  }

  const toPublicTask = ({ worktree: _, ...task }: StoredTask): Task => task

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
    const values = Object.fromEntries(
      store.query(queryDb(settingValues)).map(({ name, value }) => [name, JSON.parse(value)]),
    ) as Partial<MachineSettings>
    return {
      ...defaultSettings,
      ...values,
      appearance: (row?.appearance as Appearance | undefined) ?? defaultSettings.appearance,
    }
  }

  const activity = (): Activity => {
    const active = store.query(allRuns).filter((run) => run.state !== 'finished')
    return {
      waitingOnYou: active.filter((run) => run.state === 'waiting').length,
      runs: {
        working: active.filter((run) => run.state === 'working').length,
        active: active.length,
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
      store.commit(events.factoryAdded(row))
      const { cloneUrl: _, ...factory } = row
      emit({ type: 'factory-added', factory })
      return row
    },
    listFactories,
    getFactory: (id) => listFactories().find((f) => f.id === id),
    async createTask({ title, factoryId = placeholderFactory.id }) {
      const inFactory = listTasks().filter((t) => t.factoryId === factoryId)
      const number = Math.max(0, ...inFactory.map((t) => t.number)) + 1
      const row = {
        id: randomUUID(),
        factoryId,
        number,
        title,
        createdAt: new Date().toISOString(),
      }
      store.commit(events.taskCreated(row))
      const task = toPublicTask(toTask({ ...row, stage: 'backlog', branch: null, worktree: null }))
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
      noteActivity()
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
      if (state && state !== current.state) noteActivity()
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
    updateSettings({ appearance, ...others }) {
      const current = settings()
      const at = new Date().toISOString()
      const changed = [
        ...(appearance !== undefined && appearance !== current.appearance
          ? [events.appearanceChanged({ appearance, at })]
          : []),
        ...Object.entries(others)
          .filter(([name, value]) => current[name as keyof MachineSettings] !== value)
          .map(([name, value]) =>
            events.settingChanged({ name, value: JSON.stringify(value), at }),
          ),
      ]
      if (changed.length > 0) {
        store.commit(...changed)
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
