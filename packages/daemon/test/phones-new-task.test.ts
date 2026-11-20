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
  parsePhoneTaskCreatedBody,
  readDaemonInfo,
  toBase64Url,
} from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterAll, beforeAll, expect, expectTypeOf, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
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
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, validate, review]\n',
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
