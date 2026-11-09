import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Comment, Factory, Task, ThreadEvent } from '@ted/protocol'
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-thread-'))
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

Let notes be edited offline.

## Decisions so far

None.

## Current state

Written up.

## Open questions

None.

## Next step

Build it.
`

async function startTed(order = '[intake, work, merge]') {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': `version: 1\norder: ${order}\n` })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, daemon.appToken)
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

const comment = async (client: Client, task: Task, id: string) => {
  const found = (await comments(client, task)).find((c) => c.id === id)
  if (!found) throw new Error(`no Comment ${id}`)
  return found
}

const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const post = (client: Client, task: Task, body: string) =>
  client.ok<Comment>('POST', `/tasks/${task.id}/comments`, { body })

const threadEvents = (client: Client, task: Task) =>
  client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)

describe('Comments into the Task Lead’s Run', () => {
  test('a Comment goes into the live Run and counts as read once the agent starts a turn with it', async () => {
    const client = await startTed()
    const task = await create(client, steps({ endTurn: true }), { start: true })
    const idle = await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    expect(idle.commentBox).toBe('live')

    const posted = await post(client, task, 'Use the export button in the note menu.')

    expect(posted).toMatchObject({
      kind: 'note',
      author: { kind: 'human' },
      body: 'Use the export button in the note menu.',
      delivered: { runId: idle.leadRunId },
    })
    const read = await waitUntil(async () => {
      const current = await comment(client, task, posted.id)
      return current.readAt !== undefined ? current : undefined
    }, 'the Comment to be read')
    expect((read.readAt ?? '') >= posted.createdAt).toBe(true)
    const messages = await userMessages(client, idle.leadRunId ?? '')
    expect(messages.at(-1)).toContain('Use the export button in the note menu.')
  })

  test('a Comment sent mid-turn waits in the Run’s input and is read when the next turn starts', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const task = await create(client, steps({ waitFor: gate }, { endTurn: true }), {
      start: true,
    })
    const working = await waitFor(
      client,
      task,
      (t) => t.runs[0]?.state === 'working',
      'to be working',
    )

    const posted = await post(client, task, 'Also handle the empty query.')
    expect(posted.delivered?.runId).toBe(working.leadRunId)
    await sleep(600)
    expect((await comment(client, task, posted.id)).readAt).toBeUndefined()

    await writeFile(gate, '')
    await waitUntil(
      async () => (await comment(client, task, posted.id)).readAt,
      'the Comment to be read',
    )
  })

  test('a Comment on a Backlog Task is stored and given to the first Run', async () => {
    const client = await startTed()
    const task = await create(client, steps({ endTurn: true }))
    expect(task.commentBox).toBe('no-run')

    const posted = await post(client, task, 'Keep the old export format too.')
    expect(posted.delivered).toBeUndefined()

    await client.ok('POST', `/tasks/${task.id}/start`)
    const started = await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
    const { prompt } = (await client.getRun(started.leadRunId ?? '')).run as { prompt: string }
    expect(prompt).toContain('# Comments since the last Run')
    expect(prompt).toContain('Keep the old export format too.')
    const read = await waitUntil(async () => {
      const current = await comment(client, task, posted.id)
      return current.readAt !== undefined ? current : undefined
    }, 'the Comment to be read')
    expect(read.delivered?.runId).toBe(started.leadRunId)
  })

  test('Comments and answers given while a Task waits for a blocker go to its fresh Run', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const advance = ['ted', 'outcome', 'advance']
    const blocker = await create(
      client,
      steps({ waitFor: gate }, { everyMessage: [{ run: advance }] }, { run: advance }),
    )
    const running = await create(
      client,
      steps(
        { run: ['ted', 'outcome', 'ask', 'Which date format?'] },
        { run: ['ted', 'task', 'block', '--by', 'NB-1'] },
        { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
        { endTurn: true },
      ),
      { start: true },
    )
    const blocked = await waitFor(
      client,
      running,
      (t) => t.runs.length === 0 && t.leadRunId !== undefined && t.blockedBy.length > 0,
      'to stop for its blocker',
    )
    const firstRun = blocked.leadRunId
    expect(blocked.commentBox).toBe('no-run')
    const question = (await comments(client, running)).find((c) => c.kind === 'question')
    if (!question) throw new Error('no question')
    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      text: 'ISO dates, please.',
    })
    const posted = await post(client, running, 'The parser lives in src/dates.ts.')
    expect(posted.delivered).toBeUndefined()

    await client.ok('POST', `/tasks/${blocker.id}/start`)
    await writeFile(gate, '')
    const fresh = await waitFor(
      client,
      running,
      (t) => t.leadRunId !== undefined && t.leadRunId !== firstRun,
      'to get a fresh Run',
    )
    const { prompt } = (await client.getRun(fresh.leadRunId ?? '')).run as { prompt: string }
    expect(prompt).toContain('The parser lives in src/dates.ts.')
    expect(prompt).toContain('“Which date format?”')
    expect(prompt).toContain('ISO dates, please.')
    expect(prompt.split('The parser lives in src/dates.ts.').length).toBe(2)
    expect((await comment(client, running, posted.id)).delivered?.runId).toBe(fresh.leadRunId)
  })

  test('the human opening the thread marks the agents’ Comments read', async () => {
    const client = await startTed()
    const task = await create(client, steps({ run: ['ted', 'comment', 'Done parsing'] }), {
      start: true,
    })
    const note = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.author.kind === 'run'),
      'the agent’s Comment',
    )
    expect(note.readAt).toBeUndefined()

    await client.ok('POST', `/tasks/${task.id}/read`)

    expect((await comment(client, task, note.id)).readAt).toBeDefined()
  })

  test('a Run’s Comments are its own, and a Run can’t mark Comments read', async () => {
    const client = await startTed()
    const task = await create(client, steps({ endTurn: true }), { start: true })
    await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    const record = JSON.parse(
      await readFile(path.join(home, 'worktrees', 'NB-1', 'widgets', 'stub-record.json'), 'utf8'),
    ) as { env: Record<string, string> }
    const asRun = api(daemon?.port ?? 0, record.env.TED_RUN_TOKEN ?? '')

    const posted = await asRun.call('POST', `/tasks/${task.id}/comments`, { body: 'from the Run' })
    expect(posted.body.author.kind).toBe('run')
    expect(posted.body.delivered).toBeUndefined()
    expect((await asRun.call('POST', `/tasks/${task.id}/read`)).status).toBe(403)
    expect((await asRun.call('GET', `/tasks/${task.id}/events`)).status).toBe(403)
  })
})

describe('event lines', () => {
  test('the thread lists creation, start, Stage moves, Runs and an approval in plain words', async () => {
    const client = await startTed('[intake, design, work, merge]')
    const advance = ['ted', 'outcome', 'advance']
    const task = await create(
      client,
      steps(
        { run: advance },
        { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
        { run: advance },
        { endTurn: true },
      ),
      { start: true },
    )
    const request = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.gate !== undefined),
      'the Design review',
    )
    await client.ok('POST', `/comments/${request.id}/answer`, { action: 'approve' })
    await waitFor(client, task, (t) => t.stage === 'work', 'to reach Work')

    const lines = await threadEvents(client, task)
    const shown = lines.map(({ tone, text }) => ({ tone, text }))
    expect(shown).toEqual([
      { tone: 'done', text: 'You created this Task' },
      { tone: 'edit', text: 'Task started' },
      { tone: 'edit', text: 'Task moved to Intake' },
      { tone: 'run', text: 'Task Lead started · Claude' },
      { tone: 'edit', text: 'Task moved to Design' },
      { tone: 'edit', text: 'You approved · Task moved to Work' },
    ])
    const sorted = [...lines].sort((a, b) => a.at.localeCompare(b.at))
    expect(lines.map((l) => l.id)).toEqual(sorted.map((l) => l.id))
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length)
  })

  test('a send-back is a red line carrying its Findings, and Done is green', async () => {
    const client = await startTed()
    const findings = path.join(scratch, 'findings.md')
    await writeFile(findings, '1. The empty query hangs.\n')
    const advance = ['ted', 'outcome', 'advance']
    const task = await create(
      client,
      steps(
        { run: advance },
        { run: ['ted', 'outcome', 'back', '--to', 'intake', '--findings', findings] },
        { run: advance },
        { run: advance },
        { run: advance },
        { endTurn: true },
      ),
      { start: true },
    )
    await waitFor(client, task, (t) => t.stage === 'done', 'to reach Done')

    const lines = await waitUntil(async () => {
      const all = await threadEvents(client, task)
      return all.at(-1)?.text.startsWith('Worktree') ? all : undefined
    }, 'the worktree to be removed')
    const back = lines.find((l) => l.tone === 'failure')
    expect(back).toMatchObject({
      text: 'Work sent this back to Intake (round 1 of 3)',
      findings: '1. The empty query hangs.',
    })
    expect(lines.filter((l) => l.text === 'Task moved to Intake')).toHaveLength(1)
    expect(lines.at(-2)).toMatchObject({ tone: 'done', text: 'Task moved to Done' })
    expect(lines.at(-1)).toMatchObject({ tone: 'edit', text: 'Worktree for widgets removed' })
    expect((await getTask(client, task.id)).commentBox).toBe('done')
  })

  test('blockers the human sets show who set them', async () => {
    const client = await startTed()
    const a = await create(client, 'A')
    const b = await create(client, 'B')
    await client.ok('POST', `/tasks/${b.id}/blockers`, { by: a.displayId })
    await client.ok('DELETE', `/tasks/${b.id}/blockers/${a.displayId}`)

    const texts = (await threadEvents(client, b)).map((l) => l.text)
    expect(texts).toEqual([
      'You created this Task',
      'You made this Task wait for NB-1',
      'You removed the blocker NB-1',
    ])
  })
})

describe('event lines for Task changes', () => {
  test('archiving a Task adds an event line', async () => {
    const client = await startTed()
    const task = await create(client, 'Old idea')
    await client.ok('POST', `/tasks/${task.id}/archive`)
    const texts = (await threadEvents(client, task)).map((e) => e.text)
    expect(texts).toEqual(['You created this Task', 'You archived this Task'])
  })
})
