import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Attachment,
  type DaemonClient,
  DaemonRequestError,
  type Factory,
  readDaemonInfo,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  appClient,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

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

async function start(): Promise<DaemonClient> {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, daemon?.appToken)
}

async function withFactory(): Promise<{ client: DaemonClient; factory: Factory }> {
  const client = await start()
  const factory = await client.addFactory({ repo: origin, key: 'NB' })
  return { client, factory }
}

const statusOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error: unknown) => (error instanceof DaemonRequestError ? error.status : -1),
  )

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const bytes = (text: string) => new TextEncoder().encode(text)

describe('creating a Task from the New Task dialog', () => {
  test('a blank title takes the description’s first line', async () => {
    const { client } = await withFactory()

    const task = await client.createTask({
      factory: 'NB',
      title: '  ',
      description: '\n  Search ignores accents  \nTyping “cafe” should find “Café”.',
    })

    expect(task.title).toBe('Search ignores accents')
    expect(task.description).toBe('Search ignores accents  \nTyping “cafe” should find “Café”.')
  })

  test('a Task needs a title or a description', async () => {
    const client = await start()

    expect(await statusOf(client.createTask({ title: ' ', description: ' \n ' }))).toBe(400)
  })

  test('Priority, Clarify depth and Task Lead are stored; the defaults are None and Auto', async () => {
    const { client } = await withFactory()

    const plain = await client.createTask({ factory: 'NB', description: 'Plain' })
    const set = await client.createTask({
      factory: 'NB',
      description: 'Set',
      priority: 'high',
      clarifyDepth: 'grilling',
      lead: { agent: 'codex', model: 'gpt-5.5', effort: 'medium' },
    })

    expect(plain).toMatchObject({ priority: 'none', clarifyDepth: 'auto', blockedBy: [] })
    expect(plain.lead).toEqual({ agent: 'claude' })
    expect(set).toMatchObject({
      priority: 'high',
      clarifyDepth: 'grilling',
      lead: { agent: 'codex', model: 'gpt-5.5', effort: 'medium' },
    })
    expect((await client.listTasks()).find((t) => t.id === set.id)).toEqual(set)
  })

  test('unknown Priority, Clarify depth or Task Lead values are refused', async () => {
    const { client } = await withFactory()
    const bad = [
      { priority: 'p0' },
      { clarifyDepth: 'deep' },
      { lead: { agent: 'gemini' } },
      { lead: { agent: 'claude', effort: 'huge' } },
      { lead: { agent: 'claude', model: 3 } },
      { blockedBy: 'NB-1' },
      { start: 'yes' },
    ]

    for (const fields of bad) {
      const status = await statusOf(
        client.createTask({ factory: 'NB', description: 'x', ...fields } as never),
      )
      expect(status, JSON.stringify(fields)).toBe(400)
    }
  })

  test('Start now starts the Task at Intake; unchecked, it waits in Backlog', async () => {
    const { client } = await withFactory()

    const later = await client.createTask({ factory: 'NB', description: 'Later', start: false })
    const now = await client.createTask({
      factory: 'NB',
      description: `Now\n${steps({ endTurn: true })}`,
      start: true,
    })

    expect(later.stage).toBe('backlog')
    expect(now.stage).toBe('intake')
    expect(now.leadRunId).toBeDefined()
  })

  test('the Task Lead gets the description, the chosen Clarify depth and the attachment paths', async () => {
    const { client } = await withFactory()
    const shot = await client.uploadAttachment(
      { name: 'cafe.png', mediaType: 'image/png' },
      bytes('png bytes'),
    )

    const task = await client.createTask({
      factory: 'NB',
      title: 'Search ignores accents',
      description: `Typing cafe should find Café.\n${steps({ endTurn: true })}`,
      attachments: [shot],
      clarifyDepth: 'few',
      start: true,
    })

    if (!task.leadRunId) throw new Error('no Task Lead')
    const first = await waitUntil(
      async () => (await client.getRun(task.leadRunId ?? '')).conversation[0],
      'the first message',
    )
    const content = (JSON.parse(first.line) as { message: { content: string } }).message.content
    expect(content).toContain('Typing cafe should find Café.')
    expect(content).toContain(path.join(home, 'attachments', `${shot.hash}.png`))
    expect(content).toContain('Clarify depth: Few.')
  })

  test('the Task Lead runs the agent the dialog chose', async () => {
    const { client } = await withFactory()

    const task = await client.createTask({
      factory: 'NB',
      description: steps({ endTurn: true }),
      lead: { agent: 'codex' },
      start: true,
    })

    const lead = await client.getRun(task.leadRunId ?? '')
    expect(lead.run.agent).toBe('codex')
    await waitUntil(
      async () => (await client.getRun(lead.run.id)).conversation.length > 0 || undefined,
      'the Codex Task Lead to start',
    )
  })

  test('a blocker from any Factory is stored, and a blocked Task waits in Backlog even with Start now', async () => {
    const { client } = await withFactory()
    const other = await client.createTask({ title: 'Elsewhere' })

    const task = await client.createTask({
      factory: 'NB',
      description: 'After the other one',
      blockedBy: [other.displayId, other.id],
      start: true,
    })

    expect(task.stage).toBe('backlog')
    expect(task.blockedBy).toEqual([other.id])
    expect(task.leadRunId).toBeUndefined()
  })

  test('an unknown blocker is refused', async () => {
    const { client } = await withFactory()

    expect(
      await statusOf(client.createTask({ factory: 'NB', description: 'x', blockedBy: ['NB-9'] })),
    ).toBe(404)
  })

  test('with no start given, a Task waits in Backlog as before', async () => {
    const { client } = await withFactory()

    const task = await client.createTask({ factory: 'NB', title: 'From the CLI' })

    expect(task.stage).toBe('backlog')
    expect(task.description).toBe('')
  })

  test('with Backlog turned off, Start now unchecked still starts at Intake', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nstages:\n  backlog: { enabled: false }\n',
    })
    const { client } = await withFactory()

    const task = await client.createTask({
      factory: 'NB',
      description: steps({ endTurn: true }),
      start: false,
    })

    expect(task.stage).toBe('intake')
  })
})

describe('attachments', () => {
  test('are stored by content hash, once, and listed on the Task', async () => {
    const { client } = await withFactory()

    const first = await client.uploadAttachment(
      { name: 'notes.txt', mediaType: 'text/plain' },
      bytes('hello'),
    )
    const again = await client.uploadAttachment(
      { name: 'notes.txt', mediaType: 'text/plain' },
      bytes('hello'),
    )
    const task = await client.createTask({
      factory: 'NB',
      description: 'With a file',
      attachments: [first],
    })

    const hash = createHash('sha256').update('hello').digest('hex')
    expect(first).toEqual<Attachment>({ hash, name: 'notes.txt', size: 5, mediaType: 'text/plain' })
    expect(again).toEqual(first)
    expect(await readFile(path.join(home, 'attachments', `${hash}.txt`), 'utf8')).toBe('hello')
    expect(task.attachments).toEqual([first])
    expect((await client.listTasks()).find((t) => t.id === task.id)?.attachments).toEqual([first])
  })

  test('a name is reduced to its last path part and an odd media type to octet-stream', async () => {
    const client = await start()

    const file = await client.uploadAttachment(
      { name: '../../etc/pass\u0007wd', mediaType: 'not a type' },
      bytes('x'),
    )

    expect(file).toMatchObject({ name: 'passwd', mediaType: 'application/octet-stream' })
    expect(await readFile(path.join(home, 'attachments', file.hash), 'utf8')).toBe('x')
  })

  test('a Task can’t name an attachment that was never uploaded', async () => {
    const { client } = await withFactory()
    const missing = { hash: 'a'.repeat(64), name: 'ghost.png', mediaType: 'image/png' }
    const malformed = { hash: '../store', name: 'x', mediaType: 'text/plain' }

    for (const attachment of [missing, malformed]) {
      expect(
        await statusOf(
          client.createTask({ factory: 'NB', description: 'x', attachments: [attachment] }),
        ),
      ).toBe(400)
    }
  })

  test('uploads need a name and stay under the size limit', async () => {
    const client = await start()

    expect(await statusOf(client.uploadAttachment({ name: '', mediaType: '' }, bytes('x')))).toBe(
      400,
    )
    const huge = new Uint8Array(26 * 1024 * 1024)
    expect(await statusOf(client.uploadAttachment({ name: 'big.bin', mediaType: '' }, huge))).toBe(
      413,
    )
  })

  test('Runs can’t upload attachments or read Task defaults', async () => {
    const { factory } = await withFactory()
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = (method: string, route: string, body?: string) =>
      rawRequest(daemon?.port ?? 0, {
        method,
        path: route,
        headers: { authorization: `Bearer ${runToken}`, 'x-ted-name': 'a.txt' },
        ...(body !== undefined && { body }),
      })

    expect((await asRun('POST', '/attachments', 'x')).status).toBe(403)
    expect((await asRun('GET', `/factories/${factory.id}/task-defaults`)).status).toBe(403)
  })
})

describe('Task defaults', () => {
  test('come from the Factory’s lead and Clarify depth', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml':
        'version: 1\nlead: { agent: claude, model: opus, effort: high }\nplanner: { agent: claude, model: sonnet, effort: max }\nstages:\n  clarify: { depth: few }\n',
    })
    const { client, factory } = await withFactory()

    expect(await client.taskDefaults(factory.id)).toEqual({
      lead: { agent: 'claude', model: 'opus', effort: 'high' },
      planner: { agent: 'claude', model: 'sonnet', effort: 'max' },
      clarifyDepth: 'few',
    })
  })

  test('with nothing set, the lead is the default agent and Clarify depth is Auto', async () => {
    const { client, factory } = await withFactory()

    expect(await client.taskDefaults(factory.id)).toEqual({
      lead: { agent: 'claude' },
      planner: { agent: 'claude' },
      clarifyDepth: 'auto',
    })
  })

  test('an unknown Factory is a 404', async () => {
    const client = await start()

    expect(await statusOf(client.taskDefaults('nope'))).toBe(404)
  })
})
