import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, Factory, RunSlots, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startWithStub(keys: string[] = ['NB']) {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  for (const key of keys) {
    const made = await makeOriginRepo(await mkdtemp(path.join(scratch, `${key}-`)))
    const origin = path.join(path.dirname(made), `${key.toLowerCase()}.git`)
    await rename(made, origin)
    await ok<Factory>('POST', '/dev/factories', { repo: origin, key })
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startWithStub>>

const never = () => JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'never') }] })

const create = (client: Client, title: string, fields: Record<string, unknown> = {}) =>
  client.ok<Task>('POST', '/tasks', { title, factory: 'NB', ...fields })

const all = (client: Client) => client.ok<Task[]>('GET', '/tasks')

const byId = async (client: Client, id: string) => {
  const task = (await all(client)).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const manual = (tasks: Task[]) =>
  [...tasks]
    .sort((a, b) => priorityIndex(a) - priorityIndex(b) || a.rank - b.rank)
    .map((t) => t.displayId)

const priorityIndex = (task: Task) =>
  ['urgent', 'high', 'medium', 'low', 'none'].indexOf(task.priority)

describe('rank', () => {
  test('a new Task goes to the bottom of its Priority group', async () => {
    const client = await startWithStub()
    await create(client, 'A')
    await create(client, 'B', { priority: 'high' })
    await create(client, 'C')
    expect(manual(await all(client))).toEqual(['NB-2', 'NB-1', 'NB-3'])
  })

  test('moving a Task between two others puts it there', async () => {
    const client = await startWithStub()
    const a = await create(client, 'A')
    const b = await create(client, 'B')
    const c = await create(client, 'C')

    await client.ok('POST', `/tasks/${c.id}/move`, { after: a.id, before: b.id })
    expect(manual(await all(client))).toEqual(['NB-1', 'NB-3', 'NB-2'])

    await client.ok('POST', `/tasks/${a.id}/move`, { after: b.id })
    expect(manual(await all(client))).toEqual(['NB-3', 'NB-2', 'NB-1'])

    await client.ok('POST', `/tasks/${a.id}/move`, { before: c.id })
    expect(manual(await all(client))).toEqual(['NB-1', 'NB-3', 'NB-2'])
  })

  test('dropping among Tasks of another Priority takes that Priority', async () => {
    const client = await startWithStub()
    const high = await create(client, 'High', { priority: 'high' })
    const low = await create(client, 'Low', { priority: 'low' })
    const none = await create(client, 'None')

    const moved = await client.ok<Task>('POST', `/tasks/${none.id}/move`, { before: high.id })
    expect(moved.priority).toBe('high')
    expect(manual(await all(client))).toEqual(['NB-3', 'NB-1', 'NB-2'])

    const between = await client.ok<Task>('POST', `/tasks/${high.id}/move`, {
      after: none.id,
      before: low.id,
    })
    expect(between.priority).toBe('high')

    const last = await client.ok<Task>('POST', `/tasks/${high.id}/move`, { after: low.id })
    expect(last.priority).toBe('low')
  })

  test('a move needs a neighbour that isn’t the Task itself', async () => {
    const client = await startWithStub()
    const a = await create(client, 'A')
    expect((await client.call('POST', `/tasks/${a.id}/move`, {})).status).toBe(400)
    expect((await client.call('POST', `/tasks/${a.id}/move`, { after: a.id })).status).toBe(400)
    expect((await client.call('POST', `/tasks/${a.id}/move`, { after: 'NB-99' })).status).toBe(404)
  })

  test('reordering Queued Tasks reorders the machine-wide queue across Factories', async () => {
    const client = await startWithStub(['NB', 'MS'])
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    await client.ok<Task>('POST', '/tasks', { title: never(), factory: 'NB', start: true })
    const first = await client.ok<Task>('POST', '/tasks', {
      title: 'First',
      factory: 'NB',
      start: true,
    })
    const second = await client.ok<Task>('POST', '/tasks', {
      title: 'Second',
      factory: 'MS',
      start: true,
    })
    expect((await byId(client, first.id)).status).toEqual({ kind: 'queued', place: 1 })

    await client.ok('POST', `/tasks/${second.id}/move`, { before: first.id })

    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots.queue.map((q) => ('displayId' in q ? q.displayId : q.name))).toEqual([
      'MS-1',
      'NB-2',
    ])
    expect((await byId(client, second.id)).status).toEqual({ kind: 'queued', place: 1 })
    expect((await byId(client, first.id)).status).toEqual({ kind: 'queued', place: 2 })
  })
})

describe('Priority', () => {
  test('the human sets a Task’s Priority', async () => {
    const client = await startWithStub()
    const a = await create(client, 'A')
    const set = await client.ok<Task>('PUT', `/tasks/${a.id}/priority`, { priority: 'urgent' })
    expect(set.priority).toBe('urgent')
    expect((await byId(client, a.id)).priority).toBe('urgent')
    expect((await client.call('PUT', `/tasks/${a.id}/priority`, { priority: 'soon' })).status).toBe(
      400,
    )
  })

  test('changing Priority moves a Queued Task in the queue', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    await create(client, never(), { start: true })
    const first = await create(client, 'First', { start: true })
    const second = await create(client, 'Second', { start: true })
    await client.ok('PUT', `/tasks/${second.id}/priority`, { priority: 'high' })
    expect((await byId(client, second.id)).status).toEqual({ kind: 'queued', place: 1 })
    expect((await byId(client, first.id)).status).toEqual({ kind: 'queued', place: 2 })
  })
})

describe('Task fields for the List', () => {
  test('a Task carries when it was last updated and who created it', async () => {
    const client = await startWithStub()
    const a = await create(client, 'A')
    expect(a.updatedAt).toBe(a.createdAt)
    expect(a.createdBy).toBe('human')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const set = await client.ok<Task>('PUT', `/tasks/${a.id}/priority`, { priority: 'low' })
    expect(set.updatedAt > a.createdAt).toBe(true)
  })

  test('statuses lists every status a Task has now, including Blocked when the marker shows', async () => {
    const client = await startWithStub()
    const blocker = await create(client, 'Blocker')
    const blocked = await create(client, 'Blocked', { blockedBy: [blocker.id] })
    expect(blocked.status).toBeUndefined()
    expect(blocked.markers).toEqual([{ kind: 'blocked-by', by: 'NB-1' }])
    expect(blocked.statuses).toEqual(['blocked'])
    expect(blocker.statuses).toEqual([])
  })
})

describe('archive', () => {
  test('archiving a Backlog Task hides its status and records how it ended', async () => {
    const client = await startWithStub()
    const a = await create(client, 'A')
    const archived = await client.ok<Task>('POST', `/tasks/${a.id}/archive`)
    expect(archived.archived).toMatchObject({ ended: { kind: 'never-started' } })
    expect(archived.archived?.at).toBeDefined()
    expect(archived.status).toBeUndefined()
    expect(archived.statuses).toEqual([])
    expect((await client.call('POST', `/tasks/${a.id}/archive`)).status).toBe(409)
    expect((await client.call('POST', `/tasks/${a.id}/start`)).status).toBe(409)
  })

  test('archiving a Queued Task takes it out of the queue', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    await create(client, never(), { start: true })
    const queued = await create(client, 'Queued', { start: true })
    const next = await create(client, 'Next', { start: true })

    await client.ok('POST', `/tasks/${queued.id}/archive`)

    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots.queue.map((q) => ('displayId' in q ? q.displayId : q.name))).toEqual(['NB-3'])
    expect((await byId(client, next.id)).status).toEqual({ kind: 'queued', place: 1 })
  })

  test('archiving withdraws the Task’s open requests, so they leave the Inbox', async () => {
    const client = await startWithStub()
    const asking = await create(client, 'Asking', {
      description: JSON.stringify({
        steps: [
          { run: ['ted', 'outcome', 'ask', 'Which way?'] },
          { waitFor: path.join(scratch, 'never') },
        ],
      }),
      start: true,
    })
    await waitUntil(
      async () => (await client.ok<unknown[]>('GET', '/inbox')).length === 1,
      'the question to reach the Inbox',
    )

    await client.ok('POST', `/tasks/${asking.id}/archive`)

    expect(await client.ok<unknown[]>('GET', '/inbox')).toEqual([])
    const comments = await client.ok<Comment[]>('GET', `/tasks/${asking.id}/comments`)
    expect(comments.find((c) => c.kind === 'question')?.answer).toMatchObject({
      kind: 'withdrawn',
      archived: true,
    })
  })

  test('archiving a working Task stops its Runs and removes its worktree', async () => {
    const client = await startWithStub()
    const working = await create(client, never(), { start: true })
    expect(working.leadRunId).toBeDefined()

    const archived = await client.ok<Task>('POST', `/tasks/${working.id}/archive`)
    expect(archived.archived?.ended).toEqual({ kind: 'stopped', stage: 'intake' })

    const done = await waitUntil(async () => {
      const task = await byId(client, working.id)
      return task.runs.length === 0 && task.repos.every((r) => r.removed) ? task : undefined
    }, 'the archived Task’s Runs to stop and worktree to go')
    expect(done.repos.length).toBe(1)
  })
})

describe('List views', () => {
  test('the List view for each scope is a machine setting', async () => {
    const client = await startWithStub()
    expect((await client.ok<{ listViews: unknown }>('GET', '/settings')).listViews).toEqual({})
    const view = {
      sort: 'priority',
      group: 'none',
      columns: ['priority', 'id', 'title', 'tokens'],
      filters: { statuses: ['queued'], archived: 'included' },
    }
    const saved = await client.ok<{ listViews: unknown }>('PATCH', '/settings', {
      listViews: { all: view },
    })
    expect(saved.listViews).toEqual({ all: view })
    const withEmpty = { ...view, showEmptyGroups: true }
    await client.ok('PATCH', '/settings', { listViews: { all: withEmpty, nb: view } })
    expect((await client.ok<{ listViews: unknown }>('GET', '/settings')).listViews).toEqual({
      all: withEmpty,
      nb: view,
    })
    const withoutEmpty = { ...view, showEmptyGroups: false }
    await client.ok('PATCH', '/settings', { listViews: { all: withoutEmpty } })
    expect((await client.ok<{ listViews: unknown }>('GET', '/settings')).listViews).toEqual({
      all: withoutEmpty,
    })
    for (const bad of [
      { all: { ...view, showEmptyGroups: 'yes' } },
      { all: { ...view, showEmptyGroups: null } },
      { all: { ...view, sort: 'sideways' } },
      { all: { ...view, columns: ['nonsense'] } },
      { all: { ...view, filters: { archived: 'maybe' } } },
      [],
    ]) {
      expect((await client.call('PATCH', '/settings', { listViews: bad })).status).toBe(400)
    }
  })
})
