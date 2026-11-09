import type { Banner, Comment, DaemonEvent, Factory, MachineSettings, Task } from '@ted/protocol'
import { useCallback, useEffect, useState } from 'react'
import { nextReturn } from './banners.ts'
import { ted } from './ted.ts'

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()]
}

function useLive<T extends { id: string }>(
  load: () => Promise<T[]>,
  pick: (event: DaemonEvent) => T | undefined,
  order: (a: T, b: T) => number,
): T[] {
  const [items, setItems] = useState<T[]>([])

  useEffect(() => {
    setItems([])
    const add = (incoming: T[]) => setItems((current) => mergeById(current, incoming).sort(order))
    const unsubscribe = ted.onEvent((event) => {
      const item = pick(event)
      if (item) add([item])
    })
    void load().then(add)
    return unsubscribe
  }, [load, pick, order])

  return items
}

const byCreatedAt = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt)

const taskFrom = (event: DaemonEvent) =>
  event.type === 'task-created' || event.type === 'task-updated' ? event.task : undefined

const factoryFrom = (event: DaemonEvent) =>
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
    (event: DaemonEvent) =>
      event.type === 'comment-posted' && event.comment.taskId === taskId
        ? event.comment
        : undefined,
    [taskId],
  )
  return useLive(load, pick, byCreatedAt)
}

export function useSettings(): MachineSettings | undefined {
  const [settings, setSettings] = useState<MachineSettings>()

  useEffect(() => {
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'settings-changed') setSettings(event.settings)
    })
    void ted.getSettings().then((loaded) => setSettings((current) => current ?? loaded))
    return unsubscribe
  }, [])

  return settings
}

export function useBanners(): Banner[] {
  const [banners, setBanners] = useState<Banner[]>([])
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'banner-raised' || event.type === 'banner-updated') {
        setBanners((current) => mergeById(current, [event.banner]))
      } else if (event.type === 'banner-cleared') {
        setBanners((current) => current.filter((b) => b.id !== event.id))
      }
    })
    void ted.listBanners().then((loaded) => setBanners((current) => mergeById(loaded, current)))
    return unsubscribe
  }, [])

  useEffect(() => {
    const at = nextReturn(banners)
    if (at === undefined) return
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      Math.min(at - Date.now() + 50, 2 ** 31 - 1),
    )
    return () => clearTimeout(timer)
  }, [banners])

  return banners
}
