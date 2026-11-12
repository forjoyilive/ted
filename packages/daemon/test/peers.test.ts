import { shortReference } from '@ted/protocol/reference'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { openStore, type TedStore } from '../src/store/index.ts'
import { createPeers, type Peers } from '../src/tasks/peers.ts'
import type { Caller } from '../src/tasks/tasks.ts'

let dir: string
let store: TedStore
let peers: Peers
let sender: string
let recipient: string
let caller: Caller
const notify = vi.fn()
function lead(taskId: string, id: string = crypto.randomUUID(), parentRunId?: string) {
  return store.startRun({
    id,
    taskId,
    agent: 'codex',
    prompt: 'work',
    cwd: dir,
    ...(parentRunId && { parentRunId }),
  })
}
function services() {
  return createPeers(store, notify)
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-peers-'))
  store = await openStore({ directory: dir })
  sender = (await store.createTask({ title: 'Sender' })).id
  recipient = (await store.createTask({ title: 'Recipient', description: 'Original request' })).id
  caller = { kind: 'run', runId: lead(sender).id }
  peers = services()
  notify.mockClear()
})
afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('fresh Factory snapshots and details expose reported activity and brief timestamps', () => {
  const before = peers.list(caller)
  expect(before.tasks.map((t) => t.id)).toEqual([recipient])
  expect(peers.show(caller, recipient)).toMatchObject({
    description: 'Original request',
    original: { text: 'Original request' },
  })
  expect(peers.show(caller, recipient).brief).toBeUndefined()
  store.setActivity(recipient, 'Checking storage')
  store.writeBrief({ taskId: recipient, runId: lead(recipient).id, text: 'Current plan' })
  const after = peers.list(caller)
  expect(after.cursor).not.toBe(before.cursor)
  expect(after.tasks[0]).toMatchObject({
    activity: 'Checking storage',
    briefAt: expect.any(String),
    lead: { state: 'working' },
  })
  expect(peers.show(caller, recipient).brief?.text).toBe('Current plan')
})

test('Factory boundaries, archived targets and Lead ownership are enforced', async () => {
  const factory = store.createFactory({
    key: 'OTHER',
    name: 'Other',
    repos: [],
    defaultBranch: 'main',
    showTutorial: false,
  })
  const other = await store.createTask({ factoryId: factory.id, title: 'Private' })
  expect(peers.list(caller).tasks.map((t) => t.id)).not.toContain(other.id)
  expect(() => peers.show(caller, other.id)).toThrow('no peer Task')
  await expect(peers.send(caller, other.id, { operation: 'cross', text: 'Hello' })).rejects.toThrow(
    'no peer Task',
  )
  expect(() => peers.show(caller, sender)).toThrow('no peer Task')
  store.archiveTask(recipient)
  expect(() => peers.show(caller, recipient)).toThrow('no peer Task')
  const sub = lead(sender, 'sub', caller.kind === 'run' ? caller.runId : '')
  expect(() => peers.list({ kind: 'run', runId: sub.id })).toThrow('only a current Task Lead')
  expect(() => peers.list({ kind: 'run', runId: lead(sender).id })).not.toThrow()
  expect(() => peers.list(caller)).toThrow('only a current Task Lead')
  const standalone = store.startRun({ id: 'plan', agent: 'codex', prompt: 'plan', cwd: dir })
  expect(() => peers.list({ kind: 'run', runId: standalone.id })).toThrow(
    'only a current Task Lead',
  )
})

test('pages are bounded and cursors cover changes beyond the first page', async () => {
  for (let n = 0; n < 31; n++) await store.createTask({ title: `Peer ${n}` })
  const page = peers.list(caller)
  expect(page.tasks).toHaveLength(30)
  expect(page.nextOffset).toBe(30)
  const next = peers.list(caller, 30)
  expect(next.tasks).toHaveLength(2)
  expect(next.cursor).toBe(page.cursor)
  store.setActivity(next.tasks[0]?.id ?? '', 'Changed on page two')
  expect(peers.list(caller).cursor).not.toBe(page.cursor)
  expect(() => peers.list(caller, -1)).toThrow('offset')
})

test('watch handles changes, timeouts, disconnects and stale callers without leaking subscriptions', async () => {
  const subscribeOriginal = store.subscribe.bind(store)
  const stops: ReturnType<typeof vi.fn>[] = []
  const subscribe = vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
    const stop = vi.fn(subscribeOriginal(listener))
    stops.push(stop)
    return stop
  })
  const cursor = peers.list(caller).cursor
  const pending = peers.watch(caller, cursor, 1)
  store.setActivity(recipient, 'New work')
  expect((await pending).tasks[0]?.activity).toBe('New work')
  const stable = peers.list(caller).cursor
  expect((await peers.watch(caller, stable, 0.01)).cursor).toBe(stable)
  const controller = new AbortController()
  const canceled = peers.watch(caller, stable, 25, controller.signal)
  controller.abort()
  expect((await canceled).cursor).toBe(stable)
  const revoked = peers.watch(caller, stable, 25)
  lead(sender)
  await expect(revoked).rejects.toThrow('only a current Task Lead')
  expect(subscribe).toHaveBeenCalledTimes(4)
  for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1)
  expect(() => peers.watch(caller, stable, 26)).toThrow('timeout')
})

test('message and attributed Comment are atomic, replay-safe and survive a daemon store restart', async () => {
  const run = lead(recipient)
  const posted: unknown[] = []
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'comment-posted') posted.push(event.comment)
  })
  const input = {
    operation: 'coordinate-1',
    text: 'I am changing the protocol. Please wait for my interface.',
  }
  const sent = await peers.send(caller, recipient, input)
  expect(store.getComment(sent.id)).toMatchObject({
    taskId: recipient,
    kind: 'note',
    author: { kind: 'run', runId: sent.senderRunId },
    peer: { sender: 'DEV-1', text: input.text },
  })
  const wrappedBody = store.getComment(sent.id)?.body
  expect(wrappedBody).toContain('Peer message from DEV-1')
  expect(wrappedBody).toContain(`(Run ${shortReference(sent.senderRunId)})`)
  expect(wrappedBody).toMatch(/<<<PEER ([\w-]+)>>>\n.*\n<<<END PEER \1>>>/s)
  expect(posted).toEqual([store.getComment(sent.id)])
  expect(store.listComments(recipient)[0]?.peer).toEqual({ sender: 'DEV-1', text: input.text })
  unsubscribe()
  expect(notify).toHaveBeenCalledWith(run.id)
  expect(await peers.send(caller, recipient, input)).toEqual(sent)
  await expect(peers.send(caller, recipient, { ...input, text: 'Different' })).rejects.toThrow(
    'already used',
  )
  expect(store.listComments(recipient)).toHaveLength(1)
  await store.close()
  store = await openStore({ directory: dir })
  peers = services()
  expect(store.getComment(sent.id)).toMatchObject({
    body: wrappedBody,
    peer: { sender: 'DEV-1', text: input.text },
  })
  expect(await peers.send(caller, recipient, input)).toEqual(sent)
  const recipientCaller: Caller = { kind: 'run', runId: run.id }
  expect(peers.inbox(recipientCaller).messages).toEqual([sent])
  store.commentsDelivered([sent.id], run.id)
  expect(peers.inbox(recipientCaller).messages[0]?.delivered).toMatchObject({ runId: run.id })
  expect((await peers.send(caller, recipient, input)).delivered).toMatchObject({ runId: run.id })
})

test('pending messages follow replacement Leads, and Task deletion removes peer projections', async () => {
  const old = lead(recipient)
  const sent = await peers.send(caller, recipient, {
    operation: 'pending',
    text: 'Coordinate this change',
  })
  store.recordRunOutput(old.id, { toOffset: 1, state: 'finished' })
  const replacement = lead(recipient)
  expect(peers.inbox({ kind: 'run', runId: replacement.id }).messages[0]?.id).toBe(sent.id)
  expect(peers.inbox({ kind: 'run', runId: replacement.id }).messages[0]?.delivered).toBeUndefined()
  store.deleteTask(recipient)
  expect(store.peerMessages()).toEqual([])
})

test('outgoing notes survive sender deletion and restart until the recipient is deleted', async () => {
  const old = lead(recipient)
  const sent = await peers.send(caller, recipient, {
    operation: 'deleted-sender',
    text: 'Coordinate when you resume.',
  })
  store.recordRunOutput(old.id, { toOffset: 1, state: 'finished' })
  store.deleteTask(sender)
  expect(store.getComment(sent.id)?.body).toContain('Peer message from DEV-1')
  expect(store.getComment(sent.id)?.peer).toEqual({ sender: 'DEV-1', text: sent.text })
  expect(store.peerMessages()).toEqual([sent])
  await store.close()
  store = await openStore({ directory: dir })
  peers = services()
  const replacement = lead(recipient)
  expect(store.getComment(sent.id)?.peer).toEqual({ sender: 'DEV-1', text: sent.text })
  const receiver: Caller = { kind: 'run', runId: replacement.id }
  expect(peers.isMessage(sent.id)).toBe(true)
  expect(peers.inbox(receiver).messages).toEqual([sent])
  store.commentsDelivered([sent.id], replacement.id)
  expect(peers.inbox(receiver).messages[0]?.delivered).toMatchObject({ runId: replacement.id })
  store.deleteTask(recipient)
  expect(store.peerMessages()).toEqual([])
})

test('Factory deletion removes peer records whose sender was already deleted', async () => {
  const task = store.getTask(sender)
  if (!task) throw new Error('sender missing')
  await peers.send(caller, recipient, { operation: 'removed-factory', text: 'Coordinate' })
  store.deleteTask(sender)
  expect(store.peerMessages()).toHaveLength(1)
  store.removeFactory(task.factoryId)
  expect(store.peerMessages()).toEqual([])
})

test('size, backlog and lifecycle limits prevent unbounded or obsolete coordination', async () => {
  await expect(peers.send(caller, recipient, { operation: 'empty', text: '' })).rejects.toThrow(
    '8192',
  )
  await expect(
    peers.send(caller, recipient, { operation: 'unicode', text: '🙂'.repeat(2049) }),
  ).rejects.toThrow('8192')
  for (let i = 0; i < 20; i++)
    await peers.send(caller, recipient, { operation: `msg-${i}`, text: 'note' })
  await expect(
    peers.send(caller, recipient, { operation: 'overflow', text: 'note' }),
  ).rejects.toThrow('20 pending')
  const first = store.peerMessages()[0]
  if (!first) throw new Error('missing message')
  store.commentsDelivered([first.id], lead(recipient).id)
  await expect(
    peers.send(caller, recipient, { operation: 'room', text: 'note' }),
  ).resolves.toHaveProperty('id')
  store.changeStage(recipient, 'done')
  await expect(peers.send(caller, recipient, { operation: 'done', text: 'note' })).rejects.toThrow(
    'Done',
  )
})

test('production snapshots read the Task list once, and details do not rebuild it', async () => {
  for (let i = 0; i < 30; i++) await store.createTask({ title: `Extra peer ${i}` })
  const reads = vi.spyOn(store, 'listTasks')
  peers.list(caller)
  expect(reads).toHaveBeenCalledTimes(1)
  reads.mockClear()
  peers.show(caller, recipient)
  expect(reads).not.toHaveBeenCalled()
})

test('watch ignores raw output and other Factories, and coalesces relevant updates', async () => {
  const factory = store.createFactory({
    key: 'OTHER',
    name: 'Other',
    repos: [],
    defaultBranch: 'main',
    showTutorial: false,
  })
  const other = await store.createTask({ factoryId: factory.id, title: 'Unrelated peer' })
  const cursor = peers.list(caller).cursor
  const reads = vi.spyOn(store, 'listTasks')
  const controller = new AbortController()
  const pending = peers.watch(caller, cursor, 1, controller.signal)
  try {
    reads.mockClear()
    if (caller.kind !== 'run') throw new Error('Lead missing')
    store.recordRunOutput(caller.runId, {
      toOffset: 1,
      output: {},
    })
    await Promise.resolve()
    expect(reads).not.toHaveBeenCalled()
    store.setActivity(other.id, 'Other Factory work')
    await Promise.resolve()
    expect(reads).not.toHaveBeenCalled()
    store.setActivity(recipient, 'First update')
    store.setActivity(recipient, 'Final update')
    expect((await pending).tasks.find((t) => t.id === recipient)?.activity).toBe('Final update')
    expect(reads).toHaveBeenCalledTimes(1)
  } finally {
    controller.abort()
    await pending.catch(() => {})
  }
})

test('watch observes note timestamps in the public Task snapshot', async () => {
  const cursor = peers.list(caller).cursor
  const controller = new AbortController()
  const pending = peers.watch(caller, cursor, 1, controller.signal)
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-01-01T00:00:00Z') })
  try {
    store.postComment({ taskId: recipient, body: 'Coordination note', author: { kind: 'ted' } })
    expect((await pending).tasks.find((t) => t.id === recipient)?.updatedAt).toBe(
      '2027-01-01T00:00:00.000Z',
    )
  } finally {
    controller.abort()
    await pending.catch(() => {})
    vi.useRealTimers()
  }
})
