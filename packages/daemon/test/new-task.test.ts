import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Attachment,
  type DaemonClient,
  DaemonRequestError,
  type Factory,
  type NewTaskDraft,
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
    expect(plain.lead).toMatchObject({ agent: 'claude' })
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

    const soon = await client.createTask({
      factory: 'NB',
      description: `Soon\n${steps({ endTurn: true })}`,
      start: true,
      startInBackground: true,
    })
    expect(soon.stage).toBe('intake')
    expect(soon.leadRunId).toBeUndefined()
    const listed = async () => (await client.listTasks()).find((task) => task.id === soon.id)
    await expect.poll(async () => (await listed())?.leadRunId).toEqual(expect.any(String))
    expect((await listed())?.stage).toBe('intake')
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

    expect(await client.taskDefaults(factory.id)).toMatchObject({
      lead: { agent: 'claude', model: 'opus', effort: 'high' },
      planner: { agent: 'claude', model: 'sonnet', effort: 'max' },
      clarifyDepth: 'few',
    })
  })

  test('with nothing set, the lead is the default agent and Clarify depth is Auto', async () => {
    const { client, factory } = await withFactory()

    expect(await client.taskDefaults(factory.id)).toMatchObject({
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

const draft = (changes: Partial<NewTaskDraft> = {}): NewTaskDraft => ({
  revision: 'draft-1',
  title: 'Draft title',
  description: 'Unfinished',
  priority: 'high',
  blockedBy: [],
  attachments: [],
  start: false,
  moreOpen: true,
  clarifyDepth: 'few',
  lead: { agent: 'codex', model: 'gpt-5.5', effort: 'medium' },
  dismissed: [],
  filled: {},
  ...changes,
})

describe('durable New Task drafts', () => {
  test('round trips every field across a daemon restart, independently per Factory', async () => {
    const { client, factory } = await withFactory()
    const file = await client.uploadAttachment(
      { name: 'draft.txt', mediaType: 'text/plain' },
      bytes('draft bytes'),
    )
    const blocker = await client.createTask({ factory: 'NB', title: 'Blocker' })
    const saved = draft({
      attachments: [file],
      blockedBy: [blocker.id],
      source: 'https://linear.app/kriyadesign/issue/KRI-229',
      dismissed: ['https://linear.app/kriyadesign/issue/KRI-228'],
      filled: { title: 'Linear title', priority: 'low' },
    })
    expect(await client.saveTaskDraft(factory.id, saved)).toEqual({ draft: saved })
    await daemon?.stop()
    daemon = undefined
    const restarted = await start()
    expect(await restarted.taskDraft(factory.id)).toEqual({ draft: saved })
    const otherOrigin = await makeOriginRepo(path.join(scratch, 'other'))
    const otherRepo = path.join(path.dirname(otherOrigin), 'other.git')
    await rename(otherOrigin, otherRepo)
    const other = await restarted.addFactory({ repo: otherRepo, key: 'OTHER' })
    expect(await restarted.taskDraft(other.id)).toEqual({ draft: null })
    await restarted.saveTaskDraft(other.id, draft({ title: 'Other draft' }))
    expect(await restarted.taskDraft(factory.id)).toEqual({ draft: saved })
  })

  test('failed creation keeps a draft; successful creation clears it atomically and rejects a late copy', async () => {
    const { client, factory } = await withFactory()
    const saved = draft()
    await client.saveTaskDraft(factory.id, saved)
    expect(
      await statusOf(
        client.createTask({ factory: 'NB', title: '', draftRevision: saved.revision }),
      ),
    ).toBe(400)
    expect(await client.taskDraft(factory.id)).toEqual({ draft: saved })
    await client.createTask({
      factory: 'NB',
      description: saved.description,
      draftRevision: saved.revision,
    })
    expect(await client.taskDraft(factory.id)).toEqual({
      draft: null,
      clearedRevision: saved.revision,
      clearedRevisions: [saved.revision],
    })
    expect(await client.saveTaskDraft(factory.id, saved)).toEqual({
      draft: null,
      clearedRevision: saved.revision,
      clearedRevisions: [saved.revision],
    })
    await daemon?.stop()
    daemon = undefined
    expect(await (await start()).taskDraft(factory.id)).toEqual({
      draft: null,
      clearedRevision: saved.revision,
      clearedRevisions: [saved.revision],
    })
  })

  test('submitting an older revision preserves a newer draft and remembers both submissions across restart', async () => {
    const { client, factory } = await withFactory()
    const older = draft({ revision: 'older' })
    const newer = draft({ revision: 'newer', description: 'Keep newer work' })
    await client.saveTaskDraft(factory.id, older)
    await client.saveTaskDraft(factory.id, newer)
    await client.createTask({
      factory: 'NB',
      description: older.description,
      draftRevision: older.revision,
      start: false,
    })
    expect((await client.taskDraft(factory.id)).draft).toEqual(newer)
    expect((await client.saveTaskDraft(factory.id, older)).draft).toEqual(newer)
    await client.createTask({
      factory: 'NB',
      description: newer.description,
      draftRevision: newer.revision,
      start: false,
    })
    const current = draft({ revision: 'current', description: 'Next unfinished Task' })
    await client.saveTaskDraft(factory.id, current)
    await daemon?.stop()
    daemon = undefined
    const restarted = await start()
    for (const submitted of [older, newer]) {
      expect((await restarted.saveTaskDraft(factory.id, submitted)).draft).toEqual(current)
    }
    expect((await restarted.taskDraft(factory.id)).clearedRevisions).toEqual([
      older.revision,
      newer.revision,
    ])
  })

  test('drafts protect uploaded bytes when a Task sharing the attachment is deleted', async () => {
    const { client, factory } = await withFactory()
    const file = await client.uploadAttachment(
      { name: 'shared.txt', mediaType: 'text/plain' },
      bytes('shared draft'),
    )
    const task = await client.createTask({ factory: 'NB', title: 'Delete me', attachments: [file] })
    await client.saveTaskDraft(factory.id, draft({ attachments: [file] }))
    await client.deleteTask(task.id)
    const created = await client.createTask({
      factory: 'NB',
      title: 'From draft',
      attachments: [file],
      draftRevision: 'draft-1',
    })
    expect(created.attachments).toEqual([file])
  })

  test('draft routes refuse file and Run tokens, reject invalid data, and clear Factory data on removal', async () => {
    const { client, factory } = await withFactory()
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon')
    const path = `/factories/${factory.id}/task-draft`
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('draft-run')
    for (const token of [info.token, runToken]) {
      expect(
        (await rawRequest(info.port, { path, headers: { authorization: `Bearer ${token}` } }))
          .status,
      ).toBe(403)
      expect(
        (
          await rawRequest(info.port, {
            method: 'PUT',
            path,
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(draft()),
          })
        ).status,
      ).toBe(403)
    }
    expect(
      (await rawRequest(info.port, { path, headers: { authorization: `Bearer ${runToken}` } }))
        .status,
    ).toBe(403)
    expect(
      await statusOf(client.saveTaskDraft(factory.id, draft({ priority: 'invalid' as never }))),
    ).toBe(400)
    expect(
      await statusOf(
        client.saveTaskDraft(
          factory.id,
          draft({
            attachments: [
              { hash: 'a'.repeat(64), name: 'ghost', mediaType: 'text/plain', size: 1 },
            ],
          }),
        ),
      ),
    ).toBe(400)
    await client.saveTaskDraft(factory.id, draft())
    await client.removeFactory(factory.id, { key: factory.key, closePullRequests: true })
    expect(await statusOf(client.taskDraft(factory.id))).toBe(404)
  })
})

describe('unsent message text', () => {
  test('is kept per box across a restart and deleted with its request, Task and Factory', async () => {
    const { client, factory } = await withFactory()
    const file = await client.uploadAttachment(
      { name: 'unsent.txt', mediaType: 'text/plain' },
      bytes('unsent bytes'),
    )
    const task = await client.createTask({ factory: 'NB', title: 'Has unsent text', start: false })
    const other = await client.createTask({ factory: 'NB', title: 'Other', start: false })
    const comment = { kind: 'comment', id: task.id } as const
    const kept = { text: 'Not sent yet', attachments: [file] }
    expect(await client.saveMessageDraft(comment, kept)).toEqual({ draft: kept })
    expect(
      await client.saveMessageDraft(
        { kind: 'follow-up', id: task.displayId },
        { text: 'Later', attachments: [file], fields: '{"a":1}' },
      ),
    ).toEqual({ draft: { text: 'Later', attachments: [], fields: '{"a":1}' } })
    await client.saveMessageDraft(
      { kind: 'coordinator', id: factory.id },
      { text: 'What next?', attachments: [] },
    )
    await client.saveMessageDraft(
      { kind: 'new-plan', id: factory.id },
      { text: 'Plan this', attachments: [] },
    )
    expect(await client.messageDraft({ kind: 'comment', id: other.id })).toEqual({ draft: null })
    expect(await statusOf(client.messageDraft({ kind: 'settings' as 'comment', id: 'a' }))).toBe(
      404,
    )
    expect(
      await client.saveMessageDraft(
        { kind: 'run', id: 'no-such-run' },
        { text: 'x', attachments: [] },
      ),
    ).toEqual({ draft: null, refused: 'no such Run' })
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    expect(
      (
        await rawRequest(info.port, {
          path: `/message-drafts/comment/${task.id}`,
          headers: { authorization: `Bearer ${info.token}` },
        })
      ).status,
    ).toBe(403)

    await daemon?.stop()
    daemon = undefined
    const restarted = await start()
    expect(await restarted.messageDraft(comment)).toEqual({ draft: kept })
    expect(await restarted.messageDraft({ kind: 'follow-up', id: task.id })).toMatchObject({
      draft: { text: 'Later' },
    })
    expect(
      await restarted.saveMessageDraft(
        { kind: 'follow-up', id: task.id },
        { text: '', attachments: [] },
      ),
    ).toEqual({ draft: null })
    expect(await restarted.messageDraft({ kind: 'follow-up', id: task.id })).toEqual({
      draft: null,
    })

    const asking = await restarted.createTask({
      factory: 'NB',
      title: steps({ run: ['ted', 'comment', '--choice', 'Yes', '--choice', 'No', 'Go on?'] }),
      start: true,
    })
    const question = await waitUntil(
      async () => (await restarted.listComments(asking.id)).find((c) => c.kind === 'question'),
      'the Task Lead’s question',
    )
    const request = { kind: 'request', id: question.id } as const
    const answer = { text: 'Because', attachments: [], fields: '{"selection":{"choice":"Yes"}}' }
    expect(await restarted.saveMessageDraft(request, answer)).toEqual({ draft: answer })
    const lead = (await restarted.listTasks()).find((t) => t.id === asking.id)?.leadRunId ?? ''
    const chat = { kind: 'run', id: lead } as const
    await restarted.saveMessageDraft(chat, { text: 'To the Run', attachments: [] })
    await restarted.answerRequest(question.id, { action: 'answer', choice: 'Yes' })
    expect(await restarted.messageDraft(request)).toEqual({ draft: null })
    expect(await restarted.saveMessageDraft(request, answer)).toEqual({
      draft: null,
      refused: 'this request is already answered',
    })
    expect(await restarted.messageDraft(chat)).toMatchObject({ draft: { text: 'To the Run' } })

    await restarted.archiveTask(asking.id)
    expect(await restarted.messageDraft(chat)).toEqual({ draft: null })
    await restarted.archiveTask(task.id)
    expect(await restarted.messageDraft(comment)).toEqual({ draft: null })
    expect(await restarted.saveMessageDraft(comment, kept)).toEqual({
      draft: null,
      refused: 'an archived Task keeps no unsent text',
    })
    await restarted.unarchiveTask(task.id)
    expect(await restarted.messageDraft(comment)).toEqual({ draft: null })

    await restarted.saveMessageDraft(comment, kept)
    const stored = path.join(tedPaths(home).attachments, `${file.hash}.txt`)
    expect(await readFile(stored, 'utf8')).toBe('unsent bytes')
    await restarted.deleteTask(task.id)
    expect(await restarted.messageDraft(comment)).toEqual({ draft: null })
    await waitUntil(
      async () =>
        (await readFile(stored).then(
          () => false,
          () => true,
        )) || undefined,
      'the deleted Task’s unsent file to be removed',
    )

    await restarted.removeFactory(factory.id, { key: 'NB', closePullRequests: false })
    expect(await restarted.messageDraft({ kind: 'coordinator', id: factory.id })).toEqual({
      draft: null,
    })
    expect(await restarted.messageDraft({ kind: 'new-plan', id: factory.id })).toEqual({
      draft: null,
    })
  })
})
