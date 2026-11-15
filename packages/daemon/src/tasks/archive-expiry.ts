import type { ArchiveExpiry, Task } from '@ted/protocol'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import type { Tasks } from './tasks.ts'

const dayMs = 24 * 60 * 60 * 1000

export interface ArchivedDue {
  due: Task[]
  kept: Task[]
}

export function archivedDue(tasks: readonly Task[], days: number, now: Date): ArchivedDue {
  const cutoff = now.getTime() - days * dayMs
  const blocking = new Set(tasks.filter((t) => !t.archived).flatMap((t) => t.blockedBy))
  const result: ArchivedDue = { due: [], kept: [] }
  for (const task of tasks) {
    if (!task.archived || !(Date.parse(task.archived.at) < cutoff)) continue
    const held =
      (task.childIds?.length ?? 0) > 0 ||
      blocking.has(task.id) ||
      task.repos.some((r) => r.pullRequest?.state === 'draft' || r.pullRequest?.state === 'ready')
    ;(held ? result.kept : result.due).push(task)
  }
  return result
}

export interface ArchiveCleanup {
  preview(days: number): ArchiveExpiry
  sweep(): Promise<void>
}

export function createArchiveCleanup(options: {
  store: Pick<TedStore, 'listTasks' | 'settings'>
  tasks: Pick<Tasks, 'delete'>
  now?: () => Date
}): ArchiveCleanup {
  const now = options.now ?? (() => new Date())
  let sweeping: Promise<void> | undefined
  let again = false

  async function sweepOnce(): Promise<void> {
    const failed = new Set<string>()
    for (;;) {
      const days = options.store.settings().deleteArchivedAfterDays
      if (days === null) return
      const task = archivedDue(options.store.listTasks(), days, now()).due.find(
        (t) => !failed.has(t.id),
      )
      if (!task) return
      try {
        await options.tasks.delete(task.id, {})
        console.log(
          redactSecrets(`deleted archived Task ${task.displayId} (archived ${task.archived?.at})`),
        )
      } catch (error) {
        failed.add(task.id)
        console.error(
          redactSecrets(`couldn’t delete archived Task ${task.displayId}: ${String(error)}`),
        )
      }
    }
  }

  return {
    preview(days) {
      const { due, kept } = archivedDue(options.store.listTasks(), days, now())
      return { due: due.length, kept: kept.length }
    },
    sweep() {
      if (sweeping) {
        again = true
        return sweeping
      }
      sweeping = (async () => {
        do {
          again = false
          await sweepOnce()
        } while (again)
      })().finally(() => {
        sweeping = undefined
      })
      return sweeping
    },
  }
}
