import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Factory,
  type StorageSummary,
  storageKeptForMs,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { excludeFromTimeMachine } from '../src/disk.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { createStorage } from '../src/storage.ts'
import type { StoreContext } from '../src/store/context.ts'
import type { TedStore } from '../src/store/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

expectTypeOf<StoreContext>().toHaveProperty('store')

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
let excluded: string[][]

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
  excluded = []
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    disk: {
      freeBytes: async () => 8.2e9,
      volumeName: async () => 'Macintosh HD',
      excludeFromBackups: async (dirs) => void excluded.push(dirs),
    },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok }
}

describe('Settings → Storage', () => {
  test('shows space used by category, the largest worktrees and the backups', async () => {
    const client = await start()
    const created = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
      factory: 'NB',
    })
    await client.ok<Task>('POST', `/tasks/${created.id}/start`)
    const paths = tedPaths(home)
    await waitUntil(
      async () => (await readdir(paths.worktrees).catch((): string[] => [])).includes('NB-1'),
      'NB-1’s worktree',
    )

    await mkdir(path.join(paths.seeds, 'factory', 'seed'), { recursive: true })
    await writeFile(path.join(paths.seeds, 'factory', 'seed', 'package'), 'x'.repeat(8192))
    const storage = await client.ok<StorageSummary>('GET', '/storage')
    expect((await client.ok<StorageSummary>('GET', '/storage')).measuredAt).toBe(storage.measuredAt)
    await client.ok<StorageSummary>('GET', '/storage?refresh=1')

    expect(storage.volume).toBe('Macintosh HD')
    expect(storage.freeBytes).toBe(8.2e9)
    expect(storage.home.endsWith(`${path.sep}`)).toBe(true)
    expect(storage.categories.map((c) => c.label).sort()).toEqual(
      [
        'Attachments',
        'Backups',
        'Clones',
        'Conversations and logs',
        'Sandbox caches',
        'Scratch worktrees',
        'Simulators',
        'Store',
        'Worktrees',
      ].sort(),
    )
    const bytesOf = (id: string) => storage.categories.find((c) => c.id === id)?.bytes ?? 0
    expect(bytesOf('clones')).toBeGreaterThan(0)
    expect(bytesOf('worktrees')).toBeGreaterThan(0)
    expect(bytesOf('store')).toBeGreaterThan(0)
    expect(bytesOf('sandbox-caches')).toBeGreaterThanOrEqual(8192)
    expect(storage.usedBytes).toBeGreaterThanOrEqual(bytesOf('clones') + bytesOf('store'))
    expect(storage.largestWorktrees).toMatchObject([
      { displayId: 'NB-1', taskId: created.id, factoryName: expect.any(String) },
    ])
    expect(storage.largestWorktrees[0]?.bytes).toBeGreaterThan(0)
    expect(storage.backups.map((b) => b.kind)).toEqual(['daily'])
    expect(storage.backups[0]?.bytes).toBeGreaterThan(0)
    expect(storage.storeFiles.eventLogBytes).toBeGreaterThan(0)
    expect(storage.storeFiles.stateBytes).toBeGreaterThan(0)
    expect(storage.storeFiles.backupsBytes).toBe(bytesOf('backups'))
    expect(storage.removableClones).toEqual({ count: 0, bytes: 0 })
  })

  test('Remove clones of removed Factories deletes only clones no Factory or Task uses', async () => {
    const client = await start()
    const paths = tedPaths(home)
    const stray = path.join(paths.repos, 'kriya', 'gone')
    await mkdir(stray, { recursive: true })
    await writeFile(path.join(stray, 'README.md'), 'old clone')
    const partial = path.join(paths.repos, 'kriya', 'new.partial-0a1b2c3d')
    await mkdir(partial, { recursive: true })
    const outside = path.join(scratch, 'outside')
    await mkdir(path.join(outside, 'repo'), { recursive: true })
    await writeFile(path.join(outside, 'repo', 'keep.txt'), 'not Ted’s')
    await symlink(outside, path.join(paths.repos, 'linked'))
    await mkdir(path.join(paths.repos, 'owner'), { recursive: true })
    await symlink(path.join(outside, 'repo'), path.join(paths.repos, 'owner', 'repo'))

    const before = await client.ok<StorageSummary>('GET', '/storage')
    expect(before.removableClones.count).toBe(1)

    const result = await client.ok<{ removed: string[] }>('POST', '/storage/remove-clones')

    expect(result.removed).toEqual(['kriya/gone'])
    const left = await readdir(paths.repos)
    expect(left).toContain('linked')
    expect(left).toContain('owner')
    expect(await readdir(path.join(paths.repos, 'kriya'))).toEqual(['new.partial-0a1b2c3d'])
    expect(await readdir(path.join(paths.repos, 'owner'))).toEqual(['repo'])
    expect(await readdir(path.join(outside, 'repo'))).toEqual(['keep.txt'])
    const factory = (await client.ok<Factory[]>('GET', '/factories'))[0]
    expect(factory).toBeDefined()
    const after = await client.ok<StorageSummary>('GET', '/storage')
    expect(after.removableClones.count).toBe(0)
    expect(after.categories.find((c) => c.id === 'clones')?.bytes).toBeGreaterThan(0)
  })

  test('keeps the measurement until the page goes unviewed for 10 minutes, Refresh or clone removal', async () => {
    let clock = Date.parse('2026-11-13T10:00:00.000Z')
    let freeBytes = 5e9
    let diskGate: Promise<void> | undefined
    const minutes = (n: number) => n * 60_000
    const store: Pick<TedStore, 'listFactories' | 'listTasks'> = {
      listFactories: () => [],
      listTasks: () => [],
    }
    const storage = createStorage({
      home,
      store: store as TedStore,
      disk: {
        check: async () => {
          await diskGate
          return { freeBytes, held: false }
        },
      } as never,
      data: { summary: async () => ({ backups: [] }) } as never,
      volumeName: async () => 'Macintosh HD',
      now: () => clock,
    })
    const measuredAt = async (refresh = false) => (await storage.summary({ refresh })).measuredAt

    const first = await measuredAt()
    clock += minutes(9)
    freeBytes = 4e9
    const kept = await storage.summary()
    expect(kept.measuredAt).toBe(first)
    expect(kept.freeBytes).toBe(4e9)

    clock += minutes(9)
    expect(await measuredAt()).toBe(first)
    storage.viewed()
    clock += storageKeptForMs
    expect(await measuredAt()).toBe(first)

    clock += storageKeptForMs + 1
    const second = await measuredAt()
    expect(second).not.toBe(first)

    clock += minutes(1)
    const third = await measuredAt(true)
    expect(third).not.toBe(second)

    clock += minutes(1)
    await storage.removeUnusedClones()
    const fourth = await measuredAt()
    expect(fourth).not.toBe(third)

    const opened = Promise.withResolvers<void>()
    diskGate = opened.promise
    const during = storage.summary()
    await storage.removeUnusedClones()
    opened.resolve()
    expect(await during).toMatchObject({ measuredAt: fourth, categories: expect.any(Array) })
  })

  test.each(['physical', 'symlinked'])(
    'counts allocated space once and skips symlinks inside a %s Ted home',
    async (kind) => {
      const storageHome = path.join(scratch, 'storage')
      const paths = tedPaths(storageHome)
      await mkdir(paths.attachments, { recursive: true })
      await mkdir(paths.phoneUploads)
      const file = path.join(paths.attachments, 'one')
      const hardlink = path.join(paths.phoneUploads, 'two')
      const symlinkPath = path.join(paths.attachments, 'outside')
      const outsideFile = path.join(scratch, 'outside')
      await writeFile(file, Buffer.alloc(8192, 1))
      await writeFile(outsideFile, Buffer.alloc(32768, 1))
      await link(file, hardlink)
      await symlink(outsideFile, symlinkPath)

      const alias = path.join(scratch, 'storage-link')
      if (kind === 'symlinked') await symlink(storageHome, alias)
      const configuredHome = kind === 'symlinked' ? alias : storageHome
      const storage = createStorage({
        home: configuredHome,
        store: { listTasks: () => [], listFactories: () => [] },
        disk: { check: async () => undefined },
        data: { summary: async () => ({ backups: [], activeRuns: 0 }) },
        volumeName: async () => '',
      })
      const summary = await storage.summary()
      expect(summary.home.endsWith(path.basename(configuredHome) + path.sep)).toBe(true)
      const blocks = async (entry: string) => (await lstat(entry)).blocks
      const expected = (
        await Promise.all([paths.attachments, paths.phoneUploads, file, symlinkPath].map(blocks))
      ).reduce((sum, count) => sum + count, 0)
      expect(summary.categories.find((category) => category.id === 'attachments')?.bytes).toBe(
        expected * 512,
      )
      expect(summary.usedBytes).toBe((expected + (await blocks(storageHome))) * 512)
    },
  )

  test('returns a clear error when a shared measurement stalls and measures again on retry', async () => {
    const stalled = Promise.withResolvers<string>()
    const volumeName = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValue('Macintosh HD')
    const storage = createStorage({
      home,
      store: { listTasks: () => [], listFactories: () => [] },
      disk: { check: async () => undefined },
      data: { summary: async () => ({ backups: [], activeRuns: 0 }) },
      volumeName,
    })

    vi.useFakeTimers()
    try {
      const opened = storage.summary()
      const refreshed = storage.summary({ refresh: true })
      const outcomes = Promise.allSettled([opened, refreshed])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await outcomes).toMatchObject([
        { status: 'rejected', reason: { status: 504, message: expect.stringContaining('retry') } },
        { status: 'rejected', reason: { status: 504, message: expect.stringContaining('retry') } },
      ])
      expect(volumeName).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      stalled.resolve('Old measurement')
    }

    expect(await storage.summary()).toMatchObject({ volume: 'Macintosh HD' })
    expect(volumeName).toHaveBeenCalledTimes(2)
  })

  test('worktrees, clones, devices, scratch worktrees and Automation checkouts are kept out of Time Machine', async () => {
    await start()
    const paths = tedPaths(home)
    await waitUntil(() => excluded.length > 0 || undefined, 'the Time Machine exclusion')
    expect(excluded).toEqual([
      [
        paths.worktrees,
        paths.repos,
        paths.simulators,
        paths.emulators,
        paths.scratch,
        paths.plans,
        paths.chatCode,
        paths.automationRuns,
      ],
    ])
  })

  test('the exclusion runs tmutil addexclusion on macOS only', async () => {
    const calls: [string, string[]][] = []
    const record = async (file: string, args: string[]) => void calls.push([file, args])
    await excludeFromTimeMachine(['/a', '/b'], 'darwin', record)
    await excludeFromTimeMachine(['/a'], 'linux', record)
    await excludeFromTimeMachine([], 'darwin', record)
    expect(calls).toEqual([['tmutil', ['addexclusion', '/a', '/b']]])
  })
})
