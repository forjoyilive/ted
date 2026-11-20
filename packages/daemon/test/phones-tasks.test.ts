import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type DaemonClient,
  encodePairingLink,
  type Factory,
  type MacReply,
  type PhoneCommentEntry,
  type PhoneTaskGroup,
  type PhoneTaskRow,
  type PhoneTasksBody,
  type Priority,
  parsePhoneTaskBody,
  parsePhoneTaskCommentsBody,
  parsePhoneTasksBody,
  phoneCommentTextMax,
  phoneDescriptionMax,
  phoneProtocolVersion,
  phoneReplyBodyMax,
  phoneStatusSections,
  readDaemonInfo,
} from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import type { TedStore } from '../src/store/index.ts'
import {
  api,
  appClient,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
} from './helpers.ts'
import {
  memoryKeyrings,
  type PhoneBody,
  type RelayStub,
  startRelayStub,
  TestPhone,
} from './support/phone-relay.ts'

const dayMs = 24 * 60 * 60 * 1000

let home: string
let cleanup: () => Promise<void>
let scratch: string
let relay: RelayStub
let daemon: RunningDaemon
let store: TedStore
let client: DaemonClient
let http: ReturnType<typeof api>
let notebook: Factory
let shop: Factory
let phone: TestPhone
let shift = 0
const clock = () => Date.now() + shift

const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
  const res = await http.call(method, route, body)
  if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
  return res.body as T
}

async function origin(name: string): Promise<string> {
  const parent = path.join(scratch, name)
  await mkdir(parent)
  const repo = await makeOriginRepo(parent)
  await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\n' })
  const renamed = path.join(parent, 'acme', `${name}.git`)
  await rename(repo, renamed)
  return renamed
}

beforeAll(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-phones-tasks-'))
  const notebookRepo = await origin('notebook')
  const shopRepo = await origin('shop')
  relay = await startRelayStub()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: memoryKeyrings().keyrings,
      relayUrl: relay.url,
      macName: async () => 'Tasks Mac',
      relayDelaysMs: [50],
      now: clock,
    },
    wrap: {
      store: (opened) => {
        store = opened
        return opened
      },
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon.json')
  client = appClient(info, daemon.appToken)
  http = api(daemon.port, { appKey: daemon.appToken })
  notebook = await ok<Factory>('POST', '/dev/factories', { repo: notebookRepo, key: 'NB' })
  shop = await ok<Factory>('POST', '/dev/factories', { repo: shopRepo, key: 'SH' })
  const offer = await client.createPhonePairing()
  phone = new TestPhone(offer.link, { now: clock })
  await phone.online
  await phone.pair('Tasks Phone')
  await client.approvePhonePairing({ pairing: phone.link.pairing })
  await phone.approved()
}, 60_000)

afterAll(async () => {
  phone?.close()
  await daemon?.stop()
  await relay?.close()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const bytes = (reply: MacReply) => Buffer.byteLength(JSON.stringify(reply.ok && reply.body))

async function sent(body: PhoneBody): Promise<MacReply> {
  const reply = await phone.send(body)
  expect(bytes(reply)).toBeLessThanOrEqual(phoneReplyBodyMax)
  return reply
}

function failure(reply: MacReply): string | undefined {
  return reply.ok ? undefined : reply.error.code
}

async function page(group: PhoneTaskGroup, cursor?: string): Promise<PhoneTasksBody> {
  const reply = await sent({
    type: 'request',
    route: 'tasks',
    group,
    ...(cursor !== undefined && { cursor }),
  })
  if (!reply.ok) throw new Error(`tasks failed: ${reply.error.code}`)
  return parsePhoneTasksBody(reply.body)
}

async function pages(group: PhoneTaskGroup, cursor?: string): Promise<PhoneTasksBody[]> {
  const all: PhoneTasksBody[] = []
  let next = cursor
  do {
    const body = await page(group, next)
    all.push(body)
    next = body.cursor
  } while (next !== undefined)
  return all
}

async function everyRow(group: PhoneTaskGroup): Promise<PhoneTaskRow[]> {
  return (await pages(group)).flatMap((body) => body.rows)
}

async function opened(taskId: string) {
  const reply = await sent({ type: 'request', route: 'task', taskId })
  if (!reply.ok) throw new Error(`task failed: ${reply.error.code}`)
  return parsePhoneTaskBody(reply.body).task
}

async function thread(taskId: string): Promise<PhoneCommentEntry[][]> {
  const all: PhoneCommentEntry[][] = []
  let cursor: string | undefined
  do {
    const reply = await sent({
      type: 'request',
      route: 'task-comments',
      taskId,
      ...(cursor !== undefined && { cursor }),
    })
    if (!reply.ok) throw new Error(`task-comments failed: ${reply.error.code}`)
    const body = parsePhoneTaskCommentsBody(reply.body)
    all.push(body.entries)
    cursor = body.cursor
  } while (cursor !== undefined)
  return all
}

const make = (
  title: string,
  factory: Pick<Factory, 'id'> = notebook,
  extra: { description?: string; priority?: Priority } = {},
) => store.createTask({ title, factoryId: factory.id, ...extra })

const listedIds = () =>
  store
    .listTasks()
    .filter((task) => !task.archived)
    .map((task) => task.id)

test('the list has open Tasks and recent Done ones from every Factory, never archived or older Done ones', async () => {
  const open = await make('Sketch the phone list')
  const elsewhere = await make('Price the mugs', shop)
  const done = await make('Ship the icons')
  store.changeStage(done.id, 'done')
  const archived = await make('Old idea')
  store.archiveTask(archived.id)

  const rows = await everyRow('status')
  const ids = rows.map((row) => row.id)
  expect(ids).toEqual(expect.arrayContaining([open.id, elsewhere.id, done.id]))
  expect(ids).not.toContain(archived.id)
  expect(rows.find((row) => row.id === open.id)).toEqual({
    id: open.id,
    ref: open.displayId,
    title: 'Sketch the phone list',
    factory: { id: notebook.id, name: notebook.name },
    stage: { id: 'backlog', name: 'Backlog' },
    status: '',
    tone: 'none',
    priority: open.priority,
    section: 'backlog',
    updatedAt: expect.any(String),
  })
  expect(rows.find((row) => row.id === elsewhere.id)?.factory.id).toBe(shop.id)
  expect(rows.find((row) => row.id === done.id)).toMatchObject({ section: 'done', tone: 'done' })

  expect(await opened(open.displayId)).toMatchObject({
    id: open.id,
    ref: open.displayId,
    section: 'backlog',
    description: '',
    cut: false,
  })
  expect(failure(await sent({ type: 'request', route: 'task', taskId: archived.id }))).toBe('gone')
  expect(failure(await sent({ type: 'request', route: 'task', taskId: 'NB-99999' }))).toBe('gone')
  expect(failure(await sent({ type: 'request', route: 'task-comments', taskId: 'NB-99999' }))).toBe(
    'gone',
  )

  shift = 8 * dayMs
  try {
    const later = (await everyRow('status')).map((row) => row.id)
    expect(later).toContain(open.id)
    expect(later).not.toContain(done.id)
  } finally {
    shift = 0
  }
})

test('paging reaches every Task exactly once in each grouping, and a row that moves gives no duplicates', async () => {
  const titleTail = 'Ü'.repeat(700)
  const levels = ['medium', 'low', 'none'] as const
  for (let n = 0; n < 100; n++) {
    await make(`Task ${n} ${titleTail}`, n % 2 === 0 ? notebook : shop, {
      priority: levels[n % levels.length] ?? 'none',
    })
  }
  const expected = new Set(listedIds())

  for (const group of ['status', 'factory', 'stage'] as const) {
    const all = await pages(group)
    expect(all.length, group).toBeGreaterThan(2)
    const rows = all.flatMap((body) => body.rows)
    const ids = rows.map((row) => row.id)
    expect(new Set(ids).size, group).toBe(ids.length)
    expect(new Set(ids), group).toEqual(expected)
    const order = all[0]?.sections.map((section) => section.key) ?? []
    const places = rows.map((row) => order.indexOf(row.section))
    expect(
      places.every((place) => place >= 0),
      group,
    ).toBe(true)
    expect(places, group).toEqual(places.toSorted((a, b) => a - b))
    for (const section of all[0]?.sections ?? []) {
      expect(rows.filter((row) => row.section === section.key).length, group).toBe(section.count)
    }
    if (group === 'status') {
      expect(order).toEqual(phoneStatusSections.filter((key) => order.includes(key)))
    }
    for (const row of rows) expect([...row.title].length).toBeLessThanOrEqual(500)
  }

  const first = await page('status')
  const peek = await page('status', first.cursor)
  const moved = peek.rows[1]
  const atCursor = first.rows.at(-1)
  if (!moved || !atCursor) throw new Error('expected two pages')
  store.setPriority(moved.id, 'urgent')
  store.archiveTask(atCursor.id)
  const rest = (await pages('status', first.cursor)).flatMap((body) => body.rows)
  const ids = [...first.rows, ...rest].map((row) => row.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of listedIds()) {
    if (id !== moved.id) expect(ids).toContain(id)
  }
}, 90_000)

test('a long description and a thread of long multibyte comments stay under the reply limit', async () => {
  const task = await make('Write the long spec', notebook, {
    description: `${'Línea larga 🚀 '.repeat(7_000)}`.slice(0, 100_000),
  })
  const detail = await opened(task.id)
  expect(detail.cut).toBe(true)
  expect([...detail.description].length).toBeLessThanOrEqual(phoneDescriptionMax)
  expect(detail.description.length).toBeGreaterThan(1_000)

  for (let n = 0; n < 30; n++) {
    store.postComment({
      taskId: task.id,
      author: { kind: 'run', runId: 'run-1' },
      body: `${n} ${'漢字😀'.repeat(3_000)}`,
    })
  }
  const all = await thread(task.id)
  expect(all.length).toBeGreaterThan(1)
  const entries = all.flat()
  const newestFirst = store
    .listComments(task.id)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  expect(entries.map((entry) => entry.id)).toEqual(newestFirst.map((comment) => comment.id))
  for (const entry of entries) {
    expect(entry).toMatchObject({ author: 'Task Lead', kind: 'note', cut: true })
    expect([...entry.text].length).toBeLessThanOrEqual(phoneCommentTextMax)
  }
  expect(
    failure(
      await sent({ type: 'request', route: 'task-comments', taskId: task.id, cursor: 'bogus' }),
    ),
  ).toBe('bad-request')
})

test('secrets come out redacted, and requests show open with an ID or answered without one', async () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
  const task = await make('Rotate the token', notebook, {
    description: `Use https://bob:hunter2@example.com and ${secret}`,
  })
  const note = store.postComment({
    taskId: task.id,
    author: { kind: 'human' },
    body: `Token ${secret}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst x = 1\n\`\`\``,
    attachments: [
      { hash: 'a'.repeat(64), name: 'shot.png', size: 10, mediaType: 'image/png' },
      { hash: 'b'.repeat(64), name: 'notes.pdf', size: 10, mediaType: 'application/pdf' },
    ],
  })
  const answered = store.postComment({
    taskId: task.id,
    author: { kind: 'ted' },
    kind: 'question',
    body: 'Which repo?',
    choices: ['web', 'api'],
  })
  await client.answerRequest(answered.id, { action: 'answer', choice: 'web' })
  const open = store.postComment({
    taskId: task.id,
    author: { kind: 'ted' },
    kind: 'question',
    body: 'Ship on Friday?',
    choices: ['Yes', 'No'],
  })

  const detail = await opened(task.id)
  expect(detail.description).not.toContain('hunter2')
  expect(detail.description).not.toContain(secret)
  expect(detail.description).toContain('[redacted]')
  expect(detail).toMatchObject({ section: 'needs-you', status: 'Waiting on you', tone: 'waiting' })

  const entries = (await thread(task.id)).flat()
  expect(entries.find((entry) => entry.id === note.id)).toEqual({
    id: note.id,
    author: 'You',
    kind: 'note',
    createdAt: note.createdAt,
    text: expect.not.stringContaining(secret),
    cut: false,
    images: 1,
    attachments: 1,
    formattedBlocks: 2,
  })
  expect(entries.find((entry) => entry.id === answered.id)).toMatchObject({
    author: 'Ted',
    kind: 'request',
    request: { kind: 'question', open: false },
  })
  expect(entries.find((entry) => entry.id === answered.id)?.request).not.toHaveProperty('requestId')
  expect(entries.find((entry) => entry.id === open.id)).toMatchObject({
    kind: 'request',
    request: { kind: 'question', open: true, requestId: open.id },
  })
  const viaInbox = await sent({ type: 'request', route: 'request', requestId: open.id })
  expect(viaInbox.ok).toBe(true)
})

test('a bad cursor is bad-request and a key that isn’t paired gets not-paired', async () => {
  expect(
    failure(await sent({ type: 'request', route: 'tasks', group: 'status', cursor: 'bogus' })),
  ).toBe('bad-request')
  const stranger = new TestPhone(encodePairingLink(phone.link))
  const bodies: PhoneBody[] = [
    { type: 'request', route: 'tasks', group: 'status' },
    { type: 'request', route: 'task', taskId: 'NB-1' },
    { type: 'request', route: 'task-comments', taskId: 'NB-1' },
  ]
  for (const body of bodies) {
    expect(failure(await stranger.send(body, phoneProtocolVersion, phone)), body.type).toBe(
      'not-paired',
    )
  }
})

test('with many Factories with long names, every page stays under the limit and paging still reaches every Task', async () => {
  const letters = (n: number) =>
    String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26))
  const many: { id: string; key: string }[] = []
  for (let n = 0; n < 100; n++) {
    many.push(
      store.createFactory({
        key: `Z${letters(n)}`,
        name: `${n} ${'ßé漢😀'.repeat(60)}`,
        repos: [],
        defaultBranch: 'main',
      }),
    )
  }
  for (const factory of many) await make(`Task in ${factory.key}`, factory)
  const expected = new Set(listedIds())

  const all = await pages('factory')
  const ids = all.flatMap((body) => body.rows).map((row) => row.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(new Set(ids)).toEqual(expected)
  for (const body of all) {
    expect(body.rows.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(body.sections))).toBeLessThanOrEqual(
      phoneReplyBodyMax / 2,
    )
  }
}, 90_000)
