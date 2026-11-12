import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DaemonClient,
  type DaemonEvent,
  type Factory,
  type RunSlots,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  hostsStarted,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-auto-backlog-'))
  origin = await makeOriginRepo(scratch)
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

function clientNow() {
  if (!daemon) throw new Error('daemon not started')
  const client = api(daemon.port, { appKey: daemon.appToken })
  return {
    ...client,
    async ok<T>(method: string, route: string, body?: unknown): Promise<T> {
      const response = await client.call(method, route, body)
      if (response.status >= 300) throw new Error(`${route}: ${JSON.stringify(response)}`)
      return response.body as T
    },
  }
}
type Client = ReturnType<typeof clientNow>
async function start(options: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  daemon = await startDaemon({ ...options, home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = clientNow()
  const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { client, factory }
}
const route = (factory: Factory) => `/factories/${factory.id}/auto-start-backlog`
const enable = (client: Client, factory: Factory, enabled = true) =>
  client.ok<Factory>('PUT', route(factory), { enabled })
const steps = (...steps: unknown[]) => JSON.stringify({ steps })
const working = (file: string) => steps({ waitFor: file }, { endTurn: true })
const create = (client: Client, fields: Partial<Task> = {}) =>
  client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: working(path.join(scratch, 'never')),
    ...fields,
  })
const get = async (client: Client, task: Task) => {
  const current = (await client.ok<Task[]>('GET', '/tasks')).find(
    (candidate) => candidate.id === task.id,
  )
  if (!current) throw new Error(`missing Task ${task.displayId}`)
  return current
}
const lead = (client: Client, task: Task) =>
  waitUntil(async () => {
    const current = await get(client, task)
    return current.leadRunId ? current : undefined
  }, `${task.displayId} to start`)
const slots = (client: Client) => client.ok<RunSlots>('GET', '/slots')

describe('automatic Backlog starts', () => {
  test('defaults off, validates requests, refuses non-app callers and persists the setting', async () => {
    let { client, factory } = await start()
    expect(factory.autoStartBacklog).toBe(false)
    const task = await create(client)
    expect((await get(client, task)).stage).toBe('backlog')
    for (const enabled of [null, 'true', 1, undefined]) {
      expect((await client.call('PUT', route(factory), { enabled })).status).toBe(400)
    }
    expect(
      (await client.call('PUT', '/factories/missing/auto-start-backlog', { enabled: true })).status,
    ).toBe(404)
    const fileClient = api(daemon?.port ?? 0, await tokenFor(home))
    const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const runClient = api(daemon?.port ?? 0, token)
    for (const caller of [fileClient, runClient]) {
      expect((await caller.call('PUT', route(factory), { enabled: true })).status).toBe(403)
    }
    await client.ok('POST', `/tasks/${task.id}/archive`)
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon info')
    const events: DaemonEvent[] = []
    const subscription = await new DaemonClient(info).subscribe((event) => events.push(event))
    try {
      expect((await enable(client, factory)).autoStartBacklog).toBe(true)
      await waitUntil(
        () =>
          events.some(
            (event) => event.type === 'factory-updated' && event.factory.autoStartBacklog,
          ),
        'Factory update',
      )
    } finally {
      subscription.close()
    }
    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    client = clientNow()
    expect((await client.ok<Factory[]>('GET', '/factories'))[0]?.autoStartBacklog).toBe(true)
  })

  test('fills immediately, honors the machine cap, refills on waiting, stops filling when disabled, and Autopilot alone starts nothing', async () => {
    const { client, factory } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1, overnightMode: true })
    const free = path.join(scratch, 'free')
    const a = await create(client, { title: working(free) })
    const b = await create(client)
    const c = await create(client)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await get(client, a)).stage).toBe('backlog')
    await enable(client, factory)
    await lead(client, a)
    expect((await get(client, b)).stage).toBe('backlog')
    expect(await slots(client)).toMatchObject({ working: 1, queued: 0 })
    await writeFile(free, '')
    await lead(client, b)
    await enable(client, factory, false)
    await client.ok('POST', `/tasks/${b.id}/stop`)
    expect((await get(client, b)).leadRunId).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await get(client, c)).stage).toBe('backlog')
    expect((await get(client, a)).runs[0]?.state).toBe('idle')
  })

  test('serves Queued work first and leaves excess Backlog Tasks unstarted', async () => {
    const { client, factory } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const a = await create(client)
    const b = await create(client)
    await client.ok('POST', `/tasks/${a.id}/start`)
    await client.ok('POST', `/tasks/${b.id}/start`)
    const urgent = await create(client, { priority: 'urgent' })
    await enable(client, factory)
    await client.ok('POST', `/tasks/${a.id}/stop`)
    await lead(client, b)
    expect((await get(client, urgent)).stage).toBe('backlog')
    expect((await slots(client)).queued).toBe(0)
  })

  test('uses Priority and manual order and skips blocked and archived Tasks', async () => {
    const { client, factory } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const low = await create(client, { priority: 'low' })
    const blocked = await create(client, { priority: 'urgent' })
    await client.ok('POST', `/tasks/${blocked.id}/blockers`, { by: low.id })
    const archived = await create(client, { priority: 'urgent' })
    await client.ok('POST', `/tasks/${archived.id}/archive`)
    const first = await create(client, { priority: 'high' })
    const next = await create(client, { priority: 'high' })
    await client.ok('POST', `/tasks/${next.id}/move`, { before: first.id })
    await enable(client, factory)
    await lead(client, next)
    for (const task of [low, blocked, first])
      expect((await get(client, task)).stage).toBe('backlog')
    await client.ok('DELETE', `/tasks/${blocked.id}/blockers`)
    await client.ok('POST', `/tasks/${next.id}/stop`)
    await lead(client, blocked)
    expect((await get(client, first)).stage).toBe('backlog')
  })

  test('respects the Factory cap after disabling and re-enabling', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
    const { client, factory } = await start()
    const a = await create(client)
    const b = await create(client)
    const c = await create(client)
    await enable(client, factory)
    await lead(client, a)
    expect((await get(client, b)).stage).toBe('backlog')
    expect((await slots(client)).factories).toEqual([
      expect.objectContaining({ cap: 1, working: 1 }),
    ])
    await enable(client, factory, false)
    await client.ok('POST', `/tasks/${a.id}/stop`)
    await enable(client, factory)
    await lead(client, b)
    expect((await get(client, c)).stage).toBe('backlog')
  })

  test('fills remaining slots on restart without starting a Task twice', async () => {
    let { client, factory } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const a = await create(client)
    const b = await create(client)
    await enable(client, factory)
    await lead(client, a)
    await hostsStarted(home)
    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    client = clientNow()
    expect((await get(client, a)).runs).toHaveLength(1)
    expect((await get(client, b)).stage).toBe('backlog')
    await client.ok('POST', `/tasks/${a.id}/stop`)
    const started = await lead(client, b)
    expect(started.runs).toHaveLength(1)
  })

  test('holds Backlog while offline and starts when agent health recovers', async () => {
    let online = false
    const { client, factory } = await start({
      online: { isOnline: async () => online, onlineEveryMs: 20, offlineEveryMs: 20 },
    })
    const task = await create(client)
    await enable(client, factory)
    expect((await get(client, task)).stage).toBe('backlog')
    online = true
    await lead(client, task)
  })

  test('holds Backlog on a full disk and fills when the hold clears', async () => {
    let freeBytes = 100_000_000
    const { client, factory } = await start({
      disk: { freeBytes: async () => freeBytes, checkEveryMs: 20 },
    })
    const task = await create(client)
    await enable(client, factory)
    expect((await get(client, task)).stage).toBe('backlog')
    freeBytes = 500_000_000_000
    await lead(client, task)
  })

  test('fills several slots and reacts to new Tasks and higher limits', async () => {
    const { client, factory } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 2 })
    const a = await create(client)
    const b = await create(client)
    await enable(client, factory)
    await Promise.all([lead(client, a), lead(client, b)])
    expect(await slots(client)).toMatchObject({ working: 2, queued: 0 })
    const c = await create(client)
    expect((await get(client, c)).stage).toBe('backlog')
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 3 })
    await lead(client, c)
    await client.ok('POST', `/tasks/${a.id}/stop`)
    const d = await create(client)
    await lead(client, d)
    expect(await slots(client)).toMatchObject({ working: 3, queued: 0 })
  })

  test('two Factories share the machine cap without duplicate starts', async () => {
    const otherScratch = path.join(scratch, 'other')
    const otherOrigin = await makeOriginRepo(otherScratch)
    const renamed = path.join(otherScratch, 'acme', 'other.git')
    await rename(otherOrigin, renamed)
    const { client, factory } = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const other = await client.ok<Factory>('POST', '/dev/factories', { repo: renamed, key: 'OT' })
    const a = await create(client)
    const b = await client.ok<Task>('POST', '/tasks', {
      factory: 'OT',
      title: working(path.join(scratch, 'never')),
    })
    await enable(client, factory)
    await lead(client, a)
    await enable(client, other)
    expect((await get(client, b)).stage).toBe('backlog')
    await client.ok('POST', `/tasks/${a.id}/stop`)
    expect((await lead(client, b)).runs).toHaveLength(1)
    expect(await slots(client)).toMatchObject({ working: 1, queued: 0 })
  })
})
