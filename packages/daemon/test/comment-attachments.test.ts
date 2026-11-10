import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Attachment,
  type Comment,
  type DaemonClient,
  type Factory,
  readDaemonInfo,
  type Task,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  appClient,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-comment-files-'))
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
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  const app: DaemonClient = appClient(info, daemon.appToken)
  return { ...client, ok, app }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const bytes = (text: string) => new TextEncoder().encode(text)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

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

const runToken = async (task: Task) => {
  const record = JSON.parse(
    await readFile(
      path.join(home, 'worktrees', task.displayId, 'widgets', 'stub-record.json'),
      'utf8',
    ),
  ) as { env: Record<string, string> }
  return record.env.TED_RUN_CAPABILITY ?? ''
}

const uploadAs = (token: string, route: string, name: string, body: string) =>
  rawRequest(daemon?.port ?? 0, {
    method: 'POST',
    path: route,
    headers: {
      authorization: `Bearer ${token}`,
      'x-ted-name': name,
      'content-type': 'text/plain',
    },
    body,
  })

describe('an agent attaching files', () => {
  test('ted comment --attach stores the file by hash, once, and the Comment lists it', async () => {
    const client = await startTed()
    const shot = path.join(scratch, 'shot.png')
    await writeFile(shot, 'not really a png')
    const attach = ['ted', 'comment', '--attach', shot, 'Here is the screen']
    const task = await create(
      client,
      steps({ run: attach }, { run: ['ted', 'comment', '--attach', shot] }, { endTurn: true }),
      { start: true },
    )

    const posted = await waitUntil(async () => {
      const list = (await comments(client, task)).filter((c) => c.author.kind === 'run')
      return list.length === 2 ? list : undefined
    }, 'the agent’s two Comments')

    const hash = sha('not really a png')
    const expected: Attachment = { hash, name: 'shot.png', size: 16, mediaType: 'image/png' }
    expect(posted[0]).toMatchObject({ body: 'Here is the screen', attachments: [expected] })
    expect(posted[1]).toMatchObject({ body: '', attachments: [expected] })
    expect(await readdir(path.join(home, 'attachments'))).toEqual([`${hash}.png`])
  })

  test('a Run can attach only files it uploaded or its own Task already has', async () => {
    const client = await startTed()
    const own = await client.app.uploadAttachment(
      { name: 'brief.txt', mediaType: 'text/plain' },
      bytes('task file'),
    )
    const other = await client.app.uploadAttachment(
      { name: 'secret.txt', mediaType: 'text/plain' },
      bytes('someone else’s'),
    )
    const elsewhere = await create(client, 'Elsewhere')
    await client.ok('POST', `/tasks/${elsewhere.id}/comments`, {
      body: 'private',
      attachments: [other],
    })
    const task = await create(client, steps({ endTurn: true }), {
      start: true,
      attachments: [own],
    })
    await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    const token = await runToken(task)
    const asRun = api(daemon?.port ?? 0, token)

    const refused = await asRun.call('POST', `/tasks/${task.id}/comments`, {
      body: 'look',
      attachments: [other],
    })
    expect(refused.status).toBe(403)
    expect((await uploadAs(token, `/tasks/${elsewhere.id}/attachments`, 'a.txt', 'x')).status).toBe(
      403,
    )
    expect(
      (await uploadAs(await tokenFor(home), `/tasks/${task.id}/attachments`, 'a.txt', 'x')).status,
    ).toBe(403)

    const reused = await asRun.call('POST', `/tasks/${task.id}/comments`, {
      body: 'the brief again',
      attachments: [own],
    })
    expect(reused.status).toBe(201)
    const uploaded = await uploadAs(token, `/tasks/${task.id}/attachments`, 'log.txt', 'output')
    expect(uploaded.status).toBe(201)
    const fresh = JSON.parse(uploaded.body) as Attachment
    const posted = await asRun.call('POST', `/tasks/${task.id}/comments`, {
      body: 'the log',
      attachments: [fresh],
    })
    expect(posted.status).toBe(201)
    expect(posted.body.attachments).toEqual([
      { hash: sha('output'), name: 'log.txt', size: 6, mediaType: 'text/plain' },
    ])
  })
})

describe('the user attaching files', () => {
  test('a Comment’s files go into the live Run as paths the agent can read', async () => {
    const client = await startTed()
    const task = await create(client, steps({ endTurn: true }), { start: true })
    const idle = await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    const shot = await client.app.uploadAttachment(
      { name: 'bug.png', mediaType: 'image/png' },
      bytes('pixels'),
    )

    const posted = await client.ok<Comment>('POST', `/tasks/${task.id}/comments`, {
      body: 'This is what I see.',
      attachments: [shot],
    })

    expect(posted.attachments).toEqual([shot])
    expect(posted.delivered?.runId).toBe(idle.leadRunId)
    await waitUntil(async () => {
      const current = (await comments(client, task)).find((c) => c.id === posted.id)
      return current?.readAt
    }, 'the Comment to be read')
    const file = path.join(home, 'attachments', `${shot.hash}.png`)
    const last = (await userMessages(client, idle.leadRunId ?? '')).at(-1) ?? ''
    expect(last).toContain('This is what I see.')
    expect(last).toContain(`bug.png: ${file}`)
  })

  test('files on a Comment made with no Run reach the next Run, and a Comment may be only files', async () => {
    const client = await startTed()
    const task = await create(client, steps({ endTurn: true }))
    const page = await client.app.uploadAttachment(
      { name: 'mock.html', mediaType: 'text/html' },
      bytes('<p>hi</p>'),
    )

    const posted = await client.ok<Comment>('POST', `/tasks/${task.id}/comments`, {
      attachments: [page],
    })
    expect(posted).toMatchObject({ body: '', attachments: [page] })
    expect((await client.call('POST', `/tasks/${task.id}/comments`, { body: ' ' })).status).toBe(
      400,
    )

    await client.ok('POST', `/tasks/${task.id}/start`)
    const started = await waitFor(client, task, (t) => t.leadRunId !== undefined, 'to start')
    const { prompt } = (await client.getRun(started.leadRunId ?? '')).run as { prompt: string }
    expect(prompt).toContain(`mock.html: ${path.join(home, 'attachments', `${page.hash}.html`)}`)
  })

  test('a Comment can’t name a file that was never uploaded', async () => {
    const client = await startTed()
    const task = await create(client, 'Plain')

    const res = await client.call('POST', `/tasks/${task.id}/comments`, {
      body: 'x',
      attachments: [{ hash: 'b'.repeat(64), name: 'ghost.png', mediaType: 'image/png' }],
    })

    expect(res.status).toBe(400)
  })

  test('the app reads a file’s bytes; Runs can’t', async () => {
    const client = await startTed()
    const shot = await client.app.uploadAttachment(
      { name: 'shot.png', mediaType: 'image/png' },
      bytes('pixels'),
    )

    const read = await client.app.readAttachment(shot)

    expect(read).toEqual({ data: Buffer.from('pixels').toString('base64') })
    const task = await create(client, steps({ endTurn: true }), { start: true })
    await waitFor(client, task, (t) => t.runs[0]?.state === 'idle', 'to go idle')
    const asRun = api(daemon?.port ?? 0, await runToken(task))
    expect((await asRun.call('GET', `/attachments/${shot.hash}/shot.png`)).status).toBe(403)
    expect((await client.call('GET', `/attachments/${'c'.repeat(64)}/x.png`)).status).toBe(404)
  })
})

describe('deleting a Task', () => {
  test('removes its Comments’ files unless another Task still uses them', async () => {
    const client = await startTed()
    const shared = await client.app.uploadAttachment(
      { name: 'shared.png', mediaType: 'image/png' },
      bytes('shared'),
    )
    const own = await client.app.uploadAttachment(
      { name: 'own.png', mediaType: 'image/png' },
      bytes('own'),
    )
    const keep = await create(client, 'Keep')
    const gone = await create(client, 'Gone')
    await client.ok('POST', `/tasks/${keep.id}/comments`, { body: 'k', attachments: [shared] })
    await client.ok('POST', `/tasks/${gone.id}/comments`, {
      body: 'g',
      attachments: [shared, own],
    })

    await client.ok('POST', `/tasks/${gone.id}/delete`)

    expect(await readdir(path.join(home, 'attachments'))).toEqual([`${shared.hash}.png`])
  })
})
