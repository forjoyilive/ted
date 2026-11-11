import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Factory, type Task, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'
import { ManualClock } from './support/manual-clock.ts'

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

describe('Backlog snoozes', () => {
  test('the shared Clock drives due starts and cancels the snooze timer on close', async () => {
    const clock = new ManualClock(Date.parse('2099-11-10T00:00:00Z'))
    const { client } = await start({ clock })
    const task = await create(client)
    await client.ok('PUT', `/tasks/${task.id}/snooze`, { snoozedUntil: '2099-11-10T00:01:00.000Z' })
    clock.advance(59_999)
    expect((await get(client, task)).stage).toBe('backlog')
    clock.advance(1)
    await lead(client, task)
    expect((await get(client, task)).snoozedUntil).toBeUndefined()
    await daemon?.stop()
    daemon = undefined
    expect(clock.pending).toEqual([])
  })

  test('a pending snooze holds idle exit until cancellation', async () => {
    const clock = new ManualClock(Date.parse('2099-11-10T00:00:00Z'))
    let idles = 0
    const { client } = await start({
      clock,
      idleExit: {
        afterMs: 500,
        onIdle: () => {
          idles++
        },
      },
    })
    const task = await create(client)
    await client.ok('PUT', `/tasks/${task.id}/snooze`, { snoozedUntil: '2099-11-11T00:00:00.000Z' })
    clock.advance(1000)
    expect(idles).toBe(0)
    await client.ok('PUT', `/tasks/${task.id}/snooze`, { snoozedUntil: null })
    clock.advance(500)
    expect(idles).toBe(1)
  })

  const until = '2099-11-11T17:00:00.000Z'
  const snooze = (client: Client, task: Task, snoozedUntil: string | null = until) =>
    client.ok<Task>('PUT', `/tasks/${task.id}/snooze`, { snoozedUntil })

  test('persists a snooze, holds automatic starts in Overnight mode, and starts overdue Tasks after restart', async () => {
    let { client, factory } = await start()
    const task = await create(client)
    expect(await snooze(client, task)).toMatchObject({
      snoozedUntil: until,
      markers: [{ kind: 'snoozed', until }],
    })
    await client.ok('PUT', `/factories/${factory.id}/auto-start-backlog`, { enabled: true })
    expect((await get(client, task)).stage).toBe('backlog')
    await client.ok('PUT', `/factories/${factory.id}/auto-start-backlog`, { enabled: false })
    await client.ok('PATCH', '/settings', { overnightMode: true })
    expect((await get(client, task)).stage).toBe('backlog')
    await client.ok('PATCH', '/settings', { overnightMode: false })
    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    client = clientNow()
    expect((await get(client, task)).snoozedUntil).toBe(until)
    await daemon.stop()
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      snoozes: { now: () => new Date('2099-11-12T00:00:00Z'), checkEveryMs: 20 },
    })
    client = clientNow()
    const started = await lead(client, task)
    expect(started.snoozedUntil).toBeUndefined()
    expect(started.runs).toHaveLength(1)
  })

  test('due snoozes respect blockers and slots and start with automatic Backlog starts off', async () => {
    let now = new Date('2099-11-10T00:00:00Z')
    const { client } = await start({ snoozes: { now: () => now, checkEveryMs: 20 } })
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const blocker = await create(client)
    const task = await create(client)
    await client.ok('POST', `/tasks/${task.id}/blockers`, { by: blocker.id })
    await snooze(client, task)
    now = new Date('2099-11-12T00:00:00Z')
    await client.ok('POST', `/tasks/${blocker.id}/start`)
    await lead(client, blocker)
    expect((await get(client, task)).stage).toBe('backlog')
    await client.ok('DELETE', `/tasks/${task.id}/blockers`)
    expect((await get(client, task)).stage).toBe('backlog')
    await client.ok('POST', `/tasks/${blocker.id}/stop`)
    await lead(client, task)
  })

  test('change, cancel, manual Start and archive clear the intended schedule', async () => {
    const { client } = await start()
    const task = await create(client)
    await snooze(client, task)
    const later = '2099-12-01T17:00:00.000Z'
    expect((await snooze(client, task, later)).snoozedUntil).toBe(later)
    expect((await snooze(client, task, null)).snoozedUntil).toBeUndefined()
    await snooze(client, task)
    await client.ok('PATCH', '/settings', { overnightMode: true })
    await client.ok('POST', `/tasks/${task.id}/start`)
    await client.ok('PATCH', '/settings', { overnightMode: false })
    expect((await lead(client, task)).snoozedUntil).toBeUndefined()
    expect(
      (await client.call('PUT', `/tasks/${task.id}/snooze`, { snoozedUntil: until })).status,
    ).toBe(409)
    const archived = await create(client)
    await snooze(client, archived)
    await client.ok('POST', `/tasks/${archived.id}/archive`)
    expect((await get(client, archived)).snoozedUntil).toBeUndefined()
  })

  test('validates future instants and refuses file and Run tokens', async () => {
    const { client } = await start()
    const task = await create(client)
    for (const value of [
      undefined,
      '',
      'tomorrow',
      '2000-01-01T00:00:00.000Z',
      '2099-02-30T00:00:00.000Z',
      123,
    ]) {
      expect(
        (await client.call('PUT', `/tasks/${task.id}/snooze`, { snoozedUntil: value })).status,
      ).toBe(400)
    }
    const fileClient = api(daemon?.port ?? 0, await tokenFor(home))
    const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const runClient = api(daemon?.port ?? 0, token)
    for (const caller of [fileClient, runClient]) {
      expect(
        (await caller.call('PUT', `/tasks/${task.id}/snooze`, { snoozedUntil: until })).status,
      ).toBe(403)
    }
  })
})
