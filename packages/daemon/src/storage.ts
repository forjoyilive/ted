import { lstat, readdir, realpath, rmdir } from 'node:fs/promises'
import path from 'node:path'
import {
  type RemoveClonesResult,
  type StorageCategoryId,
  type StorageSummary,
  storageCategories,
  storageKeptForMs,
  tedPaths,
  type WorktreeUse,
} from '@ted/protocol'
import { displayPath } from './backups.ts'
import type { Data } from './data.ts'
import type { DiskWatch } from './disk.ts'
import { RequestError } from './errors.ts'
import { isCloning, removeClone } from './factories.ts'
import { storeFileSizes } from './store/files.ts'
import type { TedStore } from './store/index.ts'

export interface Storage {
  summary(options?: { refresh?: boolean }): Promise<StorageSummary>
  viewed(): void
  removeUnusedClones(only?: readonly string[]): Promise<RemoveClonesResult>
}

const largestShown = 10
const safeSegment = /^[A-Za-z0-9_.-]+$/
const walkers = 32
const measurementTimeoutMs = 30_000
const partialClone = /\.partial-[0-9a-f]+$/

export function createStorage(options: {
  home: string
  store: Pick<TedStore, 'listTasks' | 'listFactories'>
  disk: Pick<DiskWatch, 'check'>
  data: Pick<Data, 'summary'>
  volumeName: () => Promise<string>
  now?: () => number
}): Storage {
  const { store, disk } = options
  const now = options.now ?? Date.now
  const paths = tedPaths(options.home)
  let volume: string | undefined
  let saved: StorageSummary | undefined
  let measuring: Promise<StorageSummary> | undefined
  let viewedAt = 0
  let generation = 0

  const categoryDirs: Record<StorageCategoryId, string[]> = {
    worktrees: [paths.worktrees, paths.plans, paths.chatCode, paths.automationRuns],
    'sandbox-caches': [paths.sandbox, paths.seeds],
    simulators: [paths.simulators],
    clones: [paths.repos],
    'conversations-and-logs': [paths.logs, paths.runs, paths.apps],
    store: [paths.store],
    attachments: [paths.attachments, paths.phoneUploads],
    backups: [paths.backups],
    'scratch-worktrees': [paths.scratch],
  }

  async function clones(): Promise<{ repo: string; dir: string }[]> {
    const found: { repo: string; dir: string }[] = []
    for (const owner of await childDirs(paths.repos)) {
      for (const name of await childDirs(path.join(paths.repos, owner))) {
        found.push({ repo: `${owner}/${name}`, dir: path.join(paths.repos, owner, name) })
      }
    }
    return found
  }

  function usedRepos(): Set<string> {
    const used = new Set<string>()
    for (const factory of store.listFactories()) {
      used.add(factory.repo.toLowerCase())
      for (const repo of factory.repos) used.add(repo.repo.toLowerCase())
    }
    for (const task of store.listTasks()) {
      for (const repo of task.repos) if (!repo.removed) used.add(repo.repo.toLowerCase())
    }
    return used
  }

  async function unusedClones(): Promise<{ repo: string; dir: string }[]> {
    const used = usedRepos()
    return (await clones()).filter(
      ({ repo, dir }) =>
        !used.has(repo.toLowerCase()) && !partialClone.test(dir) && !isCloning(dir),
    )
  }

  async function measure(signal: AbortSignal): Promise<StorageSummary> {
    const measuredAt = new Date(now()).toISOString()
    const [home, reading, backups, storeFiles, names, removable, volumeName] = await Promise.all([
      realpath(paths.home).catch(() => path.resolve(paths.home)),
      disk.check(),
      options.data.summary(),
      storeFileSizes(paths.store),
      childDirs(paths.worktrees),
      unusedClones(),
      volume ?? options.volumeName().catch(() => ''),
    ])
    signal.throwIfAborted()
    volume = volumeName

    const totals = new Map<string, UsageTotal>()
    const scanPath = (dir: string) => path.resolve(home, path.relative(paths.home, dir))
    const used = usageTotal()
    totals.set(home, used)
    const categoryLinks = new Set<string>()
    const categories = storageCategories.map(({ id, label }) => {
      const total = usageTotal(categoryLinks)
      for (const dir of categoryDirs[id]) totals.set(scanPath(dir), total)
      return { id, label, total }
    })
    const tasks = new Map(store.listTasks().map((t) => [t.displayId, t]))
    const factories = new Map(store.listFactories().map((f) => [f.id, f]))
    const worktrees = names.flatMap((name) => {
      const task = tasks.get(name)
      if (!task) return []
      const total = usageTotal()
      totals.set(scanPath(path.join(paths.worktrees, name)), total)
      return [{ task, total }]
    })
    const cloneTotals = removable.map(({ dir }) => {
      const total = usageTotal()
      totals.set(scanPath(dir), total)
      return total
    })
    const backupTotals = backups.backups.map((backup) => {
      const total = usageTotal()
      totals.set(scanPath(path.join(paths.backups, backup.name)), total)
      return { backup, total }
    })
    await scanUsage(home, totals, signal)

    const largestWorktrees: WorktreeUse[] = worktrees.map(({ task, total }) => ({
      taskId: task.id,
      displayId: task.displayId,
      title: task.title,
      factoryId: task.factoryId,
      factoryName: factories.get(task.factoryId)?.name ?? '',
      bytes: total.bytes,
    }))
    return {
      home: `${displayPath(paths.home)}${path.sep}`,
      usedBytes: used.bytes,
      freeBytes: reading?.freeBytes ?? 0,
      volume: volumeName,
      categories: categories
        .map(({ id, label, total }) => ({ id, label, bytes: total.bytes }))
        .sort((a, b) => b.bytes - a.bytes),
      largestWorktrees: largestWorktrees.sort((a, b) => b.bytes - a.bytes).slice(0, largestShown),
      removableClones: {
        count: removable.length,
        bytes: cloneTotals.reduce((bytes, total) => bytes + total.bytes, 0),
      },
      simulators: { count: 0, bytes: 0 },
      backups: backupTotals.map(({ backup, total }) => ({ ...backup, bytes: total.bytes })),
      backupsDir: `${displayPath(paths.backups)}${path.sep}`,
      storeFiles: {
        ...storeFiles,
        backupsBytes: categories.find((c) => c.id === 'backups')?.total.bytes ?? 0,
      },
      measuredAt,
    }
  }

  function remeasure(): Promise<StorageSummary> {
    if (measuring) return measuring
    const started = generation
    const run = withMeasurementDeadline(measure)
      .then((summary) => {
        if (started === generation) saved = summary
        return summary
      })
      .finally(() => {
        if (measuring === run) measuring = undefined
      })
    measuring = run
    return run
  }

  return {
    async summary(request = {}) {
      const stale = now() - viewedAt > storageKeptForMs
      viewedAt = now()
      if (request.refresh === true || stale || saved === undefined) {
        return remeasure()
      }
      if (measuring) return measuring
      const kept = saved
      const reading = await withMeasurementDeadline(() => disk.check())
      return { ...kept, freeBytes: reading?.freeBytes ?? kept.freeBytes }
    },
    viewed() {
      viewedAt = now()
    },
    async removeUnusedClones(only) {
      try {
        return await removeClones(only)
      } finally {
        generation++
        saved = undefined
        measuring = undefined
      }
    },
  }

  async function removeClones(only?: readonly string[]): Promise<RemoveClonesResult> {
    const root = await realpath(paths.repos).catch(() => undefined)
    if (root === undefined) return { removed: [], bytes: 0 }
    const removed: string[] = []
    let bytes = 0
    const wanted = only && new Set(only.map((repo) => repo.toLowerCase()))
    for (const { repo, dir } of await unusedClones()) {
      if (wanted && !wanted.has(repo.toLowerCase())) continue
      const [owner, name] = repo.split('/')
      if (!owner || !name || ![owner, name].every(isSafeSegment)) continue
      const real = await realpath(dir).catch(() => undefined)
      if (real !== path.join(root, owner, name)) continue
      const size = await diskUsage(dir)
      if (!(await removeClone(dir, () => !usedRepos().has(repo.toLowerCase())))) continue
      await rmdir(path.dirname(dir)).catch(() => undefined)
      removed.push(repo)
      bytes += size
    }
    return { removed, bytes }
  }
}

function isSafeSegment(segment: string): boolean {
  return safeSegment.test(segment) && segment !== '.' && segment !== '..'
}

async function childDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && isSafeSegment(e.name)).map((e) => e.name)
}

async function withMeasurementDeadline<T>(
  measure: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
      once: true,
    })
  })
  const timer = setTimeout(() => {
    controller.abort(
      new RequestError(504, 'Storage measurement took too long. Open Storage again to retry.'),
    )
  }, measurementTimeoutMs)
  try {
    return await Promise.race([measure(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

type UsageTotal = { bytes: number; seen: Set<string> }

function usageTotal(seen = new Set<string>()): UsageTotal {
  return { bytes: 0, seen }
}

export async function diskUsage(dir: string): Promise<number> {
  const total = usageTotal()
  await scanUsage(dir, new Map([[dir, total]]))
  return total.bytes
}

async function scanUsage(dir: string, totals: Map<string, UsageTotal>, signal?: AbortSignal) {
  const pending: { file: string; parents: UsageTotal[] }[] = [{ file: dir, parents: [] }]

  async function visit({ file, parents }: (typeof pending)[number]) {
    const info = await lstat(file, { bigint: true }).catch(() => undefined)
    if (!info || signal?.aborted) return
    const total = totals.get(file)
    const scopes = total ? [...parents, total] : parents
    const directory = info.isDirectory()
    const key = directory || info.nlink > 1n ? `${info.dev}:${info.ino}` : undefined
    const bytes = Number(info.blocks) * 512
    const counted =
      key === undefined
        ? scopes
        : scopes.filter((scope) => {
            if (scope.seen.has(key)) return false
            scope.seen.add(key)
            return true
          })
    for (const scope of counted) scope.bytes += bytes
    if (!directory || counted.length === 0) return
    const names = await readdir(file).catch(() => [])
    if (signal?.aborted) return
    for (const name of names) pending.push({ file: path.join(file, name), parents: counted })
  }

  while (pending.length > 0) {
    signal?.throwIfAborted()
    await Promise.all(pending.splice(-walkers).map(visit))
  }
}
