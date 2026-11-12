import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type AgentHealth,
  type Comment,
  type Coordinator,
  type CoordinatorTask,
  DaemonClient,
  DaemonRequestError,
  type Factory,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runCli } from '../../cli/src/cli.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
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
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  const client = await openTed()
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return client
}

async function openTed() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
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

const askAboutBlocker = {
  run: [
    'ted',
    'comment',
    '--choice',
    'Wait for blocker',
    '--choice',
    'Continue independent work',
    'NB-1 blocks integration, but I can finish the docs. I recommend continuing independent work. How should I proceed?',
  ],
}

async function blockerQuestion(client: Client, task: Task, blocker: Task) {
  const current = await waitFor(
    client,
    task,
    (t) => t.status?.kind === 'waiting-on-you' && t.runs[0]?.state === 'idle',
    'to wait for the human’s decision',
  )
  expect(current.blockedBy).toEqual([blocker.id])
  const [question] = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
  expect(question).toMatchObject({
    kind: 'question',
    choices: ['Wait for blocker', 'Continue independent work'],
  })
  expect(question?.answer).toBeUndefined()
  if (!question) throw new Error('no blocker question')
  return question
}

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
  test('a blocker that would make a cycle is refused, naming the cycle; a Backlog Task stays in Backlog and shows the blocker as a marker; removing the last blocker by hand never starts a Task', async () => {
    const client = await startTed()
    const a = await create(client, 'A')
    const b = await create(client, 'B', { blockedBy: [a.id] })
    const c = await create(client, 'C', { blockedBy: [b.id] })

    const refused = await block(client, a, c)

    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(
      `${c.displayId} can’t block ${a.displayId}: that makes a cycle, ${a.displayId} → ${c.displayId} → ${b.displayId} → ${a.displayId}`,
    )
    expect((await block(client, a, a)).status).toBe(409)
    expect((await getTask(client, a.id)).blockedBy).toEqual([])

    const d = await create(client, 'D')
    const e = await create(client, 'E')

    const marked = await block(client, e, d)

    expect(marked.status).toBe(200)
    expect(marked.body).toMatchObject({
      stage: 'backlog',
      blockedBy: [d.id],
      markers: [{ kind: 'blocked-by', by: d.displayId }],
      activity: `Starts when ${d.displayId} merges`,
    })

    const blocker = await create(client, 'Blocker')
    const task = await create(client, 'Task', { start: true, blockedBy: [blocker.id] })

    const res = await client.call('DELETE', `/tasks/${task.id}/blockers/${blocker.displayId}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ stage: 'backlog', blockedBy: [], markers: [] })
    expect(
      (await client.call('DELETE', `/tasks/${task.id}/blockers/${blocker.displayId}`)).status,
    ).toBe(404)
    await block(client, task, blocker)
    expect((await client.ok<Task>('DELETE', `/tasks/${task.id}/blockers`)).blockedBy).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await getTask(client, task.id)).stage).toBe('backlog')
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

  test('a running Task asks the human before stopping to wait, then resumes from its brief', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const briefFile = path.join(scratch, 'brief.md')
    await writeFile(
      briefFile,
      '## Goal\n\nParse dates.\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nParser half done.\n\n## Open questions\n\nNone.\n\n## Next step\n\nWait for NB-1.\n',
    )
    const blocker = await create(client, doneWhen(gate))
    const running = await create(
      client,
      steps(
        { say: 'working' },
        { endTurn: true },
        {
          everyMessage: [
            askAboutBlocker,
            {
              everyMessage: [
                { run: ['ted', 'brief', 'write', '--file', briefFile] },
                { run: ['ted', 'task', 'block', '--by', 'NB-1'] },
                { run: ['ted', 'comment', 'Waiting for NB-1; the parser is half done'] },
                { endTurn: true },
              ],
            },
            { endTurn: true },
          ],
        },
      ),
      { start: true },
    )
    const first = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    const runId = first.leadRunId ?? ''

    expect((await block(client, running, blocker)).status).toBe(200)

    const question = await blockerQuestion(client, running, blocker)
    const waiting = await getTask(client, running.id)
    expect(waiting.leadRunId).toBe(runId)
    const [, message] = await userMessages(client, runId)
    expect(message).toContain('The human made this Task wait for NB-1')
    expect(message).toContain('Before doing more work')
    expect(message).toContain('then end your turn and wait for their answer')
    expect(message).toContain('Don’t remove the blocker just to continue')
    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      choice: 'Wait for blocker',
    })

    const blocked = await waitFor(
      client,
      running,
      (t) => t.status?.kind === 'blocked',
      'to be Blocked',
    )
    expect(blocked).toMatchObject({ stage: 'intake', status: { kind: 'blocked', by: 'NB-1' } })
    expect(blocked.runs).toEqual([])
    expect(blocked.activity).toBe('Starts when NB-1 merges')
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
    expect(prompt).toContain('## Task brief (version 1)')
    expect(prompt).toContain('Parser half done.')
    expect(prompt).toContain('Waiting for NB-1; the parser is half done')
    expect((await stat(worktree)).isDirectory()).toBe(true)
  })

  test('a Task Lead waits for permission to continue, then keeps its Run and blocker link', async () => {
    const client = await startTed()
    const blocker = await create(client, 'Blocker')
    const running = await create(
      client,
      steps(
        { endTurn: true },
        {
          everyMessage: [
            askAboutBlocker,
            {
              everyMessage: [
                {
                  run: [
                    'ted',
                    'comment',
                    'I’ll work on independent docs and wait before integration',
                  ],
                },
                { endTurn: true },
              ],
            },
            { endTurn: true },
          ],
        },
      ),
      { start: true },
    )
    const first = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'to go idle')

    await block(client, running, blocker)
    const question = await blockerQuestion(client, running, blocker)
    expect((await userMessages(client, first.leadRunId ?? '')).length).toBe(2)
    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      choice: 'Continue independent work',
    })
    await waitUntil(
      async () =>
        (await userMessages(client, first.leadRunId ?? '')).length === 3 &&
        (await client.ok<unknown[]>('GET', `/tasks/${running.id}/comments`)).length === 2,
      'the Task Lead to answer',
    )
    const current = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'idle')
    expect(current.runs).toHaveLength(1)
    expect(current.leadRunId).toBe(first.leadRunId)
    expect(current.blockedBy).toEqual([blocker.id])
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

  test('removing remaining blockers mid-flow waits for Resume and keeps context', async () => {
    let client = await startTed()
    const gate = path.join(scratch, 'gate')
    const briefFile = path.join(scratch, 'brief.md')
    await writeFile(
      briefFile,
      '## Goal\n\nParse dates.\n\n## Decisions so far\n\nKeep the parser.\n\n## Current state\n\nParser half done.\n\n## Open questions\n\nNone.\n\n## Next step\n\nFinish integration.\n',
    )
    const blocker = await create(client, doneWhen(gate))
    const other = await create(client, 'Other blocker')
    const task = await create(
      client,
      steps(
        { run: advance },
        { run: ['ted', 'brief', 'write', '--file', briefFile] },
        { endTurn: true },
        {
          everyMessage: [
            { run: ['ted', 'task', 'block', '--by', blocker.displayId] },
            { endTurn: true },
          ],
        },
      ),
      { start: true },
    )
    const first = await waitFor(
      client,
      task,
      (t) => t.stage === 'work' && t.runs[0]?.state === 'idle',
      'to work before waiting for a blocker',
    )
    const runId = first.leadRunId ?? ''
    const worktree = path.join(home, 'worktrees', task.displayId, 'widgets')
    const unfinished = path.join(worktree, 'parser.txt')
    await writeFile(unfinished, 'unfinished parser\n')

    await block(client, task, blocker)
    await waitFor(client, task, (t) => t.status?.kind === 'blocked', 'to be Blocked')
    await block(client, task, other)
    await client.ok('DELETE', `/tasks/${task.id}/blockers/${other.displayId}`)
    expect((await getTask(client, task.id)).status?.kind).toBe('blocked')
    await block(client, task, other)

    const stopped = await client.ok<Task>('DELETE', `/tasks/${task.id}/blockers`)
    expect(stopped).toMatchObject({
      stage: 'work',
      blockedBy: [],
      runs: [],
      status: { kind: 'stopped' },
      commentBox: 'stopped',
      activity: 'Its blockers are gone. Resume to carry on.',
    })
    expect(stopped.leadRunId).toBe(runId)
    expect((await client.getRun(runId)).run.state).toBe('finished')

    await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'Keep the old endpoint.' })
    await client.ok('POST', `/tasks/${blocker.id}/start`)
    await writeFile(gate, '')
    await waitFor(client, blocker, (t) => t.stage === 'done', 'to merge after manual removal')

    await daemon?.stop()
    daemon = undefined
    client = await openTed()
    const stillStopped = await getTask(client, task.id)
    expect(stillStopped.status?.kind).toBe('stopped')
    expect(stillStopped.runs).toEqual([])
    expect(stillStopped.leadRunId).toBe(runId)
    expect(await readFile(unfinished, 'utf8')).toBe('unfinished parser\n')

    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    const fresh = await waitFor(
      client,
      task,
      (t) => t.leadRunId !== undefined && t.leadRunId !== runId,
      'to start a fresh Run only after Resume',
    )
    expect(fresh.stage).toBe('work')
    const { prompt } = (await client.getRun(fresh.leadRunId ?? '')).run as { prompt?: string }
    expect(prompt).toContain('# Picking up after a stop')
    expect(prompt).toContain('Parser half done.')
    expect(prompt).toContain('Keep the old endpoint.')
    expect((await client.getRun(runId)).run.state).toBe('finished')
    expect(await readFile(unfinished, 'utf8')).toBe('unfinished parser\n')
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

describe('blockers while the agent can’t run', () => {
  const signedIn = (value: boolean) =>
    writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: value }))

  async function waitingTask(client: Client, gate: string) {
    const briefFile = path.join(scratch, 'brief.md')
    await writeFile(
      briefFile,
      '## Goal\n\nParse dates.\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nParser half done.\n\n## Open questions\n\nNone.\n\n## Next step\n\nWait for NB-1.\n',
    )
    const blocker = await create(client, doneWhen(gate))
    const running = await create(
      client,
      steps(
        { endTurn: true },
        {
          everyMessage: [
            { run: ['ted', 'task', 'block', '--by', 'NB-1'] },
            { run: ['ted', 'brief', 'write', '--file', briefFile] },
            { endTurn: true },
          ],
        },
      ),
      { start: true },
    )
    const first = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    return { blocker, running, runId: first.leadRunId ?? '' }
  }

  test('a Task Lead stopped to wait for a blocker while signed out stays stopped after signing in', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const { blocker, running, runId } = await waitingTask(client, gate)

    await signedIn(false)
    await block(client, running, blocker)
    await waitFor(client, running, (t) => t.status?.kind === 'blocked', 'to be Blocked')
    await waitUntil(
      async () =>
        (await client.ok<AgentHealth[]>('GET', '/agents/health')).find((h) => h.agent === 'claude')
          ?.state === 'signed-out',
      'TED to see Claude Code signed out',
    )
    await signedIn(true)
    await client.ok('POST', '/agents/health/check')
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const after = await getTask(client, running.id)
    expect(after.status?.kind).toBe('blocked')
    expect(after.runs).toEqual([])

    await client.ok('POST', `/tasks/${blocker.id}/start`)
    await writeFile(gate, '')
    await waitFor(
      client,
      running,
      (t) => t.leadRunId !== undefined && t.leadRunId !== runId,
      'to get a fresh Run once NB-1 merges',
    )
  })

  test('a pick-up held because the agent signed out keeps its note for the Run that starts later', async () => {
    const client = await startTed()
    const gate = path.join(scratch, 'gate')
    const { blocker, running, runId } = await waitingTask(client, gate)
    await block(client, running, blocker)
    await waitFor(client, running, (t) => t.status?.kind === 'blocked', 'to be Blocked')
    await client.ok('POST', `/tasks/${blocker.id}/start`)
    await waitFor(client, blocker, (t) => t.leadRunId !== undefined, 'to start')

    await signedIn(false)
    const realNow = Date.now
    Date.now = () => realNow() + 60_000
    try {
      await writeFile(gate, '')
      await waitFor(client, running, (t) => t.status?.kind === 'paused', 'to be held as paused')
    } finally {
      Date.now = realNow
    }
    await signedIn(true)
    await client.ok('POST', '/agents/health/check')

    const fresh = await waitFor(
      client,
      running,
      (t) => t.leadRunId !== undefined && t.leadRunId !== runId,
      'to get a fresh Run',
    )
    const { prompt } = (await client.getRun(fresh.leadRunId ?? '')).run as { prompt?: string }
    expect(prompt).toContain('# Picking up after a blocker')
    expect(prompt).toContain('Parser half done.')
  })

  test('a Task Lead that carries on past a blocker resumes after signing in', async () => {
    const client = await startTed()
    const go = path.join(scratch, 'go')
    const blocker = await create(client, 'Blocker')
    const running = await create(
      client,
      steps(
        { endTurn: true },
        { run: ['ted', 'comment', 'This only touches docs, so I can carry on'] },
        { waitFor: go },
        { authError: true },
        { exit: 1 },
      ),
      { start: true },
    )
    const first = await waitFor(client, running, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    await block(client, running, blocker)
    await waitUntil(
      async () => (await client.ok<unknown[]>('GET', `/tasks/${running.id}/comments`)).length === 1,
      'the Task Lead to carry on',
    )

    await signedIn(false)
    await writeFile(go, '')
    await waitFor(client, running, (t) => t.status?.kind === 'paused', 'to be held as paused')
    await signedIn(true)
    await client.ok('POST', '/agents/health/check')

    await waitFor(
      client,
      running,
      (t) => t.leadRunId !== undefined && t.leadRunId !== first.leadRunId,
      'to resume',
    )
  })
})

async function hierarchyApp() {
  const info = await readDaemonInfo(home)
  if (!info || !daemon) throw new Error('daemon is not running')
  return new DaemonClient(info, info.token, { appKey: daemon.appToken })
}
async function parentOf(app: DaemonClient, child: Task, parent: Task | null) {
  return withHierarchyRevision(app, child, (revision) =>
    app.setTaskParent(child.id, { parentId: parent?.id ?? null, revision }),
  )
}
async function withHierarchyRevision<T>(
  app: DaemonClient,
  task: Task,
  operation: (revision: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const { revision } = await app.taskHierarchy(task.id)
    try {
      return await operation(revision)
    } catch (error) {
      if (
        attempt >= 9 ||
        !(error instanceof DaemonRequestError) ||
        error.status !== 409 ||
        error.message !==
          'Hierarchy changed or was not confirmed; read the hierarchy preview and confirm again'
      )
        throw error
    }
  }
}

test('parent events survive replay and keep hierarchy dependency effects separate from manual blockers', async () => {
  const directory = path.join(scratch, 'hierarchy-store')
  let store = await openStore({ directory })
  try {
    const parent = await store.createTask({ title: 'Parent' })
    const child = await store.createTask({ title: 'Child' })
    store.setTaskParent(child.id, parent.id)
    store.addBlocker(parent.id, child.id)
    expect(store.blockers(parent.id)).toHaveLength(2)
    store.archiveTask(child.id)
    expect(store.blockers(parent.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockerId: child.id,
          merged: false,
          kind: 'child',
          satisfied: true,
        }),
        expect.objectContaining({ blockerId: child.id, merged: false, ended: 'archived' }),
      ]),
    )
    store.removeBlocker(parent.id, child.id)
    store.stopTask(parent.id, { runs: 0, why: 'blockers-removed' })
    store.setStartRequested(parent.id, true)
    expect(store.getTask(parent.id)).toMatchObject({ stopped: false, startRequested: true })
    expect(store.queue()).toEqual([])
    await store.close()
    store = await openStore({ directory })
    expect(store.getTask(child.id)).toMatchObject({ parentId: parent.id })
    expect(store.getTask(parent.id)).toMatchObject({ childIds: [child.id], blockedBy: [] })
    expect(store.blockers(parent.id)).toMatchObject([{ kind: 'child', satisfied: true }])
    store.deleteTask(parent.id)
    expect(store.getTask(child.id)?.parentId).toBeUndefined()
    await store.close()
    store = await openStore({ directory })
    expect(store.getTask(child.id)).toBeDefined()
    expect(store.parentOf(child.id)).toBeUndefined()
  } finally {
    await store.close()
  }
})

test('hierarchy API persists nested links, refuses stale and cyclic edits, and confirms archive and deletion effects', async () => {
  let client = await startTed()
  let app = await hierarchyApp()
  const parent = await create(client, 'Parent')
  const child = await create(client, 'Child')
  const leaf = await create(client, 'Leaf')
  const other = await create(client, 'Independent')
  await parentOf(app, child, parent)
  await parentOf(app, leaf, child)
  await block(client, parent, child)
  await client.ok('DELETE', `/tasks/${parent.id}/blockers`)
  expect(await app.taskHierarchy(child.id)).toMatchObject({
    parentId: parent.id,
    childIds: [leaf.id],
  })
  expect((await getTask(client, parent.id)).blockedBy).toEqual([])
  await expect(parentOf(app, parent, leaf)).rejects.toThrow('cycle')
  expect((await block(client, leaf, parent)).status).toBe(409)
  await block(client, leaf, other)
  await expect(parentOf(app, parent, other)).rejects.toThrow('cycle')
  await client.ok('DELETE', `/tasks/${leaf.id}/blockers`)
  await expect(parentOf(app, child, child)).rejects.toThrow('itself')
  const revision = (await app.taskHierarchy(child.id)).revision
  await create(client, 'Changes the preview')
  await expect(app.setTaskParent(child.id, { parentId: other.id, revision })).rejects.toThrow(
    'confirm again',
  )

  const otherDirectory = path.join(scratch, 'other-factory')
  await mkdir(otherDirectory)
  const otherOrigin = await makeOriginRepo(otherDirectory)
  const otherRepo = path.join(otherDirectory, 'acme', 'gadgets.git')
  await rename(otherOrigin, otherRepo)
  await client.ok('POST', '/dev/factories', { repo: otherRepo, key: 'OTHER' })
  const foreign = await client.ok<Task>('POST', '/tasks', { title: 'Foreign', factory: 'OTHER' })
  await expect(parentOf(app, child, foreign)).rejects.toThrow('same Factory')
  await client.ok('POST', `/tasks/${parent.id}/start`)
  await client.ok('POST', `/tasks/${child.id}/start`)
  await daemon?.stop()
  client = await openTed()
  app = await hierarchyApp()
  expect(await app.taskHierarchy(parent.id)).toMatchObject({ parentId: null, childIds: [child.id] })
  expect(await app.taskHierarchy(child.id)).toMatchObject({
    parentId: parent.id,
    childIds: [leaf.id],
  })
  expect((await getTask(client, parent.id)).runs).toEqual([])
  expect((await getTask(client, child.id)).runs).toEqual([])

  await block(client, child, leaf)
  await app.archiveTask(leaf.id, { blocked: 'keep' })
  expect((await getTask(client, child.id)).blockedBy).toEqual([leaf.id])
  await client.ok('DELETE', `/tasks/${child.id}/blockers`)
  expect((await getTask(client, child.id)).runs).toEqual([])
  expect((await getTask(client, leaf.id)).parentId).toBe(child.id)
  await app.unarchiveTask(leaf.id)
  expect((await getTask(client, child.id)).markers).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'blocked-by', by: leaf.displayId })]),
  )
  await parentOf(app, leaf, other)
  expect((await app.taskHierarchy(child.id)).childIds).toEqual([])
  expect((await app.taskHierarchy(other.id)).childIds).toEqual([leaf.id])
  expect((await getTask(client, child.id)).runs).toEqual([])
  await parentOf(app, leaf, child)

  const preview = await app.taskHierarchyPreview(parent.id)
  expect(new Set(preview.descendants.map((task) => task.id))).toEqual(new Set([child.id, leaf.id]))
  await expect(app.archiveTask(parent.id)).rejects.toThrow('confirm')
  await create(client, 'Added after the archive preview')
  await expect(app.archiveTask(parent.id, { hierarchyRevision: preview.revision })).rejects.toThrow(
    'confirm again',
  )
  const confirmed = await app.taskHierarchyPreview(parent.id)
  await app.archiveTask(parent.id, { hierarchyRevision: confirmed.revision })
  for (const task of [parent, child, leaf])
    expect((await getTask(client, task.id)).archived).toBeDefined()
  expect((await getTask(client, other.id)).archived).toBeUndefined()
  await expect(app.unarchiveTask(child.id)).rejects.toThrow('Restore the parent')
  await app.unarchiveTask(parent.id)
  expect((await getTask(client, parent.id)).archived).toBeUndefined()
  expect((await getTask(client, child.id)).archived).toBeDefined()
  await expect(app.deleteTask(parent.id)).rejects.toThrow('confirm')
  const deletion = await app.taskHierarchyPreview(parent.id)
  await expect(app.deleteTask(parent.id, { hierarchyRevision: deletion.revision })).rejects.toThrow(
    'Choose',
  )
  await app.deleteTask(parent.id, { children: 'unparent', hierarchyRevision: deletion.revision })
  expect((await getTask(client, child.id)).parentId).toBeUndefined()
  expect((await getTask(client, leaf.id)).parentId).toBe(child.id)
  const subtree = await app.taskHierarchyPreview(child.id)
  await app.deleteTask(child.id, { children: 'delete', hierarchyRevision: subtree.revision })
  expect((await client.ok<Task[]>('GET', '/tasks')).map((task) => task.id)).not.toEqual(
    expect.arrayContaining([child.id, leaf.id]),
  )
  expect((await getTask(client, other.id)).id).toBe(other.id)

  const deletionParent = await create(client, steps({ endTurn: true }))
  const deletionChild = await create(client, 'Deletion child')
  await parentOf(app, deletionChild, deletionParent)
  await client.ok('POST', `/tasks/${deletionParent.id}/start`)
  await app.deleteTask(deletionChild.id)
  expect(await app.taskHierarchy(deletionParent.id)).toMatchObject({ childIds: [] })
  expect((await getTask(client, deletionParent.id)).runs).toEqual([])
  await client.ok('POST', `/tasks/${deletionParent.id}/start`)
  const restarted = await waitFor(
    client,
    deletionParent,
    (task) => task.runs[0]?.state === 'idle',
    'to start only on the explicit request',
  )
  expect(restarted.status?.kind).not.toBe('stopped')
})

test('prepared parents require explicit Resume after unlink, reparent, archive or delete, including after restart', async () => {
  let client = await startTed()
  const app = await hierarchyApp()
  const cases: { parent: Task; child: Task; operation: string }[] = []
  for (const operation of ['unlink', 'reparent', 'archive', 'delete']) {
    const parent = await create(client, steps({ endTurn: true }))
    await client.ok('POST', `/tasks/${parent.id}/start`, { prepare: true })
    const preparing = await waitFor(
      client,
      parent,
      (task) => task.runs[0]?.state === 'idle',
      'to finish its preparation turn',
    )
    const run = api(
      daemon?.port ?? 0,
      (await loadRunTokens(tedPaths(home).runTokenKey)).issue(preparing.leadRunId ?? ''),
    )
    expect(
      (await run.call('POST', `/tasks/${parent.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(200)
    await waitFor(
      client,
      parent,
      (task) => task.preparation === 'ready' && task.runs.length === 0,
      'to wait ready for Work',
    )
    const child = await create(client, `${operation} child`)
    await client.ok('PUT', `/tasks/${child.id}/autopilot`, { choice: 'off' })
    await parentOf(app, child, parent)
    cases.push({ parent, child, operation })
  }
  const destination = await create(client, 'Reparent destination')
  await client.ok('PUT', `/tasks/${destination.id}/autopilot`, { choice: 'off' })
  await client.ok('PATCH', '/settings', { overnightMode: true })
  for (const { parent, child, operation } of cases) {
    expect((await getTask(client, parent.id)).runs).toEqual([])
    if (operation === 'unlink') await parentOf(app, child, null)
    else if (operation === 'reparent') await parentOf(app, child, destination)
    else if (operation === 'archive') await app.archiveTask(child.id)
    else await app.deleteTask(child.id)
    expect(await getTask(client, parent.id)).toMatchObject({
      stage: 'work',
      runs: [],
      status: { kind: 'stopped' },
    })
    expect((await getTask(client, parent.id)).preparation).toBeUndefined()
  }
  await daemon?.stop()
  client = await openTed()
  await client.ok('PATCH', '/settings', { overnightMode: false })
  await client.ok('PATCH', '/settings', { overnightMode: true })
  for (const { parent } of cases) {
    expect((await getTask(client, parent.id)).runs).toEqual([])
    expect((await getTask(client, parent.id)).status?.kind).toBe('stopped')
  }
  const parent = cases[0]?.parent
  if (!parent) throw new Error('no prepared parent')
  await client.ok('POST', `/tasks/${parent.id}/resume`, {})
  await waitFor(
    client,
    parent,
    (task) => task.runs[0]?.state === 'idle',
    'to continue Work only after explicit Resume',
  )
}, 90_000)

test('nested parents wait for children to merge while independent Tasks run, and Done parents only permit explicit unlink and restore', async () => {
  const client = await startTed()
  const app = await hierarchyApp()
  const parentGate = path.join(scratch, 'parent-gate')
  const childGate = path.join(scratch, 'child-gate')
  const leafGate = path.join(scratch, 'leaf-gate')
  const parent = await create(client, doneWhen(parentGate))
  const child = await create(client, doneWhen(childGate))
  const leaf = await create(client, doneWhen(leafGate))
  const waived = await create(client, 'Archived unfinished work')
  await parentOf(app, child, parent)
  await parentOf(app, leaf, child)
  await parentOf(app, waived, parent)
  await app.archiveTask(waived.id)
  await client.ok('POST', `/tasks/${parent.id}/start`)
  await client.ok('POST', `/tasks/${child.id}/start`)
  await client.ok('POST', `/tasks/${leaf.id}/start`)
  await waitFor(client, leaf, (task) => task.runs[0]?.state === 'working', 'to start independently')
  const independent = await create(client, steps({ endTurn: true }), { start: true })
  await waitFor(
    client,
    independent,
    (task) => task.runs[0]?.state === 'idle',
    'to run while the parent waits',
  )
  expect((await getTask(client, parent.id)).runs).toEqual([])
  expect((await getTask(client, child.id)).runs).toEqual([])
  await writeFile(leafGate, 'go')
  const mergedLeaf = await waitFor(client, leaf, (task) => task.stage === 'done', 'to merge')
  const workingChild = await waitFor(
    client,
    child,
    (task) => task.runs[0]?.state === 'working',
    'to start after its child merges',
  )
  expect(Date.parse(workingChild.startedAt ?? '')).toBeGreaterThanOrEqual(
    Date.parse(mergedLeaf.merged?.at ?? ''),
  )
  expect((await getTask(client, parent.id)).runs).toEqual([])
  const candidate = await create(client, 'New child')
  await expect(parentOf(app, candidate, child)).rejects.toThrow('Stop the parent')
  expect((await getTask(client, child.id)).leadRunId).toBe(workingChild.leadRunId)
  await writeFile(childGate, 'go')
  const mergedChild = await waitFor(
    client,
    child,
    (task) => task.stage === 'done',
    'to merge after its child',
  )
  const workingParent = await waitFor(
    client,
    parent,
    (task) => task.runs[0]?.state === 'working',
    'to start after its children merge',
  )
  expect(Date.parse(workingParent.startedAt ?? '')).toBeGreaterThanOrEqual(
    Date.parse(mergedChild.merged?.at ?? ''),
  )
  await expect(parentOf(app, waived, null)).rejects.toThrow('Stop the parent')
  expect((await getTask(client, parent.id)).leadRunId).toBe(workingParent.leadRunId)
  await expect(app.unarchiveTask(waived.id)).rejects.toThrow('Stop the parent')
  await expect(
    withHierarchyRevision(app, waived, (hierarchyRevision) =>
      app.unarchiveTask(waived.id, { unlinkParent: true, hierarchyRevision }),
    ),
  ).rejects.toThrow('Stop the parent')
  await writeFile(parentGate, 'go')
  await waitFor(client, parent, (task) => task.stage === 'done', 'to finish its own Workflow')
  await expect(parentOf(app, candidate, parent)).rejects.toThrow('Done parents')
  await app.archiveTask(leaf.id)
  await app.unarchiveTask(leaf.id)
  expect((await getTask(client, leaf.id)).parentId).toBe(child.id)
  await expect(app.unarchiveTask(waived.id)).rejects.toThrow('Done parents')
  await withHierarchyRevision(app, waived, (hierarchyRevision) =>
    app.unarchiveTask(waived.id, { unlinkParent: true, hierarchyRevision }),
  )
  expect((await getTask(client, waived.id)).parentId).toBeUndefined()
  expect((await getTask(client, waived.id)).archived).toBeUndefined()
  expect((await getTask(client, parent.id)).stage).toBe('done')
}, 60_000)

test('a queued parent is held before launch; Coordinator edits share app safety and scope while Task Leads keep manual-blocker authority', async () => {
  const client = await startTed()
  const app = await hierarchyApp()
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const holder = await create(client, steps({ waitFor: path.join(scratch, 'hold-slot') }), {
    start: true,
  })
  const working = await waitFor(
    client,
    holder,
    (task) => task.runs[0]?.state === 'working',
    'to hold the slot',
  )
  const parent = await create(client, steps({ endTurn: true }), { start: true })
  expect(parent.status?.kind).toBe('queued')
  const child = await create(client, 'Child')
  await parentOf(app, child, parent)
  expect((await getTask(client, parent.id)).status?.kind).toBe('blocked')
  expect((await getTask(client, parent.id)).runs).toEqual([])
  await app.archiveTask(child.id)
  expect((await getTask(client, parent.id)).status?.kind).toBe('stopped')
  await app.unarchiveTask(child.id)
  await client.ok('POST', `/tasks/${parent.id}/resume`, {})
  expect((await getTask(client, parent.id)).runs).toEqual([])
  const newParent = await create(client, 'New parent')
  await expect(parentOf(app, newParent, holder)).rejects.toThrow('Stop the parent')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const lead = api(daemon?.port ?? 0, tokens.issue(working.leadRunId ?? ''))
  expect((await lead.call('GET', `/tasks/${holder.id}/hierarchy`)).status).toBe(200)
  expect((await lead.call('GET', `/tasks/${child.id}/hierarchy`)).status).toBe(403)
  expect(
    (
      await lead.call('PUT', `/tasks/${holder.id}/parent`, {
        parentId: newParent.id,
        revision: (await app.taskHierarchy(holder.id)).revision,
      })
    ).status,
  ).toBe(403)
  expect(
    (await lead.call('POST', `/tasks/${holder.id}/blockers`, { by: newParent.id })).status,
  ).toBe(200)
  expect((await lead.call('DELETE', `/tasks/${holder.id}/blockers`)).status).toBe(200)
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('missing daemon info')
  const fileClient = new DaemonClient(info)
  await expect(
    fileClient.setTaskParent(child.id, {
      parentId: newParent.id,
      revision: (await app.taskHierarchy(child.id)).revision,
    }),
  ).rejects.toThrow()

  await client.ok('PATCH', '/settings', { maxWorkingRuns: 3 })
  const factory = (await client.ok<Factory[]>('GET', '/factories')).find((f) => f.key === 'NB')
  if (!factory) throw new Error('no Factory')
  const chat = await client.ok<Coordinator>(
    'POST',
    `/factories/${factory.id}/coordinator/messages`,
    {
      text: steps({ waitFor: path.join(scratch, 'coordinator-finish') }),
      agent: 'claude',
    },
  )
  await waitUntil(async () => {
    const current = await client.ok<Coordinator>('GET', `/factories/${factory.id}/coordinator`)
    return current.started && current.status === 'working' ? current : undefined
  }, 'Coordinator to start')
  const coordinator = api(daemon?.port ?? 0, tokens.issue(chat.runId))
  const read = async () => {
    const response = await coordinator.call('GET', `/coordinator/tasks/${child.id}`)
    const context = response.body.context as string
    return JSON.parse(context.split('\n').slice(1, -1).join('\n')) as CoordinatorTask
  }
  const current = await read()
  expect(current.hierarchy.parentId).toBe(parent.id)
  const input = {
    operation: 'reparent-child',
    version: current.version,
    parentId: newParent.id,
    hierarchyRevision: current.hierarchy.revision,
  }
  const result = await coordinator.call('POST', `/coordinator/tasks/${child.id}/parent`, input)
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ operation: 'parent', after: { parentId: newParent.id } })
  expect(
    (await coordinator.call('POST', `/coordinator/tasks/${child.id}/parent`, input)).body,
  ).toEqual(result.body)
  const stale = await coordinator.call('POST', `/coordinator/tasks/${child.id}/parent`, {
    ...input,
    operation: 'stale-reparent',
  })
  expect(stale.status).toBe(409)
  const otherDirectory = path.join(scratch, 'outside-factory')
  await mkdir(otherDirectory)
  const otherOrigin = await makeOriginRepo(otherDirectory)
  const otherRepo = path.join(otherDirectory, 'acme', 'gadgets.git')
  await rename(otherOrigin, otherRepo)
  await client.ok('POST', '/dev/factories', { repo: otherRepo, key: 'OUT' })
  const foreign = await client.ok<Task>('POST', '/tasks', { title: 'Foreign', factory: 'OUT' })
  const beforeForeign = await read()
  expect(
    (
      await coordinator.call('POST', `/coordinator/tasks/${child.id}/parent`, {
        ...input,
        operation: 'foreign-parent',
        version: beforeForeign.version,
        parentId: foreign.id,
        hierarchyRevision: beforeForeign.hierarchy.revision,
      })
    ).status,
  ).toBe(404)
  const beforeUnlink = await read()
  const output: string[] = []
  const errors: string[] = []
  expect(
    await runCli(
      [
        'coordinator',
        'parent',
        child.displayId,
        'none',
        '--operation',
        'unlink-child',
        '--version',
        beforeUnlink.version,
        '--hierarchy-revision',
        beforeUnlink.hierarchy.revision,
      ],
      {
        home,
        env: { ...process.env },
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
        stdin: async () => {
          throw new Error('Coordinator hierarchy commands must not read stdin')
        },
        connect: async (_home, work) => work(new DaemonClient(info, tokens.issue(chat.runId))),
      },
    ),
  ).toBe(0)
  expect(errors).toEqual([])
  expect(JSON.parse(output.join(''))).toMatchObject({ operation: 'parent', taskId: child.id })
  expect((await app.taskHierarchy(child.id)).parentId).toBeNull()
  expect((await getTask(client, parent.id)).runs).toEqual([])
  const queuedChildGate = path.join(scratch, 'queued-child-finish')
  const queuedChild = await create(client, doneWhen(queuedChildGate))
  await parentOf(app, queuedChild, parent)
  await client.ok('POST', `/tasks/${parent.id}/resume`, {})
  await client.ok('POST', `/tasks/${queuedChild.id}/start`)
  await waitFor(
    client,
    queuedChild,
    (task) => task.runs[0]?.state === 'working',
    'to run ahead of its queued parent',
  )
  expect((await getTask(client, parent.id)).runs).toEqual([])
  await writeFile(queuedChildGate, 'go')
  await waitFor(
    client,
    queuedChild,
    (task) => task.stage === 'done',
    'to merge and release its queued parent',
  )
  await waitFor(
    client,
    parent,
    (task) => task.runs[0]?.state === 'idle',
    'to launch only after its child merges',
  )
})
