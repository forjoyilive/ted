import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Activity,
  CheckRun,
  CheckTry,
  Factory,
  FactorySettingsView,
  RunSlots,
  Task,
  UpdateWork,
} from '@ted/protocol'
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-check-cap-'))
  origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, validate]',
      'stages:',
      '  validate:',
      '    checks:',
      '      - { name: Wait, run: "touch stub-started; while [ ! -e stub-go ]; do sleep 0.1; done" }',
      '',
    ].join('\n'),
  })
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home, { waitForStart: true })
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

function connect() {
  if (!daemon) throw new Error('daemon not started')
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

async function startTed(maxChecksAtOnce?: number) {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = connect()
  const { ok } = client
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  if (maxChecksAtOnce !== undefined) await ok('PATCH', '/settings', { maxChecksAtOnce })
  return { ...client, ok, factory }
}

type Client = Awaited<ReturnType<typeof startTed>>

const advance = { run: ['ted', 'outcome', 'advance'] }
const title = JSON.stringify({
  steps: [{ everyMessage: [{ run: ['sh', '-c', 'echo x > work.txt'] }, advance] }, advance],
})

async function startTask(client: Client): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const checkRun = async (client: Client, task: Task) =>
  (await client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)).at(-1)

const checkState = async (client: Client, task: Task) =>
  (await checkRun(client, task))?.checks[0]?.state

const inWorktree = async (client: Client, task: Task, name: string) =>
  path.join((await getTask(client, task.id))?.repos[0]?.worktree ?? '', name)

const go = async (client: Client, task: Task) =>
  writeFile(await inWorktree(client, task, 'stub-go'), '')

const started = async (client: Client, task: Task) =>
  stat(await inWorktree(client, task, 'stub-started')).then(
    () => true,
    () => false,
  )

const running = (client: Client, task: Task) =>
  waitUntil(
    async () => (await checkState(client, task)) === 'running' || undefined,
    `${task.displayId}’s Check to run`,
    20_000,
  )

const waitingAt = (client: Client, task: Task, place: string) =>
  waitUntil(
    async () =>
      (await getTask(client, task.id))?.activity === `Waiting to run Checks · ${place}` ||
      undefined,
    `${task.displayId} to wait ${place} for its Checks`,
    20_000,
  )

const finished = (client: Client, task: Task) =>
  waitUntil(
    async () => {
      const run = await checkRun(client, task)
      return run?.finishedAt === undefined ? undefined : run
    },
    `${task.displayId}’s Check run to finish`,
    20_000,
  )

describe('Checks running at once', () => {
  test('with the limit at 1, a second Task waits for its Checks, says so, and runs them after the first', async () => {
    const client = await startTed(1)
    const first = await startTask(client)
    await running(client, first)
    const reset = await client.call('POST', `/tasks/${first.id}/reset`)
    expect(reset.status).toBe(409)
    expect(JSON.stringify(reset.body)).toContain('Checks are running')
    const second = await startTask(client)
    await waitingAt(client, second, '1st')

    const waiting = await checkRun(client, second)
    expect(waiting).toMatchObject({ waiting: true, checks: [{ name: 'Wait', state: 'waiting' }] })
    expect(waiting?.finishedAt).toBeUndefined()
    expect(waiting?.timing?.queue).toMatchObject({ status: 'ongoing' })
    expect((await checkRun(client, first))?.timing?.queue).toMatchObject({
      status: 'complete',
      durationMs: 0,
    })
    expect((await checkRun(client, first))?.waiting).toBeUndefined()
    expect((await getTask(client, second.id))?.status).toEqual({ kind: 'working' })
    expect(await started(client, second)).toBe(false)
    expect(await client.ok<Activity>('GET', '/activity')).toMatchObject({
      checksRunning: 1,
      checksWaiting: 1,
    })
    expect((await client.ok<UpdateWork>('GET', '/update/work')).checks).toBe(2)
    expect((await client.ok<RunSlots>('GET', '/slots')).checks).toMatchObject({
      running: 1,
      waiting: 1,
      tasks: [
        { taskId: first.id, displayId: first.displayId },
        { taskId: second.id, displayId: second.displayId, place: 1 },
      ],
    })

    await go(client, first)
    expect((await finished(client, first)).outcome).toBe('passed')
    await running(client, second)
    expect((await checkRun(client, second))?.waiting).toBeUndefined()
    expect((await getTask(client, second.id))?.activity).toBe('Running Checks · Wait (1 of 1)')
    await expect
      .poll(() => client.ok<Activity>('GET', '/activity'))
      .toMatchObject({ checksRunning: 1, checksWaiting: 0 })
    expect((await client.ok<RunSlots>('GET', '/slots')).checks).toMatchObject({
      running: 1,
      waiting: 0,
      tasks: [{ taskId: second.id }],
    })
    await go(client, second)
    const measured = await finished(client, second)
    expect(measured.outcome).toBe('passed')
    expect(measured.timing?.queue).toMatchObject({
      status: 'complete',
      durationMs: expect.any(Number),
    })
    if (measured.timing?.queue.status === 'complete')
      expect(measured.timing.queue.durationMs).toBeGreaterThan(0)
    expect(measured.timing?.execution).toMatchObject([
      { position: 0, status: 'complete', durationMs: measured.checks[0]?.durationMs },
    ])
  })

  test('raising the limit starts a waiting Check run at once, and lowering it stops nothing', async () => {
    const client = await startTed(1)
    const first = await startTask(client)
    await running(client, first)
    const second = await startTask(client)
    await waitingAt(client, second, '1st')

    await client.ok('PATCH', '/settings', { maxChecksAtOnce: 2 })
    await running(client, second)
    expect(await checkState(client, first)).toBe('running')

    await client.ok('PATCH', '/settings', { maxChecksAtOnce: 1 })
    expect(await checkState(client, first)).toBe('running')
    expect(await checkState(client, second)).toBe('running')
    await go(client, first)
    await go(client, second)
    expect((await finished(client, first)).outcome).toBe('passed')
    expect((await finished(client, second)).outcome).toBe('passed')
  })

  test('stopping a waiting Task takes it out of the line, and the next one runs', async () => {
    const client = await startTed(1)
    const first = await startTask(client)
    await running(client, first)
    const second = await startTask(client)
    await waitingAt(client, second, '1st')
    const third = await startTask(client)
    await waitingAt(client, third, '2nd')

    await client.ok('POST', `/tasks/${second.id}/stop`)
    const canceled = await finished(client, second)
    expect(canceled.outcome).toBe('interrupted')
    expect(canceled.timing?.queue).toMatchObject({ status: 'canceled' })
    expect(canceled.timing?.execution).toEqual([{ position: 0, status: 'unavailable' }])
    await waitingAt(client, third, '1st')
    expect(await client.ok<Activity>('GET', '/activity')).toMatchObject({
      checksRunning: 1,
      checksWaiting: 1,
    })

    await go(client, first)
    await running(client, third)
    expect(await started(client, second)).toBe(false)
    await go(client, third)
    expect((await finished(client, third)).outcome).toBe('passed')
  })

  test('archiving a waiting Task takes it out of the line too', async () => {
    const client = await startTed(1)
    const first = await startTask(client)
    await running(client, first)
    const second = await startTask(client)
    await waitingAt(client, second, '1st')

    await client.ok('POST', `/tasks/${second.id}/archive`)
    const canceled = await finished(client, second)
    expect(canceled.outcome).toBe('interrupted')
    expect(canceled.timing?.queue).toMatchObject({ status: 'canceled' })
    expect(canceled.timing?.execution).toEqual([{ position: 0, status: 'unavailable' }])
    await waitUntil(
      async () => (await client.ok<Activity>('GET', '/activity')).checksWaiting === 0 || undefined,
      'nothing to wait for Checks',
    )
    expect(await checkState(client, first)).toBe('running')
    await go(client, first)
    expect((await finished(client, first)).outcome).toBe('passed')
  })

  test('deleting a waiting Task cancels admission without starting its commands', async () => {
    const client = await startTed(1)
    const first = await startTask(client)
    await running(client, first)
    const second = await startTask(client)
    await waitingAt(client, second, '1st')
    await client.ok('POST', `/tasks/${second.id}/delete`)
    expect(await client.ok<Activity>('GET', '/activity')).toMatchObject({
      checksWaiting: 0,
      checksRunning: 1,
    })
    await go(client, first)
    expect((await finished(client, first)).outcome).toBe('passed')
  })

  test('restart preserves the observed wait interruption and starts a separate Check run', async () => {
    let client = await startTed(1)
    const first = await startTask(client)
    await running(client, first)
    const second = await startTask(client)
    await waitingAt(client, second, '1st')
    const old = await checkRun(client, second)
    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    client = { ...connect(), factory: client.factory }
    const history = await client.ok<CheckRun[]>('GET', `/tasks/${second.id}/check-runs`)
    const interrupted = history.find((r) => r.id === old?.id)
    expect(interrupted).toMatchObject({
      outcome: 'interrupted',
      timing: { queue: { status: 'interrupted', endedAt: expect.any(String) } },
    })
    expect(interrupted?.timing?.execution).toEqual([{ position: 0, status: 'unavailable' }])
    await go(client, first)
    await running(client, second)
    expect((await checkRun(client, second))?.id).not.toBe(old?.id)
    await go(client, second)
    expect((await finished(client, second)).outcome).toBe('passed')
  })

  test('Run now in Factory settings waits for a place and says so', async () => {
    const client = await startTed(1)
    const task = await startTask(client)
    await running(client, task)

    const tries = async () =>
      (await client.ok<FactorySettingsView>('GET', `/factories/${client.factory.id}/settings`))
        .tries
    const tried = await client.ok<CheckTry>('POST', `/factories/${client.factory.id}/checks/try`, {
      name: 'Probe',
      run: 'echo tried',
    })
    expect(tried).toMatchObject({ state: 'running', waiting: true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await tries()).toMatchObject([{ name: 'Probe', state: 'running', waiting: true }])

    await go(client, task)
    const done = await waitUntil(
      async () => (await tries()).find((t) => t.state !== 'running'),
      'the tried Check to finish',
      20_000,
    )
    expect(done.state).toBe('passed')
    expect(done.waiting).toBeUndefined()
  })

  test('the limit is a whole number from 1 to 16 and starts at 2', async () => {
    const client = await startTed()
    const settings = () => client.ok<{ maxChecksAtOnce: number }>('GET', '/settings')
    expect((await settings()).maxChecksAtOnce).toBe(2)
    for (const maxChecksAtOnce of [0, 17, 1.5, '2', null]) {
      const refused = await client.call('PATCH', '/settings', { maxChecksAtOnce })
      expect(refused.status).toBe(400)
      expect(refused.body).toEqual({
        error: 'maxChecksAtOnce must be a whole number from 1 to 16',
      })
    }
    await client.ok('PATCH', '/settings', { maxChecksAtOnce: 16 })
    expect((await settings()).maxChecksAtOnce).toBe(16)
    await client.ok('PATCH', '/settings', { maxChecksAtOnce: 1 })
    expect((await settings()).maxChecksAtOnce).toBe(1)
  })
})
