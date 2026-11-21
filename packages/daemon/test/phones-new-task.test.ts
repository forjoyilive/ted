import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type DaemonClient,
  encodePairingLink,
  type Factory,
  type MacReply,
  type PhoneTaskCreatedBody,
  parsePhoneFactoriesBody,
  parsePhoneTaskCreatedBody,
  phoneFileMissing,
  phoneFilePartBytes,
  phoneLabelMax,
  phoneReplyBodyMax,
  readDaemonInfo,
  type Task,
  type TaskDefaults,
  toBase64Url,
} from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterAll, beforeAll, expect, expectTypeOf, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { AlreadyStartedError, RequestError } from '../src/errors.ts'
import { createPhoneNewTask } from '../src/phones/new-task.ts'
import type { PhoneTasks } from '../src/phones/tasks.ts'
import type { PhonesArea, TedStore } from '../src/store/index.ts'
import {
  api,
  appClient,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import {
  memoryKeyrings,
  type PhoneBody,
  type RelayStub,
  startRelayStub,
  TestPhone,
} from './support/phone-relay.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let relay: RelayStub
let daemon: RunningDaemon
let store: TedStore
let client: DaemonClient
let http: ReturnType<typeof api>
let notebook: Factory
let phone: TestPhone

const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
  const res = await http.call(method, route, body)
  if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
  return res.body as T
}

beforeAll(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-phones-new-task-'))
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml':
      'version: 1\norder: [intake, work, validate, review]\nlead: { agent: claude, model: opus, effort: high }\nstages:\n  clarify: { depth: few }\n',
  })
  const ghState = path.join(scratch, 'gh.json')
  await writeFile(ghState, '{}')
  process.env.TED_STUB_GH = ghState
  process.env.TED_STUB_GH_LOG = path.join(scratch, 'gh.jsonl')
  relay = await startRelayStub()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: memoryKeyrings().keyrings,
      relayUrl: relay.url,
      macName: async () => 'New Task Mac',
      relayDelaysMs: [50],
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
  notebook = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const offer = await client.createPhonePairing()
  phone = new TestPhone(offer.link)
  await phone.online
  await phone.pair('New Task Phone')
  await client.approvePhonePairing({ pairing: phone.link.pairing })
  await phone.approved()
}, 60_000)

afterAll(async () => {
  phone?.close()
  await daemon?.stop()
  await relay?.close()
  await killRunHosts(home)
  delete process.env.TED_STUB_GH
  delete process.env.TED_STUB_GH_LOG
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const send = (body: PhoneBody): Promise<MacReply> => phone.send(body)

const createId = () => toBase64Url(randomBytes(16))

function created(reply: MacReply): PhoneTaskCreatedBody {
  if (!reply.ok) throw new Error(`refused: ${reply.error.code} ${reply.error.message}`)
  return parsePhoneTaskCreatedBody(reply.body)
}

const named = (title: string) => store.listTasks().filter((task) => task.title === title)

const noFiles = { attach: () => Promise.resolve([]), consume: () => Promise.resolve() }

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function upload(bytes: Buffer, name: string, mediaType: string): Promise<string> {
  const uploadId = toBase64Url(randomBytes(16))
  const sends: Promise<MacReply>[] = []
  for (let index = 0; index * phoneFilePartBytes < bytes.length; index++) {
    const data = bytes.subarray(index * phoneFilePartBytes, (index + 1) * phoneFilePartBytes)
    sends.push(
      send({ type: 'request', route: 'file-part', uploadId, index, data: data.toString('base64') }),
    )
  }
  for (const reply of await Promise.all(sends)) expect(reply).toMatchObject({ ok: true, body: {} })
  const done = await send({
    type: 'request',
    route: 'file-done',
    uploadId,
    name,
    mediaType,
    size: bytes.length,
    sha256: sha(bytes),
  })
  expect(done).toMatchObject({ ok: true, body: {} })
  return uploadId
}

const fileMissing = { ok: false, error: { code: 'refused', message: phoneFileMissing } }

const idle = JSON.stringify({ steps: [{ everyMessage: [{ endTurn: true }] }] })

test('factories lists each Factory with only its key, name, icon and default priority', async () => {
  expectTypeOf<TedStore>().toExtend<PhonesArea>()
  const reply = await send({ type: 'request', route: 'factories' })
  if (!reply.ok) throw new Error(reply.error.message)
  const { factories } = parsePhoneFactoriesBody(reply.body)
  expect(factories.map((f) => f.key)).toEqual(['NB'])
  expect(factories[0]).toMatchObject({ key: 'NB', name: notebook.name, defaultPriority: 'none' })
  const raw = (reply.body.factories as JsonObject[])[0] ?? {}
  for (const field of Object.keys(raw)) {
    expect(['key', 'name', 'icon', 'defaultPriority']).toContain(field)
  }
})

test('task-create makes a Backlog Task in the chosen Factory with the given fields and the Factory’s defaults', async () => {
  const defaults = await client.taskDefaults(notebook.id)
  expect(defaults).toMatchObject({
    clarifyDepth: 'few',
    lead: { agent: 'claude', model: 'opus', effort: 'high' },
  })
  const reply = created(
    await send({
      type: 'request',
      route: 'task-create',
      createId: createId(),
      factory: 'NB',
      title: '  Fix the login loop  ',
      description: 'It loops after sign-in.',
      priority: 'high',
      start: false,
    }),
  )
  expect(reply.startRefused).toBeUndefined()
  const task = store.getTask(reply.task.id)
  expect(task).toMatchObject({
    factoryId: notebook.id,
    title: 'Fix the login loop',
    description: 'It loops after sign-in.',
    priority: 'high',
    stage: 'backlog',
    createdBy: 'human',
    clarifyDepth: defaults.clarifyDepth,
    lead: defaults.lead,
    blockedBy: [],
    attachments: [],
  })
  expect(task?.parentId).toBeUndefined()
  expect(reply.task).toMatchObject({ ref: task?.displayId, title: 'Fix the login loop' })
  expect(reply.task.stage.id).toBe('backlog')
})

test('the same task-create sent again, or twice at once, makes one Task and answers with it', async () => {
  const request = {
    type: 'request',
    route: 'task-create',
    createId: createId(),
    factory: 'NB',
    title: 'Sent twice from the phone',
    start: false,
  } as const
  const [first, second] = await Promise.all([send(request), send(request)])
  const id = created(first).task.id
  expect(created(second).task.id).toBe(id)
  const resent = created(await send({ ...request, title: 'A changed title on the resend' }))
  expect(resent.task.id).toBe(id)
  expect(named('Sent twice from the phone').map((task) => task.id)).toEqual([id])
  expect(named('A changed title on the resend')).toEqual([])
  const [paired] = (await client.pairedPhones()).phones
  expect(store.phones.createdTask(paired?.id ?? '', request.createId)).toBe(id)

  store.archiveTask(id)
  const gone = await send(request)
  expect(gone).toMatchObject({ ok: false, error: { code: 'gone' } })
})

test('task-create with Start now starts the Task', async () => {
  const reply = created(
    await send({
      type: 'request',
      route: 'task-create',
      createId: createId(),
      factory: 'NB',
      title: idle,
      start: true,
    }),
  )
  expect(reply.startRefused).toBeUndefined()
  expect(reply.task.stage.id).not.toBe('backlog')
  expect(store.getTask(reply.task.id)?.stage).not.toBe('backlog')
  await waitUntil(() => store.getTask(reply.task.id)?.leadRunId, 'the Task Lead to start')
  await ok('POST', `/tasks/${reply.task.id}/stop`)
}, 60_000)

test('a missing title or an unknown Factory is refused with a sentence and creates nothing', async () => {
  const before = store.listTasks().length
  const base = { type: 'request', route: 'task-create', factory: 'NB', start: true } as const
  expect(await send({ ...base, createId: createId() })).toMatchObject({
    ok: false,
    error: { code: 'refused', message: 'A Task needs a title.' },
  })
  expect(await send({ ...base, createId: createId(), title: '   ' })).toMatchObject({
    ok: false,
    error: { code: 'refused', message: 'A Task needs a title.' },
  })
  expect(
    await send({ ...base, createId: createId(), factory: 'ZZ', title: 'Nowhere to go' }),
  ).toMatchObject({ ok: false, error: { code: 'refused', message: 'no Factory with key ZZ' } })
  expect(await send({ ...base, createId: 'short', title: 'Bad key' })).toMatchObject({
    ok: false,
    error: { code: 'bad-request' },
  })
  expect(store.listTasks().length).toBe(before)
})

test('a phone key that isn’t paired gets not-paired on factories and task-create', async () => {
  const stranger = new TestPhone(encodePairingLink(phone.link))
  const before = store.listTasks().length
  expect(
    await stranger.send({ type: 'request', route: 'factories' }, undefined, phone),
  ).toMatchObject({ ok: false, error: { code: 'not-paired' } })
  expect(
    await stranger.send(
      {
        type: 'request',
        route: 'task-create',
        createId: createId(),
        factory: 'NB',
        title: 'From a stranger',
        start: true,
      },
      undefined,
      phone,
    ),
  ).toMatchObject({ ok: false, error: { code: 'not-paired' } })
  expect(store.listTasks().length).toBe(before)
})

test('factories stops before the reply would pass the size limit and cuts long names', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    id: `f${i}`,
    key: `F${i}`,
    name: 'N'.repeat(300),
    position: i,
  }))
  const newTask = createPhoneNewTask(
    {
      factories: () => many,
      defaults: () => Promise.reject(new Error('unused')),
      task: () => undefined,
      create: () => Promise.reject(new Error('unused')),
      start: () => Promise.reject(new Error('unused')),
    },
    { createdTask: () => undefined, persisted: () => Promise.resolve() },
    {} as PhoneTasks,
    noFiles,
  )
  const reply = newTask.factories()
  if (!('body' in reply)) throw new Error('refused')
  const { factories } = parsePhoneFactoriesBody(reply.body)
  expect(factories.length).toBeGreaterThan(0)
  expect(factories.length).toBeLessThan(many.length)
  expect(factories.map((f) => f.key)).toEqual(many.slice(0, factories.length).map((f) => f.key))
  expect(factories[0]?.name).toHaveLength(phoneLabelMax)
  expect(Buffer.byteLength(JSON.stringify(reply.body))).toBeLessThanOrEqual(phoneReplyBodyMax)
})

test('Start now that finds the Task already started answers without a refusal, and other refusals still carry their sentence', async () => {
  const startWith = (refusal: Error) =>
    createPhoneNewTask(
      {
        factories: () => [{ id: 'f1', key: 'NB', name: 'Notebook', position: 0 }],
        defaults: () => Promise.resolve({} as TaskDefaults),
        task: () => undefined,
        create: () => Promise.resolve({ id: 't1', displayId: 'NB-1' } as Task),
        start: () => Promise.reject(refusal),
      },
      { createdTask: () => undefined, persisted: () => Promise.resolve() },
      { ...({} as PhoneTasks), read: () => Promise.resolve({ body: { task: { id: 't1' } } }) },
      noFiles,
    )
  const caller = { kind: 'phone', phoneId: 'p1' } as const
  const input = {
    createId: createId(),
    factory: 'NB',
    title: 'Started elsewhere',
    priority: 'none',
    start: true,
  } as const

  expect(
    await startWith(new AlreadyStartedError('NB-1 has already started')).create(caller, input),
  ).toEqual({ body: { task: { id: 't1' } } })
  expect(
    await startWith(new RequestError(409, 'NB-1 has unfinished blockers')).create(caller, input),
  ).toEqual({ body: { task: { id: 't1' }, startRefused: 'NB-1 has unfinished blockers' } })
})

test('task-create with files attaches each to the new Task, and the files are used up', async () => {
  const photo = randomBytes(phoneFilePartBytes * 2 + 500)
  const notes = Buffer.from('Steps to reproduce\n')
  const files = [
    await upload(photo, 'IMG_2031.jpg', 'image/jpeg'),
    await upload(notes, 'notes.txt', 'text/plain'),
  ]
  const request = {
    type: 'request',
    route: 'task-create',
    createId: createId(),
    factory: 'NB',
    title: 'Login loop, with files',
    start: false,
    files,
  } as const
  const reply = created(await send(request))
  expect(store.getTask(reply.task.id)?.attachments).toEqual([
    { hash: sha(photo), name: 'IMG_2031.jpg', size: photo.length, mediaType: 'image/jpeg' },
    { hash: sha(notes), name: 'notes.txt', size: notes.length, mediaType: 'text/plain' },
  ])
  expect(await readFile(path.join(home, 'attachments', `${sha(photo)}.jpg`))).toEqual(photo)

  expect(created(await send(request)).task.id).toBe(reply.task.id)
  expect(await send({ ...request, createId: createId(), title: 'Files used twice' })).toMatchObject(
    fileMissing,
  )
  expect(named('Files used twice')).toEqual([])
})

test('a file whose hash doesn’t match is refused, and task-create naming it creates nothing until it arrives', async () => {
  const bytes = randomBytes(1_000)
  const uploadId = toBase64Url(randomBytes(16))
  const part = { type: 'request', route: 'file-part', uploadId, index: 0 } as const
  expect(await send({ ...part, data: bytes.toString('base64') })).toMatchObject({ ok: true })
  const done = {
    type: 'request',
    route: 'file-done',
    uploadId,
    name: 'scan.pdf',
    mediaType: 'application/pdf',
    size: bytes.length,
    sha256: sha(randomBytes(1_000)),
  } as const
  expect(await send(done)).toMatchObject(fileMissing)

  const ready = await upload(randomBytes(10), 'ready.txt', 'text/plain')
  const request = {
    type: 'request',
    route: 'task-create',
    createId: createId(),
    factory: 'NB',
    title: 'Waits for its files',
    start: false,
    files: [ready, uploadId],
  } as const
  const before = store.listTasks().length
  expect(await send(request)).toMatchObject(fileMissing)
  expect(store.listTasks().length).toBe(before)

  expect(await send({ ...done, sha256: sha(bytes) })).toMatchObject({ ok: true, body: {} })
  const task = store.getTask(created(await send(request)).task.id)
  expect(task?.attachments.map((file) => file.name)).toEqual(['ready.txt', 'scan.pdf'])
})

test('task-comment with files posts a Comment carrying them, even with no text', async () => {
  const { task } = created(
    await send({
      type: 'request',
      route: 'task-create',
      createId: createId(),
      factory: 'NB',
      title: 'Gets a Comment with a photo',
      start: false,
    }),
  )
  const photo = randomBytes(5_000)
  const files = [await upload(photo, 'IMG_0001.jpg', 'image/jpeg')]
  const comment = {
    type: 'request',
    route: 'task-comment',
    taskId: task.id,
    text: '',
    files,
  } as const
  expect(await send(comment)).toMatchObject({ ok: true })
  const posted = store.listComments(task.id).filter((c) => c.author.kind === 'human')
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({
    body: '',
    attachments: [
      { hash: sha(photo), name: 'IMG_0001.jpg', size: photo.length, mediaType: 'image/jpeg' },
    ],
  })

  expect(await send({ ...comment, text: 'Again' })).toMatchObject(fileMissing)
  expect(store.listComments(task.id).filter((c) => c.author.kind === 'human')).toHaveLength(1)
})
