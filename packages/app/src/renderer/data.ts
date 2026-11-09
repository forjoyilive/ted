import type { DaemonConnection } from '@ted/daemon/launch'
import type {
  Banner,
  Comment,
  Factory,
  MachineSettings,
  StageEntry,
  StageId,
  Task,
} from '@ted/protocol'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { nextReturn } from './banners.ts'
import { type AppEvent, ted } from './ted.ts'

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
    })
    void ted.connection().then(update)
    return unsubscribe
  }, [])

  return current
}

export const useConnection = () => useContext(ConnectionContext)

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()]
}

function useLive<T extends { id: string }>(
  load: () => Promise<T[]>,
  pick: (event: AppEvent) => T | undefined,
  order: (a: T, b: T) => number,
): T[] {
  const [items, setItems] = useState<T[]>([])
  const { epoch } = useConnection()

  const loaded = useRef(load)

  useEffect(() => {
    void epoch
    if (loaded.current !== load) setItems([])
    loaded.current = load
    let fresh: T[] | undefined = []
    const unsubscribe = ted.onEvent((event) => {
      const item = pick(event)
      if (!item) return
      fresh?.push(item)
      setItems((current) => mergeById(current, [item]).sort(order))
    })
    void load().then(
      (loaded) => {
        setItems(mergeById(loaded, fresh ?? []).sort(order))
        fresh = undefined
      },
      () => undefined,
    )
    return unsubscribe
  }, [load, pick, order, epoch])

  return items
}

const byCreatedAt = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt)

const taskFrom = (event: AppEvent) =>
  event.type === 'task-created' || event.type === 'task-updated' ? event.task : undefined

const factoryFrom = (event: AppEvent) =>
  event.type === 'factory-added' ? event.factory : undefined

export function useTasks(): Task[] {
  return useLive(ted.listTasks, taskFrom, byCreatedAt)
}

export function useFactories(): Factory[] {
  return useLive(ted.listFactories, factoryFrom, byCreatedAt)
}

export function useComments(taskId: string): Comment[] {
  const load = useCallback(() => ted.listComments(taskId), [taskId])
  const pick = useCallback(
    (event: AppEvent) =>
      event.type === 'comment-posted' && event.comment.taskId === taskId
        ? event.comment
        : undefined,
    [taskId],
  )
  return useLive(load, pick, byCreatedAt)
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
