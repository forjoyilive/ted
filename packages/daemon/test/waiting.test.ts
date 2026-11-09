import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DaemonEvent, WaitingRequest } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openStore, type TedStore } from '../src/store/index.ts'

let dir: string
let store: TedStore

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-waiting-'))
  store = await openStore({ directory: dir })
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

const run = { kind: 'run', runId: 'r1' } as const
const ids = (waiting: readonly WaitingRequest[]) => waiting.map((w) => w.id)

function inboxEvents(): WaitingRequest[][] {
  const seen: WaitingRequest[][] = []
  store.subscribe((event: DaemonEvent) => {
    if (event.type === 'inbox-changed') seen.push(event.waiting)
  })
  return seen
}

describe('waiting Inbox requests', () => {
  test('counts every open request, one per request, not one per Task, and leaves out notes', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    const other = await store.createTask({ title: 'Add dark mode' })
    const first = store.postComment({
      taskId: task.id,
      body: 'Which page?',
      author: run,
      kind: 'question',
    })
    const second = store.postComment({
      taskId: task.id,
      body: 'Ready to merge',
      author: { kind: 'ted' },
      kind: 'signoff',
      title: 'Sign off on DEV-1',
    })
    store.postComment({ taskId: task.id, body: 'FYI', author: run, kind: 'note' })
    const third = store.postComment({
      taskId: other.id,
      body: 'Run `rm`?\nmore',
      author: run,
      kind: 'permission',
    })

    const waiting = store.waiting()
    expect(ids(waiting)).toEqual([first.id, second.id, third.id])
    expect(waiting[1]).toMatchObject({
      source: 'task',
      kind: 'signoff',
      failed: false,
      taskId: task.id,
      factoryId: task.factoryId,
      displayId: 'DEV-1',
      taskTitle: 'Fix login',
      headline: 'Sign off on DEV-1',
    })
    expect(waiting[2]).toMatchObject({ displayId: 'DEV-2', headline: 'Run `rm`?' })
  })

  test('tells subscribers when the waiting requests change, once per change', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    const seen = inboxEvents()
    const asked = store.postComment({
      taskId: task.id,
      body: 'Which page?',
      author: run,
      kind: 'question',
    })
    await expect.poll(() => seen.length).toBe(1)
    expect(ids(seen[0] ?? [])).toEqual([asked.id])

    store.setActivity(task.id, 'Reading the code')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toHaveLength(1)

    store.answerComment(asked.id, { kind: 'answered', at: new Date().toISOString(), text: 'Home' })
    await expect.poll(() => seen.length).toBe(2)
    expect(seen[1]).toEqual([])
  })

  test('an archived Task’s requests aren’t waiting', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    store.postComment({ taskId: task.id, body: 'Which page?', author: run, kind: 'question' })
    expect(store.waiting()).toHaveLength(1)
    store.archiveTask(task.id)
    expect(store.waiting()).toEqual([])
  })

  test('a planning chat’s rounds and proposals wait; its notes don’t', async () => {
    const factory = store.createFactory({
      key: 'NB',
      name: 'Notebook',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    const plan = store.plans.start({
      factoryId: factory.id,
      title: 'Split billing',
      message: 'Plan it',
      agent: 'claude',
    })
    const round = store.plans.postRequest({
      planId: plan.id,
      runId: 'p1',
      kind: 'round',
      author: 'run',
      title: 'Round 1',
      body: 'Questions',
    })
    store.plans.postRequest({
      planId: plan.id,
      runId: 'p1',
      kind: 'note',
      author: 'run',
      body: 'x',
    })

    expect(store.waiting()).toEqual([
      expect.objectContaining({
        source: 'plan',
        id: round.id,
        kind: 'round',
        planId: plan.id,
        planTitle: 'Split billing',
        factoryId: factory.id,
        headline: 'Round 1',
      }),
    ])
  })
})
