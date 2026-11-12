import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Activity,
  type Comment,
  DaemonClient,
  type DaemonEvent,
  type Factory,
  type InboxItem,
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
import { ManualClock } from './support/manual-clock.ts'

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

async function startWithStub(options: { clock?: ManualClock; nudgeAfterMs?: number } = {}) {
  daemon = await startDaemon({ ...options, home, version: '9.9.9', claudeBin: stubClaudePath })
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
  test('slot holders follow edits and stops after the slot list has been read', async () => {
    const client = await startWithStub()
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 0 })
    const task = await startTask(client, workingUntil(path.join(scratch, 'never')))
    await waitForRunState(client, task, 'working')
    expect((await client.ok<RunSlots>('GET', '/slots')).holders).toMatchObject([
      { taskId: task.id, title: task.title },
    ])
    await client.ok('PUT', `/tasks/${task.id}`, { title: 'Keep notebook choices close' })
    expect((await client.ok<RunSlots>('GET', '/slots')).holders).toMatchObject([
      { taskId: task.id, title: 'Keep notebook choices close' },
    ])
    await client.ok('POST', `/tasks/${task.id}/stop`)
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 0, holders: [] })
  })

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
    await expect
      .poll(() => client.ok<Activity>('GET', '/activity'))
      .toMatchObject({ runs: { active: 1, queued: 2 } })
    expect(slots.holders.map((h) => (h.kind === 'task' ? h.displayId : h.name))).toEqual(['NB-1'])
    expect(slots.queue.map((q) => [q.place, 'displayId' in q ? q.displayId : q.name])).toEqual([
      [1, 'NB-2'],
      [2, 'NB-3'],
    ])

    await writeFile(free, '')
    const started = await waitForLead(client, b)
    expect(started.branch).toMatch(/^ted\/nb-2/)
    expect((await getTask(client, c.id)).status).toEqual({ kind: 'queued', place: 1 })
    await expect
      .poll(() => client.ok<Activity>('GET', '/activity'))
      .toMatchObject({ runs: { active: 2, queued: 1 } })
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

  test('permission waits release their slot and permission continuations are not held back', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const a = await startTask(
      client,
      `${steps({ permission: { tool: 'Bash', input: { command: 'echo allowed' } } }, { hook: 'PreToolUse' }, { waitFor: path.join(scratch, 'never') })}`,
    )
    await waitForRunState(client, a, 'waiting')
    expect(await client.ok<Activity>('GET', '/activity')).toMatchObject({
      runs: { working: 0, active: 1, queued: 0 },
    })

    const b = await startTask(client, `${workingUntil(path.join(scratch, 'never'))}`)
    expect(b.leadRunId).toBeDefined()
    const c = await startTask(client, 'C')
    expect(c.status).toEqual({ kind: 'queued', place: 1 })

    const permission = (await client.ok<InboxItem[]>('GET', '/inbox')).find(
      (item) => item.task.id === a.id && item.request.kind === 'permission',
    )?.request
    if (!permission) throw new Error('missing permission request')
    await client.ok('POST', `/comments/${permission.id}/answer`, { action: 'approve' })
    await waitForRunState(client, a, 'working')
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots).toMatchObject({ limit: 1, working: 2, queued: 1 })
    await expect
      .poll(() => client.ok<Activity>('GET', '/activity'))
      .toMatchObject({ runs: { working: 2, active: 2, queued: 1 } })
    expect((await getTask(client, c.id)).status?.kind).toBe('queued')
  })

  test('answered questions and sign-offs wait within both limits and precede new starts after restart', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\nstages:\n  intake:\n    gate: true\n',
    })
    const clock = new ManualClock()
    let client = await startWithStub({ clock, nudgeAfterMs: 1000 })
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const never = path.join(scratch, 'never')
    const briefFile = path.join(scratch, 'brief.md')
    await writeFile(
      briefFile,
      '## Goal\n\nContinue the Task after sign-off.\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nReady for sign-off.\n\n## Open questions\n\nNone.\n\n## Next step\n\nContinue.\n',
    )
    const afterAnswer = [{ hook: 'PreToolUse' }, { waitFor: never }]
    const low = await startTask(
      client,
      steps(
        { everyMessage: afterAnswer },
        { run: ['ted', 'comment', '--choice', 'Continue', 'Question'] },
        { endTurn: true },
      ),
      'low',
    )
    await waitForRunState(client, low, 'idle')
    const high = await startTask(
      client,
      steps(
        { everyMessage: afterAnswer },
        { run: ['ted', 'brief', 'write', '--file', briefFile] },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ),
      'high',
    )
    await waitForRunState(client, high, 'idle')
    const { question, signoff } = await waitUntil(async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      const question = items.find(
        (item) => item.task.id === low.id && item.request.choices?.includes('Continue'),
      )?.request
      const signoff = items.find((item) => item.task.id === high.id && item.request.gate)?.request
      return question && signoff ? { question, signoff } : undefined
    }, 'the question and sign-off requests')
    await client.ok('PUT', `/tasks/${low.id}/lead`, { agent: 'claude', model: 'unavailable' })
    const lowWithLead = await waitForLead(client, low)
    if (!lowWithLead.leadRunId) throw new Error('missing low Task Lead')
    const lowRunId = lowWithLead.leadRunId
    await expect
      .poll(async () => (await client.getRun(lowRunId)).run)
      .toMatchObject({ model: 'unavailable', state: 'idle' })
    await client.ok('POST', `/runs/${lowRunId}/messages`, { text: 'Try the selected model.' })
    await waitForRunState(client, low, 'waiting')
    const blocker = await startTask(client, workingUntil(never))
    await waitForRunState(client, blocker, 'working')
    const fresh = await startTask(client, 'Fresh urgent Task', 'urgent')
    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      choice: 'Continue',
    })
    await client.ok('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
    await client.ok('PUT', `/tasks/${low.id}/lead`, { agent: 'claude', model: 'sonnet' })
    const remaining = (await client.ok<InboxItem[]>('GET', '/inbox')).map((item) => item.request.id)
    expect(remaining).not.toContain(question.id)
    expect(remaining).not.toContain(signoff.id)
    const queuedIds = async () =>
      (await client.ok<RunSlots>('GET', '/slots')).queue.flatMap((entry) =>
        'taskId' in entry ? [entry.taskId] : [],
      )
    await expect.poll(queuedIds).toEqual([high.id, low.id, fresh.id])
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 1, queued: 3 })
    expect((await getTask(client, high.id)).stage).toBe('clarify')
    expect((await getTask(client, high.id)).status).toEqual({ kind: 'queued', place: 1 })
    await expect
      .poll(() => client.ok<Activity>('GET', '/activity'))
      .toMatchObject({ runs: { working: 1, queued: 3 } })

    clock.advance(1001)
    expect(await queuedIds()).toEqual([high.id, low.id, fresh.id])
    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    const restarted = api(daemon.port, { appKey: daemon.appToken })
    client = {
      ...client,
      ...restarted,
      ok: async <T>(method: string, route: string, body?: unknown): Promise<T> => {
        const res = await restarted.call(method, route, body)
        if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
        return res.body as T
      },
    }
    await expect.poll(queuedIds).toEqual([high.id, low.id, fresh.id])
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 6 })
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 1, queued: 3 })
    await client.ok('POST', `/tasks/${blocker.id}/stop`)
    await waitForRunState(client, high, 'working')
    expect(await queuedIds()).toEqual([low.id, fresh.id])
    await client.ok('POST', `/tasks/${high.id}/stop`)
    await waitForRunState(client, low, 'working')
    expect(await queuedIds()).toEqual([fresh.id])
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 1 })
  })

  test('each answered Clarify round releases capacity and queues again', async () => {
    const round = path.join(scratch, 'round.json')
    await writeFile(
      round,
      JSON.stringify({
        title: 'Choose',
        questions: [{ question: 'Continue?', recommended: 'Yes' }],
      }),
    )
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const again = path.join(scratch, 'ask-again')
    const lead = await startTask(
      client,
      steps(
        {
          everyMessage: [
            {
              everyMessage: [
                { hook: 'PreToolUse' },
                { waitFor: again },
                { run: ['ted', 'ask', '--round', round] },
                { endTurn: true },
              ],
            },
            { run: ['ted', 'clarify', 'depth', 'grilling', 'Several choices'] },
            { run: ['ted', 'ask', '--round', round] },
            { endTurn: true },
          ],
        },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ),
    )
    await waitForRunState(client, lead, 'idle')
    const openRound = () =>
      waitUntil(
        async () =>
          (await client.ok<Comment[]>('GET', `/tasks/${lead.id}/comments`)).find(
            (comment) => comment.kind === 'round' && !comment.answer,
          ),
        'an open round',
      )
    const first = await openRound()
    await waitForRunState(client, lead, 'idle')
    const blocker = await startTask(client, workingUntil(path.join(scratch, 'never')))
    await waitForRunState(client, blocker, 'working')
    await client.ok('POST', `/comments/${first.id}/answer`, { action: 'accept-recommended' })
    await expect.poll(async () => (await getTask(client, lead.id)).status?.kind).toBe('queued')
    await client.ok('POST', `/tasks/${blocker.id}/stop`)
    await waitForRunState(client, lead, 'working')
    const fresh = await startTask(client, workingUntil(path.join(scratch, 'never')))
    await writeFile(again, '')
    await waitForRunState(client, lead, 'idle')
    await waitForRunState(client, fresh, 'working')
    const second = await openRound()
    expect(second.id).not.toBe(first.id)
    await client.ok('POST', `/comments/${second.id}/answer`, { action: 'accept-recommended' })
    await expect.poll(async () => (await getTask(client, lead.id)).status?.kind).toBe('queued')
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 1, queued: 1 })
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

  test.each(['machine', 'Factory'] as const)(
    'a Task running worktree setup holds its slot under the %s limit',
    async (limit) => {
      const go = path.join(scratch, 'go')
      await commitToOrigin(scratch, {
        '.ted/workflow.yaml': `version: 1\n${limit === 'Factory' ? 'max_working_runs: 1\n' : ''}repos:\n  - name: widgets\n    worktree:\n      setup: "while [ ! -e '${go}' ]; do sleep 0.05; done"\n`,
      })
      const client = await startWithStub()
      await client.ok('PATCH', '/settings', { maxWorkingRuns: limit === 'machine' ? 1 : 6 })
      const a = await startTask(client, `${steps({ endTurn: true })}`)
      const b = await startTask(client, 'B')

      expect(a.leadRunId).toBeUndefined()
      expect(b.status).toEqual({ kind: 'queued', place: 1 })
      const slots = await client.ok<RunSlots>('GET', '/slots')
      expect(slots).toMatchObject({ working: 1, queued: 1 })
      await expect
        .poll(() => client.ok<Activity>('GET', '/activity'))
        .toMatchObject({ runs: { active: 0, queued: 1 }, startingWork: 1 })
      if (limit === 'Factory') {
        expect(slots.factories).toEqual([expect.objectContaining({ cap: 1, working: 1 })])
      }
      expect(slots.holders).toEqual([
        expect.objectContaining({ displayId: 'NB-1', settingUp: true }),
      ])

      await writeFile(go, '')
      await waitForLead(client, b)
    },
  )

  test('standalone development Runs neither hold a slot nor wait for one', async () => {
    const client = await startWithStub()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const never = path.join(scratch, 'never')
    const first = await client.startRun([{ waitFor: never }], scratch)
    await waitUntil(
      async () => (await client.getRun(first.id)).run.state === 'working',
      'the first development Run to work',
    )
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 0, queued: 0 })

    const task = await startTask(client, workingUntil(never))
    expect(task.leadRunId).toBeDefined()
    const queued = await startTask(client, 'Queued')
    expect(queued.status).toEqual({ kind: 'queued', place: 1 })

    const second = await client.startRun([{ waitFor: never }], scratch)
    await waitUntil(
      async () => (await client.getRun(second.id)).run.state === 'working',
      'the second development Run to work while the limit is full',
    )
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots).toMatchObject({ limit: 1, working: 1, queued: 1 })
    expect(slots.holders).toEqual([expect.objectContaining({ taskId: task.id })])
    expect((await getTask(client, queued.id)).status).toEqual({ kind: 'queued', place: 1 })
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
