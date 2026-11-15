import type { ArchiveExpiry, Task } from '@ted/protocol'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import type { Tasks } from './tasks.ts'

const dayMs = 24 * 60 * 60 * 1000

export interface DueTree {
  root: Task
  tasks: Task[]
}

export interface ArchivedDue {
  due: DueTree[]
  kept: Task[]
}

export function archivedDue(tasks: readonly Task[], days: number, now: Date): ArchivedDue {
  const cutoff = now.getTime() - days * dayMs
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const children = new Map<string, Task[]>()
  for (const task of tasks) {
    if (task.parentId === undefined) continue
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task])
  }
  const tree = (root: Task): Task[] => {
    const found: Task[] = []
    const seen = new Set<string>()
    const walk = (task: Task) => {
      if (seen.has(task.id)) return
      seen.add(task.id)
      found.push(task)
      for (const child of children.get(task.id) ?? []) walk(child)
    }
    walk(root)
    return found
  }
  const blocking = new Set(tasks.filter((t) => !t.archived).flatMap((t) => t.blockedBy))
  const expired = (task: Task) =>
    task.archived !== undefined && Date.parse(task.archived.at) < cutoff
  const free = (task: Task) =>
    expired(task) &&
    !blocking.has(task.id) &&
    !task.repos.some((r) => r.pullRequest?.state === 'draft' || r.pullRequest?.state === 'ready')
  const root = (task: Task) => {
    const parent = task.parentId === undefined ? undefined : byId.get(task.parentId)
    return !parent || (!parent.archived && parent.stage !== 'done')
  }

  const result: ArchivedDue = { due: [], kept: [] }
  const deleted = new Set<string>()
  for (const task of tasks) {
    if (!expired(task) || !root(task)) continue
    const whole = tree(task)
    if (whole.every(free)) {
      result.due.push({ root: task, tasks: whole })
      for (const t of whole) deleted.add(t.id)
    }
  }
  result.kept = tasks.filter((t) => expired(t) && !deleted.has(t.id))
  return result
}

export interface ArchiveCleanup {
  preview(days: number): ArchiveExpiry
  sweep(): Promise<void>
  close(): Promise<void>
}

export function createArchiveCleanup(options: {
  store: Pick<TedStore, 'listTasks' | 'settings'>
  tasks: Pick<Tasks, 'delete' | 'hierarchyPreview'>
  now?: () => Date
}): ArchiveCleanup {
  const now = options.now ?? (() => new Date())
  let sweeping: Promise<void> | undefined
  let again = false
  let closed = false

  async function sweepOnce(): Promise<void> {
    const failed = new Set<string>()
    while (!closed) {
      const days = options.store.settings().deleteArchivedAfterDays
      if (days === null) return
      const next = archivedDue(options.store.listTasks(), days, now()).due.find(
        (d) => !failed.has(d.root.id),
      )
      if (!next) return
      const { root, tasks } = next
      try {
        await options.tasks.delete(
          root.id,
          tasks.length > 1
            ? {
                children: 'delete',
                hierarchyRevision: options.tasks.hierarchyPreview(root.id).revision,
              }
            : {},
        )
        for (const task of tasks) {
          console.log(
            redactSecrets(
              `deleted archived Task ${task.displayId} (archived ${task.archived?.at})`,
            ),
          )
        }
      } catch (error) {
        failed.add(root.id)
        console.error(
          redactSecrets(`couldn’t delete archived Task ${root.displayId}: ${String(error)}`),
        )
      }
    }
  }

  return {
    preview(days) {
      const { due, kept } = archivedDue(options.store.listTasks(), days, now())
      return { due: due.reduce((n, d) => n + d.tasks.length, 0), kept: kept.length }
    },
    sweep() {
      if (closed) return Promise.resolve()
      if (sweeping) {
        again = true
        return sweeping
      }
      sweeping = (async () => {
        do {
          again = false
          await sweepOnce()
        } while (again && !closed)
      })().finally(() => {
        sweeping = undefined
      })
      return sweeping
    },
    async close() {
      closed = true
      await sweeping?.catch(() => undefined)
    },
  }
}
