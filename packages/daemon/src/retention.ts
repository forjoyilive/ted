import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isLockHeld } from './lock.ts'
import { runFiles } from './runs/host-files.ts'
import type { TedStore } from './store/index.ts'
import { removeInside } from './tasks/remove-files.ts'

const dayMs = 24 * 60 * 60 * 1000
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type RunOutputEnd = 'keep' | 'unknown' | { at: string }

export interface PruneOptions {
  runsDir: string
  keepDays: number
  endOf: (runId: string) => RunOutputEnd
  now?: Date
}

export interface PruneResult {
  removed: string[]
}

export async function pruneRunOutput(options: PruneOptions): Promise<PruneResult> {
  const now = (options.now ?? new Date()).getTime()
  const keepMs = options.keepDays * dayMs
  const result: PruneResult = { removed: [] }
  const names = await readdir(options.runsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const root = names.length > 0 ? await realpath(options.runsDir) : options.runsDir
  for (const runId of names) {
    if (!runIdPattern.test(runId)) continue
    const dir = path.join(root, runId)
    const entry = await lstat(dir).catch(() => undefined)
    if (!entry?.isDirectory()) continue
    if ((await realpath(dir).catch(() => undefined)) !== dir) continue
    const files = runFiles(dir)
    if (await hostRunning(files.lock)) continue
    const lastWritten = ((await lstat(files.log).catch(() => undefined)) ?? entry).mtimeMs
    const end = options.endOf(runId)
    if (end === 'keep') continue
    const endedAt = end === 'unknown' ? lastWritten : Date.parse(end.at)
    if (!(now - endedAt > keepMs)) continue
    try {
      await removeInside(root, runId)
      result.removed.push(runId)
    } catch (error) {
      console.error(`couldn’t remove Run ${runId}’s output:`, error)
    }
  }
  return result
}

type EndStore = Pick<
  TedStore,
  | 'getRun'
  | 'getTask'
  | 'listStageEntries'
  | 'coordinators'
  | 'sideChats'
  | 'automationDrafts'
  | 'plans'
  | 'automations'
>

export function runOutputEnd(store: EndStore, runId: string): RunOutputEnd {
  const run = store.getRun(runId)
  const side = store.sideChats.forRun(runId)
  if (side) {
    if (side.state === 'queued' || side.state === 'working') return 'keep'
    const source = store.getRun(side.sourceRunId)
    if (source && source.state !== 'finished') return 'keep'
    if (run && run.state !== 'finished') return 'keep'
    const task = store.getTask(side.taskId)
    if (task) {
      const end = [task.archived?.at, task.stage === 'done' ? doneAt(store, task) : undefined]
        .filter((at) => at !== undefined)
        .sort()[0]
      return end === undefined ? 'keep' : { at: end }
    }
  }
  if (!run) return 'unknown'
  if (run.state !== 'finished') return 'keep'
  const stopped = run.ended?.at ?? run.revivedAt ?? run.startedAt
  if (run.taskId !== undefined) {
    const task = store.getTask(run.taskId)
    if (!task) return { at: stopped }
    const closed = [task.archived?.at, task.stage === 'done' ? doneAt(store, task) : undefined]
      .filter((at) => at !== undefined)
      .sort()[0]
    return closed === undefined ? 'keep' : { at: closed }
  }
  if (
    store.coordinators.forRun(runId) ||
    store.coordinators.savedForRun(runId) ||
    store.automationDrafts.get(runId)
  )
    return 'keep'
  if (store.plans.get(runId)) return 'keep'
  const firing = store.automations.firing(runId)
  if (firing) return firing.state === 'ended' ? { at: firing.finishedAt ?? stopped } : 'keep'
  return { at: stopped }
}

function doneAt(
  store: EndStore,
  task: { id: string; merged?: { at: string }; updatedAt: string },
): string {
  const entered = store.listStageEntries(task.id).findLast((entry) => entry.stage === 'done')
  return entered?.at ?? task.merged?.at ?? task.updatedAt
}

async function hostRunning(lock: string): Promise<boolean> {
  const found = await stat(lock).catch(() => undefined)
  return found !== undefined && isLockHeld(lock)
}
