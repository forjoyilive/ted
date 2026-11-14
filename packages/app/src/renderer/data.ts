import type { DaemonConnection } from '@ted/daemon/launch'
import type {
  AgentHealth,
  ApiCostReport,
  Automation,
  AutomationDetail,
  AutomationRequest,
  AutomationTaskLink,
  AutomationTemplate,
  Banner,
  CheckRun,
  Comment,
  Coordinator,
  CoordinatorStatus,
  DataStatus,
  DescriptionVersion,
  DriftCounts,
  Factory,
  FailureCase,
  InboxItem,
  MachineSettings,
  Plan,
  PlanDetail,
  PlanInboxItem,
  RunChat,
  RunSlots,
  RunSummary,
  SimulatorSlots,
  SnoozedRequest,
  StageEntry,
  StageId,
  Task,
  TaskApp,
  TaskBrief,
  TedStoppedTask,
  ThreadEvent,
  ValidationObligations,
  WaitingRequest,
} from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { countWaiting } from '@ted/protocol/waiting'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { UpdateStatus } from '../updates.ts'
import { nextReturn } from './banners.ts'
import { type EventChange, eventValue, type ValueUpdate } from './event-value.ts'
import { inboxChange } from './inbox-events.ts'
import { useRefreshAction } from './refresh-action.ts'
import { sharedValues } from './shared-value.ts'
import { readableError, type TedEvent, ted } from './ted.ts'

export interface Connection {
  connection: DaemonConnection
  epoch: number
}

export const ConnectionContext = createContext<Connection>({
  connection: { state: 'connected' },
  epoch: 0,
})

export function useConnectionState(): Connection {
  const [current, setCurrent] = useState<Connection>({
    connection: { state: 'connected' },
    epoch: 0,
  })

  useEffect(() => {
    const update = (connection: DaemonConnection) =>
      setCurrent((previous) => ({
        connection,
        epoch:
          connection.state === 'connected' && previous.connection.state !== 'connected'
            ? previous.epoch + 1
            : previous.epoch,
      }))
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'connection') update(event.connection)
      if (event.type === 'data-status' && event.status.state === 'ready') {
        setCurrent((previous) => ({ ...previous, epoch: previous.epoch + 1 }))
      }
    })
    void ted.connection().then(update)
    return unsubscribe
  }, [])

  return current
}

export const useConnection = () => useContext(ConnectionContext)

export function useEventValue<T>(options: {
  initial: T
  load: () => Promise<T>
  event: (event: TedEvent) => EventChange<T>
  key?: string
  enabled?: boolean
  focus?: boolean
  reconcile?: (loaded: T, current: T) => T
  changed?: (value: T) => void
  error?: (error: unknown) => void
}) {
  const { epoch } = useConnection()
  const key = options.key ?? ''
  const enabled = options.enabled ?? true
  const focus = options.focus ?? false
  const [state, setState] = useState<{
    key: string
    value: T
    loaded: boolean
    error: string | undefined
  }>({ key, value: options.initial, loaded: false, error: undefined })
  const current = useRef(options)
  current.current = options
  const snapshot = useRef(state)
  snapshot.current = state
  const controller = useRef<ReturnType<typeof eventValue<T, TedEvent>> | undefined>(undefined)
  useEffect(() => {
    void epoch
    if (!enabled) return
    setState((previous) =>
      previous.key === key
        ? { ...previous, error: undefined }
        : { key, value: current.current.initial, loaded: false, error: undefined },
    )
    const source = eventValue<T, TedEvent>({
      initial: snapshot.current.key === key ? snapshot.current.value : current.current.initial,
      load: () => current.current.load(),
      event: (event) => current.current.event(event),
      subscribe: ted.onEvent,
      reconcile: (loaded, value) =>
        current.current.reconcile ? current.current.reconcile(loaded, value) : loaded,
      changed: (value) => {
        setState((previous) => ({
          key,
          value,
          loaded: previous.key === key && previous.loaded,
          error: undefined,
        }))
        current.current.changed?.(value)
      },
      loaded: () => setState((previous) => ({ ...previous, loaded: true })),
      error: (error) => {
        setState((previous) => ({ ...previous, error: readableError(error) }))
        current.current.error?.(error)
      },
    })
    controller.current = source
    const refresh = () => void source.refresh()
    if (focus) window.addEventListener('focus', refresh)
    return () => {
      source.dispose()
      if (focus) window.removeEventListener('focus', refresh)
      if (controller.current === source) controller.current = undefined
    }
  }, [key, epoch, enabled, focus])
  const refresh = useCallback((load?: () => Promise<T>) => {
    setState((previous) => ({ ...previous, error: undefined }))
    return controller.current?.refresh(load) ?? Promise.resolve(undefined)
  }, [])
  const update = useCallback((change: ValueUpdate<T>) => controller.current?.update(change), [])
  const retry = useCallback(() => refresh(), [refresh])
  return {
    value: state.key === key ? state.value : options.initial,
    loaded: state.key === key && state.loaded,
    error: state.key === key ? state.error : undefined,
    retry,
    refresh,
    update,
  }
}

const shared = sharedValues<TedEvent>({
  subscribe: (listener) => ted.onEvent(listener),
  describe: readableError,
})

function useShared<T>(
  key: string,
  load: () => Promise<T>,
  event: (event: TedEvent) => EventChange<T | undefined>,
) {
  const { epoch } = useConnection()
  const request = useRef({ load, event, epoch })
  request.current = { load, event, epoch }
  const subscribe = useCallback(
    (notify: () => void) => {
      const { load, event, epoch } = request.current
      return shared.use<T>(key, epoch, { load, event }, notify)
    },
    [key],
  )
  const snapshot = useSyncExternalStore(subscribe, () => shared.read<T>(key))
  useEffect(() => shared.renew(key, epoch), [key, epoch])
  const retry = useCallback(() => shared.refresh(key), [key])
  return { ...snapshot, retry }
}

export function useBrowserOpen(
  taskId: string,
  open: (app: Extract<TedEvent, { type: 'browser-open' }>['app']) => void,
) {
  const current = useRef(open)
  current.current = open
  useEffect(
    () =>
      ted.onEvent((event) => {
        if (event.type === 'browser-open' && event.taskId === taskId) current.current(event.app)
      }),
    [taskId],
  )
}

export function useMenuCommands(
  command: (command: import('../background.ts').MenuCommand) => void,
) {
  const current = useRef(command)
  current.current = command
  useEffect(
    () =>
      ted.onEvent((event) => {
        if (event.type === 'menu-command') current.current(event.command)
      }),
    [],
  )
}

export function useUpdateStatus(): UpdateStatus {
  return useEventValue<UpdateStatus>({
    initial: { state: 'idle' },
    load: ted.updateStatus,
    event: (event) => (event.type === 'update' ? () => event.status : undefined),
    error: (error) => console.error(error),
  }).value
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()]
}

const keepAll = () => undefined

function useLive<T extends { id: string }>(
  load: () => Promise<T[]>,
  pick: (event: TedEvent) => T | undefined,
  order: (a: T, b: T) => number,
  drop: (event: TedEvent) => string | undefined = keepAll,
): T[] {
  return useLiveList(load, pick, order, drop).items
}

function useLiveList<T extends { id: string }>(
  load: () => Promise<T[]>,
  pick: (event: TedEvent) => T | undefined,
  order: (a: T, b: T) => number,
  drop: (event: TedEvent) => string | undefined = keepAll,
  retryEveryMs?: number,
  reloadOn?: (event: TedEvent) => boolean,
): { items: T[]; loaded: boolean; error: string | undefined; retry: () => void } {
  const [items, setItems] = useState<T[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string>()
  const { revision: attempt, refresh: retry, settled } = useRefreshAction()
  const { epoch } = useConnection()

  const loaded = useRef(load)

  useEffect(() => {
    void epoch
    void attempt
    if (loaded.current !== load) {
      setItems([])
      setDone(false)
    }
    setError(undefined)
    loaded.current = load
    let active = true
    let again: ReturnType<typeof setTimeout> | undefined
    let fresh: T[] | undefined = []
    const dropped = new Set<string>()
    const unsubscribe = ted.onEvent((event) => {
      if (reloadOn?.(event)) {
        setItems([])
        void retry()
        return
      }
      const gone = drop(event)
      if (gone !== undefined) {
        dropped.add(gone)
        setItems((current) => current.filter((item) => item.id !== gone))
        return
      }
      const item = pick(event)
      if (!item || dropped.has(item.id)) return
      fresh?.push(item)
      setItems((current) => mergeById(current, [item]).sort(order))
    })
    void load()
      .then(
        (loaded) => {
          if (!active) return
          setItems(
            mergeById(loaded, fresh ?? [])
              .filter((item) => !dropped.has(item.id))
              .sort(order),
          )
          setDone(true)
          fresh = undefined
        },
        (failure: unknown) => {
          if (!active) return
          setError(readableError(failure))
          if (retryEveryMs !== undefined)
            again = setTimeout(() => {
              void retry()
            }, retryEveryMs)
        },
      )
      .finally(() => settled(attempt))
    return () => {
      settled(attempt)
      active = false
      clearTimeout(again)
      unsubscribe()
    }
  }, [load, pick, order, drop, epoch, attempt, retryEveryMs, retry, settled, reloadOn])

  const current = loaded.current === load
  return {
    items: current ? items : [],
    loaded: current && done,
    error: current ? error : undefined,
    retry,
  }
}

const byCreatedAt = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt)

const taskFrom = (event: TedEvent) =>
  event.type === 'task-created' || event.type === 'task-updated' ? event.task : undefined

const deletedTask = (event: TedEvent) => (event.type === 'task-deleted' ? event.taskId : undefined)

const factoryFrom = (event: TedEvent) =>
  event.type === 'factory-added' || event.type === 'factory-updated' ? event.factory : undefined

export function useTasks(): Task[] {
  return useLive(ted.listTasks, taskFrom, byCreatedAt, deletedTask)
}

const byPosition = (a: Factory, b: Factory) =>
  a.position - b.position || a.createdAt.localeCompare(b.createdAt)

const removedFactory = (event: TedEvent) =>
  event.type === 'factory-removed' ? event.factoryId : undefined

export function useFactories(): Factory[] {
  return useLive(ted.listFactories, factoryFrom, byPosition, removedFactory)
}

export function useFactoryList(): { factories: Factory[]; loaded: boolean } {
  // The window has no Factories until this load succeeds, so a failed one is tried again:
  // a daemon too busy to answer once must not leave the sidebar empty.
  const { items, loaded } = useLiveList(
    ted.listFactories,
    factoryFrom,
    byPosition,
    removedFactory,
    2_000,
  )
  return { factories: items, loaded }
}

export function useComments(taskId: string): Comment[] {
  return useCommentList(taskId).items
}

export function useCommentList(taskId: string) {
  const load = useCallback(() => ted.listComments(taskId), [taskId])
  const pick = useCallback(
    (event: TedEvent) =>
      (event.type === 'comment-posted' || event.type === 'comment-updated') &&
      event.comment.taskId === taskId
        ? event.comment
        : undefined,
    [taskId],
  )
  const reset = useCallback(
    (event: TedEvent) => event.type === 'task-reset' && event.taskId === taskId,
    [taskId],
  )
  return useLiveList(load, pick, byCreatedAt, undefined, undefined, reset)
}

const byStartedAt = (a: CheckRun, b: CheckRun) => a.startedAt.localeCompare(b.startedAt)

export function useCheckRuns(taskId: string): CheckRun[] {
  return useCheckRunList(taskId).items
}

export function useCheckRunList(taskId: string) {
  const load = useCallback(() => ted.listCheckRuns(taskId), [taskId])
  const pick = useCallback(
    (event: TedEvent) =>
      event.type === 'check-run-updated' && event.checkRun.taskId === taskId
        ? event.checkRun
        : undefined,
    [taskId],
  )
  const reset = useCallback(
    (event: TedEvent) => event.type === 'task-reset' && event.taskId === taskId,
    [taskId],
  )
  return useLiveList(load, pick, byStartedAt, undefined, undefined, reset)
}

export function useThreadEvents(taskId: string): ThreadEvent[] {
  return useThreadEventList(taskId).value ?? []
}

export function useThreadEventList(taskId: string) {
  return useShared<ThreadEvent[]>(
    `thread-events:${taskId}`,
    () => ted.listThreadEvents(taskId),
    (event) =>
      (event.type === 'task-updated' && event.task.id === taskId) ||
      ((event.type === 'comment-posted' || event.type === 'comment-updated') &&
        event.comment.taskId === taskId)
        ? 'reload'
        : undefined,
  )
}

export function useInbox(): InboxItem[] {
  return useInboxList('waiting', true)
}

export function useAnswered(enabled: boolean): InboxItem[] {
  return useInboxList('answered', enabled)
}

function useInboxList(list: 'waiting' | 'answered', enabled: boolean): InboxItem[] {
  const shown = useRef<readonly InboxItem[]>([])
  return useEventValue<InboxItem[]>({
    initial: [],
    load: list === 'waiting' ? ted.listInbox : ted.listAnswered,
    enabled,
    key: list,
    event: (event) => inboxChange(event, shown.current, list),
    changed: (value) => {
      shown.current = value
    },
  }).value
}

export function useSettings(): MachineSettings | undefined {
  return useSettingsState().settings
}

export function useSettingsState() {
  const resource = useEventValue<MachineSettings | undefined>({
    initial: undefined,
    load: ted.getSettings,
    event: (event) => (event.type === 'settings-changed' ? () => event.settings : undefined),
  })
  return { settings: resource.value, error: resource.error, retry: resource.retry }
}

export function useSlots(): RunSlots | undefined {
  return useEventValue<RunSlots | undefined>({
    initial: undefined,
    load: ted.getSlots,
    event: (event) => (event.type === 'slots-changed' ? () => event.slots : undefined),
  }).value
}

export function useTedStops(): TedStoppedTask[] {
  const listed = useRef<ReadonlySet<string>>(new Set())
  const stops =
    useReloading(
      () => ted.tedStops(),
      (event) =>
        event.type === 'ted-stops-changed' ||
        (event.type === 'task-updated' && listed.current.has(event.task.id)) ||
        (event.type === 'task-deleted' && listed.current.has(event.taskId)),
      'ted-stops',
    ) ?? []
  listed.current = new Set(stops.map((task) => task.id))
  return stops
}

export function useDrift(): DriftCounts | undefined {
  return useEventValue<DriftCounts | undefined>({
    initial: undefined,
    load: ted.drift,
    event: (event) => (event.type === 'drift-changed' ? () => event.drift : undefined),
  }).value
}

export function useDataStatus(): DataStatus | undefined {
  return useDataStatusState().status
}

export function useDataStatusState() {
  const resource = useEventValue<DataStatus | undefined>({
    initial: undefined,
    load: ted.getDataStatus,
    event: (event) => (event.type === 'data-status' ? () => event.status : undefined),
  })
  return { status: resource.value, error: resource.error, retry: resource.retry }
}

export function useStageEntries(taskId: string, stage: StageId): StageEntry[] {
  const [entries, setEntries] = useState<StageEntry[]>([])
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let current = true
    if (stage === 'backlog') {
      setEntries([])
      return
    }
    void ted.listStageEntries(taskId).then(
      (loaded) => {
        if (current) setEntries(loaded)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [taskId, stage, epoch])

  return entries
}

export function useBanners(): Banner[] {
  const { value: banners } = useEventValue<Banner[]>({
    initial: [],
    load: ted.listBanners,
    event: (event) => {
      if (event.type === 'banner-raised' || event.type === 'banner-updated')
        return (current) => mergeById(current, [event.banner])
      if (event.type === 'banner-cleared')
        return (current) => current.filter((b) => b.id !== event.id)
      return undefined
    },
  })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const at = nextReturn(banners, new Date(now))
    if (at === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(at - Date.now() + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [banners, now])

  return banners
}

function mergeHealth(current: AgentHealth[], incoming: AgentHealth[]): AgentHealth[] {
  const byAgent = new Map(current.map((h) => [h.agent, h]))
  for (const health of incoming) {
    const known = byAgent.get(health.agent)
    if (!known || known.checkedAt <= health.checkedAt) byAgent.set(health.agent, health)
  }
  return [...byAgent.values()].sort(
    (a, b) => agentKinds.indexOf(a.agent) - agentKinds.indexOf(b.agent),
  )
}

export function useAgentHealth(): AgentHealth[] {
  return useAgentHealthState().health
}

const finishedRun = (event: TedEvent) =>
  event.type === 'run-updated' && event.run.state === 'finished'

export function useApiCost(): ApiCostReport | undefined {
  return useReloading(ted.apiCost, finishedRun, 'api-cost')
}

export function useAgentHealthState() {
  const resource = useEventValue<AgentHealth[]>({
    initial: [],
    load: ted.agentHealth,
    reconcile: (loaded, current) => mergeHealth(current, loaded),
    event: (event) =>
      event.type === 'agent-health-changed'
        ? (current) => mergeHealth(current, [event.health])
        : undefined,
  })
  return {
    health: resource.value,
    loaded: resource.loaded,
    error: resource.error,
    retry: resource.retry,
  }
}

interface Loaded<T> {
  value: T | undefined
  loading: boolean
}

function useReloading<T>(
  load: () => Promise<T>,
  affects: (event: TedEvent, current: Loaded<T>) => boolean,
  key: string,
): T | undefined {
  return useReloadingState(load, affects, key).value
}

const outputEveryMs = 1_000

const outputLines = (event: TedEvent) => event.type === 'run-output' && event.lines === true

function useReloadingState<T>(
  load: () => Promise<T>,
  affects: (event: TedEvent, current: Loaded<T>) => boolean,
  key: string,
  paced: (event: TedEvent) => boolean = () => false,
) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string }>()
  const { revision: attempt, refresh: retry, settled } = useRefreshAction()
  const { epoch } = useConnection()
  const loadRef = useRef(load)
  const affectsRef = useRef(affects)
  const pacedRef = useRef(paced)
  loadRef.current = load
  affectsRef.current = affects
  pacedRef.current = paced

  useEffect(() => {
    void epoch
    void attempt
    let active = true
    let running = false
    let again = false
    let latest: T | undefined
    let pacedAt = Number.NEGATIVE_INFINITY
    let timer: ReturnType<typeof setTimeout> | undefined
    setState((previous) => ({
      key,
      ...(previous?.key === key && previous.value !== undefined && { value: previous.value }),
    }))
    const run = () => {
      if (running) {
        again = true
        return
      }
      running = true
      return loadRef
        .current()
        .then(
          (value) => {
            latest = value
            if (active) setState({ key, value })
          },
          (failure: unknown) => {
            if (active)
              setState((previous) => ({ ...previous, key, error: readableError(failure) }))
          },
        )
        .finally(() => {
          running = false
          if (active && again) {
            again = false
            run()
          }
        })
    }
    const now = () => {
      clearTimeout(timer)
      timer = undefined
      pacedAt = Date.now()
      run()
    }
    const unsubscribe = ted.onEvent((event) => {
      if (!affectsRef.current(event, { value: latest, loading: running })) return
      const wait = pacedRef.current(event) ? pacedAt + outputEveryMs - Date.now() : 0
      if (wait <= 0) now()
      else timer ??= setTimeout(now, wait)
    })
    void run()?.finally(() => settled(attempt))
    return () => {
      settled(attempt)
      active = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [key, epoch, attempt, settled])

  return {
    value: state?.key === key ? state.value : undefined,
    error: state?.key === key ? state.error : undefined,
    retry,
  }
}

const planEvent = (event: TedEvent, factoryId: string | undefined, planId?: string) =>
  ((event.type === 'plan-updated' || event.type === 'plan-deleted') &&
    (planId === undefined || event.planId === planId)) ||
  (event.type === 'run-updated' && (planId === undefined || event.run.id === planId)) ||
  event.type === 'slots-changed' ||
  (event.type === 'task-updated' && (factoryId === undefined || event.task.factoryId === factoryId))

const busyEvents = (event: TedEvent) =>
  event.type === 'task-updated' || event.type === 'run-updated' || event.type === 'slots-changed'

export function useCoordinator(factoryId: string): Coordinator | null | undefined {
  return useCoordinatorState(factoryId).value
}

export function useCoordinatorState(factoryId: string) {
  return useReloadingState(
    () => ted.coordinator(factoryId),
    (event) =>
      (event.type === 'coordinator-changed' && event.factoryId === factoryId) ||
      (event.type === 'task-updated' && event.task.factoryId === factoryId) ||
      event.type === 'run-updated' ||
      event.type === 'slots-changed' ||
      event.type === 'agent-health-changed',
    factoryId,
    busyEvents,
  )
}

export function useCoordinatorChat(
  factoryId: string,
  runIds: readonly string[],
): RunChat | null | undefined {
  return useCoordinatorChatState(factoryId, runIds).value
}

export function useCoordinatorChatState(factoryId: string, runIds: readonly string[]) {
  return useReloadingState(
    () => ted.coordinatorChat(factoryId),
    (event) =>
      (event.type === 'coordinator-changed' && event.factoryId === factoryId) ||
      (event.type === 'run-output' && runIds.includes(event.runId)) ||
      (event.type === 'run-updated' && runIds.includes(event.run.id)) ||
      event.type === 'agent-health-changed',
    factoryId,
    outputLines,
  )
}

export function useCoordinatorConversations(factoryId: string) {
  return useReloadingState(
    () => ted.coordinatorConversations(factoryId),
    (event) =>
      (event.type === 'coordinator-changed' && event.factoryId === factoryId) ||
      (event.type === 'task-updated' && event.task.factoryId === factoryId),
    factoryId,
  )
}

export function useCoordinatorConversationState(factoryId: string, conversationId: string) {
  return useReloadingState(
    () => ted.coordinatorConversation(factoryId, conversationId),
    (event) =>
      (event.type === 'coordinator-changed' && event.factoryId === factoryId) ||
      (event.type === 'task-updated' && event.task.factoryId === factoryId),
    `${factoryId}:${conversationId}`,
  )
}

export function useCoordinatorConversationChatState(factoryId: string, conversationId: string) {
  return useReloadingState(
    () => ted.coordinatorConversationChat(factoryId, conversationId),
    (event) => event.type === 'coordinator-changed' && event.factoryId === factoryId,
    `${factoryId}:${conversationId}`,
  )
}

export function useCoordinatorStatuses(): CoordinatorStatus[] {
  return (
    useReloading(
      () => ted.coordinatorStatuses(),
      (event) => event.type === 'coordinator-changed' || event.type === 'agent-health-changed',
      'coordinator-statuses',
    ) ?? []
  )
}

export function usePlan(planId: string | undefined): PlanDetail | undefined {
  return usePlanState(planId).value
}

export function usePlanState(planId: string | undefined) {
  return useReloadingState(
    () => (planId === undefined ? Promise.resolve(undefined) : ted.getPlan(planId)),
    (event, current) =>
      planId !== undefined && planEvent(event, current.value?.plan.factoryId, planId),
    planId ?? '',
    busyEvents,
  )
}

export function usePlans(factoryId: string): Plan[] {
  return (
    useReloadingState(
      () => ted.listPlans(factoryId),
      (event) => planEvent(event, factoryId),
      factoryId,
      busyEvents,
    ).value ?? []
  )
}

export function useAllPlans(): Plan[] {
  return (
    useReloading(
      () => ted.listPlans(),
      (event) => event.type === 'plan-updated' || event.type === 'plan-deleted',
      'all-plans',
    ) ?? []
  )
}

export function usePlanInbox(): PlanInboxItem[] {
  return (
    useReloading(
      () => ted.planInbox(),
      (event) => event.type === 'plan-updated' || event.type === 'plan-deleted',
      'plan-inbox',
    ) ?? []
  )
}

export function useRunChat(runId: string): RunChat | undefined {
  return useRunChatState(runId).value
}

export function useRunChatState(runId: string | undefined) {
  return useReloadingState(
    () => (runId === undefined ? Promise.resolve(undefined) : ted.getRunChat(runId)),
    (event) =>
      (event.type === 'run-output' && event.runId === runId) ||
      (event.type === 'run-updated' && event.run.id === runId) ||
      ((event.type === 'comment-posted' || event.type === 'comment-updated') &&
        event.comment.kind === 'permission' &&
        event.comment.author.kind === 'run' &&
        event.comment.author.runId === runId),
    runId ?? '',
    outputLines,
  )
}

export function useTaskRuns(taskId: string): RunSummary[] {
  return useTaskRunsState(taskId).value ?? []
}

export function useTaskRunsState(taskId: string, enabled = true) {
  return useReloadingState(
    () => (enabled ? ted.listTaskRuns(taskId) : Promise.resolve([])),
    (event) =>
      enabled &&
      ((event.type === 'run-updated' && event.run.taskId === taskId) ||
        (event.type === 'task-updated' && event.task.id === taskId)),
    `task-runs:${enabled ? taskId : 'none'}`,
  )
}

export function useSimulators(): SimulatorSlots | undefined {
  return useReloading(
    () => ted.simulators(),
    (event) => event.type === 'simulators-changed' || event.type === 'settings-changed',
    'simulators',
  )
}

export function useTaskApps(taskId: string): TaskApp[] {
  return (
    useShared<TaskApp[]>(
      `apps:${taskId}`,
      () => ted.listApps(taskId),
      (event) =>
        (event.type === 'apps-changed' && event.taskId === taskId) ||
        (event.type === 'task-updated' && event.task.id === taskId)
          ? 'reload'
          : undefined,
    ).value ?? []
  )
}

export function useRunApps(runId: string, enabled: boolean): TaskApp[] {
  return (
    useShared<TaskApp[]>(
      `run-apps:${runId}:${enabled}`,
      () => (enabled ? ted.listRunApps(runId).catch(() => []) : Promise.resolve([])),
      (event) =>
        (event.type === 'apps-changed' && event.taskId === runId) ||
        (event.type === 'automation-updated' && enabled)
          ? 'reload'
          : undefined,
    ).value ?? []
  )
}

export function useTaskBrief(taskId: string): TaskBrief | null | undefined {
  return useTaskBriefState(taskId).value
}

export function useTaskBriefState(taskId: string) {
  return useReloadingState(
    () => ted.taskBrief(taskId),
    (event) => event.type === 'task-updated' && event.task.id === taskId,
    taskId,
  )
}

export function useDescriptions(taskId: string): DescriptionVersion[] | undefined {
  return useDescriptionsState(taskId).value
}

export function useDescriptionsState(taskId: string) {
  return useReloadingState(
    () => ted.taskDescriptions(taskId),
    (event) => event.type === 'task-updated' && event.task.id === taskId,
    taskId,
  )
}

const taskSignature = (link: AutomationTaskLink) =>
  JSON.stringify([link.displayId, link.title, link.stage, link.source])

interface AutomationsShown {
  ids: readonly string[]
  tasks: readonly AutomationTaskLink[]
}

const automationFolder = /[\\/]automations[\\/]([^\\/]+)$/

function automationWatch<T>(shown: (value: T) => AutomationsShown) {
  const seen = new Map<string, string>([['slots', '']])
  const differs = (id: string, signature: string) => {
    const before = seen.get(id)
    seen.set(id, signature)
    return before !== signature
  }
  return (event: TedEvent, { value, loading }: Loaded<T>): boolean => {
    const view = value === undefined ? undefined : shown(value)
    const shows = (automationId: string) => view === undefined || view.ids.includes(automationId)
    switch (event.type) {
      case 'automation-updated':
      case 'automation-deleted':
      case 'task-deleted':
        return true
      case 'agent-health-changed':
        return differs(`agent ${event.health.agent}`, event.health.reason ?? '')
      case 'run-updated': {
        const { run } = event
        if (run.taskId !== undefined || run.parentRunId !== undefined) return false
        const automationId = automationFolder.exec(run.cwd)?.[1]
        return (
          automationId !== undefined && shows(automationId) && differs(`run ${run.id}`, run.state)
        )
      }
      case 'slots-changed':
        return differs(
          'slots',
          event.slots.queue
            .flatMap((q) =>
              q.kind === 'automation' && shows(q.automationId) ? [`${q.runId} ${q.place}`] : [],
            )
            .join(),
        )
      case 'task-updated': {
        const { task } = event
        if (
          task.createdBy === 'human' ||
          task.createdBy === 'planning' ||
          task.createdBy === 'setup' ||
          task.createdBy === 'coordinator'
        ) {
          return false
        }
        const id = `task ${task.id}`
        const signature = taskSignature({
          id: task.id,
          displayId: task.displayId,
          title: task.title,
          stage: task.stage,
          ...(task.source?.url !== undefined && { source: task.source.url }),
        })
        const link = view?.tasks.find((l) => l.id === task.id)
        if (!link) return loading && differs(id, signature)
        const before = seen.get(id) ?? taskSignature(link)
        seen.set(id, signature)
        return before !== signature
      }
      default:
        return false
    }
  }
}

const everyEvent = () => true

const listShown = (automations: Automation[]): AutomationsShown => ({
  ids: automations.map((a) => a.id),
  tasks: automations.flatMap((a) => a.last?.created ?? []),
})

const detailShown = (detail: AutomationDetail | null): AutomationsShown => ({
  ids: detail ? [detail.automation.id] : [],
  tasks: detail?.history.flatMap((row) => row.created ?? []) ?? [],
})

export function useAutomationOutcomes(): Automation[] | undefined {
  return useReloadingState(
    () => ted.listAutomations(undefined),
    (event) => event.type === 'automation-updated' || event.type === 'automation-deleted',
    'automation-outcomes',
    everyEvent,
  ).value
}

export function useAutomationsState(factoryId: string | undefined) {
  const { epoch } = useConnection()
  const key = factoryId ?? ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new connection or list starts a new watch
  const affects = useMemo(() => automationWatch(listShown), [epoch, key])
  return useReloadingState(() => ted.listAutomations(factoryId), affects, key, everyEvent)
}

export function useAutomation(id: string): AutomationDetail | null | undefined {
  return useAutomationState(id).value
}

export function useAutomationState(id: string) {
  const { epoch } = useConnection()
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new connection or Automation starts a new watch
  const watch = useMemo(() => automationWatch(detailShown), [epoch, id])
  return useReloadingState(
    () => ted.getAutomation(id),
    (event, current) =>
      event.type === 'automation-updated' || event.type === 'automation-deleted'
        ? current.value == null ||
          event.automationId === id ||
          event.automationId === current.value.automation.id
        : watch(event, current),
    id,
    everyEvent,
  )
}

export function useWaitingCount(): number {
  return (
    useEventValue<number | undefined>({
      initial: undefined,
      load: async () => countWaiting(await ted.listWaiting()),
      event: (event) =>
        event.type === 'inbox-changed' ? () => countWaiting(event.waiting) : undefined,
    }).value ?? 0
  )
}

export type ConfirmationRequest = Extract<WaitingRequest, { source: 'coordinator' }>

export function useCoordinatorConfirmations(): ConfirmationRequest[] {
  const pick = (requests: readonly WaitingRequest[]) =>
    requests.filter((r): r is ConfirmationRequest => r.source === 'coordinator')
  return useEventValue<ConfirmationRequest[]>({
    initial: [],
    load: async () => {
      const [waiting, snoozed] = await Promise.all([ted.listWaiting(), ted.listSnoozed()])
      return pick([...waiting, ...snoozed])
    },
    event: (event) =>
      event.type === 'inbox-changed' ? () => pick([...event.waiting, ...event.snoozed]) : undefined,
  }).value
}

export function useSnoozedRequests(): SnoozedRequest[] {
  return useEventValue<SnoozedRequest[]>({
    initial: [],
    load: ted.listSnoozed,
    event: (event) => (event.type === 'inbox-changed' ? () => event.snoozed : undefined),
  }).value
}

export function useAutomationRequests(): AutomationRequest[] {
  return (
    useReloadingState(
      () => ted.automationRequests(),
      (event) => event.type === 'automation-updated' || event.type === 'automation-deleted',
      '',
      everyEvent,
    ).value ?? []
  )
}

export function useAutomationTemplates(): AutomationTemplate[] {
  return useReloading(ted.automationTemplates, () => false, '') ?? []
}

export function useFailures(taskId: string): FailureCase[] {
  return useValidationData(`failures:${taskId}`, () => ted.listFailures(taskId), taskId) ?? []
}

export function useValidationObligations(taskId: string): ValidationObligations | undefined {
  return useValidationData(`obligations:${taskId}`, () => ted.validationObligations(taskId), taskId)
}

function useValidationData<T>(key: string, load: () => Promise<T>, taskId: string): T | undefined {
  return useShared<T>(key, load, (event) =>
    (event.type === 'task-updated' && event.task.id === taskId) ||
    ((event.type === 'comment-posted' || event.type === 'comment-updated') &&
      event.comment.taskId === taskId) ||
    (event.type === 'check-run-updated' && event.checkRun.taskId === taskId)
      ? 'reload'
      : undefined,
  ).value
}

export function useFactoryDashboard(
  factoryId: string,
  range: import('@ted/protocol').DashboardRange,
) {
  const resource = useReloadingState(
    () => ted.factoryDashboard(factoryId, range),
    (event) =>
      ((event.type === 'task-created' || event.type === 'task-updated') &&
        event.task.factoryId === factoryId) ||
      event.type === 'task-deleted' ||
      (event.type === 'factory-removed' && event.factoryId === factoryId) ||
      (event.type === 'factory-updated' && event.factory.id === factoryId) ||
      event.type === 'settings-changed',
    JSON.stringify([factoryId, range]),
    () => true,
  )
  const retry = useRef(resource.retry)
  retry.current = resource.retry
  useEffect(() => {
    const refresh = () => retry.current()
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return resource
}

export function usePolledResource<T>(load: () => Promise<T>, everyMs = 1500) {
  const { epoch } = useConnection()
  const [value, setValue] = useState<T>()
  const [error, setError] = useState<string>()
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    void epoch
    void generation
    let active = true,
      running = false
    const refresh = () => {
      if (running) return
      running = true
      void load()
        .then(
          (next) => {
            if (active) {
              setValue(next)
              setError(undefined)
            }
          },
          (failure: unknown) => {
            if (active) setError(failure instanceof Error ? failure.message : String(failure))
          },
        )
        .finally(() => {
          running = false
        })
    }
    refresh()
    const timer = setInterval(refresh, everyMs)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [load, everyMs, epoch, generation])
  return { value, error, reload: () => setGeneration((n) => n + 1) }
}
