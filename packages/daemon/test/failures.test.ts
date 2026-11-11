import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Activity,
  Comment,
  Factory,
  InboxItem,
  RunSlots,
  Task,
  ThreadEvent,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Clock } from '../src/clock.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  hostRecords,
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-failures-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed(options: { stallAfterMs?: number; clock?: Clock } = {}) {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    ...(options.clock && { clock: options.clock }),
    claudeBin: stubClaudePath,
    nudgeAfterMs: 600_000,
    ...(options.stallAfterMs !== undefined && { stallAfterMs: options.stallAfterMs }),
  })
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

const startTask = async (client: Client, title: string) => {
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB', start: true })
  return waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
}

const worktree = () => path.join(home, 'worktrees', 'NB-1', 'widgets')

async function agentStarts(): Promise<{ argv: string[]; pid: number }[]> {
  const text = await readFile(path.join(worktree(), 'stub-starts.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
}

async function killAgent(): Promise<number> {
  const starts = await agentStarts()
  const last = starts.at(-1)
  if (!last) throw new Error('no agent started')
  process.kill(last.pid, 'SIGKILL')
  return starts.length
}

const startsAfter = (count: number) =>
  waitUntil(async () => {
    const starts = await agentStarts()
    return starts.length > count ? starts : undefined
  }, 'the agent to start again')

const threadEvents = (client: Client, task: Task) =>
  client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const promptOf = async (client: Client, runId: string) =>
  ((await client.getRun(runId)).run as { prompt?: string }).prompt ?? ''

describe('a Task Lead that dies', () => {
  test('is resumed in the same session and stays the same Run', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    const runId = task.leadRunId ?? ''
    const sessionId = (await client.getRun(runId)).run.sessionId

    const count = await killAgent()

    const starts = await startsAfter(count)
    const resumed = starts.at(-1)?.argv ?? []
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(sessionId)
    const after = await waitFor(client, task, (t) => t.runs.length === 1, 'to have a live Run')
    expect(after.leadRunId).toBe(runId)
    expect(after.runs[0]?.id).toBe(runId)
    expect(after.status?.kind).not.toBe('failed')
    expect((await threadEvents(client, task)).map((e) => e.text)).toContain(
      'Task Lead Run was killed (SIGKILL) · resuming the session',
    )
  })
})

describe('resuming takes a working slot', () => {
  test.each(['resume', 'stop'] as const)(
    'a dead Task Lead counts once while awaiting a slot, then %s clears the queue',
    async (action) => {
      const client = await startTed()
      await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
      const task = await startTask(client, steps({ endTurn: true }))
      const gate = path.join(scratch, 'gate')
      const other = await client.ok<Task>('POST', '/tasks', {
        title: steps({ waitFor: gate }, { endTurn: true }),
        factory: 'NB',
        start: true,
      })
      await waitFor(client, other, (t) => t.runs[0]?.state === 'working', 'to be working')

      const count = await killAgent()

      await waitUntil(
        async () =>
          (await threadEvents(client, task)).some((e) => e.text.endsWith('resuming the session')),
        'the failure to be recorded',
      )
      const slots = await client.ok<RunSlots>('GET', '/slots')
      expect(slots.working).toBe(1)
      expect(slots.holders).toEqual([expect.objectContaining({ kind: 'task', taskId: other.id })])
      expect(await agentStarts()).toHaveLength(count)
      expect((await getTask(client, task.id)).runs).toEqual([])
      await expect
        .poll(async () => (await client.ok<Activity>('GET', '/activity')).runs)
        .toEqual({ active: 1, working: 1, queued: 1 })

      if (action === 'stop') {
        await client.ok('POST', `/tasks/${task.id}/stop`)
        await expect
          .poll(async () => (await client.ok<Activity>('GET', '/activity')).runs)
          .toEqual({ active: 1, working: 1, queued: 0 })
        await writeFile(gate, '')
        await waitFor(client, other, (t) => t.runs[0]?.state === 'idle', 'to go idle')
        expect(await agentStarts()).toHaveLength(count)
        expect((await getTask(client, task.id)).status?.kind).toBe('stopped')
        return
      }
      await writeFile(gate, '')
      await startsAfter(count)
      const after = await waitFor(client, task, (t) => t.runs.length === 1, 'to run again')
      expect(after.leadRunId).toBe(task.leadRunId)
      await expect
        .poll(async () => (await client.ok<Activity>('GET', '/activity')).runs)
        .toEqual({ active: 2, working: 0, queued: 0 })
    },
  )
})

describe('an edit while the Task Lead is dead', () => {
  test('reaches the resumed session', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const task = await startTask(client, steps({ endTurn: true }))
    const gate = path.join(scratch, 'gate')
    const other = await client.ok<Task>('POST', '/tasks', {
      title: steps({ waitFor: gate }, { endTurn: true }),
      factory: 'NB',
      start: true,
    })
    await waitFor(client, other, (t) => t.runs[0]?.state === 'working', 'to be working')
    const count = await killAgent()
    await waitUntil(
      async () =>
        (await threadEvents(client, task)).some((e) => e.text.endsWith('resuming the session')),
      'the failure to be recorded',
    )

    await client.ok('PUT', `/tasks/${task.id}`, { description: 'Search bodies too.' })
    await writeFile(gate, '')
    await startsAfter(count)

    const runId = task.leadRunId ?? ''
    await waitUntil(
      async () =>
        (await client.getRun(runId)).conversation.some((e) =>
          e.line.includes('Search bodies too.'),
        ),
      'the edit to reach the resumed session',
    )
  })
})

describe('when TED can’t resume', () => {
  test('a failed resume starts a fresh Run from the brief, shown as a new Run', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'Keep the old endpoint.' })
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))

    await killAgent()

    const fresh = await waitFor(
      client,
      task,
      (t) => t.leadRunId !== task.leadRunId && t.runs.length === 1,
      'to get a fresh Run',
    )
    expect(fresh.status?.kind).not.toBe('failed')
    const prompt = await promptOf(client, fresh.leadRunId ?? '')
    expect(prompt).toContain('# Picking up after a crash')
    expect(prompt).toContain('couldn’t resume its session')
    expect(prompt).toContain('Keep the old endpoint.')
    const old = await client.getRun(task.leadRunId ?? '')
    expect(old.run.state).toBe('finished')
    expect((await threadEvents(client, task)).map((e) => e.text)).toEqual(
      expect.arrayContaining([
        'Task Lead Run was killed (SIGKILL) · resuming the session',
        'Resume failed · started a fresh Task Lead Run from the brief',
      ]),
    )
  })

  test('a resume that fails after a daemon restart still gets a fresh Run', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    const gate = path.join(scratch, 'resume-gate')
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeFails: true, resumeWaitsFor: gate }),
    )

    const count = await killAgent()
    await startsAfter(count)
    const exits = (await hostRecords(home, task.leadRunId ?? '')).filter(
      (r) => r.t === 'exit',
    ).length
    await daemon?.stop()
    await writeFile(gate, '')
    await waitUntil(
      async () =>
        (await hostRecords(home, task.leadRunId ?? '')).filter((r) => r.t === 'exit').length >
        exits,
      'the detached resume attempt to exit while the daemon is stopped',
    )

    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      nudgeAfterMs: 600_000,
    })
    const restarted = { ...client, ...api(daemon.port, { appKey: daemon.appToken }) }
    const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const res = await restarted.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body as T
    }
    const fresh = await waitFor(
      { ...restarted, ok },
      task,
      (t) => t.status?.kind === 'failed' || (t.leadRunId !== task.leadRunId && t.runs.length === 1),
      'to get a fresh Run',
    )
    expect(fresh.status?.kind).not.toBe('failed')
    expect(fresh.leadRunId).not.toBe(task.leadRunId)
  })
})

describe('Failed', () => {
  test('a second failure within 30 minutes marks the Task Failed and posts the FAILED ask', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    const runId = task.leadRunId ?? ''

    const failed = await failTwice(client, task)

    expect(failed).toMatchObject({
      runs: [],
      commentBox: 'failed',
      activity: 'Waiting on you to retry',
      leadRunId: runId,
    })
    const ask = (await comments(client, task)).find((c) => c.failed !== undefined)
    expect(ask).toMatchObject({
      kind: 'question',
      author: { kind: 'ted' },
      title: 'The Task Lead stopped twice in 30 minutes',
      choices: ['Retry'],
      failed: { runId },
    })
    expect(ask?.body).toContain('TED resumed the session')
    expect(ask?.body).toContain('claude was killed (SIGKILL)')
    const inbox = await client.ok<InboxItem[]>('GET', '/inbox')
    expect(inbox.map((i) => i.request.id)).toContain(ask?.id)
    expect((await threadEvents(client, task)).map((e) => e.text)).toContain(
      'Task Lead Run was killed (SIGKILL) · Task marked Failed',
    )
  })

  test('Send on the FAILED ask stores a Comment and keeps the ask; Retry starts a fresh Run', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    await failTwice(client, task)
    const ask = (await comments(client, task)).find((c) => c.failed !== undefined)

    const sent = await client.ok<Comment>('POST', `/comments/${ask?.id}/answer`, {
      action: 'answer',
      text: 'Free some disk space first.',
    })

    expect(sent.answer).toBeUndefined()
    expect((await getTask(client, task.id)).status?.kind).toBe('failed')

    const retried = await client.ok<Comment>('POST', `/comments/${ask?.id}/answer`, {
      action: 'answer',
      choice: 'Retry',
      text: 'Then run the tests again.',
    })

    expect(retried.answer).toMatchObject({ kind: 'answered', choice: 'Retry' })
    const fresh = await waitFor(
      client,
      task,
      (t) => t.leadRunId !== task.leadRunId && t.runs.length === 1,
      'to get a fresh Run',
    )
    expect(fresh.status?.kind).not.toBe('failed')
    const prompt = await promptOf(client, fresh.leadRunId ?? '')
    expect(prompt).toContain('# Picking up after a failure')
    expect(prompt).toContain('Free some disk space first.')
    expect(prompt).toContain('Then run the tests again.')
    expect((await threadEvents(client, task)).map((e) => e.text)).toContain('You retried the Task')
  })

  test('Retry from the card and S is the resume route, which starts a fresh Run', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))
    await failTwice(client, task)

    const retried = await client.ok<Task>('POST', `/tasks/${task.id}/resume`, {})

    expect(retried.status?.kind).not.toBe('failed')
    await waitFor(
      client,
      task,
      (t) => t.leadRunId !== task.leadRunId && t.runs.length === 1,
      'to get a fresh Run',
    )
    const ask = (await comments(client, task)).find((c) => c.failed !== undefined)
    expect(ask?.answer).toMatchObject({ kind: 'answered', choice: 'Retry' })
  })

  test('thirty minutes with no output while Working counts as a failure', async () => {
    const clock = new ManualClock()
    const client = await startTed({ stallAfterMs: 1_500, clock })
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ say: 'thinking' }, { waitFor: '/never' }),
      factory: 'NB',
      start: true,
    })
    const working = await waitFor(client, task, (t) => t.runs[0]?.state === 'working', 'to work')

    const heard = await eventWait(
      client.subscribe,
      async () => {
        const { conversation } = await client.getRun(working.leadRunId ?? '')
        return conversation.find((entry) => assistantTexts([entry]).includes('thinking'))
      },
      'the Run’s output before starting its silence window',
    )
    clock.advance(Date.parse(heard.at ?? '') + 3_000 - clock.now())
    await eventWait(
      client.subscribe,
      async () =>
        (await threadEvents(client, task)).some(
          (e) => e.text === 'Task Lead Run sent no output for 2 seconds · resuming the session',
        ),
      'the silent Run to count as a failure',
    )
    const after = await waitFor(client, task, (t) => t.runs.length === 1, 'to run again')
    expect(after.leadRunId).toBe(working.leadRunId)
  })

  test('a Task Lead that TED stops isn’t a failure', async () => {
    const client = await startTed()
    const task = await startTask(client, steps({ endTurn: true }))

    await client.ok('POST', `/tasks/${task.id}/stop`)

    await eventWait(
      client.subscribe,
      async () => (await client.getRun(task.leadRunId ?? '')).run.state === 'finished',
      'the stopped Run to finish',
    )
    expect((await threadEvents(client, task)).some((e) => e.tone === 'failure')).toBe(false)
    expect((await getTask(client, task.id)).status?.kind).toBe('stopped')
  })
})

async function failTwice(client: Client, task: Task): Promise<Task> {
  const count = await killAgent()
  await startsAfter(count)
  await waitUntil(
    async () =>
      (await client.getRun(task.leadRunId ?? '')).conversation.some((e) =>
        e.line.includes('TED resumed your session'),
      ),
    'the resumed session to answer',
  )
  await killAgent()
  return waitFor(client, task, (t) => t.status?.kind === 'failed', 'to be Failed')
}
