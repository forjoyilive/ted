import type { DaemonConnection } from '@ted/daemon/launch'
import type {
  AgentHealth,
  Automation,
  AutomationDetail,
  AutomationRequest,
  AutomationTemplate,
  Banner,
  CheckRun,
  Comment,
  Coordinator,
  DataStatus,
  DescriptionVersion,
  DriftCounts,
  Factory,
  InboxItem,
  MachineSettings,
  Plan,
  PlanDetail,
  PlanInboxItem,
  RunChat,
  RunSlots,
  RunSummary,
  SimulatorSlots,
  StageEntry,
  StageId,
  Task,
  TaskApp,
  TaskBrief,
  ThreadEvent,
} from '@ted/protocol'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { UpdateStatus } from '../updates.ts'
import { nextReturn } from './banners.ts'
import { type TedEvent, ted } from './ted.ts'

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

export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'update') setStatus(event.status)
    })
    ted.updateStatus().then(setStatus, (error: unknown) => console.error(error))
    return unsubscribe
  }, [])
  return status
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
): { items: T[]; loaded: boolean } {
  const [items, setItems] = useState<T[]>([])
  const [done, setDone] = useState(false)
  const { epoch } = useConnection()

  const loaded = useRef(load)

  useEffect(() => {
    void epoch
    if (loaded.current !== load) setItems([])
    loaded.current = load
    let fresh: T[] | undefined = []
    const dropped = new Set<string>()
    const unsubscribe = ted.onEvent((event) => {
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
    void load().then(
      (loaded) => {
        setItems(
          mergeById(loaded, fresh ?? [])
            .filter((item) => !dropped.has(item.id))
            .sort(order),
        )
        setDone(true)
        fresh = undefined
      },
      () => undefined,
    )
    return unsubscribe
  }, [load, pick, order, drop, epoch])

  return { items, loaded: done }
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
  const { items, loaded } = useLiveList(ted.listFactories, factoryFrom, byPosition, removedFactory)
  return { factories: items, loaded }
}

export function useComments(taskId: string): Comment[] {
  const load = useCallback(() => ted.listComments(taskId), [taskId])
  const pick = useCallback(
    (event: TedEvent) =>
      (event.type === 'comment-posted' || event.type === 'comment-updated') &&
      event.comment.taskId === taskId
        ? event.comment
        : undefined,
    [taskId],
  )
  return useLive(load, pick, byCreatedAt)
}

const byStartedAt = (a: CheckRun, b: CheckRun) => a.startedAt.localeCompare(b.startedAt)

export function useCheckRuns(taskId: string): CheckRun[] {
  const load = useCallback(() => ted.listCheckRuns(taskId), [taskId])
  const pick = useCallback(
    (event: TedEvent) =>
      event.type === 'check-run-updated' && event.checkRun.taskId === taskId
        ? event.checkRun
        : undefined,
    [taskId],
  )
  return useLive(load, pick, byStartedAt)
}

export function useThreadEvents(taskId: string): ThreadEvent[] {
  const [events, setEvents] = useState<ThreadEvent[]>([])
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let latest = 0
    setEvents([])
    const load = () => {
      const call = ++latest
      void ted.listThreadEvents(taskId).then(
        (loaded) => {
          if (call === latest) setEvents(loaded)
        },
        () => undefined,
      )
    }
    const unsubscribe = ted.onEvent((event) => {
      if (
        (event.type === 'task-updated' && event.task.id === taskId) ||
        ((event.type === 'comment-posted' || event.type === 'comment-updated') &&
          event.comment.taskId === taskId)
      ) {
        load()
      }
    })
    load()
    return () => {
      latest = -1
      unsubscribe()
    }
  }, [taskId, epoch])

  return events
}

const inboxEvents = new Set<TedEvent['type']>([
  'comment-posted',
  'comment-updated',
  'task-created',
  'task-updated',
  'task-deleted',
])

export function useInbox(): InboxItem[] {
  return useInboxList(ted.listInbox, true)
}

export function useAnswered(enabled: boolean): InboxItem[] {
  return useInboxList(ted.listAnswered, enabled)
}

function useInboxList(list: () => Promise<InboxItem[]>, enabled: boolean): InboxItem[] {
  const [items, setItems] = useState<InboxItem[]>([])
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    if (!enabled) return
    let latest = 0
    const load = () => {
      const call = ++latest
      void list().then(
        (loaded) => {
          if (call === latest) setItems(loaded)
        },
        () => undefined,
      )
    }
    const unsubscribe = ted.onEvent((event) => {
      if (inboxEvents.has(event.type)) load()
    })
    load()
    return () => {
      latest = -1
      unsubscribe()
    }
  }, [epoch, enabled, list])

  return items
}

export function useSettings(): MachineSettings | undefined {
  const [settings, setSettings] = useState<MachineSettings>()
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let changed = false
    const unsubscribe = ted.onEvent((event) => {
      if (event.type !== 'settings-changed') return
      changed = true
      setSettings(event.settings)
    })
    void ted.getSettings().then(
      (loaded) => {
        if (!changed) setSettings(loaded)
      },
      () => undefined,
    )
    return unsubscribe
  }, [epoch])

  return settings
}

export function useSlots(): RunSlots | undefined {
  const [slots, setSlots] = useState<RunSlots>()
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let live = false
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'slots-changed') {
        live = true
        setSlots(event.slots)
      }
    })
    void ted.getSlots().then(
      (loaded) => {
        if (!live) setSlots(loaded)
      },
      () => undefined,
    )
    return unsubscribe
  }, [epoch])

  return slots
}

export function useDrift(): DriftCounts | undefined {
  const [drift, setDrift] = useState<DriftCounts>()
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let live = false
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'drift-changed') {
        live = true
        setDrift(event.drift)
      }
    })
    void ted.drift().then(
      (loaded) => {
        if (!live) setDrift(loaded)
      },
      () => undefined,
    )
    return unsubscribe
  }, [epoch])

  return drift
}

export function useDataStatus(): DataStatus | undefined {
  const [status, setStatus] = useState<DataStatus>()
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let changed = false
    const unsubscribe = ted.onEvent((event) => {
      if (event.type !== 'data-status') return
      changed = true
      setStatus(event.status)
    })
    void ted.getDataStatus().then(
      (loaded) => {
        if (!changed) setStatus(loaded)
      },
      () => undefined,
    )
    return unsubscribe
  }, [epoch])

  return status
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
  const [banners, setBanners] = useState<Banner[]>([])
  const [now, setNow] = useState(() => Date.now())
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    let whileLoading: Map<string, Banner | undefined> | undefined = new Map()
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'banner-raised' || event.type === 'banner-updated') {
        whileLoading?.set(event.banner.id, event.banner)
        setBanners((current) => mergeById(current, [event.banner]))
      } else if (event.type === 'banner-cleared') {
        whileLoading?.set(event.id, undefined)
        setBanners((current) => current.filter((b) => b.id !== event.id))
      }
    })
    void ted.listBanners().then(
      (loaded) => {
        const changes = whileLoading ?? new Map<string, Banner | undefined>()
        whileLoading = undefined
        const kept = loaded.filter((b) => !changes.has(b.id))
        const raised = [...changes.values()].filter((b) => b !== undefined)
        setBanners(mergeById(kept, raised))
      },
      () => undefined,
    )
    return unsubscribe
  }, [epoch])

  useEffect(() => {
    const at = nextReturn(banners, new Date(now))
    if (at === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(at - Date.now() + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [banners, now])

  return banners
}

export function useAgentHealth(): AgentHealth[] {
  const [health, setHealth] = useState<AgentHealth[]>([])
  const { epoch } = useConnection()

  useEffect(() => {
    void epoch
    const merge = (incoming: AgentHealth[]) =>
      setHealth((current) => {
        const byAgent = new Map(current.map((h) => [h.agent, h]))
        for (const h of incoming) {
          const known = byAgent.get(h.agent)
          if (!known || known.checkedAt <= h.checkedAt) byAgent.set(h.agent, h)
        }
        return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent))
      })
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'agent-health-changed') merge([event.health])
    })
    void ted.agentHealth().then(merge, () => undefined)
    return unsubscribe
  }, [epoch])

  return health
}

function useReloading<T>(
  load: () => Promise<T>,
  affects: (event: TedEvent) => boolean,
  key: string,
): T | undefined {
  const [value, setValue] = useState<T>()
  const { epoch } = useConnection()
  const loadRef = useRef(load)
  const affectsRef = useRef(affects)
  loadRef.current = load
  affectsRef.current = affects

  useEffect(() => {
    void epoch
    void key
    let active = true
    let running = false
    let again = false
    setValue(undefined)
    const run = () => {
      if (running) {
        again = true
        return
      }
      running = true
      loadRef
        .current()
        .then(
          (loaded) => {
            if (active) setValue(loaded)
          },
          () => undefined,
        )
        .finally(() => {
          running = false
          if (active && again) {
            again = false
            run()
          }
        })
    }
    const unsubscribe = ted.onEvent((event) => {
      if (affectsRef.current(event)) run()
    })
    run()
    return () => {
      active = false
      unsubscribe()
    }
  }, [key, epoch])

  return value
}

const planEvent = (event: TedEvent, planId?: string) =>
  ((event.type === 'plan-updated' || event.type === 'plan-deleted') &&
    (planId === undefined || event.planId === planId)) ||
  (event.type === 'run-updated' && (planId === undefined || event.run.id === planId)) ||
  event.type === 'slots-changed' ||
  event.type === 'task-updated'

export function useCoordinator(factoryId: string): Coordinator | null | undefined {
  return useReloading(
    () => ted.getCoordinator(factoryId),
    (event) =>
      (event.type === 'coordinator-changed' && event.factoryId === factoryId) ||
      event.type === 'task-updated' ||
      event.type === 'run-updated' ||
      event.type === 'slots-changed' ||
      event.type === 'agent-health-changed',
    factoryId,
  )
}

export function usePlan(planId: string | undefined): PlanDetail | undefined {
  return useReloading(
    () => (planId === undefined ? Promise.resolve(undefined) : ted.getPlan(planId)),
    (event) => planId !== undefined && planEvent(event, planId),
    planId ?? '',
  ) as PlanDetail | undefined
}

export function usePlans(factoryId: string): Plan[] {
  return (
    useReloading(
      () => ted.listPlans(factoryId),
      (event) => planEvent(event),
      factoryId,
    ) ?? []
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
  return useReloading(
    () => ted.getRunChat(runId),
    (event) =>
      (event.type === 'run-output' && event.runId === runId) ||
      (event.type === 'run-updated' && event.run.id === runId) ||
      ((event.type === 'comment-posted' || event.type === 'comment-updated') &&
        event.comment.kind === 'permission' &&
        event.comment.author.kind === 'run' &&
        event.comment.author.runId === runId),
    runId,
  )
}

export function useTaskRuns(taskId: string): RunSummary[] {
  return (
    useReloading(
      () => ted.listTaskRuns(taskId),
      (event) =>
        (event.type === 'run-updated' && event.run.taskId === taskId) ||
        (event.type === 'task-updated' && event.task.id === taskId),
      taskId,
    ) ?? []
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
    useReloading(
      () => ted.listApps(taskId),
      (event) =>
        (event.type === 'apps-changed' && event.taskId === taskId) ||
        (event.type === 'task-updated' && event.task.id === taskId),
      taskId,
    ) ?? []
  )
}

export function useTaskBrief(taskId: string): TaskBrief | null | undefined {
  return useReloading(
    () => ted.taskBrief(taskId),
    (event) => event.type === 'task-updated' && event.task.id === taskId,
    taskId,
  )
}

export function useDescriptions(taskId: string): DescriptionVersion[] | undefined {
  return useReloading(
    () => ted.taskDescriptions(taskId),
    (event) => event.type === 'task-updated' && event.task.id === taskId,
    taskId,
  )
}

const automationEvents = new Set<TedEvent['type']>([
  'automation-updated',
  'automation-deleted',
  'run-updated',
  'slots-changed',
  'task-updated',
  'task-deleted',
  'agent-health-changed',
])

export function useAutomations(factoryId: string | undefined): Automation[] | undefined {
  return useReloading(
    () => ted.listAutomations(factoryId),
    (event) => automationEvents.has(event.type),
    factoryId ?? '',
  )
}

export function useAutomation(id: string): AutomationDetail | null | undefined {
  return useReloading(
    () => ted.getAutomation(id).catch(() => null),
    (event) => automationEvents.has(event.type),
    id,
  )
}

export function useWaitingCount(): number {
  return (
    useReloading(
      async () => (await ted.listWaiting()).length,
      (event) => event.type === 'inbox-changed',
      '',
    ) ?? 0
  )
}

export function useAutomationRequests(): AutomationRequest[] {
  return (
    useReloading(
      () => ted.automationRequests(),
      (event) => event.type === 'automation-updated' || event.type === 'automation-deleted',
      '',
    ) ?? []
  )
}

export function useAutomationTemplates(): AutomationTemplate[] {
  return useReloading(ted.automationTemplates, () => false, '') ?? []
}
