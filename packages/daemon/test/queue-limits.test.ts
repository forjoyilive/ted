import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startWithStub() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startWithStub>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const startTask = (client: Client, title: string, priority?: string) =>
  client
    .ok<Task>('POST', '/tasks', { title, factory: 'NB', ...(priority && { priority }) })
    .then((task) => client.ok<Task>('POST', `/tasks/${task.id}/start`))

const workingUntil = (file: string) => steps({ waitFor: file }, { endTurn: true })

const waitForLead = (client: Client, task: Task) =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return current.leadRunId !== undefined ? current : undefined
  }, `${task.displayId} to start its Task Lead`)

const waitForRunState = (client: Client, task: Task, state: string) =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return current.runs[0]?.state === state ? current : undefined
  }, `${task.displayId}’s Task Lead to be ${state}`)

describe('the queue', () => {
  test('with the limit full, a started Task is Queued with its place and starts when a slot frees', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const free = path.join(scratch, 'free-a')
    const a = await startTask(client, `${workingUntil(free)}`)
    expect(a.leadRunId).toBeDefined()

    const b = await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)
    const c = await startTask(client, 'C')

    expect(b.stage).toBe('intake')
    expect(b.status).toEqual({ kind: 'queued', place: 1 })
    expect(b.leadRunId).toBeUndefined()
    expect(b.branch).toBeUndefined()
    expect(b.repos).toEqual([])
    expect(c.status).toEqual({ kind: 'queued', place: 2 })

    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots).toMatchObject({ limit: 1, working: 1, queued: 2 })
    expect(slots.holders.map((h) => (h.kind === 'task' ? h.displayId : h.name))).toEqual(['NB-1'])
    expect(slots.queue.map((q) => [q.place, 'displayId' in q ? q.displayId : q.name])).toEqual([
      [1, 'NB-2'],
      [2, 'NB-3'],
    ])

    await writeFile(free, '')
    const started = await waitForLead(client, b)
    expect(started.branch).toMatch(/^ted\/nb-2/)
    expect((await getTask(client, c.id)).status).toEqual({ kind: 'queued', place: 1 })
  })

  test('a higher Priority Task queues ahead of earlier ones', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)
    const low = await startTask(client, 'Low', 'low')
    const urgent = await startTask(client, 'Urgent', 'urgent')

    expect((await getTask(client, urgent.id)).status).toEqual({ kind: 'queued', place: 1 })
    expect((await getTask(client, low.id)).status).toEqual({ kind: 'queued', place: 2 })
  })

  test('raising the limit starts queued Tasks', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)
    const b = await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)
    expect(b.status?.kind).toBe('queued')

    await client.ok('PATCH', '/settings', { maxWorkingRuns: 2 })

    await waitForLead(client, b)
  })

  test('the limit is a whole number of at least 1', async () => {
    const client = await startWithStub()
    expect((await client.ok<{ maxWorkingRuns: number }>('GET', '/settings')).maxWorkingRuns).toBe(6)
    for (const value of [0, 1.5, '3']) {
      expect((await client.call('PATCH', '/settings', { maxWorkingRuns: value })).status).toBe(400)
    }
  })

  test('a subscribed client hears slots-changed as Tasks start and queue', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    const events: DaemonEvent[] = []
    const subscription = await new DaemonClient(info).subscribe((event) => events.push(event))
    try {
      await startTask(client, workingUntil(path.join(scratch, 'never')))
      await startTask(client, 'B')

      const last = await waitUntil(() => {
        const slots = events.flatMap((e) => (e.type === 'slots-changed' ? [e.slots] : [])).at(-1)
        return slots?.queued === 1 ? slots : undefined
      }, 'slots-changed with one queued')
      expect(last).toMatchObject({ limit: 1, working: 1 })
    } finally {
      subscription.close()
    }
  })

  test('changing the limit with nothing queued still reaches a client that subscribed late', async () => {
    const client = await startWithStub()
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    const events: DaemonEvent[] = []
    const subscription = await new DaemonClient(info).subscribe((event) => events.push(event))
    try {
      await client.ok('PATCH', '/settings', { maxWorkingRuns: 3 })
      await waitUntil(
        () => events.some((e) => e.type === 'slots-changed' && e.slots.limit === 3),
        'slots-changed with the new limit',
      )
    } finally {
      subscription.close()
    }
  })

  test('a waiting Run frees its slot, and when it works again it isn’t held back', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const answered = path.join(scratch, 'answered')
    const a = await startTask(
      client,
      `${steps({ hook: 'PermissionRequest' }, { waitFor: answered }, { hook: 'PreToolUse' }, { waitFor: path.join(scratch, 'never') })}`,
    )
    await waitForRunState(client, a, 'waiting')

    const b = await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)
    expect(b.leadRunId).toBeDefined()
    const c = await startTask(client, 'C')
    expect(c.status).toEqual({ kind: 'queued', place: 1 })

    await writeFile(answered, '')
    await waitForRunState(client, a, 'working')
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots).toMatchObject({ limit: 1, working: 2, queued: 1 })
    expect((await getTask(client, c.id)).status?.kind).toBe('queued')
  })

  test('a Factory’s max_working_runs caps its Tasks, and the slots show the cap', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
    const client = await startWithStub()
    const free = path.join(scratch, 'free-a')
    await startTask(client, `${workingUntil(free)}`)
    const b = await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)

    expect(b.status).toEqual({ kind: 'queued', place: 1 })
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots).toMatchObject({ limit: 6, working: 1, queued: 1 })
    expect(slots.factories).toEqual([expect.objectContaining({ cap: 1, working: 1 })])

    await writeFile(free, '')
    await waitForLead(client, b)
  })

  test('a raised max_working_runs applies from the next Stage entry', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
    const client = await startWithStub()
    const advance = path.join(scratch, 'advance')
    await startTask(
      client,
      steps(
        { waitFor: advance },
        { run: ['ted', 'outcome', 'advance'] },
        { waitFor: path.join(scratch, 'never') },
      ),
    )
    const b = await startTask(client, workingUntil(path.join(scratch, 'never')))
    expect(b.status).toEqual({ kind: 'queued', place: 1 })

    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 2\n' })
    await writeFile(advance, '')

    await waitForLead(client, b)
  })

  test('a Task running worktree setup holds its slot', async () => {
    const go = path.join(scratch, 'go')
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': `version: 1\nrepos:\n  - name: widgets\n    worktree:\n      setup: "while [ ! -e '${go}' ]; do sleep 0.05; done"\n`,
    })
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const a = await startTask(client, `${steps({ endTurn: true })}`)
    const b = await startTask(client, 'B')

    expect(a.leadRunId).toBeUndefined()
    expect(b.status).toEqual({ kind: 'queued', place: 1 })
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots.holders).toEqual([expect.objectContaining({ displayId: 'NB-1', settingUp: true })])

    await writeFile(go, '')
    await waitForLead(client, b)
  })

  test('a queued Task survives a daemon restart and starts when a slot frees', async () => {
    let client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const free = path.join(scratch, 'free-a')
    await startTask(client, `${workingUntil(free)}`)
    const b = await startTask(client, 'B')
    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    const restarted = api(daemon.port, { appKey: daemon.appToken })
    client = { ...client, ...restarted }
    client.ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const res = await restarted.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body as T
    }

    expect((await getTask(client, b.id)).status).toEqual({ kind: 'queued', place: 1 })
    await writeFile(free, '')
    await waitForLead(client, b)
  })
})

describe('Move to Backlog', () => {
  test('a Queued Task goes back to Backlog and leaves the queue', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)
    const b = await startTask(client, 'B')
    const c = await startTask(client, 'C')

    const back = await client.ok<Task>('POST', `/tasks/${b.id}/backlog`)

    expect(back.stage).toBe('backlog')
    expect(back.status).toBeUndefined()
    expect((await getTask(client, c.id)).status).toEqual({ kind: 'queued', place: 1 })
    expect((await client.ok<RunSlots>('GET', '/slots')).queued).toBe(1)
  })

  test('a Task that has had a Run can’t go back to Backlog', async () => {
    const client = await startWithStub()
    const a = await startTask(client, `${steps({ endTurn: true })}`)

    const res = await client.call('POST', `/tasks/${a.id}/backlog`)

    expect(res.status).toBe(409)
  })

  test('Runs can’t read the slots or move Tasks to Backlog', async () => {
    await startWithStub()
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = api(daemon?.port ?? 0, runToken)

    expect((await asRun.call('GET', '/slots')).status).toBe(403)
    expect((await asRun.call('POST', '/tasks/NB-1/backlog')).status).toBe(403)
  })
})
