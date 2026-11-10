import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type DaemonClient,
  DaemonRequestError,
  readDaemonInfo,
  type Task,
  type ThreadEvent,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  appClient,
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-edit-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(): Promise<DaemonClient> {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  const client = appClient(info, daemon.appToken)
  await client.addFactory({ repo: origin, key: 'NB' })
  return client
}

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) =>
      error instanceof DaemonRequestError
        ? { status: error.status, message: error.message }
        : error,
  )

const getTask = async (client: DaemonClient, id: string) => {
  const task = (await client.listTasks()).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const edits = async (client: DaemonClient, task: Task): Promise<ThreadEvent[]> =>
  (await client.listThreadEvents(task.id)).filter((e) => e.tone === 'edit')

const userMessages = async (client: DaemonClient, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

describe('Editing a Task', () => {
  test('each description edit is a new version, and the Original request never changes', async () => {
    const client = await start()
    const task = await client.createTask({
      factory: 'NB',
      title: 'Search ignores accents',
      description: 'Typing cafe should find Café.\nOnly in note titles.',
      start: false,
    })

    const edited = await client.editTask(task.id, {
      description: 'Typing cafe should find Café.\nIn titles and bodies.',
    })
    expect(edited).toMatchObject({
      title: 'Search ignores accents',
      description: 'Typing cafe should find Café.\nIn titles and bodies.',
    })
    await client.editTask(task.id, {
      description: 'Typing cafe should find Café.\nIn titles, bodies and tags.',
    })

    const versions = await client.taskDescriptions(task.id)
    expect(versions.map(({ version, text }) => ({ version, text }))).toEqual([
      { version: 1, text: 'Typing cafe should find Café.\nOnly in note titles.' },
      { version: 2, text: 'Typing cafe should find Café.\nIn titles and bodies.' },
      { version: 3, text: 'Typing cafe should find Café.\nIn titles, bodies and tags.' },
    ])
    expect((await getTask(client, task.id)).description).toBe(
      'Typing cafe should find Café.\nIn titles, bodies and tags.',
    )

    const lines = await edits(client, task)
    expect(lines.map((e) => e.text)).toEqual([
      'You edited the description',
      'You edited the description',
    ])
    expect(lines[0]?.changes?.lines).toEqual([
      { kind: 'context', text: 'Typing cafe should find Café.' },
      { kind: 'removed', text: 'Only in note titles.' },
      { kind: 'added', text: 'In titles and bodies.' },
    ])
  })

  test('a title change is a thread line too; an edit that changes nothing records nothing', async () => {
    const client = await start()
    const task = await client.createTask({
      factory: 'NB',
      title: 'Search ignores accents',
      description: 'Typing cafe should find Café.',
      start: false,
    })

    const renamed = await client.editTask(task.id, { title: '  Search ignores diacritics ' })
    expect(renamed.title).toBe('Search ignores diacritics')
    await client.editTask(task.id, {
      title: 'Search ignores diacritics',
      description: 'Typing cafe should find Café.',
    })
    await client.editTask(task.id, {
      title: 'Accent-blind search',
      description: 'Typing cafe should find Café and café.',
    })

    expect((await edits(client, task)).map((e) => e.text)).toEqual([
      'You renamed this Task to “Search ignores diacritics”',
      'You renamed this Task to “Accent-blind search” and edited the description',
    ])
    expect(await client.taskDescriptions(task.id)).toHaveLength(2)
  })

  test('a Task needs a title, an archived Task can’t be edited, and only the app can edit', async () => {
    const client = await start()
    const task = await client.createTask({
      factory: 'NB',
      title: 'Search ignores accents',
      description: 'Typing cafe should find Café.',
      start: false,
    })

    expect(await failure(client.editTask(task.id, { title: '   ' }))).toMatchObject({
      status: 400,
    })
    expect(await failure(client.editTask(task.id, {}))).toMatchObject({ status: 400 })

    const fileToken = api(daemon?.port ?? 0, await tokenFor(home))
    expect(
      await fileToken.call('PUT', `/tasks/${task.id}`, { description: 'Something else' }),
    ).toEqual({ status: 403, body: { error: 'only the TED app can do this' } })

    await client.archiveTask(task.id)
    expect(
      await failure(client.editTask(task.id, { description: 'Something else' })),
    ).toMatchObject({ status: 409 })
    expect(await client.taskDescriptions(task.id)).toHaveLength(1)
  })

  test('the live Task Lead gets the edit as a Comment with the diff', async () => {
    const client = await start()
    const task = await client.createTask({
      factory: 'NB',
      title: steps({ endTurn: true }),
      description: 'Make search ignore accents.\nTitles only.',
      start: true,
    })
    const started = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t.leadRunId !== undefined && t.runs.some((r) => r.state === 'idle') ? t : undefined
    }, 'the Task Lead to be idle')

    await client.editTask(task.id, {
      description: 'Make search ignore accents.\nTitles and bodies.',
    })

    const message = await waitUntil(
      async () =>
        (await userMessages(client, started.leadRunId ?? '')).find((m) =>
          m.includes('The user edited this Task’s description'),
        ),
      'the edit to reach the Task Lead',
    )
    expect(message).toContain('- Titles only.')
    expect(message).toContain('+ Titles and bodies.')
    expect(message).toContain('  Make search ignore accents.')
  })

  test('a new Task Lead Run gets the Original request next to the current description', async () => {
    const client = await start()
    const task = await client.createTask({
      factory: 'NB',
      title: steps({ endTurn: true }),
      description: 'Make search ignore accents.',
      start: false,
    })
    await client.editTask(task.id, { description: 'Make search ignore accents and case.' })
    await client.startTask(task.id)

    const started = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t.leadRunId !== undefined ? t : undefined
    }, 'the Task Lead to start')
    const { run } = await client.getRun(started.leadRunId ?? '')
    expect(run.prompt).toContain('Make search ignore accents and case.')
    expect(run.prompt).toContain('# Original request')
    const original = run.prompt.slice(run.prompt.indexOf('# Original request'))
    expect(original).toContain('Make search ignore accents.')
  })

  test('an unedited Task’s prompt has no Original request section', async () => {
    const client = await start()
    const task = await client.createTask({
      factory: 'NB',
      title: steps({ endTurn: true }),
      description: 'Make search ignore accents.',
      start: true,
    })
    const started = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t.leadRunId !== undefined ? t : undefined
    }, 'the Task Lead to start')
    const { run } = await client.getRun(started.leadRunId ?? '')
    expect(run.prompt).not.toContain('# Original request')
  })

  test('changing Clarify depth after Clarify is refused with the reason, and changes nothing', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, clarify, work]\n',
    })
    const client = await start()
    const task = await client.createTask({
      factory: 'NB',
      title: steps(
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'clarify', 'depth', 'none', 'nothing to ask'] },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ),
      description: 'Make search ignore accents.',
      start: true,
    })
    await waitUntil(
      async () => ((await getTask(client, task.id)).stage === 'work' ? true : undefined),
      'the Task to reach Work',
    )

    expect(await failure(client.setClarifyDepth(task.id, { depth: 'grilling' }))).toEqual({
      status: 409,
      message: 'Clarify is over for NB-1, so changing its Clarify depth would do nothing',
    })
    expect(await getTask(client, task.id)).toMatchObject({
      clarifyDepth: 'none',
      clarifyDepthBy: 'task-lead',
    })
  })
})
