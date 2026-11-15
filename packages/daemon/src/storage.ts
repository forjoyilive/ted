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
const partialClone = /\.partial-[0-9a-f]+$/

export function createStorage(options: {
  home: string
  store: TedStore
  disk: DiskWatch
  data: Pick<Data, 'summary'>
  volumeName: () => Promise<string>
  now?: () => number
}): Storage {
  const { store, disk } = options
  const now = options.now ?? Date.now
  const paths = tedPaths(options.home)
  let volume: Promise<string> | undefined
  let saved: StorageSummary | undefined
  let measuring: Promise<StorageSummary> | undefined
  let viewedAt = 0
  let generation = 0

  const categoryDirs: Record<StorageCategoryId, string[]> = {
    worktrees: [paths.worktrees, paths.plans, paths.automationRuns],
    'sandbox-caches': [paths.sandbox, paths.seeds],
    simulators: [paths.simulators],
    clones: [paths.repos],
    'conversations-and-logs': [paths.logs, paths.runs, paths.apps],
    store: [paths.store],
    attachments: [paths.attachments],
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

  async function measure(): Promise<StorageSummary> {
    const measuredAt = new Date(now()).toISOString()
    const counter = createCounter()
    const [categories, usedBytes, reading, backups, storeFiles] = await Promise.all([
      Promise.all(
        storageCategories.map(async ({ id, label }) => ({
          id,
          label,
          bytes: (await Promise.all(categoryDirs[id].map((dir) => counter.size(dir)))).reduce(
            (a, b) => a + b,
            0,
          ),
        })),
      ),
      diskUsage(paths.home),
      disk.check(),
      options.data.summary(),
      storeFileSizes(paths.store),
    ])
    const tasks = new Map(store.listTasks().map((t) => [t.displayId, t]))
    const factories = new Map(store.listFactories().map((f) => [f.id, f]))
    const worktrees: WorktreeUse[] = []
    for (const name of await childDirs(paths.worktrees)) {
      const task = tasks.get(name)
      if (!task) continue
      worktrees.push({
        taskId: task.id,
        displayId: task.displayId,
        title: task.title,
        factoryId: task.factoryId,
        factoryName: factories.get(task.factoryId)?.name ?? '',
        bytes: await diskUsage(path.join(paths.worktrees, name)),
      })
    }
    const removable = await unusedClones()
    volume ??= options.volumeName().catch(() => '')
    return {
      home: `${displayPath(paths.home)}${path.sep}`,
      usedBytes,
      freeBytes: reading?.freeBytes ?? 0,
      volume: await volume,
      categories: categories.sort((a, b) => b.bytes - a.bytes),
      largestWorktrees: worktrees.sort((a, b) => b.bytes - a.bytes).slice(0, largestShown),
      removableClones: {
        count: removable.length,
        bytes: (await Promise.all(removable.map(({ dir }) => diskUsage(dir)))).reduce(
          (a, b) => a + b,
          0,
        ),
      },
      simulators: { count: 0, bytes: 0 },
      backups: await Promise.all(
        backups.backups.map(async (backup) => ({
          ...backup,
          bytes: await diskUsage(path.join(paths.backups, backup.name)),
        })),
      ),
      backupsDir: `${displayPath(paths.backups)}${path.sep}`,
      storeFiles: {
        ...storeFiles,
        backupsBytes: categories.find((c) => c.id === 'backups')?.bytes ?? 0,
      },
      measuredAt,
    }
  }

  function remeasure(): Promise<StorageSummary> {
    if (measuring) return measuring
    const started = generation
    const run = measure()
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
      const reading = await disk.check()
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

export function diskUsage(dir: string): Promise<number> {
  return createCounter().size(dir)
}

function createCounter() {
  const seen = new Set<string>()
  let running = 0
  const waiting: (() => void)[] = []

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= walkers) await new Promise<void>((resolve) => waiting.push(resolve))
    running++
    try {
      return await work()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  async function size(file: string): Promise<number> {
    const info = await slot(() => lstat(file, { bigint: true })).catch(() => undefined)
    if (!info) return 0
    const key = `${info.dev}:${info.ino}`
    if (seen.has(key)) return 0
    seen.add(key)
    const own = Number(info.blocks) * 512
    if (!info.isDirectory()) return own
    const names = await slot(() => readdir(file)).catch(() => [])
    const children = await Promise.all(names.map((name) => size(path.join(file, name))))
    return children.reduce((a, b) => a + b, own)
  }

  return { size }
}
