import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Factory, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
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
  const app = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await app.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const cli = api(daemon.port, await tokenFor(home))
  return { ok, cli }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const url = 'https://acme.sentry.io/issues/4242/'

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

async function doneTask(client: Client): Promise<Task> {
  const gate = path.join(scratch, 'gate')
  const advance = ['ted', 'outcome', 'advance']
  const task = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    start: true,
    source: url,
    title: steps(
      { run: ['sh', '-c', 'printf "Goal: fix the crash\\n" | ted brief write'] },
      { waitFor: gate },
      { everyMessage: [{ run: advance }] },
      { run: advance },
    ),
  })
  await waitUntil(
    async () => (await getTask(client, task.id)).leadRunId,
    `${task.displayId} to start`,
  )
  await writeFile(gate, '')
  return waitUntil(
    async () => {
      const current = await getTask(client, task.id)
      return current.stage === 'done' && current.repos.every((r) => r.removed) ? current : undefined
    },
    `${task.displayId} to reach Done`,
    20_000,
  )
}

describe('ted task create --source', () => {
  test('refuses a source an open Task tracks; deleted Tasks don’t count', async () => {
    const client = await startTed()
    const first = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      source: url,
      title: 'A',
    })
    const again = await client.cli.call('POST', '/tasks', {
      factory: 'NB',
      source: 'https://ACME.sentry.io/issues/4242?project=3',
      title: 'B',
    })
    expect(again).toMatchObject({
      status: 409,
      body: { error: `Already tracked as ${first.displayId} · Backlog` },
    })
    await client.ok('POST', `/tasks/${first.id}/delete`, {})
    const created = await client.cli.call('POST', '/tasks', {
      factory: 'NB',
      source: url,
      title: 'C',
    })
    expect(created.status).toBe(201)
  })

  test('refuses a source whose Task was archived without merging', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', { factory: 'NB', source: url, title: 'A' })
    await client.ok('POST', `/tasks/${task.id}/archive`, {})
    const again = await client.cli.call('POST', '/tasks', {
      factory: 'NB',
      source: url,
      title: 'B',
    })
    expect(again).toMatchObject({
      status: 409,
      body: {
        error: `Already tracked as ${task.displayId}, which the human archived without merging. Leave it.`,
      },
    })
  })

  test('refuses a Done Task’s source with its merge facts, and --follow-up revisits it once', async () => {
    const client = await startTed()
    const done = await doneTask(client)
    const merged = new Date(done.merged?.at ?? '').toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    })
    const again = await client.cli.call('POST', '/tasks', {
      factory: 'NB',
      source: url,
      title: 'B',
    })
    expect(again).toMatchObject({
      status: 409,
      body: {
        error: `${done.displayId} is Done: merged ${merged}. Use --follow-up ${done.displayId} if it isn’t fixed.`,
      },
    })

    const followUp = await client.cli.call('POST', '/tasks', {
      factory: 'NB',
      followUp: done.displayId,
      source: url,
      title: steps({ waitFor: path.join(scratch, 'never') }),
      description: 'Events came back from 2.4.1.',
    })
    expect(followUp.status).toBe(201)
    expect(followUp.body).toMatchObject({
      createdBy: 'follow-up',
      followUpOf: { id: done.id, displayId: done.displayId },
      source: { url },
    })
    expect(followUp.body.stage).not.toBe('backlog')

    const twice = await client.cli.call('POST', '/tasks', {
      factory: 'NB',
      followUp: done.displayId,
      title: 'Again',
    })
    expect(twice).toMatchObject({
      status: 409,
      body: { error: `Already tracked as ${followUp.body.displayId} · Intake` },
    })
    const other = await client.cli.call('POST', '/tasks', {
      factory: 'NB',
      followUp: done.displayId,
      source: 'https://acme.sentry.io/issues/9/',
      title: 'Elsewhere',
    })
    expect(other.status).toBe(400)
  })
})
