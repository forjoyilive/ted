import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  DaemonClient,
  type DaemonEvent,
  type Factory,
  type InboxItem,
  type RunSlots,
  readDaemonInfo,
  type Task,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
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
let origin: string
let daemon: RunningDaemon | undefined
let subscription: { close(): void } | undefined
let ratio = 0
let memory = 1

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
  ratio = 0
  memory = 1
})

afterEach(async () => {
  subscription?.close()
  subscription = undefined
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startWithStub(checkEveryMs = 50) {
  const events: DaemonEvent[] = []
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    load: { ratio: () => ratio, memoryAvailable: () => memory, checkEveryMs },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  subscription = await new DaemonClient(info).subscribe((event) => events.push(event))
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok, events }
}

type Client = Awaited<ReturnType<typeof startWithStub>>

const never = () => path.join(scratch, 'never')
const workingUntil = (file: string) =>
  JSON.stringify({ steps: [{ waitFor: file }, { endTurn: true }] })

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const startTask = (client: Client, title: string) =>
  client
    .ok<Task>('POST', '/tasks', { title, factory: 'NB' })
    .then((task) => client.ok<Task>('POST', `/tasks/${task.id}/start`))

const waitForLead = (client: Client, task: Task) =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return current.leadRunId !== undefined ? current : undefined
  }, `${task.displayId} to start its Task Lead`)

const slotsOf = (client: Client) => client.ok<RunSlots>('GET', '/slots')

test('while this computer is busy a second Task stays queued, and starts once the load falls and memory recovers with no other event', async () => {
  const client = await startWithStub()
  ratio = 2.004
  const a = await startTask(client, workingUntil(never()))
  expect(a.leadRunId).toBeDefined()

  const b = await startTask(client, workingUntil(never()))

  expect(b.leadRunId).toBeUndefined()
  expect(b.status).toEqual({ kind: 'queued', place: 1 })
  expect(await slotsOf(client)).toMatchObject({
    limit: 6,
    working: 1,
    queued: 1,
    busy: { loadRatio: 2 },
  })
  await sleep(300)
  expect((await getTask(client, b.id)).leadRunId).toBeUndefined()
  expect((await getTask(client, a.id)).runs[0]?.state).toBe('working')

  ratio = 0.9
  await sleep(300)
  expect((await getTask(client, b.id)).leadRunId).toBeUndefined()
  expect((await slotsOf(client)).busy).toEqual({ loadRatio: 0.9 })

  ratio = 0.5
  memory = 0.05
  await waitUntil(
    async () => (await slotsOf(client)).busy?.memoryAvailable === 0.05 || undefined,
    'the hold to move from load to memory',
  )
  expect((await getTask(client, b.id)).status).toEqual({ kind: 'queued', place: 1 })
  memory = 0.15
  await sleep(300)
  expect((await getTask(client, b.id)).leadRunId).toBeUndefined()
  expect((await slotsOf(client)).busy).toEqual({ memoryAvailable: 0.15 })

  client.events.length = 0
  memory = 0.5
  await waitForLead(client, b)
  const after = await waitUntil(async () => {
    const slots = await slotsOf(client)
    return slots.working === 2 ? slots : undefined
  }, 'both Tasks to hold a slot')
  expect(after.busy).toBeUndefined()
  expect(client.events.some((e) => e.type === 'slots-changed' && e.slots.busy === undefined)).toBe(
    true,
  )
  expect((await getTask(client, a.id)).runs[0]?.state).toBe('working')
})

test('a subscribed client hears slots-changed when the hold starts', async () => {
  const client = await startWithStub()
  await startTask(client, workingUntil(never()))
  const b = await startTask(client, workingUntil(never()))
  await waitForLead(client, b)
  ratio = 1.5

  const c = await startTask(client, 'C')

  expect(c.status).toEqual({ kind: 'queued', place: 1 })
  await waitUntil(
    () => client.events.some((e) => e.type === 'slots-changed' && e.slots.busy !== undefined),
    'slots-changed with the hold',
  )
})

test('with nothing working, the first Task starts even when this computer is busy', async () => {
  const client = await startWithStub()
  ratio = 5
  const free = path.join(scratch, 'free-a')

  const a = await startTask(client, workingUntil(free))
  expect(a.leadRunId).toBeDefined()
  const b = await startTask(client, workingUntil(never()))
  expect(b.status?.kind).toBe('queued')

  await writeFile(free, '')
  await waitForLead(client, b)
})

test('a waiting Task Lead’s first sub-agent still starts while this computer is busy, and its second waits', async () => {
  const client = await startWithStub()
  const go = path.join(scratch, 'go')
  const release = path.join(scratch, 'release')
  const prompt = path.join(scratch, 'review.md')
  await writeFile(
    prompt,
    `${JSON.stringify({ steps: [{ waitFor: release }, { say: 'Reviewed' }, { endTurn: true }] })}\n`,
  )
  const runId = 'grep -o "[0-9a-f]\\{6\\}" | head -1'
  const start = (name: string) =>
    `$(ted run start --name ${name} --prompt-file ${prompt} | ${runId})`
  const task = await startTask(
    client,
    JSON.stringify({
      steps: [
        { waitFor: go },
        {
          run: [
            'sh',
            '-c',
            `a=${start('First')}; b=${start('Second')}; ted run wait "$a"; ted run wait "$b"`,
          ],
        },
        { endTurn: true },
      ],
    }),
  )
  const other = await startTask(client, workingUntil(never()))
  await waitUntil(async () => (await slotsOf(client)).working === 2 || undefined, 'both to work')
  ratio = 3

  await writeFile(go, '')
  const handedOff = await waitUntil(async () => {
    const current = await getTask(client, task.id)
    const first = current.runs.find((r) => r.name === 'First')
    return first?.state === 'working' && current.runs[0]?.onSubAgents ? current : undefined
  }, 'the first sub-agent to start under the load hold')

  expect(handedOff.runs.map((r) => r.name)).toEqual(['Task Lead', 'First'])
  const slots = await slotsOf(client)
  expect(slots).toMatchObject({ limit: 6, working: 2, queued: 1, busy: { loadRatio: 3 } })
  expect(slots.queue).toEqual([
    expect.objectContaining({ kind: 'sub-agent', name: 'Second', taskId: task.id }),
  ])

  await writeFile(release, '')
  let second = false
  await waitUntil(async () => {
    const current = await getTask(client, task.id)
    second ||= current.runs.some((r) => r.name === 'Second')
    return second && current.runs[0]?.state !== 'working' ? current : undefined
  }, 'the second sub-agent to take the handoff and the Task Lead to end its turn')
  expect((await getTask(client, other.id)).runs[0]?.state).toBe('working')
})

test('an answered Task Lead skips the busy hold but still waits for the working-Run limit', async () => {
  const client = await startWithStub()
  const lead = await startTask(
    client,
    JSON.stringify({
      steps: [
        { everyMessage: [{ hook: 'PreToolUse' }, { waitFor: never() }] },
        { run: ['ted', 'comment', '--choice', 'Continue', 'Question'] },
        { endTurn: true },
      ],
    }),
  )
  const question = await waitUntil(async () => {
    const items = await client.ok<InboxItem[]>('GET', '/inbox')
    return items.find((item) => item.task.id === lead.id)?.request
  }, 'the Task Lead’s question')
  const other = await startTask(client, workingUntil(never()))
  await waitForLead(client, other)
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  ratio = 3

  await client.ok('POST', `/comments/${question.id}/answer`, {
    action: 'answer',
    choice: 'Continue',
  })

  await waitUntil(
    async () => (await slotsOf(client)).busy?.loadRatio === 3 || undefined,
    'the hold, read once the answered Task Lead waits',
  )
  expect((await getTask(client, lead.id)).status).toEqual({
    kind: 'queued',
    place: 1,
  })
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 6 })
  await waitUntil(async () => {
    const current = await getTask(client, lead.id)
    return current.runs[0]?.state === 'working' ? current : undefined
  }, 'the answered Task Lead to work while the computer is still busy')
  expect((await getTask(client, other.id)).runs[0]?.state).toBe('working')
})

test('with the setting off, a busy computer changes nothing', async () => {
  const client = await startWithStub()
  await client.ok('PATCH', '/settings', { waitWhenBusy: false })
  ratio = 5
  memory = 0.01
  const a = await startTask(client, workingUntil(never()))
  const b = await startTask(client, workingUntil(never()))

  expect(a.leadRunId).toBeDefined()
  expect(b.leadRunId).toBeDefined()
  const slots = await slotsOf(client)
  expect(slots.working).toBe(2)
  expect(slots.busy).toBeUndefined()
})

test('turning the setting off starts what the load was holding', async () => {
  const client = await startWithStub(60_000)
  ratio = 3
  await startTask(client, workingUntil(never()))
  const b = await startTask(client, workingUntil(never()))
  expect(b.status).toEqual({ kind: 'queued', place: 1 })

  await client.ok('PATCH', '/settings', { waitWhenBusy: false })

  await waitForLead(client, b)
  expect((await slotsOf(client)).busy).toBeUndefined()
})

test('the limit above is still the most Ted runs when this computer is quiet', async () => {
  const client = await startWithStub()
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  await startTask(client, workingUntil(never()))

  const b = await startTask(client, 'B')

  expect(b.status).toEqual({ kind: 'queued', place: 1 })
  expect((await slotsOf(client)).busy).toBeUndefined()
})

test('waitWhenBusy is on by default and must be true or false, and the working Run default follows memory', async () => {
  const memoryFile = path.join(scratch, 'memory.json')
  await writeFile(memoryFile, JSON.stringify({ totalBytes: 16 * 1024 ** 3, availableBytes: 1 }))
  const fixture = process.env.TED_MEMORY_FILE
  process.env.TED_MEMORY_FILE = memoryFile
  const client = await startWithStub().finally(() => {
    process.env.TED_MEMORY_FILE = fixture
  })
  const settings = await client.ok<{ waitWhenBusy: boolean; maxWorkingRuns: number }>(
    'GET',
    '/settings',
  )
  expect(settings).toMatchObject({ waitWhenBusy: true, maxWorkingRuns: 4 })
  for (const value of ['yes', 1, null]) {
    expect((await client.call('PATCH', '/settings', { waitWhenBusy: value })).status).toBe(400)
  }
})
