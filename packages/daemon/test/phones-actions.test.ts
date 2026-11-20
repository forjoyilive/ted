import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Comment,
  type DaemonClient,
  encodePairingLink,
  type Factory,
  type InboxItem,
  type MacReply,
  type PhoneTaskDetail,
  parsePhoneTaskBody,
  phoneProtocolVersion,
  readDaemonInfo,
  type Task,
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
let ghLog: string
let briefFile: string
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

const brief = `## Goal

Let notes be edited offline.

## Decisions so far

None.

## Current state

Built.

## Open questions

None.

## Next step

Review it.
`

beforeAll(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-phones-actions-'))
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, validate, review]\n',
  })
  ghLog = path.join(scratch, 'gh.jsonl')
  const ghState = path.join(scratch, 'gh.json')
  await writeFile(ghState, '{}')
  process.env.TED_STUB_GH = ghState
  process.env.TED_STUB_GH_LOG = ghLog
  briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  relay = await startRelayStub()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    phones: {
      keyrings: memoryKeyrings().keyrings,
      relayUrl: relay.url,
      macName: async () => 'Actions Mac',
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
  await phone.pair('Actions Phone')
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

function shown(reply: MacReply): PhoneTaskDetail {
  if (!reply.ok) throw new Error(`refused: ${reply.error.code} ${reply.error.message}`)
  return parsePhoneTaskBody(reply.body).task
}

async function opened(taskId: string): Promise<PhoneTaskDetail> {
  return shown(await send({ type: 'request', route: 'task', taskId }))
}

function refusal(reply: MacReply): { code: string; message: string } | undefined {
  return reply.ok ? undefined : reply.error
}

const make = (title: string, extra: { parentId?: string } = {}) =>
  store.createTask({ title, factoryId: notebook.id, ...extra })

const idle = JSON.stringify({ steps: [{ everyMessage: [{ endTurn: true }] }] })

const prCalls = async (sub: string) =>
  (await readFile(ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { args: string[] })
    .filter((c) => c.args[0] === 'pr' && c.args[1] === sub)

function draftOn(taskId: string, body: string) {
  return store.draftLineComment({
    taskId,
    repo: 'notebook',
    path: 'notes.md',
    side: 'new',
    start: 1,
    end: 1,
    commit: 'HEAD',
    quoted: [],
    body,
  })
}

test('Start, Stop and Resume from the phone change the Task as the Mac does, and refusals carry the daemon’s sentence', async () => {
  const task = await make(idle)
  expect((await opened(task.id)).actions).toEqual([
    'start',
    'priority',
    'comment',
    'archive',
    'delete',
  ])

  const stopEarly = refusal(await send({ type: 'request', route: 'task-stop', taskId: task.id }))
  expect(stopEarly).toEqual({
    code: 'refused',
    message: `${task.displayId} hasn’t started, so there’s nothing to stop`,
  })
  const resumeEarly = refusal(
    await send({ type: 'request', route: 'task-resume', taskId: task.id }),
  )
  expect(resumeEarly).toEqual({ code: 'refused', message: `${task.displayId} isn’t stopped` })

  const started = shown(await send({ type: 'request', route: 'task-start', taskId: task.id }))
  expect(started.stage.id).not.toBe('backlog')
  expect(store.getTask(task.id)?.stage).toBe(started.stage.id)
  await waitUntil(() => store.getTask(task.id)?.leadRunId, 'the Task Lead to start')

  const stopped = shown(await send({ type: 'request', route: 'task-stop', taskId: task.id }))
  expect(store.getTask(task.id)?.statuses).toContain('stopped')
  expect(stopped).toMatchObject({ tone: 'stopped' })
  expect(stopped.actions).toContain('resume')
  expect(stopped.actions).not.toContain('stop')

  const draft = draftOn(task.id, 'Rename this heading')
  const resumed = shown(
    await send({
      type: 'request',
      route: 'task-resume',
      taskId: task.id,
      text: 'Carry on from the phone',
    }),
  )
  expect(store.getTask(task.id)?.statuses).not.toContain('stopped')
  expect(resumed.actions).not.toContain('resume')
  const note = store.listComments(task.id).find((c) => c.body === 'Carry on from the phone')
  expect(note).toMatchObject({ author: { kind: 'human' } })
  expect(note?.lineComments ?? []).toEqual([])
  expect(store.lineCommentDrafts(task.id).map((c) => c.id)).toContain(draft.id)

  expect(
    refusal(await send({ type: 'request', route: 'task-start', taskId: 'NB-99999' }))?.code,
  ).toBe('gone')
  await waitUntil(() => store.getTask(task.id)?.leadRunId, 'the Task Lead to start again')
  await ok('POST', `/tasks/${task.id}/stop`)
}, 90_000)

test('Priority and Comment from the phone change the Task, and a comment leaves line comment drafts unsent', async () => {
  const task = await make('Tidy the settings page')
  const changed = shown(
    await send({ type: 'request', route: 'task-priority', taskId: task.id, priority: 'urgent' }),
  )
  expect(changed.priority).toBe('urgent')
  expect(store.getTask(task.id)?.priority).toBe('urgent')

  const draft = draftOn(task.id, 'Use the shorter label')
  shown(
    await send({ type: 'request', route: 'task-comment', taskId: task.id, text: 'From my phone' }),
  )
  const posted = store.listComments(task.id).find((c) => c.body === 'From my phone')
  expect(posted).toMatchObject({ author: { kind: 'human' }, kind: 'note' })
  expect(posted?.lineComments ?? []).toEqual([])
  expect(posted?.attachments ?? []).toEqual([])
  expect(store.lineCommentDrafts(task.id).map((c) => c.id)).toContain(draft.id)

  store.archiveTask(task.id)
  expect(
    refusal(
      await send({ type: 'request', route: 'task-comment', taskId: task.id, text: 'Too late' }),
    )?.code,
  ).toBe('gone')
})

test('Archive and Delete with child Tasks honour each choice and refuse a stale read', async () => {
  const detached = await make('Parent to archive alone')
  const keptChild = await make('Child that stays', { parentId: detached.id })
  const read = await opened(detached.id)
  expect(read).toMatchObject({ childTasks: 1, openPullRequests: 0 })

  await make('Another child', { parentId: detached.id })
  const stale = refusal(
    await send({
      type: 'request',
      route: 'task-archive',
      taskId: detached.id,
      hierarchyRevision: read.hierarchyRevision,
      closePullRequests: false,
      children: 'detach',
    }),
  )
  expect(stale).toEqual({
    code: 'refused',
    message: `${detached.displayId} or its child Tasks changed since your phone read it. Open it again and choose again.`,
  })
  expect(store.getTask(detached.id)?.archived).toBeUndefined()

  const fresh = await opened(detached.id)
  expect(fresh.childTasks).toBe(2)
  const elsewhere = await make('Unrelated Task in the same Factory')
  store.setPriority(elsewhere.id, 'urgent')
  await make('Another unrelated Task')
  expect(
    await send({
      type: 'request',
      route: 'task-archive',
      taskId: detached.id,
      hierarchyRevision: fresh.hierarchyRevision,
      closePullRequests: false,
      children: 'detach',
    }),
  ).toMatchObject({ ok: true, body: {} })
  expect(store.getTask(detached.id)?.archived).toBeDefined()
  expect(store.getTask(keptChild.id)?.archived).toBeUndefined()
  expect(store.getTask(keptChild.id)?.parentId).toBeUndefined()

  const together = await make('Parent archived with its child')
  const goesToo = await make('Child archived too', { parentId: together.id })
  expect(
    await send({
      type: 'request',
      route: 'task-archive',
      taskId: together.id,
      hierarchyRevision: (await opened(together.id)).hierarchyRevision,
      closePullRequests: false,
      children: 'archive',
    }),
  ).toMatchObject({ ok: true })
  expect(store.getTask(together.id)?.archived).toBeDefined()
  expect(store.getTask(goesToo.id)?.archived).toBeDefined()

  const unparented = await make('Parent deleted alone')
  const orphan = await make('Child left without a parent', { parentId: unparented.id })
  const before = await opened(unparented.id)
  const unchosen = refusal(
    await send({
      type: 'request',
      route: 'task-delete',
      taskId: unparented.id,
      hierarchyRevision: before.hierarchyRevision,
    }),
  )
  expect(unchosen).toEqual({
    code: 'refused',
    message: 'Choose whether to delete descendants or unparent direct children, or cancel',
  })
  await make('A newer child', { parentId: unparented.id })
  expect(
    refusal(
      await send({
        type: 'request',
        route: 'task-delete',
        taskId: unparented.id,
        hierarchyRevision: before.hierarchyRevision,
        children: 'unparent',
      }),
    )?.message,
  ).toMatch(/changed since your phone read it/)
  expect(
    await send({
      type: 'request',
      route: 'task-delete',
      taskId: unparented.id,
      hierarchyRevision: (await opened(unparented.id)).hierarchyRevision,
      children: 'unparent',
    }),
  ).toMatchObject({ ok: true, body: {} })
  await waitUntil(() => store.getTask(unparented.id) === undefined || undefined, 'the delete')
  expect(store.getTask(orphan.id)?.parentId).toBeUndefined()

  const family = await make('Parent deleted with its child')
  const child = await make('Child deleted too', { parentId: family.id })
  expect(
    await send({
      type: 'request',
      route: 'task-delete',
      taskId: family.id,
      hierarchyRevision: (await opened(family.id)).hierarchyRevision,
      children: 'delete',
    }),
  ).toMatchObject({ ok: true })
  await waitUntil(
    () =>
      (store.getTask(family.id) === undefined && store.getTask(child.id) === undefined) ||
      undefined,
    'both deletes',
  )
})

const commitStep = {
  run: [
    'sh',
    '-c',
    'echo $$ >> work.txt && git add work.txt && git -c user.name=T -c user.email=t@example.com commit -qm work',
  ],
}

async function toPullRequest(): Promise<Task> {
  const steps = [
    {
      everyMessage: [
        commitStep,
        { run: ['ted', 'brief', 'write', '--file', briefFile] },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ],
    },
    { run: ['ted', 'outcome', 'advance'] },
    { endTurn: true },
  ]
  const task = await ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps }),
    factory: 'NB',
  })
  await ok('POST', `/tasks/${task.id}/start`)
  const signoff = await waitUntil(async () => {
    const items = await ok<InboxItem[]>('GET', '/inbox')
    const item = items.find((i) => i.task.id === task.id && i.request.kind === 'signoff')
    return item?.request
  }, 'the Review sign-off')
  await ok<Comment>('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
  await waitUntil(
    () => store.getTask(task.id)?.repos[0]?.pullRequest?.state === 'ready' || undefined,
    'the pull request to be ready',
  )
  return task
}

test('Archive from the phone closes the open pull request only when asked', async () => {
  const kept = await toPullRequest()
  const keptRead = await opened(kept.id)
  expect(keptRead.openPullRequests).toBe(1)
  expect(
    await send({
      type: 'request',
      route: 'task-archive',
      taskId: kept.id,
      hierarchyRevision: keptRead.hierarchyRevision,
      closePullRequests: false,
    }),
  ).toMatchObject({ ok: true })
  expect(store.getTask(kept.id)?.archived).toBeDefined()
  expect(await prCalls('close')).toEqual([])

  const closed = await toPullRequest()
  expect(
    await send({
      type: 'request',
      route: 'task-archive',
      taskId: closed.id,
      hierarchyRevision: (await opened(closed.id)).hierarchyRevision,
      closePullRequests: true,
    }),
  ).toMatchObject({ ok: true })
  await waitUntil(
    () => store.getTask(closed.id)?.repos[0]?.pullRequest?.state === 'closed' || undefined,
    'the pull request to close',
  )
  expect(await prCalls('close')).toHaveLength(1)
  expect(store.getTask(kept.id)?.repos[0]?.pullRequest?.state).toBe('ready')
}, 120_000)

test('a key that isn’t paired gets not-paired on every action route', async () => {
  const stranger = new TestPhone(encodePairingLink(phone.link))
  const task = await make('Not for strangers')
  const bodies: PhoneBody[] = [
    { type: 'request', route: 'task-start', taskId: task.id },
    { type: 'request', route: 'task-stop', taskId: task.id },
    { type: 'request', route: 'task-resume', taskId: task.id },
    { type: 'request', route: 'task-priority', taskId: task.id, priority: 'high' },
    { type: 'request', route: 'task-comment', taskId: task.id, text: 'Hi' },
    {
      type: 'request',
      route: 'task-archive',
      taskId: task.id,
      hierarchyRevision: 'rev',
      closePullRequests: false,
    },
    { type: 'request', route: 'task-delete', taskId: task.id, hierarchyRevision: 'rev' },
  ]
  for (const body of bodies) {
    const reply = await stranger.send(body, phoneProtocolVersion, phone)
    expect(refusal(reply)?.code, body.type === 'request' ? body.route : body.type).toBe(
      'not-paired',
    )
  }
  expect(store.getTask(task.id)).toMatchObject({ stage: 'backlog', priority: task.priority })
  expect(store.getTask(task.id)?.archived).toBeUndefined()
  expect(store.listComments(task.id)).toEqual([])
})
