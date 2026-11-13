import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Factory, Task, ThreadEvent } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
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

async function startTed() {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
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

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const advance = ['ted', 'outcome', 'advance']
const never = () => steps({ waitFor: path.join(scratch, 'never') })
const briefThenDone = (gate: string) =>
  steps(
    { run: ['sh', '-c', 'printf "Goal: export notes as Markdown\\n" | ted brief write'] },
    { waitFor: gate },
    { everyMessage: [{ run: advance }] },
    { run: advance },
  )

const create = (client: Client, title: string, extra: Record<string, unknown> = {}) =>
  client.ok<Task>('POST', '/tasks', { title, factory: 'NB', ...extra })

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const waitFor = (client: Client, task: Task, check: (t: Task) => boolean, what: string) =>
  waitUntil(
    async () => {
      const current = await getTask(client, task.id)
      return check(current) ? current : undefined
    },
    `${task.displayId} ${what}`,
    20_000,
  )

const threadTexts = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

async function doneTask(client: Client) {
  const gate = path.join(scratch, 'gate')
  const task = await create(client, briefThenDone(gate), { start: true, priority: 'high' })
  await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
  await writeFile(gate, '')
  return waitFor(
    client,
    task,
    (t) => t.stage === 'done' && t.repos.every((r) => r.removed),
    'to reach Done',
  )
}

describe('a Done Task', () => {
  test('says when it merged', async () => {
    const client = await startTed()
    const before = new Date().toISOString()
    const done = await doneTask(client)

    expect(done.merged?.at).toBeDefined()
    expect(done.merged?.at && done.merged.at >= before).toBe(true)
    expect(done.merged?.pullRequests).toEqual([])
    expect(done.commentBox).toBe('done')
  })

  test('is never reopened', async () => {
    const client = await startTed()
    const done = await doneTask(client)

    for (const action of ['start', 'resume', 'stop']) {
      const res = await client.call('POST', `/tasks/${done.id}/${action}`, {})
      expect(res.status, action).toBe(409)
    }
    const comment = await client.call('POST', `/tasks/${done.id}/comments`, { body: 'Nice' })
    expect(comment.status).toBe(201)
    const after = await getTask(client, done.id)
    expect(after.stage).toBe('done')
    expect(after.runs).toEqual([])
  })
})

describe('Follow up', () => {
  test('creates a linked Task that skips Backlog and starts from the brief', async () => {
    const client = await startTed()
    const done = await doneTask(client)

    const followUp = await client.ok<Task>('POST', `/tasks/${done.id}/follow-up`, {
      comment: `${never()}\nAlso export the tags.`,
    })

    expect(followUp.id).not.toBe(done.id)
    expect(followUp.factoryId).toBe(done.factoryId)
    expect(followUp.createdBy).toBe('follow-up')
    expect(followUp.followUpOf).toEqual({ id: done.id, displayId: done.displayId })
    expect(followUp.priority).toBe('high')
    expect(followUp.stage).not.toBe('backlog')
    expect(followUp.title).toBe(never())
    expect(followUp.description).toBe('Also export the tags.')

    const running = await waitFor(
      client,
      followUp,
      (t) => t.leadRunId !== undefined,
      'to start a Task Lead Run',
    )
    const { prompt } = (await client.getRun(running.leadRunId ?? '')).run as { prompt?: string }
    expect(prompt).toContain(`# Follow-up to ${done.displayId}`)
    expect(prompt).toContain('Goal: export notes as Markdown')
    expect(prompt).toContain('ted outcome advance --skip')

    const original = await getTask(client, done.id)
    expect(original.stage).toBe('done')
    expect(original.runs).toEqual([])
    expect(await threadTexts(client, original)).toContain(
      `You followed up in ${followUp.displayId}`,
    )
    expect(await threadTexts(client, followUp)).toContain(`Follow-up to ${done.displayId}`)
  })

  test('waits for a slot like any started Task', async () => {
    const client = await startTed()
    const done = await doneTask(client)
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const busy = await create(client, never(), { start: true })
    await waitFor(client, busy, (t) => t.leadRunId !== undefined, 'to start')

    const followUp = await client.ok<Task>('POST', `/tasks/${done.id}/follow-up`, {
      comment: never(),
    })

    expect(followUp.statuses).toContain('queued')
    expect(followUp.leadRunId).toBeUndefined()
  })

  test('without a Comment, the new Task is named after the original', async () => {
    const client = await startTed()
    const done = await doneTask(client)

    const followUp = await client.ok<Task>('POST', `/tasks/${done.id}/follow-up`, {})

    expect(followUp.title).toBe(`Follow-up to ${done.displayId}`)
    expect(followUp.description).toBe('')
  })

  test('only a Done Task that isn’t archived can be followed up', async () => {
    const client = await startTed()
    const idea = await create(client, 'Idea')
    expect((await client.call('POST', `/tasks/${idea.id}/follow-up`, {})).status).toBe(409)

    const done = await doneTask(client)
    await client.ok('POST', `/tasks/${done.id}/archive`)
    expect((await client.call('POST', `/tasks/${done.id}/follow-up`, {})).status).toBe(409)

    const bad = await client.call('POST', `/tasks/${idea.id}/follow-up`, { comment: 3 })
    expect(bad.status).toBe(400)
  })
})

describe('Archive all in Done', () => {
  test('archives every Done Task of the Factory and says how many', async () => {
    const client = await startTed()
    const done = await doneTask(client)
    const idea = await create(client, 'Idea')

    const result = await client.ok<{ archived: number }>('POST', '/factories/NB/archive-done')

    expect(result).toEqual({ archived: 1 })
    expect((await getTask(client, done.id)).archived?.ended.kind).toBe('merged')
    expect((await getTask(client, idea.id)).archived).toBeUndefined()
    expect(await client.ok('POST', '/factories/NB/archive-done')).toEqual({ archived: 0 })
    expect((await client.call('POST', '/factories/XX/archive-done')).status).toBe(404)
  })
})
