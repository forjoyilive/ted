import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AsanaImportPreview,
  type AsanaImportResult,
  asanaAddChoice,
  asanaCompleteChoice,
  asanaLeaveOpenChoice,
  type DaemonClient,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import type { Keyring } from '../src/linear/keyring.ts'
import { openStore } from '../src/store/index.ts'
import { startStubAsana, unusedPort } from './fixtures/stub-asana.ts'
import {
  api,
  appClient,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let stub: Awaited<ReturnType<typeof startStubAsana>>
let daemon: RunningDaemon | undefined
let callbackPort: number
let secret: string | undefined
const keyring: Keyring = {
  kind: 'macos-keychain',
  async get() {
    return secret
  },
  async set(value) {
    secret = value
  },
  async delete() {
    secret = undefined
  },
}

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
  stub = await startStubAsana()
  callbackPort = await unusedPort()
  secret = undefined
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await stub.close()
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(asanaSyncMs?: number): Promise<DaemonClient> {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    asana: { keyring, oauthOrigin: stub.url, apiOrigin: stub.url, callbackPort },
    ...(asanaSyncMs !== undefined && { asanaSyncMs }),
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon info')
  return appClient(info, daemon.appToken)
}

async function connect(client: DaemonClient) {
  await client.configureAsana({
    clientId: '12345',
    clientSecret: 'client-secret-opaque',
    inFile: false,
  })
  const { url } = await client.connectAsana()
  expect((await fetch(stub.callback(url))).status).toBe(200)
  await waitUntil(async () => (await client.getAsana()).state === 'connected', 'connected')
}

const png = '\x89PNG\r\n\x1a\nnot really a picture'

function tasksIn(all: Task[]) {
  const byGid = (gid: string) => all.find((t) => t.source?.asana?.gid === gid)
  return { byGid, imported: all.filter((t) => t.source?.asana) }
}

test('import a nested tree, reuse a tracked subtree, hold the parent on missing work and resume after restart', async () => {
  let client = await start()
  await connect(client)
  await client.addFactory({ repo: origin, key: 'NB' })
  const cli = api(daemon?.port ?? 0, await tokenFor(home))
  stub.setPageSize(2)
  stub.setTasks([
    {
      gid: '501',
      name: 'Checkout redesign',
      notes: 'Ship the new checkout',
      assignee: { gid: '100', name: 'Avery' },
      subtasks: ['502', '503', '504', '506'],
      comments: [
        { author: 'Sam', at: '2026-11-01T10:00:00.000Z', text: 'Keep the old flow for a week' },
      ],
      attachments: [
        { name: 'mock.png', bytes: png },
        { name: 'Spec', host: 'gdrive' },
      ],
    },
    { gid: '502', name: 'Payment form', assignee: { gid: '200', name: 'Sam' } },
    { gid: '503', name: 'Order summary', subtasks: ['505'] },
    { gid: '504', name: 'Pick provider', completed: true },
    { gid: '505', name: 'Tax line', assignee: { gid: '100', name: 'Avery' } },
    { gid: '506', name: 'Gift cards', status: 403 },
  ])

  const first = await cli.call('POST', '/tasks', {
    factory: 'NB',
    source: 'https://app.asana.com/1/77/project/9/task/503',
  })
  expect(first.status).toBe(201)
  let all = await client.listTasks()
  expect(
    tasksIn(all)
      .imported.map((t) => t.title)
      .sort(),
  ).toEqual(['Order summary', 'Tax line'])
  const summary = tasksIn(all).byGid('503')
  expect(tasksIn(all).byGid('505')?.parentId).toBe(summary?.id)

  const preview: AsanaImportPreview = await client.previewAsanaImport({
    url: 'https://app.asana.com/0/9/501/f',
    factory: 'NB',
  })
  expect(preview).toMatchObject({
    create: 2,
    ownership: { you: 1, others: 1, unassigned: 0 },
    missing: 1,
  })
  expect(preview.rows.map((r) => [r.name, r.action.kind])).toEqual([
    ['Checkout redesign', 'new'],
    ['Payment form', 'new'],
    ['Order summary', 'linked'],
    ['Tax line', 'kept'],
    ['Pick provider', 'complete'],
    ['Gift cards', 'unreadable'],
  ])

  let release = () => {}
  stub.hold(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const importing = client.importAsana({ url: 'https://app.asana.com/0/0/501', factory: 'NB' })
  await waitUntil(
    async () => stub.requests.some((r) => r.path === '/api/1.0/tasks/501'),
    'discovery started',
  )
  expect(tasksIn(await client.listTasks()).imported).toHaveLength(2)
  stub.hold(undefined)
  release()
  const result: AsanaImportResult = await importing
  expect(result.created).toHaveLength(2)
  expect(result.linked.map((t) => t.taskId)).toEqual([summary?.id])

  all = await client.listTasks()
  const { byGid } = tasksIn(all)
  const root = byGid('501')
  expect(root).toMatchObject({
    title: 'Checkout redesign',
    description: 'Ship the new checkout',
    priority: 'none',
    stage: 'backlog',
    attachments: [expect.objectContaining({ name: 'mock.png', mediaType: 'image/png' })],
    source: { asana: { gid: '501', assignee: { name: 'Avery', you: true }, completed: false } },
  })
  expect(root?.source?.asana?.context).toContain('Sam, 2026-11-01T10:00:00.000Z:')
  expect(root?.source?.asana?.context).not.toContain('changed the due date')
  expect(byGid('502')?.parentId).toBe(root?.id)
  expect(byGid('503')?.parentId).toBe(root?.id)
  expect(byGid('503')?.description).toBe('')
  expect(byGid('504')).toBeUndefined()
  expect(root?.asanaSync).toMatchObject({ state: 'waiting-merge' })
  expect(byGid('502')?.asanaSync).toMatchObject({ state: 'waiting-merge' })
  expect(byGid('503')?.asanaSync).toMatchObject({ state: 'not-allowed' })
  expect(byGid('505')?.asanaSync).toMatchObject({ state: 'not-allowed' })
  expect((await cli.call('POST', `/tasks/${byGid('505')?.id}/asana-sync`)).status).toBe(403)
  expect((await client.allowAsanaSync(byGid('505')?.id ?? '')).asanaSync).toMatchObject({
    state: 'waiting-merge',
  })
  const downloads = stub.requests.filter((r) => r.path.startsWith('/files/'))
  expect(downloads).toHaveLength(1)
  expect(downloads[0]?.authorization).toBeUndefined()

  const comments = await client.listComments(root?.id ?? '')
  expect(comments.find((c) => c.kind === 'note')?.body).toContain('Spec: it’s stored outside Asana')
  const question = comments.find((c) => c.asanaMissing)
  expect(question).toMatchObject({
    kind: 'question',
    choices: ['Retry', 'Go ahead without them'],
    asanaMissing: { rootGid: '501', items: [expect.objectContaining({ gid: '506' })] },
  })
  expect((await client.startTask(root?.id ?? '')).stage).toBe('backlog')

  const again = await cli.call('POST', '/tasks/asana-import', {
    url: 'https://app.asana.com/1/77/task/501',
    factory: 'NB',
  })
  expect(again.status).toBe(409)
  expect(JSON.stringify(again.body)).toContain('Already tracked as NB-')
  expect(
    (
      await cli.call('POST', '/tasks/asana-import', {
        url: 'https://app.asana.com/0/0/501',
        factory: 'NB',
        addToTree: true,
      })
    ).status,
  ).toBe(403)

  stub.setTasks([
    {
      gid: '501',
      name: 'Checkout redesign',
      notes: 'Ship the new checkout',
      subtasks: ['502', '503', '504', '506', '507'],
    },
    { gid: '502', name: 'Payment form' },
    { gid: '503', name: 'Order summary', subtasks: ['505'] },
    { gid: '504', name: 'Pick provider', completed: true },
    { gid: '505', name: 'Tax line' },
    { gid: '506', name: 'Gift cards' },
    { gid: '507', name: 'Store credit', status: 404 },
  ])
  await client.answerRequest(question?.id ?? '', { action: 'answer', choice: 'Retry' })
  all = await client.listTasks()
  expect(tasksIn(all).byGid('506')?.parentId).toBe(root?.id)
  expect(tasksIn(all).byGid('506')?.asanaSync).toMatchObject({ state: 'waiting-merge' })
  const afterRetry = await client.listComments(root?.id ?? '')
  expect(afterRetry.find((c) => c.id === question?.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Retry',
  })
  const earlier = afterRetry.find((c) => c.asanaMissing && !c.answer)
  expect(earlier?.asanaMissing?.items.map((i) => i.gid)).toEqual(['507'])

  stub.setTasks([
    ...['502', '504', '506'].map((gid) => ({ gid, name: `Item ${gid}`, completed: gid === '504' })),
    {
      gid: '501',
      name: 'Checkout redesign',
      subtasks: ['502', '503', '504', '506', '507', '508'],
    },
    { gid: '503', name: 'Order summary', subtasks: ['505'] },
    { gid: '505', name: 'Tax line' },
    { gid: '507', name: 'Store credit', status: 404 },
    { gid: '508', name: 'Receipts' },
  ])
  const added = await client.importAsana({
    url: 'https://app.asana.com/0/0/501',
    factory: 'NB',
    addToTree: true,
  })
  expect(added.created).toHaveLength(1)
  const replaced = await client.listComments(root?.id ?? '')
  expect(replaced.find((c) => c.id === earlier?.id)?.answer).toMatchObject({
    kind: 'withdrawn',
    asanaReread: true,
  })
  const open = replaced.filter((c) => c.asanaMissing && !c.answer)
  expect(open).toHaveLength(1)
  const second = open[0]

  await daemon?.stop()
  daemon = undefined
  client = await start()
  const count = (await client.listTasks()).length
  await expect
    .poll(async () => {
      const after = tasksIn(await client.listTasks())
      return ['503', '505'].map((gid) => after.byGid(gid)?.asanaSync?.state)
    })
    .toEqual(['not-allowed', 'waiting-merge'])
  const reread = await client.previewAsanaImport({
    url: 'https://app.asana.com/0/9/501',
    factory: 'NB',
  })
  expect(reread).toMatchObject({ create: 0, tracked: { taskId: root?.id } })
  await client.answerRequest(second?.id ?? '', {
    action: 'answer',
    choice: 'Go ahead without them',
  })
  const final = await client.listComments(root?.id ?? '')
  expect(final.find((c) => c.id === second?.id)?.answer).toMatchObject({
    choice: 'Go ahead without them',
  })
  expect(final.at(-1)?.body).toContain('aren’t this Task’s work')
  expect((await client.listTasks()).length).toBe(count)
})

test('a tree over the limit is refused whole, and a completed root still imports', async () => {
  const client = await start()
  await connect(client)
  await client.addFactory({ repo: origin, key: 'NB' })
  stub.setPageSize(100)
  const children = Array.from({ length: 100 }, (_, i) => String(700 + i))
  stub.setTasks([
    { gid: '600', name: 'Huge', subtasks: children },
    ...children.map((gid) => ({ gid, name: `Child ${gid}` })),
    { gid: '900', name: 'Already shipped', completed: true, subtasks: ['901'] },
    { gid: '901', name: 'Hidden', status: 403 },
    { gid: '920', name: 'Declined', subtasks: ['921'] },
    { gid: '921', name: 'Hidden for now', status: 403 },
    { gid: '950', name: 'From the terminal' },
  ])
  const refused = await client
    .importAsana({ url: 'https://app.asana.com/0/0/600', factory: 'NB' })
    .catch((error: unknown) => String(error))
  expect(refused).toContain('101 Tasks')
  expect((await client.listTasks()).filter((t) => t.source?.asana)).toEqual([])
  const done = await client.importAsana({ url: 'https://app.asana.com/0/0/900', factory: 'NB' })
  expect(done.created).toHaveLength(1)
  const shipped = (await client.listTasks()).find((t) => t.source?.asana?.gid === '900')
  expect(shipped?.source?.asana?.completed).toBe(true)
  expect((await client.startTask(shipped?.id ?? '')).stage).toBe('backlog')
  const ask = (await client.listComments(shipped?.id ?? '')).find((c) => c.asanaMissing)
  await client.answerRequest(ask?.id ?? '', { action: 'answer', choice: 'Go ahead without them' })
  await waitUntil(
    async () => (await client.listTasks()).find((t) => t.id === shipped?.id)?.stage !== 'backlog',
    'the root starts once its question is answered',
  )

  const cli = api(daemon?.port ?? 0, await tokenFor(home))
  const fromCli = await cli.call('POST', '/tasks/asana-import', {
    url: 'https://app.asana.com/0/0/950',
    factory: 'NB',
    taskSync: true,
  })
  expect(fromCli.status).toBe(201)
  await client.importAsana({ url: 'https://app.asana.com/0/0/920', factory: 'NB', taskSync: false })
  let byGid = tasksIn(await client.listTasks()).byGid
  expect(byGid('950')?.asanaSync).toMatchObject({ state: 'not-allowed' })
  expect(byGid('920')?.asanaSync).toMatchObject({ state: 'not-allowed' })
  const declined = (await client.listComments(byGid('920')?.id ?? '')).find((c) => c.asanaMissing)
  stub.setTasks([
    { gid: '920', name: 'Declined', subtasks: ['921'] },
    { gid: '921', name: 'Hidden for now' },
  ])
  await client.answerRequest(declined?.id ?? '', { action: 'answer', choice: 'Retry' })
  byGid = tasksIn(await client.listTasks()).byGid
  expect(byGid('921')?.parentId).toBe(byGid('920')?.id)
  expect(byGid('921')?.asanaSync).toMatchObject({ state: 'not-allowed' })
  const ids = ['920', '921', '950'].map((gid) => byGid(gid)?.id ?? '')
  await daemon?.stop()
  daemon = undefined
  const store = await openStore({ directory: tedPaths(home).store })
  expect(ids.map((id) => store.trackerSync(id, 'asana'))).toMatchObject([
    { allowed: false, declined: true },
    { allowed: false, declined: true },
    { allowed: false },
  ])
  expect(store.trackerSync(ids[2] ?? '', 'asana').declined).toBeUndefined()
  await store.close()
})

test('Add them as Tasks imports new Asana items under a merged parent, which then waits for their Tasks', async () => {
  let client = await start()
  await connect(client)
  await client.addFactory({ repo: origin, key: 'NB' })
  stub.setPageSize(100)
  stub.setTasks([
    { gid: '1501', name: 'Billing', subtasks: ['1502'] },
    { gid: '1502', name: 'Invoices' },
    { gid: '1504', name: 'Tax report' },
  ])
  await client.importAsana({ url: 'https://app.asana.com/0/0/1501', factory: 'NB' })
  await client.importAsana({ url: 'https://app.asana.com/0/0/1504', factory: 'NB' })
  const parent = tasksIn(await client.listTasks()).byGid('1501') as Task
  const repo = (await client.listFactories()).find((f) => f.key === 'NB')?.repos[0]
  stub.setTasks([
    { gid: '1501', name: 'Billing', subtasks: ['1502', '1503', '1504'] },
    { gid: '1502', name: 'Invoices' },
    { gid: '1503', name: 'Refunds' },
    { gid: '1504', name: 'Tax report' },
  ])
  await daemon?.stop()
  daemon = undefined
  const store = await openStore({ directory: tedPaths(home).store })
  store.startTask({
    taskId: parent.id,
    stage: 'work',
    branch: 'ted/billing',
    worktree: path.join(scratch, 'billing'),
    entry: { layers: [], order: [{ stage: 'work', enabled: true }] },
    repo: { name: repo?.name ?? '', repo: repo?.repo ?? '', copied: [], skipped: [] },
  })
  store.pullRequestOpened(parent.id, repo?.name ?? '', {
    number: 15,
    url: 'https://github.com/acme/notes/pull/15',
    base: 'main',
  })
  store.pullRequestMerged(parent.id, repo?.name ?? '', { noCi: true, byTed: true })
  store.changeStage(parent.id, 'done')
  await store.close()

  client = await start(100)
  const question = await waitUntil(
    async () => (await client.listComments(parent.id)).find((c) => c.asanaUnfinished && !c.answer),
    'the merged parent asks about the new Asana item',
  )
  expect(question).toMatchObject({
    choices: [asanaAddChoice, asanaCompleteChoice, asanaLeaveOpenChoice],
    asanaUnfinished: { parentGid: '1501', items: [expect.objectContaining({ gid: '1503' })] },
  })
  expect(question.asanaUnfinished?.items).toHaveLength(1)
  expect((await client.listTasks()).find((t) => t.id === parent.id)?.asanaSync?.state).toBe(
    'needs-answer',
  )
  await expect(
    client.answerRequest(question.id, { action: 'answer', choice: 'Archive' }),
  ).rejects.toThrow()
  await client.answerRequest(question.id, { action: 'answer', choice: asanaAddChoice })
  const all = tasksIn(await client.listTasks())
  expect(all.byGid('1503')?.parentId).toBe(parent.id)
  expect(all.byGid('1504')?.parentId).toBeUndefined()
  expect(all.byGid('1501')?.stage).toBe('done')
  const after = await client.listComments(parent.id)
  expect(after.find((c) => c.id === question.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: asanaAddChoice,
  })
  expect(after.filter((c) => c.asanaMissing)).toEqual([])
  await expect
    .poll(async () => (await client.listTasks()).find((t) => t.id === parent.id)?.asanaSync)
    .toMatchObject({ state: 'waiting-children', openChildren: 3 })
  expect(stub.requests.filter((r) => r.method === 'PUT')).toEqual([])
})
