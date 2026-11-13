import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { eventlogFile } from '../src/store/files.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { heldToRelease } from '../src/tasks/held-requests.ts'

let directory: string
let store: TedStore
let taskId: string

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ted-held-requests-'))
  store = await openStore({ directory })
  taskId = (await store.createTask({ title: 'Held requests' })).id
  store.startRun({ id: 'lead', taskId, agent: 'claude', prompt: 'Work', cwd: directory })
  store.recordRunOutput('lead', { toOffset: 1, state: 'working' })
})
afterEach(async () => {
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

const lead = { kind: 'run' as const, runId: 'lead' }

test('a request the working Task Lead posts is held until released, then follows its note', async () => {
  const request = store.postComment({
    taskId,
    kind: 'question',
    body: 'Which one?',
    choices: ['A', 'B'],
    author: lead,
  })
  store.postComment({ taskId, body: 'Why I ask', author: lead })
  expect(request.held).toBe(true)
  expect(store.waiting()).toEqual([])
  expect(store.listOpenRequests()).toEqual([])
  expect(store.heldRequests()).toEqual([
    { id: request.id, runId: 'lead', createdAt: request.createdAt },
  ])

  await store.close()
  const folder = path.dirname((await eventlogFile(directory)) as string)
  for (const name of await readdir(folder)) {
    if (name.startsWith('state')) await rm(path.join(folder, name))
  }
  store = await openStore({ directory })
  expect(store.heldRequests().map((r) => r.id)).toEqual([request.id])

  await new Promise((resolve) => setTimeout(resolve, 5))
  store.releaseRequests([request.id])
  expect(store.heldRequests()).toEqual([])
  expect(store.listComments(taskId).map((c) => [c.body, c.held])).toEqual([
    ['Why I ask', undefined],
    ['Which one?', undefined],
  ])
  expect(store.waiting().map((r) => r.id)).toEqual([request.id])
})

test('notes, TED’s requests and requests from an idle Run post at once', () => {
  const posted = [
    store.postComment({ taskId, body: 'A note', author: lead }),
    store.postComment({ taskId, kind: 'question', body: 'From TED', author: { kind: 'ted' } }),
  ]
  store.recordRunOutput('lead', { toOffset: 2, state: 'idle' })
  posted.push(store.postComment({ taskId, kind: 'question', body: 'Idle', author: lead }))
  expect(posted.map((c) => c.held)).toEqual([undefined, undefined, undefined])
  expect(store.heldRequests()).toEqual([])
})

test('heldToRelease lets go of requests whose Run stopped working or that waited too long', () => {
  const now = Date.parse('2026-11-13T12:10:00Z')
  const held = [
    { id: 'working', runId: 'a', createdAt: '2026-11-13T12:09:00Z' },
    { id: 'idle', runId: 'b', createdAt: '2026-11-13T12:09:00Z' },
    { id: 'old', runId: 'a', createdAt: '2026-11-13T12:04:00Z' },
  ]
  expect(heldToRelease(held, (runId) => runId === 'a', now)).toEqual(['idle', 'old'])
})
