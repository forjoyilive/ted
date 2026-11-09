import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Comment, Factory, Run, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  refsOf,
  stubClaudePath,
  tokenFor,
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

async function startWithStub() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startWithStub>>

const addFactory = (client: Client, key = 'NB') =>
  client.ok<Factory>('POST', '/dev/factories', { repo: origin, key })

const createTask = (client: Client, title: string, factory = 'NB') =>
  client.ok<Task>('POST', '/tasks', { title, factory })

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

const commandResults = async (client: Client, runId: string) =>
  assistantTexts((await client.getRun(runId)).conversation).map(
    (text) => JSON.parse(text) as { code: number; stderr: string },
  )

const leadRun = async (client: Client, task: Task): Promise<Run> => {
  const current = await getTask(client, task.id)
  if (!current?.leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return (await client.getRun(current.leadRunId)).run
}

describe('Factories', () => {
  test('adding a Factory clones its repo into TED_HOME/repos and leaves the source untouched', async () => {
    const client = await startWithStub()
    const before = await refsOf(origin)

    const factory = await addFactory(client)

    expect(factory).toMatchObject({ key: 'NB', repo: 'acme/widgets', defaultBranch: 'main' })
    const clone = path.join(home, 'repos', 'acme', 'widgets')
    expect(await readFile(path.join(clone, 'README.md'), 'utf8')).toBe('# widgets\n')
    expect(await refsOf(origin)).toBe(before)
  })

  test('a Factory key must be 2 to 5 uppercase letters or digits and unused', async () => {
    const client = await startWithStub()
    await addFactory(client)

    for (const key of ['N', 'nb', '1AB', 'TOOLONG']) {
      const res = await client.call('POST', '/dev/factories', { repo: origin, key })
      expect(res.status, key).toBe(400)
    }
    const again = await client.call('POST', '/dev/factories', { repo: origin, key: 'NB' })
    expect(again.status).toBe(409)
  })

  test('two Factories added at once can’t share a key', async () => {
    const client = await startWithStub()
    const otherOrigin = await makeOriginRepo(path.join(scratch, 'other'))
    const renamed = path.join(scratch, 'other', 'acme', 'gadgets.git')
    await execFileAsync('mv', [otherOrigin, renamed])

    const results = await Promise.all([
      client.call('POST', '/dev/factories', { repo: origin, key: 'NB' }),
      client.call('POST', '/dev/factories', { repo: renamed, key: 'NB' }),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
  })

  test('Task IDs count from 1 in each Factory', async () => {
    const client = await startWithStub()
    await addFactory(client)

    const first = await createTask(client, 'One')
    const dev = await client.ok<Task>('POST', '/tasks', { title: 'Elsewhere' })
    const second = await createTask(client, 'Two')

    expect([first.displayId, dev.displayId, second.displayId]).toEqual(['NB-1', 'DEV-1', 'NB-2'])
    expect(first.stage).toBe('backlog')
  })
})

describe('Tasks', () => {
  test('starting a Task makes its branch and worktree and starts the Task Lead there', async () => {
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, `Fix login ${steps({ endTurn: true })}`)

    const started = await client.ok<Task>('POST', `/tasks/${task.displayId}/start`)

    expect(started.stage).toBe('work')
    expect(started.branch).toMatch(/^ted\/nb-1-fix-login/)
    const worktree = path.join(home, 'worktrees', 'NB-1', 'widgets')
    expect(await readFile(path.join(worktree, 'README.md'), 'utf8')).toBe('# widgets\n')
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: worktree })
    expect(stdout.trim()).toBe(started.branch)

    const run = await leadRun(client, task)
    expect(run.cwd).toBe(worktree)
    expect(run.taskId).toBe(task.id)
    const record = await waitUntil(
      () =>
        readFile(path.join(worktree, 'stub-record.json'), 'utf8')
          .then((s) => JSON.parse(s) as { env: Record<string, string> })
          .catch(() => undefined),
      'the Task Lead to start',
    )
    expect(record.env.TED_TASK).toBe('NB-1')
    expect(record.env.TED_RUN).toBe(run.id)
  })

  test('the Task Lead’s first message holds the preamble and the Work Stage file', async () => {
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, `Fix login ${steps({ endTurn: true })}`)

    await client.ok('POST', `/tasks/${task.id}/start`)

    const run = await leadRun(client, task)
    const first = await waitUntil(async () => {
      const { conversation } = await client.getRun(run.id)
      return conversation[0]
    }, 'the first message')
    const content = (JSON.parse(first.line) as { message: { content: string } }).message.content
    expect(content).toContain('ted help')
    expect(content).toContain('ted comment')
    expect(content).toContain('ted outcome advance')
    expect(content).toContain('# Work')
    expect(content).toContain('Fix login')
  })

  test('a Task with no repo can’t start', async () => {
    const client = await startWithStub()
    const task = await client.ok<Task>('POST', '/tasks', { title: 'Nowhere' })

    const res = await client.call('POST', `/tasks/${task.id}/start`)

    expect(res.status).toBe(409)
  })

  test('create, start, comment, advance: the Task lands in Done and its worktree is gone', async () => {
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(
      client,
      steps(
        { run: ['ted', 'comment', 'Halfway there'] },
        { run: ['ted', 'outcome', 'advance'] },
        { waitFor: 'never-appears' },
      ),
    )

    await client.ok('POST', `/tasks/${task.displayId}/start`)

    const done = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t?.stage === 'done' ? t : undefined
    }, 'the Task to reach Done')
    expect(done.displayId).toBe('NB-1')
    const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    expect(comments).toMatchObject([{ kind: 'note', body: 'Halfway there' }])

    const run = await leadRun(client, task)
    await waitUntil(async () => {
      const { run: r } = await client.getRun(run.id)
      return r.state === 'finished'
    }, 'the Task Lead’s Run to stop')
    await waitUntil(
      async () => !(await exists(path.join(home, 'worktrees', 'NB-1'))),
      'the worktree to be removed',
    )
    const clone = path.join(home, 'repos', 'acme', 'widgets')
    const { stdout } = await execFileAsync('git', ['worktree', 'list'], { cwd: clone })
    expect(stdout.trim().split('\n')).toHaveLength(1)
  })

  test('a Run may comment on and advance only its own Task', async () => {
    const client = await startWithStub()
    await addFactory(client)
    const other = await createTask(client, 'Someone else’s')
    const task = await createTask(
      client,
      steps(
        { run: ['ted', 'comment', '--task', 'NB-1', 'sneaky'] },
        { run: ['ted', 'outcome', 'advance', '--task', 'NB-1'] },
        { endTurn: true },
      ),
    )

    await client.ok('POST', `/tasks/${task.displayId}/start`)

    const run = await leadRun(client, task)
    await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle')
    expect(await commandResults(client, run.id)).toEqual([
      { code: 1, stdout: '', stderr: 'ted: this Run doesn’t belong to NB-1\n' },
      { code: 1, stdout: '', stderr: 'ted: this Run doesn’t belong to NB-1\n' },
    ])
    expect(await client.ok<Comment[]>('GET', `/tasks/${other.id}/comments`)).toEqual([])
    expect((await getTask(client, other.id))?.stage).toBe('backlog')
    expect((await getTask(client, task.id))?.stage).toBe('work')
  })

  test('a Run that isn’t on the Task can’t report its outcome', async () => {
    const client = await startWithStub()
    await addFactory(client)
    const task = await createTask(client, steps({ endTurn: true }))
    await client.ok('POST', `/tasks/${task.displayId}/start`)
    const cwd = await mkdtemp(path.join(scratch, 'dev-run-'))

    const devRun = await client.startRun(
      [{ run: ['ted', 'outcome', 'advance', '--task', 'NB-1'] }, { endTurn: true }],
      cwd,
    )

    await waitUntil(async () => (await client.getRun(devRun.id)).run.state === 'idle', 'idle')
    expect(await commandResults(client, devRun.id)).toEqual([
      { code: 1, stdout: '', stderr: 'ted: this Run doesn’t belong to NB-1\n' },
    ])
    expect((await getTask(client, task.id))?.stage).toBe('work')
  })
})
