import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Factory, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

const execFileAsync = promisify(execFile)

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

async function startTed() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const advance = ['ted', 'outcome', 'advance']

const doneWhen = (gate: string) =>
  steps({ waitFor: gate }, { everyMessage: [{ run: advance }] }, { run: advance })

const getTask = async (client: Client, ref: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find(
    (t) => t.id === ref || t.displayId === ref,
  )
  if (!task) throw new Error(`no Task ${ref}`)
  return task
}

const create = (client: Client, title: string, extra: Record<string, unknown> = {}) =>
  client.ok<Task>('POST', '/tasks', { title, factory: 'NB', ...extra })

const block = (client: Client, task: Task, by: Task) =>
  client.call('POST', `/tasks/${task.id}/blockers`, { by: by.displayId })

const waitFor = (client: Client, task: Task, check: (t: Task) => boolean, what: string) =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return check(current) ? current : undefined
  }, `${task.displayId} ${what}`)

const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

describe('adding a blocker', () => {
  test('a blocker that would make a cycle is refused, naming the cycle', async () => {
    const client = await startTed()
    const a = await create(client, 'A')
    const b = await create(client, 'B', { blockedBy: [a.id] })
    const c = await create(client, 'C', { blockedBy: [b.id] })

    const refused = await block(client, a, c)

    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(
      'NB-3 can’t block NB-1: that makes a cycle, NB-1 → NB-3 → NB-2 → NB-1',
    )
    expect((await block(client, a, a)).status).toBe(409)
    expect((await getTask(client, a.id)).blockedBy).toEqual([])
  })

  test('a Backlog Task stays in Backlog and shows the blocker as a marker', async () => {
    const client = await startTed()
    const a = await create(client, 'A')
    const b = await create(client, 'B')

    const res = await block(client, b, a)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      stage: 'backlog',
      blockedBy: [a.id],
      markers: [{ kind: 'blocked-by', by: 'NB-1' }],
      activity: 'Starts when NB-1 merges',
    })
  })

  test('a Queued Task goes back to Backlog and starts when its blocker reaches Done', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const gate = path.join(scratch, 'gate')
    const blocker = await create(client, doneWhen(gate), { start: true })
    const queued = await create(client, steps({ endTurn: true }), { start: true })
    expect(queued.status).toEqual({ kind: 'queued', place: 1 })

    const res = await block(client, queued, blocker)
    expect(res.body).toMatchObject({ stage: 'backlog', markers: [{ kind: 'blocked-by' }] })
    expect(res.body.status).toBeUndefined()

    await writeFile(gate, '')
    await waitFor(client, blocker, (t) => t.stage === 'done', 'to reach Done')
    const started = await waitFor(client, queued, (t) => t.leadRunId !== undefined, 'to start')
    expect(started.markers).toEqual([])
  })

  test('a running Task’s Task Lead is told, and can stop to wait', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const blocker = await create(client, doneWhen(gate))
    const running = await create(
      client,
      steps(
        { say: 'working' },
        { endTurn: true },
        {
          everyMessage: [
            { run: ['ted', 'task', 'block', '--by', 'NB-1'] },
            { run: ['ted', 'comment', 'Waiting for NB-1; the parser is half done'] },
            { endTurn: true },
          ],
        },
      ),
      { start: true },
    )
    const first = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    const runId = first.leadRunId ?? ''

    expect((await block(client, running, blocker)).status).toBe(200)

    const blocked = await waitFor(
      client,
      running,
      (t) => t.status?.kind === 'blocked',
      'to be Blocked',
    )
    expect(blocked).toMatchObject({ stage: 'intake', status: { kind: 'blocked', by: 'NB-1' } })
    expect(blocked.runs).toEqual([])
    expect(blocked.activity).toBe('Starts when NB-1 merges')
    const [, message] = await userMessages(client, runId)
    expect(message).toContain('The human made this Task wait for NB-1')
    const worktree = path.join(home, 'worktrees', 'NB-2', 'widgets')
    expect((await stat(worktree)).isDirectory()).toBe(true)

    await client.ok('POST', `/tasks/${blocker.id}/start`)
    await writeFile(gate, '')
    const fresh = await waitFor(
      client,
      running,
      (t) => t.leadRunId !== undefined && t.leadRunId !== runId,
      'to get a fresh Run',
    )
    expect(fresh.stage).toBe('intake')
    const { prompt } = (await client.getRun(fresh.leadRunId ?? '')).run as { prompt?: string }
    expect(prompt).toContain('# Picking up after a blocker')
    expect(prompt).toContain('Waiting for NB-1; the parser is half done')
    expect((await stat(worktree)).isDirectory()).toBe(true)
  })

  test('a Task Lead that carries on keeps its Run, with the blocker as a marker', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const running = await create(
      client,
      steps(
        { endTurn: true },
        {
          everyMessage: [
            { run: ['ted', 'comment', 'This only touches docs, so I can carry on'] },
            { endTurn: true },
          ],
        },
      ),
      { start: true },
    )
    const first = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'to go idle')

    await block(client, running, blocker)
    await waitUntil(
      async () =>
        (await userMessages(client, first.leadRunId ?? '')).length === 2 &&
        (await client.ok<unknown[]>('GET', `/tasks/${running.id}/comments`)).length === 1,
      'the Task Lead to answer',
    )
    const current = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'idle')
    expect(current.runs).toHaveLength(1)
    expect(current.status?.kind).not.toBe('blocked')
    expect(current.markers).toEqual([{ kind: 'blocked-by', by: 'NB-1' }])
  })
})

describe('starting when the blocker merges', () => {
  test('a Task created with Start now starts; one created without stays in Backlog', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const blocker = await create(client, doneWhen(gate), { start: true })
    const meant = await create(client, steps({ endTurn: true }), {
      start: true,
      blockedBy: [blocker.id],
    })
    const later = await create(client, 'Later', { start: false, blockedBy: [blocker.id] })
    expect(meant.stage).toBe('backlog')

    await writeFile(gate, '')
    await waitFor(client, meant, (t) => t.leadRunId !== undefined, 'to start')
    const stays = await getTask(client, later.id)
    expect(stays.stage).toBe('backlog')
    expect(stays.markers).toEqual([])
  })

  test('starting a blocked Backlog Task by hand waits for the blocker', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const blocker = await create(client, doneWhen(gate))
    const task = await create(client, steps({ endTurn: true }), { blockedBy: [blocker.id] })

    const res = await client.ok<Task>('POST', `/tasks/${task.id}/start`)
    expect(res).toMatchObject({ stage: 'backlog', activity: 'Starts when NB-1 merges' })

    await client.ok('POST', `/tasks/${blocker.id}/start`)
    await writeFile(gate, '')
    await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
  })

  test('removing the last blocker by hand never starts a Task', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const task = await create(client, 'Task', { start: true, blockedBy: [blocker.id] })

    const res = await client.call('DELETE', `/tasks/${task.id}/blockers/${blocker.displayId}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ stage: 'backlog', blockedBy: [], markers: [] })
    expect((await client.call('DELETE', `/tasks/${task.id}/blockers/NB-1`)).status).toBe(404)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await getTask(client, task.id)).stage).toBe('backlog')
  })

  test('a blocker in another Factory works', async () => {
    const client = await startTed()
    const other = path.join(scratch, 'kriya', 'gadgets.git')
    await execFileAsync('git', ['clone', '--bare', origin, other])
    await client.ok<Factory>('POST', '/dev/factories', { repo: other, key: 'MS' })
    const gate = path.join(scratch, 'gate')
    const blocker = await client.ok<Task>('POST', '/tasks', {
      title: doneWhen(gate),
      factory: 'MS',
      start: true,
    })
    const task = await create(client, steps({ endTurn: true }), {
      start: true,
      blockedBy: [blocker.displayId],
    })
    expect(task.markers).toEqual([{ kind: 'blocked-by', by: 'MS-1' }])

    await writeFile(gate, '')
    await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
  })
})

describe('blockers from inside a Run', () => {
  test('a Run may block and unblock its own Task, but no other', async () => {
    const client = await startTed()
    const other = await create(client, 'Other')
    await create(client, 'Blocker')
    const running = await create(
      client,
      steps(
        { run: ['ted', 'task', 'block', 'NB-1', '--by', 'NB-2'] },
        { run: ['ted', 'task', 'block', '--by', 'NB-2'] },
        { run: ['ted', 'task', 'unblock', '--by', 'NB-2'] },
        { endTurn: true },
      ),
      { start: true },
    )
    const idle = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'idle')

    const results = (await client.getRun(idle.leadRunId ?? '')).conversation.flatMap((e) => {
      const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
      const content = line.message?.content
      return line.type === 'assistant' && Array.isArray(content)
        ? content.map((c: { text?: string }) => JSON.parse(c.text ?? '{}'))
        : []
    })
    expect(results).toMatchObject([
      { code: 1, stderr: 'ted: this Run doesn’t belong to NB-1\n' },
      { code: 0, stdout: 'NB-3 waits for NB-2\n' },
      { code: 0, stdout: 'NB-3 no longer waits for NB-2\n' },
    ])
    expect((await getTask(client, other.id)).blockedBy).toEqual([])
    expect(idle.blockedBy).toEqual([])
    expect(idle.runs).toHaveLength(1)
  })
})
