import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Comment, Factory, RunSlots, Task, ThreadEvent } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
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

async function startTed(options: { nudgeAfterMs?: number } = {}) {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
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
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return check(current) ? current : undefined
  }, `${task.displayId} ${what}`)

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

const nudge = 'Continue, or post a Comment if you need the human.'

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
    await sleep(300)
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

    await sleep(300)
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
    const client = await startTed({ nudgeAfterMs: 100 })
    const task = await create(
      client,
      steps(
        { say: 'Templates are wired into New Note.' },
        { endTurn: true },
        { everyMessage: [{ say: 'I’ll check the empty template next.' }, { endTurn: true }] },
      ),
      { start: true },
    )
    const asked = await waitUntil(async () => {
      const found = (await comments(client, task)).find((c) => c.kind === 'question')
      return found
    }, 'TED to ask')
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
    await sleep(300)
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
    const client = await startTed({ nudgeAfterMs: 100 })
    const task = await create(
      client,
      steps({ run: ['ted', 'outcome', 'ask', 'Which endpoint?'] }, { endTurn: true }),
      { start: true },
    )
    const idle = await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')

    await sleep(500)

    expect(await userMessages(client, idle.leadRunId ?? '')).toHaveLength(1)
    expect((await comments(client, task)).map((c) => c.author.kind)).toEqual(['run'])
  })
})
