import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Banner, DaemonEvent, Factory, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createBanners } from '../src/banners.ts'
import { createDiskWatch, isDiskFullError } from '../src/disk.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { openStore } from '../src/store/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
let free = 50e9

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
  free = 50e9
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
    codexBin: stubCodexPath,
    disk: {
      freeBytes: async () => free,
      checkEveryMs: 20,
      volumeName: async () => 'Macintosh HD',
      excludeFromBackups: async () => undefined,
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

type Client = Awaited<ReturnType<typeof start>>

const diskBanners = async (client: Client) =>
  (await client.ok<Banner[]>('GET', '/banners'))
    .filter((b) => b.problem.startsWith('disk'))
    .map((b) => ({ problem: b.problem, severity: b.severity, text: b.text, action: b.action }))

const openStorage = { label: 'Open Storage', opens: { kind: 'settings', section: 'storage' } }

const bannersBecome = (client: Client, expected: unknown) =>
  waitUntil(
    async () => {
      const now = await diskBanners(client)
      return JSON.stringify(now) === JSON.stringify(expected) ? now : undefined
    },
    `disk banners to be ${JSON.stringify(expected)}`,
  )

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

describe('watching free disk space', () => {
  test('below 10 GB a warning offers Storage; with plenty free there is none', async () => {
    const client = await start()
    expect(await diskBanners(client)).toEqual([])

    free = 8.2e9
    await bannersBecome(client, [
      {
        problem: 'disk-almost-full',
        severity: 'warning',
        text: 'Disk almost full · 8.2 GB free',
        action: openStorage,
      },
    ])

    free = 30e9
    await bannersBecome(client, [])
  })

  test('below 2 GB new work is held until more than 4 GB is free', async () => {
    const client = await start()
    free = 1.4e9
    await bannersBecome(client, [
      {
        problem: 'disk-full',
        severity: 'stops-work',
        text: 'Disk full · new work held · 1.4 GB free',
        action: openStorage,
      },
    ])

    const created = await client.ok<Task>('POST', '/tasks', { title: 'Held', factory: 'NB' })
    const task = await client.ok<Task>('POST', `/tasks/${created.id}/start`)
    expect(task.status).toEqual({ kind: 'queued', hold: 'disk full' })
    expect(task.leadRunId).toBeUndefined()

    const devRun = await client.call('POST', '/dev/runs', { prompt: 'hi', cwd: scratch })
    expect(devRun.status).toBe(507)

    free = 3.5e9
    await bannersBecome(client, [
      {
        problem: 'disk-full',
        severity: 'stops-work',
        text: 'Disk full · new work held · 3.5 GB free',
        action: openStorage,
      },
    ])
    expect((await getTask(client, task.id)).leadRunId).toBeUndefined()

    free = 4.5e9
    await bannersBecome(client, [
      {
        problem: 'disk-almost-full',
        severity: 'warning',
        text: 'Disk almost full · 4.5 GB free',
        action: openStorage,
      },
    ])
    await waitUntil(
      async () => (await getTask(client, task.id)).leadRunId,
      'the held Task to start once space returns',
    )
  })

  test('a Task Lead’s agent change can’t start a new Run until the hold lifts', async () => {
    const client = await start()
    const created = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
      factory: 'NB',
    })
    await client.ok<Task>('POST', `/tasks/${created.id}/start`)
    const first = await waitUntil(async () => {
      const task = await getTask(client, created.id)
      return task.leadRunId !== undefined && task.runs[0]?.state === 'idle' ? task : undefined
    }, 'the Task Lead to go idle')

    free = 1e9
    await bannersBecome(client, [
      {
        problem: 'disk-full',
        severity: 'stops-work',
        text: 'Disk full · new work held · 1.0 GB free',
        action: openStorage,
      },
    ])
    await client.ok<Task>('PUT', `/tasks/${created.id}/lead`, { agent: 'codex' })
    const refused = await client.call('POST', `/tasks/${created.id}/lead/restart`)
    expect(refused.status).toBe(409)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await getTask(client, created.id)).leadRunId).toBe(first.leadRunId)

    free = 50e9
    await bannersBecome(client, [])
    await client.ok('POST', `/tasks/${created.id}/lead/restart`)
    const moved = await waitUntil(async () => {
      const task = await getTask(client, created.id)
      return task.leadRunId !== first.leadRunId ? task : undefined
    }, 'the new Task Lead once space returns')
    expect(moved.runs[0]?.agent).toBe('codex')
  })

  test('a disk that is already full when TED starts holds queued work from the first moment', async () => {
    free = 1e9
    const client = await start()
    const created = await client.ok<Task>('POST', '/tasks', { title: 'Held', factory: 'NB' })
    const task = await client.ok<Task>('POST', `/tasks/${created.id}/start`)
    expect(task.status).toEqual({ kind: 'queued', hold: 'disk full' })
  })
})

describe('a store write that fails on a full disk', () => {
  test('shows that TED can’t save until a write succeeds again', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ted-store-'))
    const store = await openStore({ directory: dir })
    try {
      const seen: DaemonEvent[] = []
      const banners = createBanners({ store, emit: (event) => seen.push(event) })
      let probeWorks = false
      const disk = createDiskWatch({
        storeDir: dir,
        banners,
        hold: () => undefined,
        freeBytes: async () => 50e9,
        probe: async () => {
          if (!probeWorks) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
        },
      })

      disk.writeFailed()
      expect(disk.cantSave()).toBe(true)
      expect(banners.list().map((b) => [b.problem, b.severity, b.text])).toEqual([
        ['store-write-failed', 'stops-work', 'TED can’t save changes: disk full'],
      ])
      expect(seen.map((e) => e.type)).toEqual(['banner-raised'])

      await disk.check()
      expect(disk.cantSave()).toBe(true)

      probeWorks = true
      await disk.check()
      expect(disk.cantSave()).toBe(false)
      expect(banners.list()).toEqual([])
      expect(seen.map((e) => e.type)).toEqual(['banner-raised', 'banner-cleared'])
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('knows a full disk from SQLite’s and Node’s errors', () => {
    expect(isDiskFullError(Object.assign(new Error('write'), { code: 'ENOSPC' }))).toBe(true)
    expect(
      isDiskFullError(new Error('outer', { cause: new Error('database or disk is full') })),
    ).toBe(true)
    expect(isDiskFullError(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'))).toBe(false)
  })
})
