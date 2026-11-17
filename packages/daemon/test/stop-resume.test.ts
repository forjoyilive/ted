import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, Factory, RunSlots, Task, ThreadEvent } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Clock } from '../src/clock.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { nudgeMessage } from '../src/tasks/thread.ts'
import {
  api,
  commitToOrigin,
  hostRecords,
  hostsStarted,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-stop-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const brief = `## Goal

Pin notes to the top.

## Decisions so far

Use the swipe actions.

## Current state

API half done.

## Open questions

None.

## Next step

Finish the API.
`

async function startTed(options: { nudgeAfterMs?: number; clock?: Clock } = {}) {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    ...(options.clock && { clock: options.clock }),
    claudeBin: stubClaudePath,
    nudgeAfterMs: options.nudgeAfterMs ?? 600_000,
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  return { ...client, ok, briefFile }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const create = (client: Client, title: string, extra: Record<string, unknown> = {}) =>
  client.ok<Task>('POST', '/tasks', { title, factory: 'NB', ...extra })

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const waitFor = (client: Client, task: Task, check: (t: Task) => boolean, what: string) =>
  eventWait(
    client.subscribe,
    async () => {
      const current = await getTask(client, task.id)
      return check(current) ? current : undefined
    },
    `${task.displayId} ${what}`,
  )

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const threadEvents = (client: Client, task: Task) =>
  client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)

const promptOf = async (client: Client, runId: string) =>
  ((await client.getRun(runId)).run as { prompt?: string }).prompt ?? ''

const nudge = nudgeMessage

test('a Task interrupted by full quit can resume directly after reopening', async () => {
  const client = await startTed()
  const task = await create(client, steps({ waitFor: '/never' }), { start: true })
  const working = await waitFor(client, task, (t) => t.runs[0]?.state === 'working', 'to work')
  const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(working.leadRunId ?? '')
  expect(
    (await api(daemon?.port ?? 0, token).call('POST', `/tasks/${task.id}/brief`, { text: brief }))
      .status,
  ).toBe(201)
  const worktree = path.join(home, 'worktrees', 'NB-1', 'widgets')
  await writeFile(path.join(worktree, 'unfinished.txt'), 'keep this work')

  await client.ok('POST', '/shutdown')
  await daemon?.stop()
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const reopened = api(daemon.port, { appKey: daemon.appToken })
  const interrupted = ((await reopened.call('GET', '/tasks')).body as Task[]).find(
    (t) => t.id === task.id,
  )
  expect(interrupted).toMatchObject({
    stage: working.stage,
    leadRunId: working.leadRunId,
    runs: [],
    canResume: true,
    commentBox: 'stopped',
    activity: 'The Task Lead has stopped. Resume to carry on.',
  })
  expect(interrupted?.statuses).not.toContain('stopped')
  expect((await reopened.getRun(working.leadRunId ?? '')).run.state).toBe('finished')
  expect((await reopened.call('GET', '/ted-stops')).body).toMatchObject([
    { id: task.id, displayId: 'NB-1', stage: working.stage },
  ])

  const resumed = await reopened.call('POST', `/tasks/${task.id}/resume`, {
    comment: 'Keep the unfinished work.',
  })
  expect(resumed.status).toBe(200)
  await waitUntil(async () => {
    const current = ((await reopened.call('GET', '/tasks')).body as Task[]).find(
      (t) => t.id === task.id,
    )
    return current?.runs[0]?.state === 'working' && current.leadRunId !== working.leadRunId
      ? current
      : undefined
  }, 'a fresh Task Lead to start')
  const latest = ((await reopened.call('GET', '/tasks')).body as Task[]).find(
    (t) => t.id === task.id,
  )
  expect(latest).toMatchObject({ stage: working.stage, commentBox: 'live' })
  expect(latest).not.toHaveProperty('canResume', true)
  expect((await reopened.call('GET', '/ted-stops')).body).toEqual([])
  expect(await stat(path.join(worktree, 'unfinished.txt'))).toBeDefined()
  const prompt = (await reopened.getRun(latest?.leadRunId ?? '')).run as { prompt?: string }
  expect(prompt.prompt).toContain('Pin notes to the top.')
  expect(prompt.prompt).toContain('Keep the unfinished work.')
  expect((await reopened.call('POST', `/tasks/${task.id}/resume`, {})).status).toBe(409)
})

test('interrupted Resume uses the queue and refuses duplicate and Run-token requests', async () => {
  const client = await startTed()
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const task = await create(client, steps({ waitFor: '/never' }), { start: true })
  const working = await waitFor(client, task, (t) => t.runs[0]?.state === 'working', 'to work')
  await client.ok('POST', '/shutdown')
  await daemon?.stop()
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const reopened = api(daemon.port, { appKey: daemon.appToken })
  const second = (
    await reopened.call('POST', '/tasks', {
      factory: 'NB',
      title: steps({ waitFor: '/never' }),
      start: true,
    })
  ).body as Task
  await waitUntil(async () => {
    const tasks = (await reopened.call('GET', '/tasks')).body as Task[]
    return tasks.find((t) => t.id === second.id)?.runs[0]?.state === 'working'
  }, 'the second Task to take the only slot')
  const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(working.leadRunId ?? '')
  expect((await api(daemon.port, token).call('POST', `/tasks/${task.id}/resume`, {})).status).toBe(
    403,
  )
  const attempts = await Promise.all([
    reopened.call('POST', `/tasks/${task.id}/resume`, { comment: 'Carry on once.' }),
    reopened.call('POST', `/tasks/${task.id}/resume`, { comment: 'Carry on once.' }),
  ])
  expect(attempts.map((a) => a.status).sort()).toEqual([200, 409])
  const queued = ((await reopened.call('GET', '/tasks')).body as Task[]).find(
    (t) => t.id === task.id,
  )
  expect(queued).toMatchObject({ status: { kind: 'queued' }, runs: [] })
  expect(queued).not.toHaveProperty('canResume', true)
  const notes = (await reopened.call('GET', `/tasks/${task.id}/comments`)).body as Comment[]
  expect(notes.filter((c) => c.body === 'Carry on once.')).toHaveLength(1)
})

test('an answer or a Comment restarts a Task Lead stopped while it waited, unless the user stopped the Task', async () => {
  const client = await startTed()
  const ask = steps({ run: ['ted', 'outcome', 'ask', 'Which endpoint?'] }, { endTurn: true })
  const task = await create(client, ask, { start: true })
  const byHand = await create(client, ask, { start: true })
  const commented = await create(client, ask, { start: true })
  const asked = await waitFor(client, task, (t) => t.status?.kind === 'waiting-on-you', 'to ask')
  await waitFor(client, byHand, (t) => t.status?.kind === 'waiting-on-you', 'to ask')
  const askedToo = await waitFor(
    client,
    commented,
    (t) => t.status?.kind === 'waiting-on-you',
    'to ask',
  )
  await client.ok('POST', `/tasks/${byHand.id}/stop`)
  await client.ok('POST', '/shutdown')
  const waiting = await getTask(client, task.id)
  expect(waiting).toMatchObject({ status: { kind: 'waiting-on-you' }, runs: [] })
  expect(waiting).not.toHaveProperty('canResume', true)
  expect(await client.ok('GET', '/ted-stops')).toEqual([])
  expect((await client.call('POST', `/tasks/${task.id}/resume`, {})).status).toBe(409)
  expect((await comments(client, task)).find((c) => c.kind === 'question')?.answer).toBeUndefined()

  await daemon?.stop()
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const reopened = api(daemon.port, { appKey: daemon.appToken })
  const tasks = async () => (await reopened.call('GET', '/tasks')).body as Task[]
  const answer = async (id: string, text: string) => {
    const all = (await reopened.call('GET', `/tasks/${id}/comments`)).body as Comment[]
    const question = all.find((c) => c.kind === 'question')
    const res = await reopened.call('POST', `/comments/${question?.id}/answer`, {
      action: 'answer',
      text,
    })
    expect(res.status).toBe(200)
  }
  const post = async (id: string, body: string) => {
    const res = await reopened.call('POST', `/tasks/${id}/comments`, { body })
    expect(res.status).toBe(201)
    return res.body as Comment
  }
  const before = await tasks()
  expect(before.find((t) => t.id === commented.id)).toMatchObject({ wakesOnComment: true })
  expect(before.find((t) => t.id === byHand.id)).not.toHaveProperty('wakesOnComment')
  const stoppedNote = await post(byHand.id, 'Is this still going?')
  expect(stoppedNote.delivered).toBeUndefined()
  await answer(task.id, 'Use /v2/notes.')
  await answer(byHand.id, 'Use /v3/notes.')
  const note = await post(commented.id, 'There is overlap with NB-1; read it first.')

  const restarted = await waitUntil(async () => {
    const current = (await tasks()).find((t) => t.id === task.id)
    return current && current.runs.length > 0 && current.leadRunId !== asked.leadRunId
      ? current
      : undefined
  }, 'a fresh Task Lead after the answer')
  expect(restarted).not.toHaveProperty('canResume', true)
  const run = (await reopened.getRun(restarted.leadRunId ?? '')).run as { prompt?: string }
  expect(run.prompt).toContain('Use /v2/notes.')
  expect((await tasks()).find((t) => t.id === byHand.id)).toMatchObject({
    status: { kind: 'stopped' },
    runs: [],
  })

  const woken = await waitUntil(async () => {
    const current = (await tasks()).find((t) => t.id === commented.id)
    return current && current.runs.length > 0 && current.leadRunId !== askedToo.leadRunId
      ? current
      : undefined
  }, 'a fresh Task Lead after the Comment')
  const wokenRun = (await reopened.getRun(woken.leadRunId ?? '')).run as { prompt?: string }
  expect(wokenRun.prompt).toContain('There is overlap with NB-1; read it first.')
  const after = (await reopened.call('GET', `/tasks/${commented.id}/comments`)).body as Comment[]
  expect(after.find((c) => c.id === note.id)?.delivered?.runId).toBe(woken.leadRunId)
  expect(after.find((c) => c.kind === 'question')?.answer).toBeUndefined()
})

test('after a quit TED offers the Tasks that were working, restarts the chosen ones and leaves the rest', async () => {
  const client = await startTed()
  const restarted = await create(client, steps({ waitFor: '/never' }), { start: true })
  const left = await create(client, steps({ waitFor: '/never' }), { start: true })
  const byHand = await create(client, steps({ waitFor: '/never' }), { start: true })
  const leads = new Map<string, string>()
  for (const task of [restarted, left, byHand]) {
    const working = await waitFor(client, task, (t) => t.runs[0]?.state === 'working', 'to work')
    leads.set(task.id, working.leadRunId ?? '')
  }
  await client.ok('POST', `/tasks/${byHand.id}/stop`)

  const stubHealth = path.join(home, 'stub-claude.json')
  await writeFile(stubHealth, JSON.stringify({ signedIn: false }))
  await client.ok('POST', '/shutdown')
  await daemon?.stop()
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const reopened = api(daemon.port, { appKey: daemon.appToken })
  await writeFile(stubHealth, JSON.stringify({ signedIn: true }))
  expect((await reopened.call('POST', '/agents/health/check')).status).toBeLessThan(300)
  const offered = (await reopened.call('GET', '/ted-stops')).body as {
    id: string
    stoppedAt: string
  }[]
  expect(offered.map((t) => t.id).sort()).toEqual([restarted.id, left.id].sort())
  const held = ((await reopened.call('GET', '/tasks')).body as Task[]).filter(
    (t) => t.runs.length > 0 || t.statuses.includes('paused') || t.statuses.includes('queued'),
  )
  expect(held).toEqual([])

  const token = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(leads.get(left.id) ?? '')
  const answer = { restart: [restarted.id], leave: [left.id, byHand.id] }
  expect((await api(daemon.port, token).call('POST', '/ted-stops/answer', answer)).status).toBe(403)
  const answered = await reopened.call('POST', '/ted-stops/answer', answer)
  expect(answered).toMatchObject({ status: 200, body: [] })

  const tasks = async () => (await reopened.call('GET', '/tasks')).body as Task[]
  await waitUntil(async () => {
    const current = (await tasks()).find((t) => t.id === restarted.id)
    return current?.runs[0]?.state === 'working' && current.leadRunId !== leads.get(restarted.id)
  }, 'a fresh Task Lead for the restarted Task')
  const after = await tasks()
  expect(after.find((t) => t.id === left.id)).toMatchObject({ runs: [], canResume: true })
  expect(after.find((t) => t.id === byHand.id)).toMatchObject({ status: { kind: 'stopped' } })
  expect((await reopened.call('GET', '/ted-stops')).body).toEqual([])

  const lines = async (id: string) =>
    ((await reopened.call('GET', `/tasks/${id}/events`)).body as ThreadEvent[]).map((e) => e.text)
  expect(await lines(left.id)).toEqual(
    expect.arrayContaining(['TED stopped the Task Lead when it quit', 'You left the Task stopped']),
  )
  expect(await lines(restarted.id)).toEqual(
    expect.arrayContaining(['TED stopped the Task Lead when it quit', 'You resumed the Task']),
  )
  expect(await lines(byHand.id)).not.toContain('TED stopped the Task Lead when it quit')
  expect((await reopened.call('POST', `/tasks/${left.id}/resume`, {})).status).toBe(200)
})

test('a working Task Lead ended while the daemon was down is offered at the next start', async () => {
  const client = await startTed()
  const task = await create(client, steps({ waitFor: '/never' }), { start: true })
  const working = await waitFor(client, task, (t) => t.runs[0]?.state === 'working', 'to work')
  const runId = working.leadRunId ?? ''
  await hostsStarted(home)
  await daemon?.stop()
  const start = (await hostRecords(home, runId)).find((r) => r.t === 'start')
  process.kill(Number(start?.hostPid), 'SIGTERM')
  const exit = await waitUntil(
    async () => (await hostRecords(home, runId)).find((r) => r.t === 'exit'),
    'the host to exit',
  )

  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const reopened = api(daemon.port, { appKey: daemon.appToken })
  const offered = await waitUntil(
    async () =>
      ((await reopened.call('GET', '/ted-stops')).body as { id: string; stoppedAt: string }[]).find(
        (t) => t.id === task.id,
      ),
    'the Task to be offered',
  )
  expect(offered.stoppedAt).toBe(exit.at)
  const events = (await reopened.call('GET', `/tasks/${task.id}/events`)).body as ThreadEvent[]
  expect(events.map((e) => e.text)).toContain('The Task Lead was stopped when TED went down')
})

describe('Stop', () => {
  test('stops every Run, frees the slot, keeps the worktree and shows Stopped', async () => {
    const client = await startTed()
    const task = await create(client, steps({ say: 'working on it' }, { waitFor: '/never' }), {
      start: true,
    })
    const working = await waitFor(
      client,
      task,
      (t) => t.runs[0]?.state === 'working',
      'to be working',
    )
    expect((await client.ok<RunSlots>('GET', '/slots')).working).toBe(1)

    const stopped = await client.ok<Task>('POST', `/tasks/${task.id}/stop`)

    expect(stopped).toMatchObject({
      stage: 'intake',
      runs: [],
      status: { kind: 'stopped' },
      commentBox: 'stopped',
      activity: 'Worktree and Apps kept. 1 Run stopped.',
    })
    expect(stopped.statuses).toContain('stopped')
    const run = await client.getRun(working.leadRunId ?? '')
    expect(run.run.state).toBe('finished')
    expect((await client.ok<RunSlots>('GET', '/slots')).working).toBe(0)
    const worktree = path.join(home, 'worktrees', 'NB-1', 'widgets')
    expect((await stat(worktree)).isDirectory()).toBe(true)
    expect((await threadEvents(client, task)).map((e) => e.text)).toContain(
      'You stopped the Task · 1 Run stopped',
    )

    expect((await client.call('POST', `/tasks/${task.id}/stop`)).status).toBe(409)
    expect((await getTask(client, task.id)).status).toMatchObject({ kind: 'stopped' })
  })

  test('a Comment on a Stopped Task waits for the next Run', async () => {
    const client = await startTed()
    const task = await create(client, steps({ endTurn: true }), { start: true })
    await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    await client.ok('POST', `/tasks/${task.id}/stop`)

    const posted = await client.ok<Comment>('POST', `/tasks/${task.id}/comments`, {
      body: 'Use the existing component.',
    })

    expect(posted.delivered).toBeUndefined()
    expect((await getTask(client, task.id)).status?.kind).toBe('stopped')
  })

  test('only a started Task can stop, and Runs can’t stop or resume Tasks', async () => {
    const client = await startTed()
    const backlog = await create(client, 'Not yet')

    const res = await client.call('POST', `/tasks/${backlog.id}/stop`)

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('NB-1 hasn’t started, so there’s nothing to stop')
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = api(daemon?.port ?? 0, runToken)
    expect((await asRun.call('POST', `/tasks/${backlog.id}/stop`)).status).toBe(403)
    expect((await asRun.call('POST', `/tasks/${backlog.id}/resume`)).status).toBe(403)
  })
})

describe('Resume', () => {
  test('starts a fresh Task Lead Run from the brief plus the Comments since', async () => {
    const client = await startTed()
    const task = await create(
      client,
      steps(
        { run: ['ted', 'brief', 'write', '--file', path.join(scratch, 'brief.md')] },
        { run: ['ted', 'comment', 'The API is half done'] },
        { endTurn: true },
      ),
      { start: true },
    )
    const first = await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    await client.ok('POST', `/tasks/${task.id}/stop`)
    await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'Keep the old endpoint.' })

    expect((await client.call('POST', `/tasks/${task.id}/resume`, {})).status).toBe(200)

    const fresh = await waitFor(
      client,
      task,
      (t) => t.leadRunId !== undefined && t.leadRunId !== first.leadRunId && t.runs.length === 1,
      'to get a fresh Run',
    )
    expect(fresh.status?.kind).not.toBe('stopped')
    expect(fresh.stage).toBe('intake')
    const prompt = await promptOf(client, fresh.leadRunId ?? '')
    expect(prompt).toContain('# Picking up after a stop')
    expect(prompt).toContain('## Task brief (version 1)')
    expect(prompt).toContain('API half done.')
    expect(prompt).toContain('The API is half done')
    expect(prompt).toContain('Keep the old endpoint.')
    const posted = (await comments(client, task)).find((c) => c.body === 'Keep the old endpoint.')
    expect(posted?.delivered?.runId).toBe(fresh.leadRunId)
    expect((await threadEvents(client, task)).map((e) => e.text)).toContain('You resumed the Task')
  })

  test('Send and resume posts the Comment and resumes, through the queue', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const task = await create(client, steps({ endTurn: true }), { start: true })
    const first = await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    await client.ok('POST', `/tasks/${task.id}/stop`)
    const gate = path.join(scratch, 'gate')
    const other = await create(client, steps({ waitFor: gate }, { endTurn: true }), {
      start: true,
    })
    await waitFor(client, other, (t) => t.runs[0]?.state === 'working', 'to be working')

    const resumed = await client.ok<Task>('POST', `/tasks/${task.id}/resume`, {
      comment: 'Use the swipe actions.',
    })

    expect(resumed.status).toEqual({ kind: 'queued', place: 1 })
    await writeFile(gate, '')
    const fresh = await waitFor(
      client,
      task,
      (t) => t.leadRunId !== first.leadRunId && t.runs.length === 1,
      'to get a fresh Run',
    )
    expect(await promptOf(client, fresh.leadRunId ?? '')).toContain('Use the swipe actions.')
  })

  test('only a Stopped Task resumes', async () => {
    const client = await startTed()
    const task = await create(client, steps({ endTurn: true }), { start: true })
    await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')

    const res = await client.call('POST', `/tasks/${task.id}/resume`, {})

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('NB-1 isn’t stopped')
  })

  test('removing the last blocker from a Task waiting mid-flow leaves it Stopped until Resume', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const task = await create(
      client,
      steps(
        { run: ['ted', 'task', 'block', '--by', 'NB-1'] },
        { run: ['ted', 'brief', 'write', '--file', path.join(scratch, 'brief.md')] },
        { endTurn: true },
      ),
      { start: true },
    )
    const blocked = await waitFor(
      client,
      task,
      (t) => t.status?.kind === 'blocked',
      'to be Blocked',
    )

    await client.ok('DELETE', `/tasks/${task.id}/blockers/${blocker.displayId}`)

    const after = await getTask(client, task.id)
    expect(after.status?.kind).toBe('stopped')
    expect(after.runs).toEqual([])
    expect(after.leadRunId).toBe(blocked.leadRunId)

    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    await waitFor(
      client,
      task,
      (t) => t.leadRunId !== blocked.leadRunId && t.runs.length === 1,
      'to get a fresh Run',
    )
  })
})

describe('the idle Task Lead', () => {
  test('is nudged once, then TED asks with its last message and Nudge again', async () => {
    const clock = new ManualClock()
    const client = await startTed({ nudgeAfterMs: 100, clock })
    const task = await create(
      client,
      steps(
        { say: 'Templates are wired into New Note.' },
        { endTurn: true },
        { everyMessage: [{ say: 'I’ll check the empty template next.' }, { endTurn: true }] },
      ),
      { start: true },
    )
    await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    await eventWait(
      clock.subscribe,
      () => clock.pending.includes(100),
      'the first nudge timer to arm',
    )
    clock.advance(100)
    await eventWait(
      client.subscribe,
      async () => {
        const current = await getTask(client, task.id)
        const messages = await userMessages(client, current.leadRunId ?? '')
        return current.runs[0]?.state === 'idle' && messages.filter((m) => m === nudge).length === 1
      },
      'the nudged turn to finish',
    )
    await eventWait(
      clock.subscribe,
      () => clock.pending.includes(100),
      'the second nudge timer to arm',
    )
    clock.advance(100)
    const asked = await eventWait(
      client.subscribe,
      async () => {
        const found = (await comments(client, task)).find((c) => c.kind === 'question')
        return found
      },
      'TED to ask',
    )
    const current = await getTask(client, task.id)
    const runId = current.leadRunId ?? ''
    const messages = await userMessages(client, runId)
    expect(messages.filter((m) => m === nudge)).toHaveLength(1)
    expect(asked).toMatchObject({
      author: { kind: 'ted' },
      title: 'The Task Lead stopped without saying why',
      choices: ['Nudge again'],
    })
    expect(asked.body).toContain('It went idle again after the nudge, with nothing open.')
    expect(asked.body).toContain('I’ll check the empty template next.')
    expect(current.status?.kind).toBe('waiting-on-you')
    expect((await threadEvents(client, task)).map((e) => e.text)).toContain(
      `TED nudged the Task Lead: “${nudge}”`,
    )
    clock.advance(300)
    expect((await comments(client, task)).filter((c) => c.kind === 'question')).toHaveLength(1)

    await client.ok('POST', `/comments/${asked.id}/answer`, {
      action: 'answer',
      choice: 'Nudge again',
    })

    await waitUntil(
      async () => (await userMessages(client, runId)).filter((m) => m === nudge).length === 2,
      'a second nudge',
    )
  })

  test('isn’t nudged while it waits on the human', async () => {
    const clock = new ManualClock()
    const client = await startTed({ nudgeAfterMs: 100, clock })
    const task = await create(
      client,
      steps({ run: ['ted', 'outcome', 'ask', 'Which endpoint?'] }, { endTurn: true }),
      { start: true },
    )
    const idle = await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')

    await eventWait(
      clock.subscribe,
      () => clock.pending.includes(100),
      'the idle timer to arm while waiting on the human',
    )
    clock.advance(500)

    expect(await userMessages(client, idle.leadRunId ?? '')).toHaveLength(1)
    expect((await comments(client, task)).map((c) => c.author.kind)).toEqual(['run'])
  })

  test('isn’t nudged while its sub-agent works, and is once the sub-agent stops working', async () => {
    const clock = new ManualClock()
    const client = await startTed({ nudgeAfterMs: 100, clock })
    const release = path.join(scratch, 'release-sub-agent')
    const prompt = path.join(scratch, 'sub-agent.md')
    await writeFile(prompt, `${steps({ waitFor: release }, { say: 'done' }, { endTurn: true })}\n`)
    const task = await create(
      client,
      steps({ run: ['sh', '-c', `ted run start --prompt-file ${prompt}`] }, { endTurn: true }),
      { start: true },
    )
    const idle = await waitFor(
      client,
      task,
      (t) => t.runs[0]?.state === 'idle' && t.runs.length === 2,
      'the Lead to go idle beside its sub-agent',
    )
    const leadRunId = idle.leadRunId ?? ''
    for (let i = 0; i < 3; i++) {
      await eventWait(clock.subscribe, () => clock.pending.includes(100), 'the idle timer to arm')
      clock.advance(100)
    }
    expect((await userMessages(client, leadRunId)).filter((m) => m === nudge)).toHaveLength(0)

    await writeFile(release, '')
    await waitUntil(async () => {
      const runs = await client.ok<{ role: string; state: string }[]>(
        'GET',
        `/tasks/${task.id}/runs`,
      )
      return runs.find((r) => r.role === 'sub-agent')?.state === 'idle' ? true : undefined
    }, 'the sub-agent to stop working')
    await eventWait(
      client.subscribe,
      async () => {
        if (clock.pending.includes(100)) clock.advance(100)
        return (await userMessages(client, leadRunId)).includes(nudge)
      },
      'the nudge after the sub-agent stops working',
    )
  })
})
