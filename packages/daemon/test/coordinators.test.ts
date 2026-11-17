import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Automation,
  type Comment,
  type Coordinator,
  type CoordinatorChatSummary,
  type CoordinatorReceipt,
  type CoordinatorRequest,
  type CoordinatorTask,
  type CoordinatorTaskList,
  coordinatorTaskSearch,
  DaemonClient,
  draftBody,
  type Factory,
  type LineComment,
  movePlanKey,
  parseAutomationDraftRequest,
  type RunChat,
  type RunMessage,
  type RunSlots,
  type RunWithConversation,
  readDaemonInfo,
  sizeChoices,
  type Task,
  type TaskMovePlan,
  type ThreadEvent,
  tedPaths,
  type WaitingRequest,
} from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { coordinatorLine } from '../src/coordinators/coordinators.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import type { StoredCoordinator } from '../src/store/coordinators.ts'
import { openStore } from '../src/store/index.ts'
import {
  api,
  commitToOrigin,
  editEventlog,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  pretendStateSchemaChanged,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

let home: string,
  scratch: string,
  origin: string,
  cleanup: () => Promise<void>,
  daemon: RunningDaemon | undefined
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-coordinator-'))
  origin = await makeOriginRepo(scratch)
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})
async function setup(
  disk?: { freeBytes: () => Promise<number>; checkEveryMs: number },
  workflow?: string,
  nudgeAfterMs?: number,
) {
  if (workflow) await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
    ...(disk && { disk }),
    ...(nudgeAfterMs !== undefined && { nudgeAfterMs }),
  })
  const port = daemon.port
  const client = api(port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const chats = `/factories/${factory.id}/coordinator-chats`
  let chatId: string | undefined
  const chatPath = () => {
    if (chatId === undefined) throw new Error('no Coordinator chat yet')
    return `/coordinator-chats/${chatId}`
  }
  const chat = () => ok<Coordinator>('GET', chatPath())
  const message = async (body: Record<string, unknown>) => {
    const c =
      chatId === undefined
        ? await ok<Coordinator>('POST', chats, body)
        : await ok<Coordinator>('POST', `${chatPath()}/messages`, body)
    chatId = c.id
    return c
  }
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  async function start(steps: unknown[] = [{ waitFor: path.join(scratch, 'finish') }]) {
    const c = await message({ text: JSON.stringify({ steps }), agent: 'claude' })
    await waitUntil(async () => {
      const current = await chat()
      return current.started && current.status === 'working' ? current : undefined
    }, 'Coordinator to start')
    return { c, run: api(port, tokens.issue(c.runId)) }
  }
  const task = (title = 'A Task', factoryKey = 'NB') =>
    ok<Task>('POST', '/tasks', { factory: factoryKey, title })
  async function led(...steps: unknown[]) {
    const made = await task(JSON.stringify({ steps }))
    await ok('POST', `/tasks/${made.id}/start`)
    const leadRunId = await waitUntil(
      async () => (await ok<Task[]>('GET', '/tasks')).find((t) => t.id === made.id)?.leadRunId,
      'a Task Lead Run',
    )
    return { task: made, leadRunId, lead: api(port, tokens.issue(leadRunId)) }
  }
  const comments = (id: string) => ok<Comment[]>('GET', `/tasks/${id}/comments`)
  const waitingIds = async () =>
    (await ok<WaitingRequest[]>('GET', '/inbox/waiting')).map((w) => w.id)
  return {
    port,
    client,
    ok,
    factory,
    chats,
    get base() {
      return chatPath()
    },
    useChat(id: string | undefined) {
      chatId = id
    },
    chat,
    message,
    tokens,
    start,
    task,
    led,
    comments,
    waitingIds,
  }
}
type Api = ReturnType<typeof api>
function fullDisk(free = 1.4e9) {
  const disk = { free, freeBytes: async () => disk.free, checkEveryMs: 20 }
  return disk
}
const diskHold = (s: Awaited<ReturnType<typeof setup>>) =>
  waitUntil(
    async () =>
      (await s.ok<{ problem: string }[]>('GET', '/banners')).some((b) => b.problem === 'disk-full'),
    'disk hold',
  )
const version = async (run: Api, id: string) =>
  unpack<CoordinatorTask>((await run.call('GET', `/coordinator/tasks/${id}`)).body).version
const hold = () => ({ waitFor: path.join(scratch, 'lead-finish') })
function unpack<T>(body: unknown): T {
  const text = (body as { context: string }).context
  return JSON.parse(text.split('\n').slice(1, -1).join('\n')) as T
}

test('one conversation per Factory; scoped reads include fresh briefs and Comments', async () => {
  const s = await setup(),
    task = await s.task()
  const otherDir = path.join(scratch, 'other-origin')
  await mkdir(otherDir, { recursive: true })
  const otherOrigin = await makeOriginRepo(otherDir)
  const renamed = path.join(otherDir, 'acme', 'gadgets.git')
  await rename(otherOrigin, renamed)
  await s.ok('POST', '/dev/factories', { repo: renamed, key: 'OTHER' })
  const other = await s.task('Other Task', 'OTHER')
  await mkdir(path.join(home, 'library', 'agents'), { recursive: true })
  await writeFile(
    path.join(home, 'library', 'agents', 'coordinator.md'),
    '# You are the Coordinator for one TED Factory\nKeep answers to three lines.\n',
  )
  const { c, run } = await s.start()
  const conversation = await s.ok<RunWithConversation>('GET', `/runs/${c.runId}`)
  expect(conversation.run.prompt).toContain('## Write clearly for the user')
  expect(conversation.run.prompt).toContain('Keep answers to three lines.')
  expect(conversation.run.prompt).not.toContain('Help the human compare Tasks')
  expect(conversation.run.prompt).toContain('ted coordinator tasks [--stage <Stage>]')
  const list = unpack<{ tasks: Task[] }>((await run.call('GET', '/coordinator/tasks')).body)
  expect(list.tasks.map((t) => t.id)).toEqual([task.id])
  const badge = await s.task('Offline badge')
  const shelved = await s.task('Shelved idea')
  await s.ok('POST', `/tasks/${shelved.id}/archive`)
  const tasksWhere = async (query: string) =>
    unpack<CoordinatorTaskList>((await run.call('GET', `/coordinator/tasks${query}`)).body)
  expect(await tasksWhere('')).toMatchObject({
    tasks: [{ id: task.id }, { id: badge.id }],
    matching: 2,
    stageCounts: { backlog: 2 },
  })
  expect(await tasksWhere('?all=1')).toMatchObject({ matching: 3, archived: 1 })
  expect((await tasksWhere('?search=OFFLINE')).tasks.map((t) => t.id)).toEqual([badge.id])
  expect(
    (await tasksWhere(`?search=${encodeURIComponent(badge.displayId)}`)).tasks.map((t) => t.id),
  ).toEqual([badge.id])
  expect(await tasksWhere('?stage=work&stage=review')).toMatchObject({
    tasks: [],
    stageCounts: { backlog: 2 },
  })
  expect((await tasksWhere('?status=working')).matching).toBe(0)
  expect((await tasksWhere('?waiting=1')).matching).toBe(0)
  const nowhere = await run.call('GET', '/coordinator/tasks?stage=nowhere')
  expect(nowhere.status).toBe(400)
  expect(nowhere.body).toMatchObject({
    error: expect.stringContaining('unknown Stage nowhere; use one of backlog, intake,'),
  })
  expect((await run.call('GET', '/coordinator/tasks?stage=queued')).status).toBe(400)
  const symbols = await s.task('Sync & retry C++ at 100%')
  expect(
    (await tasksWhere(coordinatorTaskSearch({ search: '& retry C++ at 100%' }))).tasks.map(
      (t) => t.id,
    ),
  ).toEqual([symbols.id])
  expect((await run.call('GET', `/coordinator/tasks/${other.id}`)).status).toBe(404)
  await s.ok('POST', `/tasks/${task.id}/comments`, { body: 'Fresh context from the human' })
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
  )
  expect(read.comments.some((c) => c.body === 'Fresh context from the human')).toBe(true)
  const again = await s.message({
    text: 'Compare these Tasks',
  })
  expect(again.runId).toBe(c.runId)
  expect((await s.chat()).tasks.map((t) => t.id)).toEqual([
    symbols.id,
    shelved.id,
    badge.id,
    task.id,
  ])
})

test('Coordinator tokens cannot use generic reads, mutations, or human-only actions', async () => {
  const s = await setup(),
    task = await s.task(),
    { run } = await s.start()
  for (const [method, route] of [
    ['GET', '/tasks'],
    ['GET', '/settings'],
    ['GET', '/backups'],
    ['GET', '/events'],
    ['POST', `/tasks/${task.id}/start`],
    ['POST', `/tasks/${task.id}/outcome`],
    ['POST', `${s.base}/messages`],
    ['POST', s.chats],
    ['POST', `${s.base}/archive`],
    ['POST', `${s.base}/unarchive`],
    ['DELETE', s.base],
  ] as const) {
    expect(
      (await run.call(method, route, method === 'POST' ? { text: 'bypass' } : undefined)).status,
      route,
    ).toBe(403)
  }
  const ordinary = await s.client.startRun(
    [{ waitFor: path.join(scratch, 'other-finish') }],
    scratch,
  )
  expect(
    (await api(s.port, s.tokens.issue(ordinary.id)).call('GET', '/coordinator/tasks')).status,
  ).toBe(403)
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('missing daemon connection')
  const file = api(s.port, info.token)
  expect((await file.call('POST', `${s.base}/messages`, { text: 'bypass' })).status).toBe(403)
  expect((await file.call('POST', s.chats, { text: 'bypass' })).status).toBe(403)
  expect((await file.call('DELETE', s.base)).status).toBe(403)
  expect((await file.call('POST', `${s.base}/archive`, {})).status).toBe(403)
  expect((await file.call('POST', `/coordinator/tasks/${task.id}/start`, {})).status).toBe(403)
})

test('the Coordinator drafts Automations as cards that only the app carries out', async () => {
  const s = await setup()
  const { c, run } = await s.start()
  const automations = () => s.ok<Automation[]>('GET', '/automations')
  const draft = (operation: string, kind: string, extra: JsonObject) =>
    run.call('POST', '/coordinator/automation-drafts', { operation, kind, ...extra })
  const cards = async () => (await s.chat()).automationCards
  const answer = (cardId: string, body: JsonObject) =>
    s.ok<Coordinator>('POST', `${s.base}/automation-cards/${cardId}`, body)
  const weekdays = { kind: 'weekdays', at: '08:00' }

  const info = await readDaemonInfo(home)
  if (!info) throw new Error('missing daemon connection')
  const file = api(s.port, info.token)
  const body = { name: 'Sneaky', prompt: 'Go', schedule: weekdays }
  for (const caller of [run, file]) {
    expect((await caller.call('POST', '/automations', body)).status).toBe(403)
    expect((await caller.call('PATCH', '/automations/x', { name: 'N' })).status).toBe(403)
    expect((await caller.call('DELETE', '/automations/x')).status).toBe(403)
    expect(
      (await caller.call('POST', `${s.base}/automation-cards/x`, { decision: 'confirm' })).status,
    ).toBe(403)
  }

  const fields = {
    name: 'Morning intake',
    prompt: 'Pull my new Linear issues. Key ghp_abcdefghijklmnopqrstuvwxyz0123',
    schedule: weekdays,
    on: false,
  }
  const runClient = new DaemonClient(info, s.tokens.issue(c.runId))
  const drafted = await runClient.draftAutomation(
    draftBody(parseAutomationDraftRequest({ operation: 'op-create', kind: 'create', fields })),
  )
  const cardId = drafted.card.id
  expect((await draft('op-create', 'create', { fields })).body).toEqual({
    card: { id: cardId, waiting: true },
  })
  expect(
    (await draft('op-create', 'create', { fields: { ...fields, name: 'Other' } })).status,
  ).toBe(409)
  expect(await automations()).toEqual([])
  const [card] = await cards()
  expect(card).toMatchObject({ id: cardId, kind: 'create', name: 'Morning intake' })
  expect(card?.create?.prompt).toBe('Pull my new Linear issues. Key [redacted]')
  expect(card?.rows.find((r) => r.label === 'Schedule')?.value).toMatch(/weekday/i)
  expect(card?.nextFirings).toHaveLength(3)
  expect(card?.offersStartTasks).toBe(false)
  expect(
    (await s.ok<WaitingRequest[]>('GET', '/inbox/waiting')).find((w) => w.id === cardId),
  ).toMatchObject({
    source: 'coordinator',
    chatId: c.id,
    headline: 'Create Automation “Morning intake”?',
    automationCard: 'create',
  })
  expect(
    (
      await s.client.call('POST', `${s.base}/automation-cards/${cardId}`, {
        decision: 'confirm',
        startTasks: true,
      })
    ).status,
  ).toBe(400)

  await answer(cardId, { decision: 'confirm' })
  const [created] = await automations()
  expect(created).toMatchObject({
    name: 'Morning intake',
    prompt: 'Pull my new Linear issues. Key [redacted]',
    schedule: weekdays,
    on: false,
  })
  expect((await cards())[0]?.answer).toMatchObject({
    decision: 'confirm',
    automationId: created?.id,
  })
  expect(await s.waitingIds()).not.toContain(cardId)
  const listed = unpack<{ automations: Automation[] }>(
    (await run.call('GET', '/coordinator/automations')).body,
  )
  expect(listed.automations.map((a) => a.name)).toEqual(['Morning intake'])

  const check = await draft('op-check', 'create', {
    fields: {
      name: 'Nightly tests',
      schedule: { kind: 'daily', at: '03:00' },
      on: false,
      check: { command: 'pnpm check' },
    },
  })
  const checkCard = (check.body as { card: { id: string } }).card.id
  expect((await cards()).find((x) => x.id === checkCard)?.offersStartTasks).toBe(true)
  await answer(checkCard, { decision: 'confirm', startTasks: true })
  expect((await automations()).find((a) => a.name === 'Nightly tests')?.check?.startTasks).toBe(
    true,
  )

  const id = created?.id ?? ''
  const edit = await draft('op-edit', 'edit', {
    automation: id,
    fields: { schedule: { kind: 'daily', at: '07:00' } },
  })
  const editCard = (edit.body as { card: { id: string } }).card.id
  expect((await cards()).find((x) => x.id === editCard)?.rows).toEqual([
    expect.objectContaining({ label: 'Schedule', before: created?.scheduleText }),
  ])
  expect(
    (await draft('op-same', 'edit', { automation: id, fields: { schedule: weekdays } })).status,
  ).toBe(400)
  await s.ok('PATCH', `/automations/${id}`, { name: 'Renamed by hand' })
  await answer(editCard, { decision: 'confirm' })
  expect((await cards()).find((x) => x.id === editCard)?.answer?.refused).toBe(
    '“Morning intake” changed after this card was shown',
  )
  expect((await automations()).find((a) => a.id === id)?.schedule).toEqual(weekdays)

  const remove = await draft('op-delete', 'delete', { automation: id })
  const removeCard = (remove.body as { card: { id: string } }).card.id
  await answer(removeCard, { decision: 'cancel' })
  expect((await automations()).some((a) => a.id === id)).toBe(true)
  const again = await draft('op-delete-2', 'delete', { automation: id })
  await answer((again.body as { card: { id: string } }).card.id, { decision: 'confirm' })
  expect((await automations()).some((a) => a.id === id)).toBe(false)

  const secretModel = await draft('op-model', 'create', {
    fields: { ...fields, model: `sk-${'a'.repeat(24)}` },
  })
  expect(secretModel.status).toBe(400)
  expect(JSON.stringify(secretModel.body)).toContain('model looks like a secret')
  const open: string[] = []
  for (let n = 0; n < 20; n++) {
    const made = await draft(`op-open-${n}`, 'create', { fields: { ...fields, name: `Open ${n}` } })
    open.push((made.body as { card: { id: string } }).card.id)
  }
  expect((await draft('op-open-20', 'create', { fields })).status).toBe(409)
  await s.ok('POST', `${s.base}/archive`, {})
  const after = await cards()
  for (const id of open) expect(after.find((x) => x.id === id)?.answer?.decision).toBe('cancel')
  const waiting = await s.waitingIds()
  expect(open.some((id) => waiting.includes(id))).toBe(false)
  expect((await automations()).some((a) => a.name.startsWith('Open '))).toBe(false)
}, 90_000)

test('actions reject stale state and cross-Factory neighbours; moves and creates retry receipts after a restart', async () => {
  const s = await setup(),
    a = await s.task('A'),
    b = await s.task('B'),
    { run } = await s.start([
      { everyMessage: [{ endTurn: true }] },
      { waitFor: path.join(scratch, 'finish') },
      { endTurn: true },
    ])
  const read = async (id: string) =>
    unpack<CoordinatorTask>((await run.call('GET', `/coordinator/tasks/${id}`)).body)
  await s.ok('PUT', `/tasks/${b.id}/priority`, { priority: 'high' })
  const av = await read(a.id),
    bv = await read(b.id)
  const input = {
    operation: 'move-1',
    version: av.version,
    after: b.id,
    neighbours: { [b.id]: bv.version },
  }
  const move = await run.call('POST', `/coordinator/tasks/${a.id}/move`, input)
  expect(move.status).toBe(200)
  expect((move.body as { text: string }).text).toContain('Priority changed to high')
  const receipt = (await s.chat()).receipts[0]
  expect(receipt?.before?.priority).toBe('none')
  expect(receipt?.after?.priority).toBe('high')
  expect((await run.call('POST', `/coordinator/tasks/${a.id}/move`, input)).body).toEqual(move.body)
  expect(
    (await run.call('POST', `/coordinator/tasks/${a.id}/move`, { ...input, operation: 'stale' }))
      .status,
  ).toBe(409)
  expect(
    (await run.call('POST', `/coordinator/tasks/${a.id}/move`, { ...input, before: a.id })).status,
  ).toBe(409)
  const otherDir = path.join(scratch, 'other-origin')
  await mkdir(otherDir, { recursive: true })
  const otherOrigin = await makeOriginRepo(otherDir)
  const renamed = path.join(otherDir, 'acme', 'gadgets.git')
  await rename(otherOrigin, renamed)
  await s.ok('POST', '/dev/factories', { repo: renamed, key: 'OTHER' })
  const foreign = await s.task('foreign', 'OTHER')
  expect(
    (
      await run.call('POST', `/coordinator/tasks/${b.id}/move`, {
        operation: 'foreign',
        version: bv.version,
        before: foreign.id,
      })
    ).status,
  ).toBe(404)

  const create = {
    operation: 'create-1',
    title: 'C',
    description: 'From the Coordinator',
    parentId: a.id,
    blockedBy: [b.id],
    after: b.id,
    neighbours: { [b.id]: (await read(b.id)).version },
  }
  const made = await run.call('POST', '/coordinator/tasks', create)
  expect(made.status).toBe(201)
  const createReceipt = made.body as CoordinatorReceipt
  expect(createReceipt.text).toMatch(/^Created NB-\d+ “C” · Backlog · Priority high$/)
  const titled = async (title: string) =>
    (await s.ok<Task[]>('GET', '/tasks')).filter((t) => t.title === title)
  expect(await titled('C')).toMatchObject([
    {
      id: createReceipt.taskId,
      description: 'From the Coordinator',
      stage: 'backlog',
      createdBy: 'coordinator',
      parentId: a.id,
      blockedBy: [b.id],
      priority: 'high',
    },
  ])
  expect((await run.call('POST', '/coordinator/tasks', create)).body).toEqual(made.body)
  expect((await run.call('POST', '/coordinator/tasks', { ...create, title: 'D' })).status).toBe(409)
  expect(
    (
      await run.call('POST', '/coordinator/tasks', {
        operation: 'create-foreign',
        title: 'E',
        blockedBy: [foreign.id],
      })
    ).status,
  ).toBe(404)
  expect(await titled('C')).toHaveLength(1)
  expect(await titled('E')).toHaveLength(0)
  expect(
    (await s.client.call('POST', '/coordinator/tasks', { operation: 'x', title: 'F' })).status,
  ).toBe(403)

  const d = await s.task('D')
  const removal = async (kind: string, ids: string[], extra: object = {}, operation = '') =>
    run.call('POST', `/coordinator/${kind}`, {
      operation: operation || `${kind}-${ids.join('-')}`,
      tasks: await Promise.all(ids.map(async (id) => ({ id, version: (await read(id)).version }))),
      ...extra,
    })
  const taskById = async (id: string) =>
    (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  const archivedD = await removal('archive', [d.id], {}, 'archive-d')
  expect(archivedD.status).toBe(200)
  expect(archivedD.body).toMatchObject({
    receipts: [{ operation: 'archive', taskId: d.id, text: `Archived ${d.displayId}` }],
  })
  expect(archivedD.body).not.toHaveProperty('confirmation')
  expect((await taskById(d.id))?.archived).toBeTruthy()
  const unarchivedD = await removal('unarchive', [d.id])
  expect((unarchivedD.body as { receipts: CoordinatorReceipt[] }).receipts[0]?.text).toContain(
    `Unarchived ${d.displayId}`,
  )
  expect((await taskById(d.id))?.archived).toBeFalsy()
  expect(
    (
      await run.call('POST', '/coordinator/archive', {
        operation: 'archive-foreign',
        tasks: [{ id: foreign.id, version: av.version }],
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await run.call('POST', '/coordinator/archive', {
        operation: 'stale-archive',
        tasks: [{ id: d.id, version: av.version }],
      })
    ).status,
  ).toBe(409)

  const childC = await taskById(createReceipt.taskId ?? '')
  if (!childC) throw new Error('missing C')
  const archiveB = await removal('archive', [b.id])
  expect(archiveB.body).toMatchObject({
    receipts: [
      {
        operation: 'archive',
        taskId: b.id,
        text: `Archived ${b.displayId} · unblocked ${childC.displayId}`,
      },
    ],
  })
  expect(archiveB.body).not.toHaveProperty('confirmation')
  expect((await taskById(childC.id))?.blockedBy).toEqual([])
  const archiveA = await removal('archive', [a.id])
  const askedA = (archiveA.body as { confirmation: { id: string; waiting: boolean } }).confirmation
  expect(askedA.waiting).toBe(true)
  expect((await taskById(a.id))?.archived).toBeFalsy()
  const p = await s.task('P')
  const madeQ = await run.call('POST', '/coordinator/tasks', {
    operation: 'create-q',
    title: 'Q',
    parentId: p.id,
  })
  expect(madeQ.status).toBe(201)
  const q = await taskById((madeQ.body as CoordinatorReceipt).taskId ?? '')
  if (!q) throw new Error('missing Q')
  const madeR = await run.call('POST', '/coordinator/tasks', {
    operation: 'create-r',
    title: 'R',
    parentId: q.id,
  })
  expect(madeR.status).toBe(201)
  const r = (madeR.body as CoordinatorReceipt).taskId ?? ''
  const f = await s.task('F')
  await removal('archive', [f.id])
  expect((await taskById(f.id))?.archived).toBeTruthy()
  const adInput = {
    operation: 'delete-adf',
    tasks: await Promise.all(
      [p.id, d.id, f.id].map(async (id) => ({ id, version: (await read(id)).version })),
    ),
    children: 'delete',
  }
  const deleteAD = await run.call('POST', '/coordinator/delete', adInput)
  const askedAD = (deleteAD.body as { confirmation: { id: string } }).confirmation
  const cards = (await s.chat()).confirmations
  expect(cards.find((card) => card.id === askedA.id)).toMatchObject({
    kind: 'archive',
    tasks: [{ id: a.id, descendants: [{ id: childC.id }], blockedTasks: [] }],
  })
  expect(cards.find((c) => c.id === askedAD.id)).toMatchObject({
    kind: 'delete',
    tasks: [
      { id: p.id, children: 'delete', descendants: [{ id: q.id }, { id: r }] },
      { id: d.id, descendants: [] },
      { id: f.id },
    ],
  })
  const waiting = await s.ok<WaitingRequest[]>('GET', '/inbox/waiting')
  expect(waiting.filter((w) => w.source === 'coordinator')).toMatchObject([
    { id: askedA.id, headline: `Archive ${a.displayId}?` },
    {
      id: askedAD.id,
      headline: `Delete 3 Tasks? ${p.displayId}, ${d.displayId}, ${f.displayId}`,
    },
  ])
  const answer = (id: string) => `${s.base}/confirmations/${id}`
  expect((await run.call('POST', answer(askedA.id), { decision: 'confirm' })).status).toBe(403)
  await s.ok('POST', answer(askedA.id), { decision: 'cancel' })
  expect((await taskById(a.id))?.archived).toBeFalsy()
  expect(await s.waitingIds()).not.toContain(askedA.id)

  const g = await s.task('G')
  const madeH = await run.call('POST', '/coordinator/tasks', {
    operation: 'create-h',
    title: 'H',
    parentId: g.id,
  })
  const h = (madeH.body as CoordinatorReceipt).taskId ?? ''
  const i = await s.ok<Task>('POST', '/tasks', { factory: 'NB', title: 'I', blockedBy: [h] })
  const j = await s.ok<Task>('POST', '/tasks', { factory: 'NB', title: 'J', blockedBy: [g.id] })
  const madeK = await run.call('POST', '/coordinator/tasks', {
    operation: 'create-k',
    title: 'K',
    parentId: j.id,
    blockedBy: [g.id],
  })
  const k = (madeK.body as CoordinatorReceipt).taskId ?? ''
  const gj = await removal('archive', [g.id, j.id], {}, 'archive-gj')
  const askedGJ = (gj.body as { confirmation: { id: string } }).confirmation
  expect((await s.chat()).confirmations.find((x) => x.id === askedGJ.id)?.tasks).toMatchObject([
    { id: g.id, blockedTasks: [], blockedTogether: [{ id: i.id }] },
    { id: j.id, blockedTasks: [], blockedTogether: [] },
  ])
  const archivedGJ = await s.ok<Coordinator>('POST', answer(askedGJ.id), { decision: 'confirm' })
  expect(archivedGJ.confirmations.find((x) => x.id === askedGJ.id)?.tasks).toMatchObject([
    {
      id: g.id,
      result: {
        done: true,
        text: `Archived ${g.displayId} and the Tasks under it · unblocked ${i.displayId}`,
      },
    },
    { id: j.id, result: { done: true, text: `Archived ${j.displayId} and the Tasks under it` } },
  ])
  expect((await taskById(i.id))?.blockedBy).toEqual([])
  expect((await taskById(k))?.archived).toBeTruthy()
  const x = await s.task('X')
  await run.call('POST', '/coordinator/tasks', {
    operation: 'create-y',
    title: 'Y',
    parentId: x.id,
  })
  const z = await s.task('Z')
  const xz = await removal('archive', [x.id, z.id], {}, 'archive-xz')
  const askedXZ = (xz.body as { confirmation: { id: string } }).confirmation
  await s.ok('POST', `/tasks/${z.id}/delete`, {})
  const answeredXZ = await s.ok<Coordinator>('POST', answer(askedXZ.id), { decision: 'confirm' })
  expect(answeredXZ.confirmations.find((c) => c.id === askedXZ.id)).toMatchObject({
    answer: { decision: 'confirm' },
    tasks: [
      { id: x.id, result: { done: true } },
      { id: z.id, result: { done: false, text: expect.stringContaining('no longer exists') } },
    ],
  })

  const e2 = await s.ok<Task>('POST', '/tasks', { factory: 'NB', title: 'E2', blockedBy: [q.id] })
  const own = await removal('delete', [p.id, q.id], { children: 'delete' }, 'delete-ac-own')
  const askedOwn = (own.body as { confirmation: { id: string } }).confirmation
  const refusedOwn = await s.ok<Coordinator>('POST', answer(askedOwn.id), {
    decision: 'confirm',
    choices: { [q.id]: { children: 'unparent' } },
  })
  expect(refusedOwn.confirmations.find((x) => x.id === askedOwn.id)?.tasks).toMatchObject([
    {
      id: p.id,
      result: {
        done: false,
        text: expect.stringContaining(`${q.displayId}, which is under it, has its own choices`),
      },
    },
    { id: q.id, result: { done: false, text: expect.stringContaining(`under ${p.displayId}`) } },
  ])
  expect(await taskById(p.id)).toBeDefined()
  expect(await taskById(q.id)).toBeDefined()
  const cascade = await removal('delete', [p.id, q.id], { children: 'delete' }, 'delete-ac')
  const askedAC = (cascade.body as { confirmation: { id: string } }).confirmation
  const e3 = await s.ok<Task>('POST', '/tasks', { factory: 'NB', title: 'E3', blockedBy: [q.id] })
  const refusedAC = await s.ok<Coordinator>('POST', answer(askedAC.id), { decision: 'confirm' })
  expect(refusedAC.confirmations.find((x) => x.id === askedAC.id)?.tasks).toMatchObject([
    {
      id: p.id,
      result: { done: false, text: expect.stringContaining('the Tasks it blocks changed') },
    },
    { id: q.id, result: { done: false, text: expect.stringContaining('the Tasks it blocks') } },
  ])
  expect(await taskById(p.id)).toBeDefined()
  expect(await taskById(q.id)).toBeDefined()

  for (const e of [e2, e3]) await s.ok('DELETE', `/tasks/${e.id}/blockers/${q.id}`)
  await s.ok('POST', '/tasks', { factory: 'NB', title: 'E', blockedBy: [d.id] })
  const answered = await s.ok<Coordinator>('POST', answer(askedAD.id), {
    decision: 'confirm',
  })
  expect(answered.confirmations.find((c) => c.id === askedAD.id)).toMatchObject({
    answer: { decision: 'confirm' },
    tasks: [
      { id: p.id, result: { done: true } },
      {
        id: d.id,
        result: {
          done: false,
          text: expect.stringContaining('the Tasks it blocks changed after this card was shown'),
        },
      },
      { id: f.id, result: { done: true } },
    ],
  })
  expect(await taskById(f.id)).toBeUndefined()
  expect(await taskById(p.id)).toBeUndefined()
  expect(await taskById(q.id)).toBeUndefined()
  expect(await taskById(a.id)).toBeDefined()
  expect((await taskById(d.id))?.archived).toBeFalsy()
  expect((await s.client.call('POST', answer(askedAD.id), { decision: 'cancel' })).status).toBe(409)
  expect((await run.call('POST', '/coordinator/delete', adInput)).body).toMatchObject({
    confirmation: { id: askedAD.id, waiting: false },
    receipts: [
      { operation: 'delete', taskId: p.id },
      { operation: 'delete', taskId: f.id },
    ],
  })

  const t = await s.task('T')
  const transfer = async (operation: string, factory = 'OTHER') =>
    run.call('POST', '/coordinator/transfer', {
      operation,
      task: { id: t.id, version: (await read(t.id)).version },
      factory,
      reason: 'The user asked to move it',
    })
  expect((await transfer('transfer-own', 'NB')).status).toBe(409)
  expect((await transfer('transfer-nowhere', 'NOPE')).status).toBe(404)
  const moveAsked = async () =>
    (await s.comments(t.id)).find((c) => c.move !== undefined && c.answer === undefined)
  expect((await transfer('transfer-t-keep')).body).toMatchObject({
    receipts: [
      {
        operation: 'transfer',
        taskId: t.id,
        text: expect.stringContaining('Asked the user to move'),
      },
    ],
  })
  const kept = await waitUntil(moveAsked, 'the move request')
  expect(kept).toMatchObject({
    author: { kind: 'ted' },
    choices: ['Move', 'Keep it'],
    move: {
      askedBy: 'coordinator',
      chatId: (await s.chat()).id,
      reason: 'The user asked to move it',
    },
  })
  expect(await s.waitingIds()).toContain(kept.id)
  expect((await transfer('transfer-t-again')).status).toBe(409)
  expect(
    (
      await run.call('POST', `/coordinator/tasks/${t.id}/answer`, {
        operation: 'answer-move',
        version: (await read(t.id)).version,
        request: kept.id,
        choice: 'Move',
      })
    ).status,
  ).toBe(403)
  await s.ok('POST', `/comments/${kept.id}/answer`, { action: 'answer', choice: 'Keep it' })
  expect(await taskById(t.id)).toMatchObject({ factoryId: t.factoryId, displayId: t.displayId })

  await transfer('transfer-t')
  const asked = await waitUntil(moveAsked, 'the second move request')
  const counted = await s.ok<TaskMovePlan>(
    'GET',
    `/tasks/${t.id}/move-plan?factory=${foreign.factoryId}`,
  )
  expect(counted.tasks).toMatchObject([{ id: t.id, openRequests: 1 }])
  const plan = await s.ok<TaskMovePlan>(
    'GET',
    `/tasks/${t.id}/move-plan?factory=${foreign.factoryId}&request=${asked.id}`,
  )
  expect(plan.tasks).toMatchObject([{ id: t.id, openRequests: 0 }])
  await s.ok('POST', `/comments/${asked.id}/answer`, {
    action: 'answer',
    choice: 'Move',
    move: { factoryId: foreign.factoryId, planKey: movePlanKey(plan) },
  })
  expect(await taskById(t.id)).toMatchObject({
    factoryId: foreign.factoryId,
    displayId: expect.stringMatching(/^OTHER-\d+$/),
  })
  expect((await s.comments(t.id)).find((c) => c.id === asked.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Move',
  })

  const u = await s.task('U')
  await run.call('POST', '/coordinator/transfer', {
    operation: 'transfer-u',
    task: { id: u.id, version: (await read(u.id)).version },
    factory: 'OTHER',
    reason: 'The user asked to move it',
  })
  const askedU = await waitUntil(
    async () => (await s.comments(u.id)).find((c) => c.move !== undefined),
    'the move request on U',
  )
  await s.ok('POST', `/tasks/${u.id}/move-to-factory`, { factoryId: foreign.factoryId })
  expect((await s.comments(u.id)).find((c) => c.id === askedU.id)?.answer).toMatchObject({
    kind: 'withdrawn',
  })

  if (!receipt) throw new Error('missing move receipt')
  const legacyReceipt = {
    ...receipt,
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([a.id, 'move', input.version, input.after, undefined, input.neighbours]),
      )
      .digest('hex'),
  }
  await writeFile(path.join(scratch, 'finish'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'Coordinator to finish its turn')
  const chatRun = (await s.chat()).runId
  await waitUntil(
    async () =>
      JSON.stringify((await s.ok<RunChat>('GET', `/runs/${chatRun}/chat`)).items).includes(
        `Your request to move ${u.displayId} was withdrawn`,
      ),
    'the Coordinator to hear its request was withdrawn',
  )
  await daemon?.stop()
  const store = await openStore({ directory: tedPaths(home).store })
  let deliveredId = ''
  try {
    const saved = store.coordinators.list().find((c) => c.factoryId === s.factory.id)
    if (!saved) throw new Error('missing saved Coordinator')
    await store.createTask({
      title: 'Made by another chat',
      factoryId: s.factory.id,
      coordinatorOperation: 'another-chat:create-crash',
    })
    await store.createTask({
      title: 'Crashed',
      factoryId: s.factory.id,
      coordinatorOperation: `${saved.id}:create-crash`,
    })
    const crashed: CoordinatorReceipt = {
      id: 'create-crash',
      operation: 'create',
      text: 'Action interrupted before its result was saved.',
      at: new Date().toISOString(),
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            'create',
            'Crashed',
            createHash('sha256').update('').digest('hex'),
            ...Array(10).fill(undefined),
          ]),
        )
        .digest('hex'),
    }
    const at = new Date().toISOString()
    const delivered = store.queueRunMessage({
      runId: saved.runId,
      text: 'Continue the interrupted response using fresh facts. Do not repeat completed actions.',
    })
    store.deliverRunMessages(saved.runId, [delivered.id], false)
    deliveredId = delivered.id
    store.coordinators.save({
      ...saved,
      receipts: [
        ...saved.receipts.map((r) => (r.id === legacyReceipt.id ? legacyReceipt : r)),
        crashed,
      ],
      unsentMessages: [
        {
          id: 'legacy-ted',
          runId: saved.runId,
          text: 'Continue the interrupted response using fresh facts. Do not repeat completed actions.',
          at,
        },
        { id: 'legacy-human', runId: saved.runId, text: 'Hold NB-2 for now.', at },
      ],
    })
    await store.persisted()
  } finally {
    await store.close()
  }
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  expect(((await client.call('GET', s.base)).body as Coordinator).receipts).toContainEqual(
    legacyReceipt,
  )
  const chat = (await client.call('GET', `${s.base}/chat`)).body as RunChat
  const unsent = chat.items.filter((item) => item.kind === 'human' && item.unsent === true)
  expect(unsent.map((item) => item.id)).toEqual(['legacy-human'])
  expect(chat.items.find((item) => item.id === deliveredId)?.kind).toBe('ted')
  expect(
    chat.items.filter((item) => item.kind === 'human' && item.text.startsWith('Continue the')),
  ).toEqual([])
  expect(
    (
      await client.call('POST', `${s.base}/messages`, {
        text: JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'after-restart') }] }),
        agent: 'claude',
      })
    ).status,
  ).toBe(201)
  const resumed = await waitUntil(async () => {
    const current = (await client.call('GET', s.base)).body as Coordinator
    return current.started && current.status === 'working' ? current : undefined
  }, 'Coordinator to resume after replay')
  const retry = api(daemon.port, s.tokens.issue(resumed.runId))
  const recovered = await retry.call('POST', '/coordinator/tasks', {
    operation: 'create-crash',
    title: 'Crashed',
  })
  const crashedTasks = ((await client.call('GET', '/tasks')).body as Task[]).filter(
    (t) => t.title === 'Crashed',
  )
  expect(crashedTasks).toHaveLength(1)
  expect(recovered.body).toMatchObject({ taskId: crashedTasks[0]?.id, operation: 'create' })
  expect((recovered.body as CoordinatorReceipt).text).toContain(
    'the rest of the action was interrupted',
  )
  const repeated = await retry.call('POST', `/coordinator/tasks/${a.id}/move`, input)
  expect(repeated.status).toBe(200)
  expect(repeated.body).toEqual(legacyReceipt)
  expect(
    ((await client.call('GET', s.base)).body as Coordinator).receipts.filter(
      (r) => r.id === input.operation,
    ),
  ).toHaveLength(1)
  expect(
    (await retry.call('POST', `/coordinator/tasks/${a.id}/move`, { ...input, before: a.id }))
      .status,
  ).toBe(409)
}, 60_000)

test('start queues a Task through existing slot limits and writes one receipt', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const blocker = await s.task(JSON.stringify({ steps: [hold(), { endTurn: true }] }))
  await s.ok('POST', `/tasks/${blocker.id}/start`)
  await waitUntil(
    async () => (await s.ok<RunSlots>('GET', '/slots')).working === 1,
    'another Task to hold the slot',
  )
  const task = await s.task(),
    { run } = await s.start()
  const detail = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
  )
  const input = { operation: 'start-1', version: detail.version }
  const first = await run.call('POST', `/coordinator/tasks/${task.id}/start`, input)
  expect(first.status).toBe(200)
  expect((await run.call('POST', `/coordinator/tasks/${task.id}/start`, input)).body).toEqual(
    first.body,
  )
  const tasks = await s.ok<Task[]>('GET', '/tasks')
  expect(tasks.find((t) => t.id === task.id)?.stage).toBe('intake')
  expect((await s.chat()).receipts).toHaveLength(1)
  const slots = await s.ok<RunSlots>('GET', '/slots')
  expect(slots.working).toBe(1)
  expect(slots.queue.some((q) => q.kind === 'task' && q.taskId === task.id)).toBe(true)
  const thread = (await s.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)
  expect(thread).toContain('Started by the Coordinator')
  expect(thread).not.toContain('Task started')
})

test('idle follow-up turns start past the slot limit, including generic chat message paths', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const { c } = await s.start([{ say: 'First response' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'Coordinator to become ready')
  const task = await s.task(JSON.stringify({ steps: [hold(), { endTurn: true }] }))
  await s.ok('POST', `/tasks/${task.id}/start`)
  await waitUntil(
    async () => (await s.ok<RunSlots>('GET', '/slots')).working === 1,
    'Task to hold slot',
  )
  await s.ok('POST', `/runs/${c.runId}/messages`, {
    text: JSON.stringify({
      steps: [
        { say: 'Second response' },
        { waitFor: path.join(scratch, 'finish') },
        { endTurn: true },
      ],
    }),
  })
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Second response')
  }, 'follow-up response while the slot is taken')
  expect((await s.chat()).status).toBe('working')
  const slots = await s.ok<RunSlots>('GET', '/slots')
  expect(slots).toMatchObject({ limit: 1, working: 1, queued: 0 })
  expect(slots.holders.map((h) => h.kind).sort()).toEqual(['coordinator', 'task'])
  await writeFile(path.join(scratch, 'finish'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'follow-up to finish')
})

test('Stop cancels an unstarted conversation turn; later messages do not execute it', async () => {
  const disk = fullDisk()
  const s = await setup(disk)
  await diskHold(s)
  const c = await s.message({
    agent: 'claude',
    text: JSON.stringify({ steps: [{ say: 'Cancelled response' }, { endTurn: true }] }),
  })
  expect(c.status).toBe('queued')
  await expect
    .poll(() => s.ok<import('@ted/protocol').Activity>('GET', '/activity'))
    .toMatchObject({ runs: { queued: 1 } })
  await s.ok('POST', `${s.base}/stop`)
  await s.message({
    text: JSON.stringify({ steps: [{ say: 'Replacement response' }, { endTurn: true }] }),
  })
  disk.free = 30e9
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`).catch(() => undefined)
    return chat?.items.some((i) => i.kind === 'agent' && i.text === 'Replacement response')
  }, 'replacement response')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Cancelled response')).toBe(false)
})

test('chats started at the same time each get their own Coordinator and survive daemon restart', async () => {
  const disk = fullDisk()
  const s = await setup(disk)
  await diskHold(s)
  const inputs = ['First queued message', 'Second queued message']
  const chats = await Promise.all(
    inputs.map((text) => s.ok<Coordinator>('POST', s.chats, { text, agent: 'claude' })),
  )
  expect(new Set(chats.map((c) => c.id)).size).toBe(2)
  expect(chats[0]?.runId).not.toBe(chats[1]?.runId)
  await daemon?.stop()
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath, disk })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const read = async (id: string) =>
    (await client.call('GET', `/coordinator-chats/${id}`)).body as Coordinator
  for (const c of chats) {
    expect(await read(c.id)).toMatchObject({ runId: c.runId, status: 'queued', started: false })
  }
  disk.free = 30e9
  for (const [i, c] of chats.entries()) {
    await waitUntil(async () => (await read(c.id)).started, 'recovered Coordinator')
    const chat = (await client.call('GET', `/coordinator-chats/${c.id}/chat`)).body as RunChat
    expect(chat.items.some((item) => item.kind === 'human' && item.text === inputs[i])).toBe(true)
    expect(chat.items.some((item) => item.kind === 'human' && item.text === inputs[1 - i])).toBe(
      false,
    )
  }
})

test('failed session resumption can retry in a replacement Run with history and stale tokens refused', async () => {
  const s = await setup()
  const { c, run } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'initial failure')
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
  await s.ok('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'failed', 'failed resume')
  await s.ok('POST', `${s.base}/retry`)
  const replaced = await waitUntil(async () => {
    const chat = await s.chat()
    return chat.runId !== c.runId && chat.started ? chat : undefined
  }, 'replacement Run')
  expect(replaced.runIds).toContain(c.runId)
  expect(replaced.status).toBe('working')
  const replacement = api(s.port, s.tokens.issue(replaced.runId))
  expect((await replacement.call('GET', '/coordinator/tasks')).status).toBe(200)
  await s.message({
    text: JSON.stringify({ steps: [{ run: ['ted', 'coordinator', 'tasks'] }, { endTurn: true }] }),
  })
  await waitUntil(
    async () =>
      (await s.ok<RunChat>('GET', `/runs/${replaced.runId}/chat`)).run.state === 'working',
    'replacement agent turn',
  )
  await replacement.call('POST', `/runs/${replaced.runId}/boundary`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'replacement settlement')
  expect((await s.ok<RunSlots>('GET', '/slots')).working).toBe(0)
  const replacementChat = await s.ok<RunChat>('GET', `/runs/${replaced.runId}/chat`)
  const reply = replacementChat.items.find((i) => i.kind === 'agent' && i.text.includes('stdout'))
  if (reply?.kind !== 'agent') throw new Error('missing replacement tool response')
  expect(JSON.parse(reply.text).code).toBe(0)

  expect((await run.call('GET', '/coordinator/tasks')).status).toBe(403)
  const history = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(history.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
})

test('Factory removal deletes every Coordinator chat, its pending work and managed files', async () => {
  const s = await setup()
  const first = await s.start()
  s.useChat(undefined)
  const { c, run } = await s.start()
  const firstPath = `/coordinator-chats/${first.c.id}`
  await s.ok('POST', `/factories/${s.factory.id}/remove`, { key: 'NB', closePullRequests: false })
  expect((await s.client.call('GET', s.base)).status).toBe(404)
  expect((await s.client.call('GET', firstPath)).status).toBe(404)
  expect((await s.client.call('GET', s.chats)).status).toBe(404)
  for (const runId of [first.c.runId, c.runId]) {
    expect((await s.client.call('GET', `/runs/${runId}/chat`)).status).toBe(404)
    expect(existsSync(path.join(home, 'coordinators', runId))).toBe(false)
    expect(existsSync(path.join(home, 'runs', runId))).toBe(false)
  }
  expect((await run.call('GET', '/coordinator/tasks')).status).toBe(403)
  expect((await first.run.call('GET', '/coordinator/tasks')).status).toBe(403)
})

test('two open chats keep their own receipts and confirmations; deleting one leaves the other working', async () => {
  const s = await setup()
  const one = await s.task('One')
  const two = await s.task('Two')
  const a = await s.start([{ waitFor: path.join(scratch, 'finish-a') }])
  const aPath = s.base
  s.useChat(undefined)
  const b = await s.start([{ waitFor: path.join(scratch, 'finish-b') }, { endTurn: true }])
  const bPath = s.base
  expect(b.c.id).not.toBe(a.c.id)
  const read = (route: string) => s.ok<Coordinator>('GET', route)
  expect((await read(aPath)).status).toBe('working')
  expect((await read(bPath)).status).toBe('working')

  const told = await a.run.call('POST', `/coordinator/tasks/${one.id}/tell`, {
    operation: 'tell-a',
    version: await version(a.run, one.id),
    message: 'From chat A',
  })
  expect(told.status).toBe(200)
  const removal = (run: Api, operation: string, task: Task) =>
    version(run, task.id).then((v) =>
      run.call('POST', '/coordinator/delete', { operation, tasks: [{ id: task.id, version: v }] }),
    )
  expect((await removal(a.run, 'delete-a', one)).status).toBe(200)
  expect((await removal(b.run, 'delete-b', two)).status).toBe(200)

  const created = await Promise.all(
    [a.run, b.run].map((run, i) =>
      run.call('POST', '/coordinator/tasks', { operation: 'same-operation', title: `From ${i}` }),
    ),
  )
  const madeIds = created.map((r) => (r.body as CoordinatorReceipt).taskId)
  expect(madeIds.every((id) => id !== undefined)).toBe(true)
  expect(new Set(madeIds).size).toBe(2)

  const chatA = await read(aPath)
  const chatB = await read(bPath)
  expect(chatA.receipts.map((r) => r.id)).toEqual(['tell-a', 'same-operation'])
  expect(chatB.receipts.map((r) => r.id)).toEqual(['same-operation'])
  expect(chatA.receipts[1]?.taskId).toBe(madeIds[0])
  expect(chatB.receipts[0]?.taskId).toBe(madeIds[1])
  expect(chatA.confirmations.map((x) => x.operation)).toEqual(['delete-a'])
  expect(chatB.confirmations.map((x) => x.operation)).toEqual(['delete-b'])
  const cardA = chatA.confirmations[0]
  const cardB = chatB.confirmations[0]
  if (!cardA || !cardB) throw new Error('missing confirmation cards')
  const waiting = await s.ok<WaitingRequest[]>('GET', '/inbox/waiting')
  expect(
    waiting.flatMap((w) => (w.source === 'coordinator' ? [[w.id, w.chatId]] : [])).sort(),
  ).toEqual(
    [
      [cardA.id, a.c.id],
      [cardB.id, b.c.id],
    ].sort(),
  )
  expect(
    (await s.client.call('POST', `${aPath}/confirmations/${cardB.id}`, { decision: 'cancel' }))
      .status,
  ).toBe(404)
  await s.ok('POST', `${bPath}/confirmations/${cardB.id}`, { decision: 'cancel' })
  expect((await read(bPath)).confirmations[0]?.answer?.decision).toBe('cancel')
  expect((await read(aPath)).confirmations[0]?.answer).toBeUndefined()

  const listed = await s.ok<CoordinatorChatSummary[]>('GET', s.chats)
  expect(listed.map((c) => c.id).sort()).toEqual([a.c.id, b.c.id].sort())
  expect(listed.find((c) => c.id === a.c.id)).toMatchObject({ waiting: true, taskCount: 2 })
  expect(listed.find((c) => c.id === b.c.id)).toMatchObject({ waiting: false })
  expect(listed.every((c) => c.endedAt === undefined)).toBe(true)
  expect(await s.ok('GET', '/coordinators')).toEqual([
    { factoryId: s.factory.id, status: 'working' },
  ])

  const archivedA = await s.ok<Coordinator>('POST', `${aPath}/archive`)
  expect(archivedA.endedAt).toBeDefined()
  expect(archivedA.confirmations[0]?.answer?.decision).toBe('cancel')
  expect(await s.waitingIds()).not.toContain(cardA.id)
  expect((await s.client.call('POST', `${aPath}/messages`, { text: 'more' })).status).toBe(409)
  expect((await a.run.call('GET', '/coordinator/tasks')).status).toBe(403)
  expect(
    (await s.ok<CoordinatorChatSummary[]>('GET', s.chats)).find((c) => c.id === a.c.id),
  ).toMatchObject({ waiting: false, endedAt: archivedA.endedAt })
  await waitUntil(
    async () =>
      (await s.ok<RunWithConversation>('GET', `/runs/${a.c.runId}`)).run.state === 'finished' ||
      undefined,
    'chat A’s Run to stop',
  )

  await s.ok('DELETE', aPath)
  expect((await s.client.call('GET', aPath)).status).toBe(404)
  expect((await a.run.call('GET', '/coordinator/tasks')).status).toBe(403)
  expect((await s.client.call('GET', `/runs/${a.c.runId}/chat`)).status).toBe(404)
  expect(existsSync(path.join(home, 'coordinators', a.c.runId))).toBe(false)
  expect(existsSync(path.join(home, 'runs', a.c.runId))).toBe(true)
  expect(await s.waitingIds()).not.toContain(cardA.id)
  expect((await s.ok<Task[]>('GET', '/tasks')).map((t) => t.id)).toContain(one.id)
  expect((await read(bPath)).status).toBe('working')
  expect((await b.run.call('GET', '/coordinator/tasks')).status).toBe(200)
  expect((await s.ok<CoordinatorChatSummary[]>('GET', s.chats)).map((c) => c.id)).toEqual([b.c.id])
  await writeFile(path.join(scratch, 'finish-b'), '')
  await waitUntil(async () => (await read(bPath)).status === 'ready', 'chat B to finish')
}, 60_000)

test('a conversation saved before chats is an archived chat that can be read, unarchived, archived again and deleted', async () => {
  const s = await setup()
  const { c } = await s.start([{ say: 'Saved advice' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'the first reply')
  await daemon?.stop()
  const store = await openStore({ directory: tedPaths(home).store })
  let old: Omit<StoredCoordinator, 'id'>
  try {
    const current = store.coordinators.get(c.id)
    if (!current) throw new Error('missing chat')
    const { id: _id, ...rest } = current
    old = rest
    store.coordinators.save({ ...current, id: 'placeholder', runIds: [] })
    await store.persisted()
  } finally {
    await store.close()
  }
  const endedAt = '2026-01-02T00:00:00.000Z'
  const saved = {
    id: 'saved-1',
    factoryId: s.factory.id,
    endedAt,
    data: JSON.stringify({ id: 'saved-1', startedAt: old.startedAt ?? '', endedAt, chat: old }),
  }
  await editEventlog(
    home,
    `UPDATE eventlog SET name = 'v2.CoordinatorChanged',
       argsJson = json_set(json_remove(argsJson, '$.id'), '$.factoryId', '${s.factory.id}')
       WHERE name = 'v1.CoordinatorChatChanged' AND json_extract(argsJson, '$.id') = '${c.id}';
     UPDATE eventlog SET name = 'v1.CoordinatorConversationSaved',
       argsJson = '${JSON.stringify(saved).replaceAll("'", "''")}'
       WHERE name = 'v1.CoordinatorChatChanged'
         AND json_extract(argsJson, '$.id') = 'placeholder';`,
  )
  await pretendStateSchemaChanged(home)
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  expect(await ok<CoordinatorChatSummary[]>('GET', s.chats)).toMatchObject([
    { id: 'saved-1', endedAt, title: c.opening, status: 'ready' },
  ])
  expect(await ok<Coordinator>('GET', '/coordinator-chats/saved-1')).toMatchObject({
    endedAt,
    runIds: [c.runId],
  })
  expect((await client.call('PATCH', '/coordinator-chats/saved-1', { title: '   ' })).status).toBe(
    400,
  )
  expect(
    await ok<Coordinator>('PATCH', '/coordinator-chats/saved-1', { title: '  Saved   review ' }),
  ).toMatchObject({ title: 'Saved review', endedAt })
  expect(await ok<CoordinatorChatSummary[]>('GET', s.chats)).toMatchObject([
    { id: 'saved-1', title: 'Saved review' },
  ])
  const kept = await ok<RunChat>('GET', '/coordinator-chats/saved-1/chat')
  expect(kept.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
  expect(
    (await client.call('POST', '/coordinator-chats/saved-1/messages', { text: 'Too early' }))
      .status,
  ).toBe(409)

  const continued = await ok<Coordinator>('POST', '/coordinator-chats/saved-1/unarchive')
  expect(continued).toMatchObject({ id: 'saved-1', status: 'ready', runIds: [c.runId] })
  expect(continued.endedAt).toBeUndefined()
  await ok('POST', '/coordinator-chats/saved-1/messages', {
    text: JSON.stringify({ steps: [{ say: 'Back again' }, { endTurn: true }] }),
  })
  const resumed = await waitUntil(async () => {
    const chat = await ok<RunChat>('GET', '/coordinator-chats/saved-1/chat')
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Back again') ? chat : undefined
  }, 'the continued chat’s reply')
  expect(resumed.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
  await waitUntil(
    async () => (await ok<Coordinator>('GET', '/coordinator-chats/saved-1')).status === 'ready',
    'the continued chat to settle',
  )
  const again = await ok<Coordinator>('POST', '/coordinator-chats/saved-1/archive')
  expect(again.endedAt).toBeDefined()
  expect(
    (await client.call('POST', '/coordinator-chats/saved-1/messages', { text: 'Archived' })).status,
  ).toBe(409)

  await ok('DELETE', '/coordinator-chats/saved-1')
  expect(await ok('GET', s.chats)).toEqual([])
  expect((await client.call('GET', `/runs/${c.runId}/chat`)).status).toBe(404)
  expect(existsSync(path.join(home, 'coordinators', c.runId))).toBe(false)
  expect((await client.call('DELETE', '/coordinator-chats/saved-1')).status).toBe(404)
}, 60_000)

test('agent health pauses queued responses and sending advice leaves Tasks unchanged', async () => {
  const s = await setup()
  const task = await s.task()
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  await s.ok('POST', '/agents/health/check')
  const c = await s.message({
    agent: 'claude',
    text: JSON.stringify({
      steps: [{ say: 'I recommend discussing priorities first.' }, { endTurn: true }],
    }),
  })
  expect(c.status).toBe('paused')
  expect(c.started).toBe(false)
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
  await s.ok('POST', '/agents/health/check')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'healthy response')
  expect((await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.stage).toBe('backlog')
  expect((await s.chat()).receipts).toEqual([])
})

test('a pause while working records TED’s continuation as TED’s and keeps the conversation', async () => {
  const s = await setup()
  const { c } = await s.start([{ say: 'Saved advice' }, { waitFor: path.join(scratch, 'finish') }])
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  const continuation = 'Continue the interrupted response using fresh facts'
  await waitUntil(
    async () => (await conversation()).items.some((i) => i.kind === 'agent'),
    'the first reply',
  )
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  await s.ok('POST', '/agents/health/check')
  await waitUntil(async () => {
    const run = (await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)).run
    return (await s.chat()).status === 'paused' && run.state === 'finished'
  }, 'the paused Coordinator')
  for (const chat of [await conversation(), await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)]) {
    expect(chat.items.filter((i) => i.kind === 'human' && i.text.includes(continuation))).toEqual(
      [],
    )
    expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
  }
  expect((await s.chat()).unsentMessages).toEqual([])

  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
  await s.ok('POST', '/agents/health/check')
  const replaced = await waitUntil(async () => {
    const chat = await s.chat()
    return chat.runId !== c.runId && chat.started ? chat : undefined
  }, 'the replacement Run')
  const after = await conversation()
  expect(after.run.id).toBe(replaced.runId)
  expect(after.items.filter((i) => i.kind === 'human').map((i) => i.text)).toEqual([
    expect.stringContaining('Saved advice'),
  ])
  expect(after.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
  expect(after.items.filter((i) => i.kind === 'ted' && i.text.includes(continuation))).toHaveLength(
    1,
  )
  expect(after.items.filter((i) => i.kind === 'instructions')).toHaveLength(1)
  const own = await s.ok<RunChat>('GET', `/runs/${replaced.runId}/chat`)
  expect(own.items.filter((i) => i.kind === 'human')).toEqual([])
  expect(await s.ok('GET', '/coordinators')).toEqual([
    { factoryId: s.factory.id, status: (await s.chat()).status },
  ])
})

test('Retry’s continuation shows as TED’s in the resumed Run, never as the human’s', async () => {
  const s = await setup()
  const { c } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'the failure')
  await s.ok('POST', `${s.base}/retry`)
  const continuation = 'Please continue the interrupted response'
  const chat = await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `${s.base}/chat`)
    return chat.items.some((i) => i.kind === 'ted' && i.text.includes(continuation))
      ? chat
      : undefined
  }, 'TED’s continuation in the chat')
  expect((await s.chat()).runId).toBe(c.runId)
  expect(chat.items.filter((i) => i.kind === 'human' && i.text.includes(continuation))).toEqual([])
})

test('a message after Stop starts a new Run and the conversation keeps both Runs in order', async () => {
  const s = await setup()
  const { c } = await s.start([{ say: 'First reply' }, { waitFor: path.join(scratch, 'finish') }])
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  await waitUntil(
    async () => (await conversation()).items.some((i) => i.kind === 'agent'),
    'the first reply',
  )
  await s.ok('POST', `${s.base}/stop`)
  await s.message({
    text: JSON.stringify({ steps: [{ say: 'Second reply' }, { endTurn: true }] }),
  })
  const chat = await waitUntil(async () => {
    const chat = await conversation()
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Second reply')
      ? chat
      : undefined
  }, 'the second reply')
  expect((await s.chat()).runId).not.toBe(c.runId)
  expect(chat.run.id).toBe((await s.chat()).runId)
  const shown = chat.items.flatMap((i) =>
    i.kind === 'agent'
      ? [i.text]
      : i.kind === 'human'
        ? ['human']
        : i.kind === 'ted'
          ? [i.title]
          : [],
  )
  expect(shown).toEqual(['human', 'First reply', 'New Run', 'human', 'Second reply'])
  expect(new Set(chat.items.map((i) => `${i.kind}:${i.id}`)).size).toBe(chat.items.length)
})

const signIn = async (s: Awaited<ReturnType<typeof setup>>, signedIn: boolean) => {
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn }))
  await s.ok('POST', '/agents/health/check')
}
const bubbles = (chat: RunChat) =>
  chat.items.flatMap<Record<string, unknown>>((i) =>
    i.kind === 'human'
      ? [{ human: i.text, sent: i.sent, queued: i.queued, unsent: i.unsent }]
      : i.kind === 'ted'
        ? [{ ted: i.text }]
        : [],
  )

test('a human message queued after Retry is delivered with TED’s continuation and each keeps its author', async () => {
  const s = await setup()
  const { c } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'the failure')
  await signIn(s, false)
  await s.ok('POST', `${s.base}/retry`)
  const typed = JSON.stringify({ steps: [{ say: 'Resumed reply' }, { endTurn: true }] })
  await s.message({ text: typed })
  expect((await s.chat()).started).toBe(true)
  await signIn(s, true)
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  const chat = await waitUntil(async () => {
    const chat = await conversation()
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Resumed reply')
      ? chat
      : undefined
  }, 'the resumed reply')
  expect((await s.chat()).runId).toBe(c.runId)
  expect(bubbles(chat).slice(1)).toEqual([
    { ted: expect.stringContaining('Please continue the interrupted response') },
    { human: typed, sent: true },
  ])
  expect((await s.chat()).unsentMessages).toEqual([])
})

test('two human messages delivered as one resumed turn show as two sent bubbles', async () => {
  const s = await setup()
  const { c } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  const first = 'Look at the release Tasks first.'
  const second = JSON.stringify({ steps: [{ say: 'Resumed reply' }, { endTurn: true }] })
  await s.message({ text: first })
  await s.message({ text: second })
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'the failure')
  await s.ok('POST', `${s.base}/retry`)
  const chat = await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `${s.base}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Resumed reply')
      ? chat
      : undefined
  }, 'the resumed reply')
  expect((await s.chat()).runId).toBe(c.runId)
  expect(bubbles(chat).slice(1)).toEqual([
    { human: first, sent: true },
    { human: second, sent: true },
  ])
})

test('an opening prompt that carries two pending messages shows each as its own sent bubble', async () => {
  const s = await setup()
  await signIn(s, false)
  const first = 'Compare the release Tasks.'
  const second = JSON.stringify({ steps: [{ say: 'Both read' }, { endTurn: true }] })
  await s.message({ text: first, agent: 'claude' })
  await s.message({ text: second })
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  expect(bubbles(await conversation())).toEqual([
    { human: first, sent: false, queued: true },
    { human: second, sent: false, queued: true },
  ])
  await signIn(s, true)
  const chat = await waitUntil(async () => {
    const chat = await conversation()
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Both read') ? chat : undefined
  }, 'the reply')
  expect(bubbles(chat)).toEqual([
    { human: first, sent: true },
    { human: second, sent: true },
  ])
  const own = await s.ok<RunChat>('GET', `/runs/${chat.run.id}/chat`)
  expect(bubbles(own)).toEqual(bubbles(chat))
  expect(own.items.filter((i) => i.kind === 'instructions')).toHaveLength(1)
})

test('disk holds keep Coordinator turns queued until space recovers', async () => {
  let free = 30e9
  const s = await setup({ freeBytes: async () => free, checkEveryMs: 20 })
  free = 1.4e9
  await waitUntil(async () => {
    const banners = await s.ok<{ problem: string }[]>('GET', '/banners')
    return banners.some((b) => b.problem === 'disk-full')
  }, 'disk hold')
  const c = await s.message({
    agent: 'claude',
    text: JSON.stringify({ steps: [{ say: 'Space recovered' }, { endTurn: true }] }),
  })
  expect(c.status).toBe('queued')
  expect(c.started).toBe(false)
  free = 30e9
  await waitUntil(async () => (await s.chat()).status === 'ready', 'response after disk recovers')
})

test('the Coordinator CLI reads scoped facts from an actual Run', async () => {
  const s = await setup()
  const task = await s.task('CLI context')
  const { c } = await s.start([{ run: ['ted', 'coordinator', 'tasks'] }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'CLI response')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  const reply = chat.items.find((i) => i.kind === 'agent' && i.text.includes('stdout'))
  if (reply?.kind !== 'agent') throw new Error('missing CLI reply')
  const result = JSON.parse(reply.text) as { code: number; stdout: string }
  expect(result.code).toBe(0)
  expect(result.stdout).toContain(task.displayId)
  expect(result.stdout).toContain('TASK CONTEXT')
})

test('deleting the last queued follow-up returns Ready and never runs it', async () => {
  const disk = fullDisk(30e9)
  const s = await setup(disk)
  const { c } = await s.start([{ say: 'First answer' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'first answer')
  disk.free = 1.4e9
  await diskHold(s)
  const message = await s.ok<RunMessage>('POST', `/runs/${c.runId}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Deleted answer' }, { endTurn: true }] }),
  })
  expect((await s.chat()).status).toBe('queued')
  await s.ok('DELETE', `/runs/${c.runId}/messages/${message.id}`)
  expect((await s.chat()).status).toBe('ready')
  expect((await s.ok<RunSlots>('GET', '/slots')).queue.some((q) => q.kind === 'coordinator')).toBe(
    false,
  )
  disk.free = 30e9
  await waitUntil(
    async () =>
      !(await s.ok<{ problem: string }[]>('GET', '/banners')).some(
        (b) => b.problem === 'disk-full',
      ),
    'disk hold to end',
  )
  expect((await s.chat()).status).toBe('ready')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Deleted answer')).toBe(false)
  await s.message({
    text: JSON.stringify({ steps: [{ say: 'Later answer' }, { endTurn: true }] }),
  })
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Later answer')
  }, 'later message still works')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'later answer settlement')
})

test('Stop followed by a message replaces the Run, uses scoped tools and releases its slot', async () => {
  const s = await setup()
  const { c } = await s.start()
  await s.ok('POST', `${s.base}/stop`)
  await s.message({
    text: JSON.stringify({ steps: [{ run: ['ted', 'coordinator', 'tasks'] }, { endTurn: true }] }),
  })
  const replacement = await waitUntil(async () => {
    const chat = await s.chat()
    return chat.runId !== c.runId && chat.started && chat.status === 'ready' ? chat : undefined
  }, 'new response completes')
  const chat = await s.ok<RunChat>('GET', `/runs/${replacement.runId}/chat`)
  const reply = chat.items.find((i) => i.kind === 'agent' && i.text.includes('stdout'))
  if (reply?.kind !== 'agent') throw new Error('missing scoped tool reply')
  expect(JSON.parse(reply.text).code).toBe(0)
  expect((await s.ok<RunSlots>('GET', '/slots')).working).toBe(0)
})

test('working Coordinator messages share steering’s boundary gate and serialized delivery', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const { c } = await s.start([
    { say: 'Before boundary' },
    { waitFor: path.join(scratch, 'boundary') },
    { tool: 'Read' },
    { say: 'After boundary' },
    { waitFor: path.join(scratch, 'finish-turn') },
    { endTurn: true },
  ])
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Before boundary')
  }, 'before boundary')
  const messages = await Promise.all(
    ['First steering message', 'Second steering message'].map((text) =>
      s.ok<RunMessage>('POST', `/runs/${c.runId}/messages`, { text }),
    ),
  )
  const queued = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  for (const message of messages)
    expect(queued.items.find((i) => i.id === message.id)).toMatchObject({
      kind: 'human',
      queued: true,
      sent: false,
    })
  expect(existsSync(path.join(home, 'runs', c.runId, 'queued'))).toBe(true)
  expect(queued.items.some((i) => i.kind === 'agent' && i.text.startsWith('Read:'))).toBe(false)
  await writeFile(path.join(scratch, 'boundary'), '')
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'After boundary')
  }, 'boundary completed')
  const delivered = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  const agents = delivered.items.filter((i) => i.kind === 'agent').map((i) => i.text)
  for (const message of messages) {
    expect(agents.filter((text) => text === `Read: ${message.text}`)).toHaveLength(1)
    expect(agents.indexOf(`Read: ${message.text}`)).toBeLessThan(agents.indexOf('After boundary'))
    expect(delivered.items.find((i) => i.id === message.id)).toMatchObject({
      kind: 'human',
      sent: true,
    })
  }
  expect(existsSync(path.join(home, 'runs', c.runId, 'queued'))).toBe(false)
  const coordinators = async () =>
    (await s.ok<RunSlots>('GET', '/slots')).holders.filter((h) => h.kind === 'coordinator')
  expect(await coordinators()).toHaveLength(1)
  expect((await s.ok<RunSlots>('GET', '/slots')).working).toBe(0)
  await writeFile(path.join(scratch, 'finish-turn'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'response finishes')
  expect(await coordinators()).toHaveLength(0)
})

test('tell posts a Comment marked as sent through the Coordinator and delivers it to the Task Lead', async () => {
  const s = await setup(),
    boundary = path.join(scratch, 'lead-boundary'),
    { task, leadRunId, lead } = await s.led({ waitFor: boundary }, { tool: 'Read' }, hold()),
    { run } = await s.start()
  const input = {
    operation: 'tell-1',
    version: await version(run, task.id),
    message: 'Wait for the queued reviewer; do not start another one.',
  }
  const told = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, input)
  expect(told.status).toBe(200)
  expect(told.body).toMatchObject({
    operation: 'tell',
    taskId: task.id,
    text: `Told ${task.displayId}’s Task Lead`,
  })
  const posted = (await s.comments(task.id)).filter((c) => c.body.startsWith(coordinatorLine))
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({
    kind: 'note',
    author: { kind: 'human' },
    body: `${coordinatorLine}\n\n${input.message}`,
  })
  await writeFile(boundary, '')
  await waitUntil(
    async () =>
      (await s.comments(task.id)).find((c) => c.id === posted[0]?.id)?.delivered?.runId ===
      leadRunId,
    'the Comment to reach the Task Lead',
  )
  await waitUntil(async () => {
    const heard = JSON.stringify(await s.ok<RunChat>('GET', `/runs/${leadRunId}/chat`))
    return heard.includes(coordinatorLine) && heard.includes(input.message)
  }, 'the Task Lead to read the message')

  expect((await run.call('POST', `/coordinator/tasks/${task.id}/tell`, input)).body).toEqual(
    told.body,
  )
  const reused = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
    ...input,
    message: 'Something else',
  })
  expect(reused.status).toBe(409)
  expect((await s.comments(task.id)).filter((c) => c.author.kind === 'human')).toHaveLength(1)
  expect((await s.chat()).receipts.map((r) => r.id)).toEqual(['tell-1'])

  expect(
    (
      await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
        ...input,
        operation: 'empty',
        message: ' ',
      })
    ).status,
  ).toBe(400)
  for (const kind of ['tell', 'answer', 'resume', 'done'])
    expect(
      (await lead.call('POST', `/coordinator/tasks/${task.id}/${kind}`, { ...input, request: 'x' }))
        .status,
      kind,
    ).toBe(403)

  const backlog = await s.task('Unstarted')
  const quiet = await run.call('POST', `/coordinator/tasks/${backlog.id}/tell`, {
    operation: 'tell-backlog',
    version: await version(run, backlog.id),
    message: 'Read this when you start.',
  })
  expect((quiet.body as CoordinatorReceipt).text).toContain(
    `Left a Comment on ${backlog.displayId}`,
  )

  await s.ok('POST', `/tasks/${backlog.id}/archive`)
  const archived = await run.call('POST', `/coordinator/tasks/${backlog.id}/tell`, {
    operation: 'tell-archived',
    version: await version(run, backlog.id),
    message: 'Too late.',
  })
  expect(archived.status).toBe(409)
  expect((archived.body as { error: string }).error).toContain('not archived and not Done')
})

test('answer closes a Task Lead’s open question, which leaves the Inbox', async () => {
  const s = await setup(),
    { task, lead } = await s.led(hold()),
    other = await s.led(hold()),
    { run } = await s.start()
  const ask = async (who: Api, id: string, body: string) =>
    (await who.call('POST', `/tasks/${id}/comments`, { body, choices: ['Wait', 'Start another'] }))
      .body as Comment
  const question = await ask(lead, task.id, 'My reviewer is queued. What should I do?')
  const foreign = await ask(other.lead, other.task.id, 'Same question on another Task')
  const note = (await lead.call('POST', `/tasks/${task.id}/comments`, { body: 'A note' }))
    .body as Comment
  expect(await s.waitingIds()).toContain(question.id)
  const answer = async (body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      ...body,
    })

  const wrongChoice = await answer({ operation: 'bad', request: question.id, choice: 'Skip it' })
  expect(wrongChoice.status).toBe(409)
  expect((await answer({ operation: 'other', request: foreign.id, choice: 'Wait' })).status).toBe(
    409,
  )
  expect(
    (await answer({ operation: 'gone', request: 'no-such-comment', choice: 'Wait' })).status,
  ).toBe(409)
  expect((await answer({ operation: 'note', request: note.id, message: 'Noted' })).status).toBe(403)
  expect((await answer({ operation: 'nothing', request: question.id })).status).toBe(400)
  expect(await s.waitingIds()).toContain(question.id)

  const input = {
    operation: 'answer-1',
    version: await version(run, task.id),
    request: question.id,
    choice: 'Wait',
    message: 'The reviewer starts when a slot frees.',
  }
  const answered = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, input)
  expect(answered.status).toBe(200)
  expect(answered.body).toMatchObject({
    operation: 'answer',
    text: expect.stringContaining(`Answered ${task.displayId}’s question with “Wait” · was intake`),
  })
  expect((await s.comments(task.id)).find((c) => c.id === question.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Wait',
    text: `${coordinatorLine}\n\n${input.message}`,
  })
  const waiting = await s.waitingIds()
  expect(waiting).not.toContain(question.id)
  expect(waiting).toContain(foreign.id)

  expect((await run.call('POST', `/coordinator/tasks/${task.id}/answer`, input)).body).toEqual(
    answered.body,
  )
  expect(
    (
      await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
        ...input,
        choice: 'Start another',
      })
    ).status,
  ).toBe(409)
  const again = await answer({ operation: 'again', request: question.id, choice: 'Wait' })
  expect(again.status).toBe(409)
  expect((again.body as { error: string }).error).toContain('already closed')

  const archiveAsk = (
    await other.lead.call('POST', `/tasks/${other.task.id}/archive-request`, {
      reason: 'Duplicate of the first Task',
    })
  ).body as Comment
  const answerOther = async (body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${other.task.id}/answer`, {
      version: await version(run, other.task.id),
      ...body,
    })
  expect(
    (
      await answerOther({
        operation: 'close-wrong',
        request: foreign.id,
        choice: 'Wait',
        closePullRequests: true,
      })
    ).status,
  ).toBe(400)
  const archiveInput = {
    operation: 'archive-1',
    version: await version(run, other.task.id),
    request: archiveAsk.id,
    choice: 'Archive',
    closePullRequests: false,
  }
  const archivePath = `/coordinator/tasks/${other.task.id}/answer`
  const archived = await run.call('POST', archivePath, archiveInput)
  expect(archived.status).toBe(200)
  expect((await run.call('POST', archivePath, archiveInput)).body).toEqual(archived.body)
  expect(
    (await run.call('POST', archivePath, { ...archiveInput, closePullRequests: true })).status,
  ).toBe(409)
  expect(
    (await s.comments(other.task.id)).find((c) => c.id === archiveAsk.id)?.answer,
  ).toMatchObject({ kind: 'answered', choice: 'Archive' })
  const tasks = await s.ok<Task[]>('GET', '/tasks')
  expect(tasks.find((t) => t.id === other.task.id)?.archived).toBeDefined()
})

test('answer approves a sign-off request or asks for changes, and refuses permission prompts', async () => {
  await commitToOrigin(scratch, { 'app.txt': 'one\ntwo\nthree\n' })
  const s = await setup(undefined, 'version: 1\norder: [intake, design, work, merge]\n')
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(
    briefFile,
    '## Goal\n\nEdit notes offline.\n\n## Decisions so far\n\n- Keep both copies.\n\n## Current state\n\nNothing built yet.\n\n## Open questions\n\nNone.\n\n## Next step\n\nDesign the merge view.\n',
  )
  const advance = { run: ['ted', 'outcome', 'advance'] }
  const gated = await s.led(
    {
      everyMessage: [
        { run: ['ted', 'brief', 'write', '--file', briefFile] },
        advance,
        { endTurn: true },
      ],
    },
    advance,
    { endTurn: true },
  )
  const prompted = await s.led(
    {
      permission: {
        tool: 'Bash',
        input: { command: 'npm install', description: 'Install' },
        description: 'Install',
      },
    },
    { endTurn: true },
  )
  const request = (id: string, wanted: (c: Comment) => boolean, what: string) =>
    waitUntil(async () => (await s.comments(id)).find(wanted), what)
  const openGate = (c: Comment) => c.gate !== undefined && c.answer === undefined
  const gate = await request(gated.task.id, openGate, 'a sign-off request')
  const permission = await request(
    prompted.task.id,
    (c) => c.kind === 'permission',
    'a permission request',
  )
  const worktree = await waitUntil(
    async () =>
      (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === gated.task.id)?.repos[0]?.worktree,
    'the worktree',
  )
  await writeFile(path.join(worktree, 'app.txt'), 'one\nTWO\nthree\n')
  await s.ok('POST', `/tasks/${gated.task.id}/line-comments`, {
    repo: 'widgets',
    path: 'app.txt',
    from: { new: 2 },
    body: 'An unfinished review note',
  })
  const unsent = async () =>
    (await s.ok<LineComment[]>('GET', `/tasks/${gated.task.id}/line-comments`)).filter(
      (c) => c.sent === undefined,
    )
  const { run } = await s.start()
  const answer = async (task: Task, body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      ...body,
    })
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${gated.task.id}`)).body,
  )
  expect(read.openRequests.find((r) => r.id === gate.id)?.coordinatorMayAnswer).toBe(
    'approve or request changes',
  )

  const refused = await answer(prompted.task, {
    operation: 'refused-permission',
    request: permission.id,
    decision: 'approve',
  })
  expect(refused.status).toBe(403)
  expect(
    (await s.comments(prompted.task.id)).find((c) => c.id === permission.id)?.answer,
  ).toBeUndefined()

  const words = await answer(gated.task, {
    operation: 'words',
    request: gate.id,
    message: 'Looks fine',
  })
  expect(words.status).toBe(400)
  expect(
    (await answer(gated.task, { operation: 'bare', request: gate.id, decision: 'request-changes' }))
      .status,
  ).toBe(400)
  expect(await s.waitingIds()).toContain(gate.id)

  const changes = await answer(gated.task, {
    operation: 'changes',
    request: gate.id,
    decision: 'request-changes',
    message: 'Show both copies side by side.',
  })
  expect(changes.status).toBe(200)
  expect((changes.body as CoordinatorReceipt).text).toContain(
    `Requested changes on ${gated.task.displayId}’s Sign-off request`,
  )
  const asked = (await s.comments(gated.task.id)).find((c) => c.id === gate.id)
  expect(asked?.answer).toEqual({
    kind: 'changes-requested',
    at: expect.any(String),
    text: `${coordinatorLine}\n\nShow both copies side by side.`,
  })
  expect(asked?.lineComments ?? []).toEqual([])
  expect(await unsent()).toHaveLength(1)

  const second = await request(
    gated.task.id,
    (c) => openGate(c) && c.id !== gate.id,
    'a second Sign-off request',
  )
  const approved = await answer(gated.task, {
    operation: 'approve',
    request: second.id,
    decision: 'approve',
  })
  expect(approved.status).toBe(200)
  const receipt = approved.body as CoordinatorReceipt
  expect(receipt.text).toContain(`Approved ${gated.task.displayId}’s Sign-off request`)
  expect(receipt.before?.stage).toBe('design')
  expect(receipt.after?.stage).not.toBe('design')
  expect((await s.comments(gated.task.id)).find((c) => c.id === second.id)?.answer).toMatchObject({
    kind: 'approved',
    text: coordinatorLine,
  })
  expect(await s.waitingIds()).not.toContain(second.id)
  expect(await unsent()).toHaveLength(1)
})

test('answer answers a Clarify round and a size check', async () => {
  const s = await setup(undefined, 'version: 1\norder: [intake, clarify, work]\n')
  const roundFile = path.join(scratch, 'round.json')
  await writeFile(
    roundFile,
    JSON.stringify({
      title: 'Sync · 1 question',
      questions: [
        { question: 'How long offline before a warning?', recommended: '7 days' },
        {
          question: 'Where should the warning show?',
          multiple: true,
          choices: ['Board', 'List', 'Map'],
          recommended: ['Board', 'Map'],
        },
      ],
    }),
  )
  const advance = { run: ['ted', 'outcome', 'advance'] }
  const asking = await s.led(
    advance,
    { run: ['ted', 'clarify', 'depth', 'few', 'one question settles it'] },
    { run: ['ted', 'ask', '--round', roundFile] },
    { endTurn: true },
  )
  const sizing = await s.led(
    advance,
    {
      run: [
        'ted',
        'clarify',
        'too-big',
        '--settle',
        'Which piece ships first',
        'It touches storage and sync.',
      ],
    },
    { endTurn: true },
  )
  const request = (id: string, wanted: (c: Comment) => boolean, what: string) =>
    waitUntil(async () => (await s.comments(id)).find(wanted), what)
  const round = await request(asking.task.id, (c) => c.kind === 'round', 'a round')
  const sizeCheck = await request(sizing.task.id, (c) => c.sizeCheck !== undefined, 'a size check')
  const { run } = await s.start()
  const answer = async (task: Task, body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      ...body,
    })
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${asking.task.id}`)).body,
  )
  expect(read.openRequests.find((r) => r.id === round.id)).toMatchObject({
    coordinatorMayAnswer: 'round answers',
    questions: [
      { question: 'How long offline before a warning?', recommended: '7 days' },
      {
        question: 'Where should the warning show?',
        recommended: 'Board; Map',
        multiple: true,
        recommendedChoices: ['Board', 'Map'],
      },
    ],
  })

  expect(
    (await answer(asking.task, { operation: 'words', request: round.id, message: '14 days' }))
      .status,
  ).toBe(400)
  expect(
    (
      await answer(asking.task, {
        operation: 'short',
        request: round.id,
        answers: [{ answer: '14 days' }, { answer: '', choices: ['Board'] }, { answer: 'Extra' }],
      })
    ).status,
  ).toBe(400)
  const answered = await answer(asking.task, {
    operation: 'round',
    request: round.id,
    answers: [
      { answer: '14 days', note: 'People travel.' },
      { answer: '', choices: ['Map', 'List'] },
    ],
  })
  expect(answered.status).toBe(200)
  expect((answered.body as CoordinatorReceipt).text).toContain(
    `Answered ${asking.task.displayId}’s Clarify round “Sync · 1 question”`,
  )
  expect((await s.comments(asking.task.id)).find((c) => c.id === round.id)?.answer).toMatchObject({
    kind: 'answered',
    answers: [
      { answer: '14 days', note: 'People travel.', changed: true },
      { answer: 'List; Map', choices: ['List', 'Map'], changed: true },
    ],
    text: coordinatorLine,
  })

  expect(
    (await answer(sizing.task, { operation: 'size-words', request: sizeCheck.id, message: 'Go' }))
      .status,
  ).toBe(400)
  const sized = await answer(sizing.task, {
    operation: 'size',
    request: sizeCheck.id,
    choice: sizeChoices.grill,
  })
  expect(sized.status).toBe(200)
  expect(
    (await s.comments(sizing.task.id)).find((c) => c.id === sizeCheck.id)?.answer,
  ).toMatchObject({ kind: 'answered', choice: sizeChoices.grill, text: coordinatorLine })
  const waiting = await s.waitingIds()
  expect(waiting).not.toContain(round.id)
  expect(waiting).not.toContain(sizeCheck.id)
})

test('resume queues a stopped Task again and refuses one that isn’t stopped; done refuses a Task not at Merge', async () => {
  const s = await setup(),
    { task, leadRunId } = await s.led(hold()),
    { run } = await s.start()
  const resume = async (operation: string, at?: string) =>
    run.call('POST', `/coordinator/tasks/${task.id}/resume`, {
      operation,
      version: at ?? (await version(run, task.id)),
    })
  const current = async () => (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)

  const running = await resume('too-early')
  expect(running.status).toBe(409)
  expect((running.body as { error: string }).error).toContain('isn’t stopped')
  const notAtMerge = await run.call('POST', `/coordinator/tasks/${task.id}/done`, {
    operation: 'done-early',
    version: await version(run, task.id),
  })
  expect(notAtMerge.status).toBe(409)
  expect((notAtMerge.body as { error: string }).error).toContain('Tasks at Merge')

  await s.ok('POST', `/tasks/${task.id}/stop`)
  expect((await current())?.status?.kind).toBe('stopped')
  const stoppedAt = await version(run, task.id)
  const resumed = await resume('resume-1', stoppedAt)
  expect(resumed.status).toBe(200)
  expect(resumed.body).toMatchObject({
    operation: 'resume',
    taskId: task.id,
    text: expect.stringContaining(`Resumed ${task.displayId}`),
  })
  expect((await current())?.status?.kind).not.toBe('stopped')
  await waitUntil(async () => {
    const lead = (await current())?.leadRunId
    return lead !== undefined && lead !== leadRunId
  }, 'a new Task Lead Run')
  expect((await s.comments(task.id)).filter((c) => c.author.kind === 'human')).toEqual([])
  expect((await resume('resume-1', stoppedAt)).body).toEqual(resumed.body)
})

test('the Coordinator CLI tells and answers with a message argument and never reads a file', async () => {
  const s = await setup(),
    quiet = await s.task('Unstarted'),
    { task, lead } = await s.led(hold())
  const question = (
    await lead.call('POST', `/tasks/${task.id}/comments`, {
      body: 'My reviewer is queued. What should I do?',
      choices: ['Wait', 'Start another'],
    })
  ).body as Comment
  const release = path.join(scratch, 'first-turn')
  const { c, run } = await s.start([{ waitFor: release }, { endTurn: true }])
  const versions = { quiet: await version(run, quiet.id), task: await version(run, task.id) }
  await writeFile(release, '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'first turn to end')
  const common = ['--message', 'Wait for the queued reviewer.', '--operation']
  await s.message({
    text: JSON.stringify({
      steps: [
        {
          run: [
            'ted',
            'coordinator',
            'tell',
            quiet.id,
            ...common,
            'cli-tell',
            '--version',
            versions.quiet,
          ],
        },
        {
          run: [
            'ted',
            'coordinator',
            'answer',
            task.id,
            '--request',
            question.id,
            '--choice',
            'Wait',
            ...common,
            'cli-answer',
            '--version',
            versions.task,
          ],
        },
        { endTurn: true },
      ],
    }),
  })
  await waitUntil(async () => {
    const chat = await s.chat()
    return chat.receipts.length === 2 && chat.status === 'ready'
  }, 'both CLI actions')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  const results = chat.items.flatMap((i) =>
    i.kind === 'agent' && i.text.includes('stdout')
      ? [JSON.parse(i.text) as { code: number; stderr: string }]
      : [],
  )
  expect(results.map((r) => r.code)).toEqual([0, 0])
  expect((await s.comments(quiet.id)).map((c) => c.body)).toEqual([
    `${coordinatorLine}\n\nWait for the queued reviewer.`,
  ])
  expect((await s.comments(task.id)).find((c) => c.id === question.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Wait',
    text: `${coordinatorLine}\n\nWait for the queued reviewer.`,
  })

  const secret = path.join(scratch, 'secret.txt')
  await writeFile(secret, 'private key')
  await s.message({
    text: JSON.stringify({
      steps: [
        {
          run: [
            'ted',
            'coordinator',
            'tell',
            quiet.id,
            '--message-file',
            secret,
            '--operation',
            'cli-file',
            '--version',
            versions.quiet,
          ],
        },
        { endTurn: true },
      ],
    }),
  })
  const refused = await waitUntil(async () => {
    const items = (await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)).items
    const ran = items.filter((i) => i.kind === 'agent' && i.text.includes('stdout'))
    const last = ran[2]
    return last?.kind === 'agent' ? (JSON.parse(last.text) as { code: number }) : undefined
  }, 'the file option to be refused')
  expect(refused.code).not.toBe(0)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'refusal turn to end')
  expect((await s.chat()).receipts).toHaveLength(2)
  expect(JSON.stringify(await s.comments(quiet.id))).not.toContain('private key')
})

test('tell and answer cap the message, remove secrets and leave line comment drafts unsent', async () => {
  await commitToOrigin(scratch, { 'app.txt': 'one\ntwo\nthree\n' })
  const s = await setup(),
    { task, lead } = await s.led(hold())
  const worktree = await waitUntil(
    async () =>
      (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.repos[0]?.worktree,
    'the worktree',
  )
  await writeFile(path.join(worktree, 'app.txt'), 'one\nTWO\nthree\n')
  await s.ok('POST', `/tasks/${task.id}/line-comments`, {
    repo: 'widgets',
    path: 'app.txt',
    from: { new: 2 },
    body: 'An unfinished review note',
  })
  const unsent = async () =>
    (await s.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)).filter(
      (c) => c.sent === undefined,
    )
  expect(await unsent()).toHaveLength(1)
  const question = (
    await lead.call('POST', `/tasks/${task.id}/comments`, {
      body: 'My reviewer is queued. What should I do?',
      choices: ['Wait', 'Start another'],
    })
  ).body as Comment
  const { run } = await s.start()

  const long = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
    operation: 'long',
    version: await version(run, task.id),
    message: 'x'.repeat(8001),
  })
  expect(long.status).toBe(400)
  expect((long.body as { error: string }).error).toContain('8000 characters')

  const told = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
    operation: 'tell-secret',
    version: await version(run, task.id),
    message: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123 to push.',
  })
  expect(told.status).toBe(200)
  const answered = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
    operation: 'answer-secret',
    version: await version(run, task.id),
    request: question.id,
    choice: 'Wait',
    message: 'The key is sk-abcdefghijklmnopqrstuvwxyz0123.',
  })
  expect(answered.status).toBe(200)

  const comments = await s.comments(task.id)
  const posted = comments.find((c) => c.author.kind === 'human')
  expect(posted?.body).toBe(`${coordinatorLine}\n\nUse [redacted] to push.`)
  expect(posted?.lineComments ?? []).toEqual([])
  const answer = comments.find((c) => c.id === question.id)?.answer
  expect(answer).toMatchObject({ text: `${coordinatorLine}\n\nThe key is [redacted].` })
  expect(JSON.stringify(comments)).not.toContain('An unfinished review note')
  expect(JSON.stringify(await s.chat())).not.toContain('ghp_abcdefghij')
  expect(await unsent()).toHaveLength(1)
})

test.each(['general', 'Validate'])(
  'answer resolves a %s failure decision and leaves line comment drafts unsent',
  async (stage) => {
    await commitToOrigin(scratch, { 'app.txt': 'one\ntwo\nthree\n' })
    const workflow =
      stage === 'Validate' ? 'version: 1\norder: [intake, work, validate, review]\n' : undefined
    const s = await setup(undefined, workflow),
      { task, leadRunId, lead } = await s.led(hold())
    const { run } = await s.start()
    const worktree = await waitUntil(
      async () =>
        (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.repos[0]?.worktree,
      'the worktree',
    )
    await writeFile(path.join(worktree, 'app.txt'), 'one\nTWO\nthree\n')
    const post = async <T>(route: string, body: unknown = {}) => {
      const res = await lead.call('POST', `/tasks/${task.id}${route}`, body)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
      return res.body as T
    }
    if (stage === 'Validate') {
      await post('/outcome', { outcome: 'advance' })
      await post('/outcome', { outcome: 'advance' })
    }
    const context =
      stage === 'Validate' ? await post<{ id: string }>('/failure-contexts') : undefined
    const failure = await post<{ id: string }>('/failures', {
      source: { kind: 'finding', runId: leadRunId, finding: 'A flaky test' },
      evidence: 'Fails on main too',
      ...(context && { contextId: context.id }),
    })
    await post(`/failures/${failure.id}/assessments`, {
      assessment: 'unrelated',
      recommendation:
        stage === 'Validate' ? 'Accept for this context' : 'No longer applicable to this Task',
    })
    const asked = await post<{ decisions: { commentId: string }[] }>(
      `/failures/${failure.id}/decision`,
    )
    const requestId = asked.decisions.at(-1)?.commentId ?? ''
    await s.ok('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { new: 2 },
      body: 'An unfinished review note',
    })
    const unsent = async () =>
      (await s.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)).filter(
        (c) => c.sent === undefined,
      )
    const read = unpack<CoordinatorTask>(
      (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
    )
    expect(read.openRequests.find((r) => r.id === requestId)?.coordinatorMayAnswer).toBe(
      'with a choice',
    )
    const choice = stage === 'Validate' ? 'Accept this failure' : 'No longer applicable'
    const answered = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      operation: 'resolve-failure',
      version: read.version,
      request: requestId,
      choice,
    })
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    const comment = (await s.comments(task.id)).find((c) => c.id === requestId)
    expect(comment?.answer).toMatchObject({ kind: 'answered', choice })
    expect(comment?.lineComments ?? []).toEqual([])
    expect(await unsent()).toHaveLength(1)
  },
)

test('answer gives a choice on TED’s idle question, and refuses free text alone', async () => {
  const s = await setup(undefined, undefined, 100)
  const { task } = await s.led(
    { say: 'Templates are wired in.' },
    { endTurn: true },
    { everyMessage: [{ say: 'I’ll check the empty template next.' }, { endTurn: true }] },
  )
  const idle = await waitUntil(
    async () => (await s.comments(task.id)).find((c) => c.kind === 'question'),
    'TED to ask about the idle Task Lead',
  )
  expect(idle).toMatchObject({ author: { kind: 'ted' }, choices: ['Nudge again'] })
  const { run } = await s.start()

  const list = unpack<{
    now: string
    tasks: { id: string; openRequests?: CoordinatorRequest[] }[]
  }>((await run.call('GET', '/coordinator/tasks')).body)
  expect(Date.parse(list.now)).toBeGreaterThanOrEqual(Date.parse(idle.createdAt))
  expect(list.tasks.find((t) => t.id === task.id)?.openRequests).toEqual([
    {
      id: idle.id,
      kind: 'question',
      askedBy: 'ted',
      stage: idle.stage,
      title: 'The Task Lead stopped without saying why',
      text: idle.body,
      choices: ['Nudge again'],
      createdAt: idle.createdAt,
      coordinatorMayAnswer: 'with a choice',
    },
  ])
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
  )
  expect(read.openRequests.map((r) => r.id)).toEqual([idle.id])

  const answer = async (body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      request: idle.id,
      ...body,
    })
  const words = await answer({ operation: 'words', message: 'Carry on with the template.' })
  expect(words.status).toBe(400)
  expect((words.body as { error: string }).error).toContain('one of its choices')
  expect((await answer({ operation: 'other', choice: 'Stop it' })).status).toBe(409)
  expect((await s.comments(task.id)).find((c) => c.id === idle.id)?.answer).toBeUndefined()

  const nudged = await answer({ operation: 'nudge', choice: 'Nudge again' })
  expect(nudged.status).toBe(200)
  const receipt = nudged.body as CoordinatorReceipt
  expect(receipt.text).toContain(
    `Answered ${task.displayId}’s question “The Task Lead stopped without saying why” with “Nudge again” · was `,
  )
  expect(receipt.text).toContain(' · now ')
  expect((await s.comments(task.id)).find((c) => c.id === idle.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Nudge again',
    text: coordinatorLine,
  })
  expect(await s.waitingIds()).not.toContain(idle.id)
})

test('answer gives Try again on Validate’s send-back limit; the receipt shows the Stage change', async () => {
  const s = await setup(
    undefined,
    [
      'version: 1',
      'order: [intake, work, validate]',
      'stages:',
      '  validate:',
      '    max_back: 1',
      '',
    ].join('\n'),
  )
  const findings = path.join(scratch, 'findings.md')
  await writeFile(findings, '1. The export button does nothing.\n')
  const count = path.join(scratch, 'lead-messages')
  const each = {
    run: [
      'sh',
      '-c',
      [
        `n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}";`,
        'case $n in',
        '1|2|4) ted outcome advance;;',
        `3|5) ted outcome back --to work --findings "${findings}";;`,
        'esac',
      ].join(' '),
    ],
  }
  const { task } = await s.led({ everyMessage: [each, { endTurn: true }] }, each, {
    endTurn: true,
  })
  const limit = await waitUntil(
    async () => (await s.comments(task.id)).find((c) => c.kind === 'question'),
    'TED to ask about the send-back limit',
    40_000,
  )
  expect(limit).toMatchObject({
    author: { kind: 'ted' },
    title: 'Validate has sent this Task back 1 time, its limit',
    choices: ['Try again', 'Move to Done anyway'],
  })
  const stage = async () =>
    (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.stage
  expect(await stage()).toBe('validate')
  const { run } = await s.start()
  const again = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
    operation: 'try-again',
    version: await version(run, task.id),
    request: limit.id,
    choice: 'Try again',
  })
  expect(again.status).toBe(200)
  const receipt = again.body as CoordinatorReceipt
  expect(receipt.text).toContain('with “Try again” · was validate')
  expect(receipt.text).toContain(' · now work')
  expect(receipt.before?.stage).toBe('validate')
  expect(receipt.after?.stage).toBe('work')
  expect((await s.comments(task.id)).find((c) => c.id === limit.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Try again',
    text: coordinatorLine,
  })
})
