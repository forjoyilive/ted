import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type DaemonClient,
  encodePairingLink,
  type Factory,
  type MacReply,
  type PhoneTaskCreatedBody,
  parsePhoneFactoriesBody,
  parsePhoneFactoryIconBody,
  parsePhoneTaskCreatedBody,
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

const idle = JSON.stringify({ steps: [{ everyMessage: [{ endTurn: true }] }] })

test('factories lists each Factory with only its ID, key, name, icon and default priority', async () => {
  expectTypeOf<TedStore>().toExtend<PhonesArea>()
  const reply = await send({ type: 'request', route: 'factories' })
  if (!reply.ok) throw new Error(reply.error.message)
  const { factories } = parsePhoneFactoriesBody(reply.body)
  expect(factories.map((f) => f.key)).toEqual(['NB'])
  expect(factories[0]).toMatchObject({
    id: notebook.id,
    key: 'NB',
    name: notebook.name,
    defaultPriority: 'none',
  })
  const raw = (reply.body.factories as JsonObject[])[0] ?? {}
  for (const field of Object.keys(raw)) {
    expect(['id', 'key', 'name', 'icon', 'defaultPriority']).toContain(field)
  }
})

const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('factories sends the icon the Mac draws, and factory-icon sends an image icon once', async () => {
  const listed = async () => {
    const reply = await send({ type: 'request', route: 'factories' })
    if (!reply.ok) throw new Error(reply.error.message)
    return parsePhoneFactoriesBody(reply.body).factories[0]?.icon
  }
  try {
    await client.setFactoryIcon(notebook.id, null)
    expect(await listed()).toEqual({ kind: 'letter', color: 'blue' })
    await client.setFactoryIcon(notebook.id, { kind: 'image', dataUrl: tinyPng })
    const icon = await listed()
    if (icon?.kind !== 'image')
      throw new Error(`expected an image icon, got ${JSON.stringify(icon)}`)
    const image = await send({ type: 'request', route: 'factory-icon', factoryId: notebook.id })
    if (!image.ok) throw new Error(image.error.message)
    expect(parsePhoneFactoryIconBody(image.body)).toEqual({
      dataUrl: tinyPng,
      version: icon.version,
    })
    expect(
      await send({ type: 'request', route: 'factory-icon', factoryId: 'no-such-factory' }),
    ).toMatchObject({ ok: false, error: { code: 'gone' } })
    await client.setFactoryIcon(notebook.id, { kind: 'symbol', name: 'code', color: 'teal' })
    expect(await listed()).toEqual({ kind: 'symbol', symbol: 'code', color: 'teal' })
    expect(
      await send({ type: 'request', route: 'factory-icon', factoryId: notebook.id }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } })
  } finally {
    await client.setFactoryIcon(notebook.id, null)
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
    createdAt: '2026-11-20T09:00:00.000Z',
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
        factories: () => [
          {
            id: 'f1',
            key: 'NB',
            name: 'Notebook',
            position: 0,
            createdAt: '2026-11-20T09:00:00.000Z',
          },
        ],
        defaults: () => Promise.resolve({} as TaskDefaults),
        task: () => undefined,
        create: () => Promise.resolve({ id: 't1', displayId: 'NB-1' } as Task),
        start: () => Promise.reject(refusal),
      },
      { createdTask: () => undefined, persisted: () => Promise.resolve() },
      { ...({} as PhoneTasks), read: () => Promise.resolve({ body: { task: { id: 't1' } } }) },
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
