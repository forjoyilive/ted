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

  test('Run output tells subscribers only when it asks or withdraws a permission request', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    store.startRun({ id: 'r1', taskId: task.id, agent: 'claude', prompt: 'Fix it', cwd: dir })
    const seen = inboxEvents()

    store.recordRunOutput('r1', { toOffset: 10, output: {}, state: 'working' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([])

    store.recordRunOutput('r1', {
      toOffset: 20,
      output: {},
      state: 'waiting',
      permissionPrompts: [
        { requestId: 'p1', title: 'Run a command', command: 'rm -rf build', generation: 1 },
      ],
    })
    await expect.poll(() => seen.length).toBe(1)
    expect(seen[0]).toMatchObject([{ kind: 'permission', taskId: task.id }])
    expect(ids(store.waiting())).toEqual(ids(seen[0] ?? []))

    store.recordRunOutput('r1', { toOffset: 30, output: {}, closedPermissions: ['p1'] })
    await expect.poll(() => seen.length).toBe(2)
    expect(seen[1]).toEqual([])

    store.recordRunOutput('r1', {
      toOffset: 40,
      permissionPrompts: [
        { requestId: 'p2', title: 'Run a command', command: 'ls', generation: 1 },
      ],
    })
    await expect.poll(() => seen.length).toBe(3)
    store.recordRunOutput('r1', { toOffset: 50, state: 'finished' })
    await expect.poll(() => seen.length).toBe(4)
    expect(seen[3]).toEqual([])
    expect(store.waiting()).toEqual([])
  })

  test('an archived Task’s requests aren’t waiting', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    store.postComment({ taskId: task.id, body: 'Which page?', author: run, kind: 'question' })
    expect(store.waiting()).toHaveLength(1)
    store.archiveTask(task.id)
    expect(store.waiting()).toEqual([])
  })

  test('counts read requests even on Stopped Tasks, but never counts a waiting Run alone', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    store.startRun({ id: 'r1', taskId: task.id, agent: 'claude', prompt: 'Fix it', cwd: dir })
    store.recordRunOutput('r1', { toOffset: 0, state: 'waiting' })
    expect(store.getRun('r1')?.state).toBe('waiting')
    expect(store.waiting()).toEqual([])

    const question = store.postComment({
      taskId: task.id,
      body: 'Which page?',
      author: run,
      kind: 'question',
    })
    store.commentsRead([question.id])
    expect(store.listComments(task.id).find((c) => c.id === question.id)?.readAt).toBeDefined()
    expect(ids(store.waiting())).toEqual([question.id])

    store.stopTask(task.id, { runs: 1, why: 'human' })
    expect(ids(store.waiting())).toEqual([question.id])
    store.answerComment(question.id, {
      kind: 'answered',
      at: new Date().toISOString(),
      text: 'Home',
    })
    expect(store.waiting()).toEqual([])
  })

  test('counts an Automation question once alongside Task requests and removes it when answered', async () => {
    const factory = store.createFactory({
      key: 'NB',
      name: 'Notebook',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    const task = await store.createTask({ title: 'Fix login', factoryId: factory.id })
    const question = store.postComment({
      taskId: task.id,
      body: 'Which page?',
      author: run,
      kind: 'question',
    })
    const automation = store.automations.create(
      {
        factoryId: task.factoryId,
        name: 'Daily triage',
        prompt: 'Triage',
        schedule: { kind: 'daily', at: '09:00' },
        timeZone: 'UTC',
        agent: 'claude',
        on: true,
      },
      new Date().toISOString(),
    )
    const firing = store.automations.fire({
      automationId: automation.id,
      trigger: 'run-now',
      at: new Date().toISOString(),
    })
    const comment = { automationId: automation.id, firingId: firing.id }
    store.automations.postComment({ ...comment, kind: 'note', body: 'Triage started' })
    const asked = store.automations.postComment({
      ...comment,
      kind: 'question',
      body: 'Create a Task?',
    })
    expect(store.waiting()).toEqual([
      expect.objectContaining({ source: 'task', id: question.id }),
      expect.objectContaining({ source: 'automation', id: asked.id }),
    ])

    await store.persisted()
    const seen = inboxEvents()
    store.automations.answerComment(asked.id, 'Yes')
    await expect.poll(() => seen.length).toBe(1)
    expect(ids(seen[0] ?? [])).toEqual([question.id])
    expect(ids(store.waiting())).toEqual([question.id])
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
    const proposal = store.plans.postRequest({
      planId: plan.id,
      runId: 'p1',
      kind: 'proposal',
      author: 'run',
      title: 'Billing Tasks',
      body: 'Split billing into Tasks',
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
      expect.objectContaining({ source: 'plan', id: proposal.id, kind: 'proposal' }),
    ])
    store.plans.answerRequest(round.id, { kind: 'answered', at: new Date().toISOString() })
    expect(ids(store.waiting())).toEqual([proposal.id])
    store.plans.answerRequest(proposal.id, { kind: 'approved', at: new Date().toISOString() })
    expect(store.waiting()).toEqual([])
  })
})
