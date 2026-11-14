import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type AsanaSyncFacts, asanaSyncOf, type Comment, type Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { AsanaReadError } from '../src/asana/asana.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import {
  type AsanaSync,
  type AsanaSyncApi,
  asanaComment,
  createAsanaSync,
  mentions,
} from '../src/tasks/asana-sync.ts'
import { ManualClock } from './support/manual-clock.ts'

interface FakeTask {
  completed: boolean
  subtasks: string[]
  stories: string[]
  projects?: string[]
}

const everyMs = 60_000
const prUrl = (n: number) => `https://github.com/acme/notes/pull/${n}`

let dir: string
let store: TedStore
let factoryId: string
let asana: Map<string, FakeTask>
let account: string | undefined
let writes: { kind: 'comment' | 'complete'; gid: string; text?: string }[]
let reads: string[]
let failNext: { kind: 'comment' | 'complete'; error: Error; applied: boolean } | undefined
let held: Map<string, Promise<void>>
let syncs: AsanaSync[]
let jobs: Promise<void>[]
let clock: ManualClock
let archived: string[]
let live: Set<string>

const api: AsanaSyncApi = {
  async account() {
    return account
  },
  async read(route) {
    reads.push(route)
    await held.get(route)
    const [, , gid = '', list] = route.split('/')
    const task = asana.get(gid)
    if (!task) throw new AsanaReadError('not found', 404)
    if (list === 'subtasks')
      return {
        data: task.subtasks.map((child) => ({ completed: asana.get(child)?.completed === true })),
        next_page: null,
      }
    if (list === 'stories')
      return {
        data: [
          { type: 'system', text: 'changed the due date' },
          ...task.stories.map((text) => ({ type: 'comment', text })),
        ],
        next_page: null,
      }
    return {
      data: {
        completed: task.completed,
        num_subtasks: task.subtasks.length,
        ...(task.projects && { memberships: task.projects.map((gid) => ({ project: { gid } })) }),
      },
    }
  },
  async comment(gid, text, writer) {
    if (writer !== account) throw new AsanaReadError('another account')
    const failing = failNext?.kind === 'comment' ? failNext : undefined
    if (failing) failNext = undefined
    if (failing && !failing.applied) throw failing.error
    writes.push({ kind: 'comment', gid, text })
    asana.get(gid)?.stories.push(text)
    if (failing) throw failing.error
  },
  async complete(gid, writer) {
    if (writer !== account) throw new AsanaReadError('another account')
    const failing = failNext?.kind === 'complete' ? failNext : undefined
    if (failing) failNext = undefined
    if (failing && !failing.applied) throw failing.error
    writes.push({ kind: 'complete', gid })
    const task = asana.get(gid)
    if (task) task.completed = true
    if (failing) throw failing.error
  },
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-asana-sync-'))
  store = await openStore({ directory: dir })
  factoryId = store.addFactory({
    key: 'NB',
    name: 'Notebooks',
    repo: 'acme/notes',
    cloneUrl: path.join(dir, 'notes.git'),
    defaultBranch: 'main',
  }).id
  asana = new Map()
  account = '100'
  writes = []
  reads = []
  failNext = undefined
  held = new Map()
  syncs = []
  jobs = []
  clock = new ManualClock()
  archived = []
  live = new Set()
})

afterEach(async () => {
  for (const sync of syncs) sync.close()
  await Promise.all(jobs)
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

function startSync(requestsPerCycle?: number): void {
  syncs.push(
    createAsanaSync({
      store,
      asana: api,
      clock,
      everyMs,
      ...(requestsPerCycle !== undefined && { requestsPerCycle }),
      actions: {
        gone: () => false,
        liveRun: (task) => live.has(task.id),
        openRequests: (taskId) => store.listOpenRequests().filter((c) => c.taskId === taskId),
        archive(task) {
          archived.push(task.id)
          store.archiveTask(task.id)
        },
        under: (taskId) => store.childrenOf(taskId).flatMap((id) => store.getTask(id) ?? []),
      },
      inBackground(_what, work) {
        jobs.push(work())
      },
    }),
  )
}

async function cycle(ms = everyMs): Promise<void> {
  await Promise.all(jobs)
  const before = jobs.length
  clock.advance(ms)
  await Promise.all(jobs.slice(before))
}

interface Planned {
  gid: string
  completed?: boolean
  subtasks?: string[]
  syncAccount?: string
  parent?: string
  projects?: string[]
  automation?: boolean
}

function imported(...planned: Planned[]): Map<string, Task> {
  for (const item of planned) {
    if (!asana.has(item.gid))
      asana.set(item.gid, {
        completed: item.completed === true,
        subtasks: item.subtasks ?? [],
        stories: [],
        ...(item.projects && { projects: item.projects }),
      })
  }
  return store.createTaskTree({
    factoryId,
    tasks: planned.map((item) => ({
      key: item.gid,
      ...(item.parent !== undefined && { parent: { key: item.parent } }),
      title: `Item ${item.gid}`,
      description: '',
      priority: 'none',
      startRequested: false,
      attachments: [],
      sourceUrl: `https://app.asana.com/0/0/${item.gid}`,
      asana: {
        gid: item.gid,
        title: `Item ${item.gid}`,
        completed: item.completed === true,
        importedAt: new Date().toISOString(),
        context: '',
        children: [],
      },
      ...(item.syncAccount !== undefined && { syncAccount: item.syncAccount }),
      ...(item.projects && { projects: item.projects }),
      ...(item.automation && { automation: { automationId: 'auto-1', firingId: 'fire-1' } }),
    })),
    links: [],
    comments: [],
  }).created
}

function withPullRequest(task: Task, number: number): void {
  store.startTask({
    taskId: task.id,
    stage: 'work',
    branch: `task-${task.displayId}`,
    worktree: dir,
    entry: { layers: [], order: [{ stage: 'work', enabled: true }] },
    repo: { name: 'notes', repo: 'acme/notes', copied: [], skipped: [] },
  })
  store.pullRequestOpened(task.id, 'notes', { number, url: prUrl(number), base: 'main' })
}

function merge(task: Task): void {
  store.pullRequestMerged(task.id, 'notes', { noCi: true, byTed: true })
  store.changeStage(task.id, 'done')
}

const sync = (task: Task) => store.getTask(task.id)?.asanaSync

test('the Task Sync state follows permission, the switch, the connection and what TED did', () => {
  const base: AsanaSyncFacts = {
    allowed: true,
    allowedAccount: '100',
    switchOn: true,
    connection: { known: true, account: '100' },
    archivedUnmerged: false,
    completeInAsana: false,
    merged: false,
    linked: 1,
  }
  expect(asanaSyncOf(base)).toEqual({ state: 'waiting-merge', linked: 1 })
  expect(asanaSyncOf({ ...base, allowed: false, switchOn: false }).state).toBe('not-allowed')
  expect(asanaSyncOf({ ...base, switchOn: false }).state).toBe('off')
  expect(asanaSyncOf({ ...base, connection: { known: true } }).state).toBe('disconnected')
  expect(asanaSyncOf({ ...base, connection: { known: true, account: '200' } }).state).toBe(
    'other-account',
  )
  expect(asanaSyncOf({ ...base, connection: { known: false } }).state).toBe('waiting-merge')
  expect(asanaSyncOf({ ...base, merged: true, openChildren: 2 })).toMatchObject({
    state: 'waiting-children',
    openChildren: 2,
  })
  expect(asanaSyncOf({ ...base, completedByTed: '2026-11-14T10:00:00.000Z' })).toMatchObject({
    state: 'completed-by-ted',
    completedAt: '2026-11-14T10:00:00.000Z',
  })
  expect(asanaSyncOf({ ...base, completeInAsana: true }).state).toBe('completed-in-asana')
  expect(asanaSyncOf({ ...base, archivedUnmerged: true }).state).toBe('archived')

  expect(mentions(`see ${prUrl(12)}`, prUrl(1))).toBe(false)
  expect(mentions(`see ${prUrl(1)}.`, prUrl(1))).toBe(true)
  expect(mentions(`${prUrl(1)}/files`, prUrl(1))).toBe(false)
  expect(mentions(`https://example.com/${prUrl(1)}`, prUrl(1))).toBe(false)
  expect(mentions(`(${prUrl(1)})`, prUrl(1))).toBe(true)
  expect(asanaComment('Fix checkout totals', { url: prUrl(7), title: 'acme/notes#7' })).toBe(
    `TED opened a pull request for this task: Fix checkout totals (acme/notes#7) ${prUrl(7)}`,
  )
  expect(
    asanaComment('x'.repeat(5000), { url: prUrl(7), title: 'acme/notes#7' }).length,
  ).toBeLessThan(2000)
})

test('only allowed Tasks are written to; each pull request is commented once across a lost reply and a restart; completion waits for merge and never touches items under it', async () => {
  const tree = imported(
    { gid: '501', subtasks: ['502'], syncAccount: '100' },
    { gid: '502', parent: '501', syncAccount: '100' },
    { gid: '503' },
  )
  const parent = tree.get('501') as Task
  const child = tree.get('502') as Task
  const waiting = tree.get('503') as Task
  withPullRequest(parent, 7)
  withPullRequest(waiting, 8)
  startSync()
  await cycle()
  expect(sync(waiting)).toMatchObject({ state: 'not-allowed' })
  expect(writes.filter((w) => w.gid === '503')).toEqual([])
  expect(writes).toEqual([
    {
      kind: 'comment',
      gid: '501',
      text: asanaComment('Item 501', { url: prUrl(7), title: 'acme/notes#7' }),
    },
  ])
  expect(sync(parent)).toMatchObject({ state: 'waiting-merge', linked: 1 })

  store.pullRequestOpened(parent.id, 'notes', { number: 9, url: prUrl(9), base: 'main' })
  failNext = { kind: 'comment', error: new AsanaReadError('reply lost'), applied: true }
  await cycle()
  expect(writes.filter((w) => w.kind === 'comment' && w.gid === '501')).toHaveLength(2)
  for (const s of syncs.splice(0)) s.close()
  await Promise.all(jobs)
  await store.close()
  store = await openStore({ directory: dir })
  startSync()
  await cycle()
  expect(writes.filter((w) => w.kind === 'comment' && w.gid === '501')).toHaveLength(2)
  expect(asana.get('501')?.stories).toHaveLength(2)
  expect(sync(parent)).toMatchObject({ linked: 2 })

  merge(parent)
  await cycle()
  expect(writes.filter((w) => w.kind === 'complete')).toEqual([])
  expect(sync(parent)).toMatchObject({ state: 'waiting-children', openChildren: 1 })
  expect(sync(child)?.state).toBe('waiting-merge')

  const childTask = asana.get('502')
  if (childTask) childTask.completed = true
  await cycle()
  expect(writes.filter((w) => w.kind === 'complete')).toEqual([{ kind: 'complete', gid: '501' }])
  expect(sync(parent)).toMatchObject({ state: 'completed-by-ted' })
  expect(store.getTask(child.id)?.archived).toBeFalsy()
  const readsBefore = reads.length
  await cycle()
  expect(writes.filter((w) => w.kind === 'complete')).toHaveLength(1)
  expect(reads.filter((r) => r === '/tasks/501').length).toBe(
    reads.slice(0, readsBefore).filter((r) => r === '/tasks/501').length,
  )
})

test('an item already complete gets its links but no completion, and a Task archived without merging gets nothing', async () => {
  const tree = imported(
    { gid: '601', completed: true, syncAccount: '100' },
    { gid: '602', syncAccount: '100' },
  )
  const done = tree.get('601') as Task
  const dropped = tree.get('602') as Task
  withPullRequest(done, 11)
  withPullRequest(dropped, 12)
  store.archiveTask(dropped.id)
  startSync()
  await cycle()
  merge(done)
  await cycle()
  expect(writes).toEqual([
    {
      kind: 'comment',
      gid: '601',
      text: asanaComment('Item 601', { url: prUrl(11), title: 'acme/notes#11' }),
    },
  ])
  expect(sync(done)?.state).toBe('completed-in-asana')
  expect(sync(dropped)?.state).toBe('archived')
  expect(archived).toEqual([])
})

test('completion in Asana archives an idle Task, asks for one with Tasks under it and names them, and withdraws on reopen', async () => {
  const tree = imported(
    { gid: '701', syncAccount: '100' },
    { gid: '702', syncAccount: '100', subtasks: ['703'] },
    { gid: '703', parent: '702', syncAccount: '100' },
    { gid: '704', completed: true, syncAccount: '100' },
  )
  startSync()
  await cycle()
  for (const gid of ['701', '702']) {
    const item = asana.get(gid)
    if (item) item.completed = true
  }
  await cycle()
  expect(archived).toEqual([tree.get('701')?.id])
  expect(store.getTask(tree.get('704')?.id ?? '')?.archived).toBeFalsy()
  const parent = tree.get('702') as Task
  const asked = store.listOpenRequests().filter((c) => c.taskId === parent.id)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({
    title: 'Its Asana task was marked complete',
    choices: ['Archive', 'Keep going'],
    purpose: { kind: 'tracker-closed', tracker: 'asana' },
  })
  expect(asked[0]?.body).toContain(
    `Archive also archives the Task under it: ${tree.get('703')?.displayId} Item 703.`,
  )
  const item = asana.get('702')
  if (item) item.completed = false
  await cycle()
  expect(store.listOpenRequests().filter((c) => c.taskId === parent.id)).toEqual([])
  expect(writes).toEqual([])
})

test('nothing is sent while Asana is disconnected or the switch is off; another account pauses the Task until it is allowed again; due work catches up', async () => {
  const task = imported({ gid: '801', syncAccount: '100' }).get('801') as Task
  withPullRequest(task, 21)
  account = undefined
  startSync()
  await cycle()
  expect(sync(task)?.state).toBe('disconnected')
  expect(writes).toEqual([])

  store.updateSettings({ asanaSync: false })
  account = '100'
  await cycle()
  expect(sync(task)?.state).toBe('off')
  expect(writes).toEqual([])

  account = '200'
  store.updateSettings({ asanaSync: true })
  await cycle()
  expect(sync(task)?.state).toBe('other-account')
  expect(writes).toEqual([])

  store.trackerSyncAllowed(task.id, 'asana', '801', '200')
  merge(task)
  await cycle()
  expect(writes.map((w) => w.kind)).toEqual(['complete', 'comment'])
  expect(sync(task)?.state).toBe('completed-by-ted')
})

test('a Retry-After answer stops the cycle for as long as Asana asks, and one cycle sends a bounded number of requests', async () => {
  const tasks = imported(
    ...Array.from({ length: 6 }, (_, i) => ({ gid: String(900 + i), syncAccount: '100' })),
  )
  let n = 30
  for (const task of tasks.values()) withPullRequest(task, n++)
  failNext = {
    kind: 'comment',
    error: new AsanaReadError('slow down', 429, 120_000),
    applied: false,
  }
  startSync(6)
  await cycle()
  expect(writes).toEqual([])
  await cycle()
  expect(writes).toEqual([])
  const before = reads.length
  await cycle()
  expect(reads.length - before + writes.length).toBeLessThanOrEqual(6)
  expect(writes.length).toBeGreaterThan(0)
  for (let i = 0; i < 6; i++) await cycle()
  expect(writes).toHaveLength(6)
})

test('turning Task Sync off while a read is in flight sends neither the completion nor the comment', async () => {
  const reached = async (route: string) => {
    while (!reads.includes(route)) await new Promise((resolve) => setImmediate(resolve))
  }
  const hold = (route: string) => {
    let release = () => {}
    held.set(
      route,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    return () => {
      held.delete(route)
      release()
    }
  }
  const tree = imported(
    { gid: '851', subtasks: ['852'], syncAccount: '100' },
    { gid: '852', completed: true },
  )
  const parent = tree.get('851') as Task
  withPullRequest(parent, 51)
  merge(parent)
  startSync()
  await Promise.all(jobs)
  let release = hold('/tasks/851/subtasks')
  clock.advance(everyMs)
  await reached('/tasks/851/subtasks')
  store.updateSettings({ asanaSync: false })
  release()
  await Promise.all(jobs)
  expect(writes).toEqual([])
  store.updateSettings({ asanaSync: true })
  await cycle()
  expect(writes.map((w) => [w.kind, w.gid])).toEqual([
    ['complete', '851'],
    ['comment', '851'],
  ])

  const later = imported({ gid: '861', syncAccount: '100' }).get('861') as Task
  withPullRequest(later, 61)
  release = hold('/tasks/861/stories')
  const before = jobs.length
  clock.advance(everyMs)
  await reached('/tasks/861/stories')
  store.updateSettings({ asanaSync: false })
  release()
  await Promise.all(jobs.slice(before))
  expect(writes.filter((w) => w.gid === '861')).toEqual([])
  expect(sync(later)).toMatchObject({ state: 'off', linked: 0 })
})

test('an allowed Asana project syncs its items, by each item’s own current projects and the account that allowed it', async () => {
  const tree = imported(
    { gid: '901', subtasks: ['902'], projects: ['70', '71'], automation: true },
    { gid: '902', parent: '901', projects: ['72'], automation: true },
    { gid: '903', projects: [], automation: true },
    { gid: '904', projects: ['70'], automation: true },
    { gid: '905', projects: ['73'], automation: true },
  )
  const [inProject, subtask, noProject, done, other] = ['901', '902', '903', '904', '905'].map(
    (gid) => tree.get(gid) as Task,
  )
  for (const [i, task] of [inProject, subtask, noProject, done, other].entries())
    withPullRequest(task as Task, 30 + i)
  merge(done as Task)
  startSync()
  const consent = (syncs[0] as AsanaSync).consent
  await cycle()
  expect(writes).toEqual([])

  consent.askGroups((inProject as Task).id, 'Intake', [
    { key: '70', name: 'Roadmap' },
    { key: '71', name: 'Bugs' },
  ])
  consent.askGroups((done as Task).id, 'Intake', [{ key: '70', name: 'Roadmap' }])
  consent.askGroups((noProject as Task).id, 'Intake', [])
  consent.askGroups((other as Task).id, 'Intake', [{ key: '73', name: 'Ops' }])
  const asks = store.listOpenRequests().filter((c) => c.purpose?.kind === 'tracker-group')
  expect(asks.map((c) => [c.taskId, c.purpose])).toEqual([
    [
      (inProject as Task).id,
      { kind: 'tracker-group', tracker: 'asana', group: { key: '70', name: 'Roadmap' } },
    ],
    [
      (other as Task).id,
      { kind: 'tracker-group', tracker: 'asana', group: { key: '73', name: 'Ops' } },
    ],
  ])
  expect(asks[0]?.title).toBe(
    'Sync Tasks from the Asana project Roadmap for Automations in Notebooks?',
  )
  expect(asks[0]?.body).not.toContain('Roadmap')

  consent.answerGroup(store.getTask((other as Task).id) as Task, asks[1] as Comment, 'Not now', '')
  expect(store.settings().trackerSyncDeclined.asana?.[factoryId]).toEqual(['73'])
  consent.answerGroup(
    store.getTask((inProject as Task).id) as Task,
    asks[0] as Comment,
    'Allow',
    '',
  )
  expect(store.settings().trackerSyncGroups.asana?.[factoryId]).toEqual(['70'])
  expect(store.settings().trackerSyncGroupAccounts.asana?.[factoryId]).toEqual({ '70': '100' })
  expect(store.listOpenRequests().filter((c) => c.purpose?.kind === 'tracker-group')).toEqual([])
  expect(sync(inProject as Task)?.state).toBe('waiting-merge')
  expect(sync(done as Task)?.state).toBe('waiting-merge')
  expect(sync(subtask as Task)?.state).toBe('not-allowed')
  expect(sync(noProject as Task)?.state).toBe('not-allowed')
  expect(sync(other as Task)?.state).toBe('not-allowed')

  await cycle()
  expect(writes.map((w) => [w.kind, w.gid]).sort()).toEqual([
    ['comment', '901'],
    ['comment', '904'],
    ['complete', '904'],
  ])

  const item = asana.get('901') as FakeTask
  item.projects = ['71']
  store.pullRequestOpened((inProject as Task).id, 'notes', {
    number: 40,
    url: prUrl(40),
    base: 'main',
  })
  await cycle()
  expect(sync(inProject as Task)?.state).toBe('not-allowed')
  expect(writes.filter((w) => w.gid === '901')).toHaveLength(1)
  item.projects = ['71', '70']
  await cycle()
  expect(writes.filter((w) => w.gid === '901')).toHaveLength(2)

  account = '200'
  store.pullRequestOpened((inProject as Task).id, 'notes', {
    number: 41,
    url: prUrl(41),
    base: 'main',
  })
  await cycle()
  expect(sync(inProject as Task)?.state).toBe('other-account')
  expect(writes.filter((w) => w.gid === '901')).toHaveLength(2)
  consent.allowGroup(factoryId, '70')
  expect(store.settings().trackerSyncGroupAccounts.asana?.[factoryId]).toEqual({ '70': '200' })
  await cycle()
  expect(writes.filter((w) => w.gid === '901')).toHaveLength(3)

  consent.forgetGroup(factoryId, '70', 'allowed')
  expect(store.settings().trackerSyncGroups.asana?.[factoryId]).toBeUndefined()
  expect(sync(inProject as Task)?.state).toBe('waiting-merge')
})

test('Asana project facts: another account’s project allowance doesn’t count, the Task’s own allowance still does', () => {
  const base: AsanaSyncFacts = {
    allowed: false,
    switchOn: true,
    connection: { known: true, account: '200' },
    archivedUnmerged: false,
    completeInAsana: false,
    merged: false,
    linked: 0,
  }
  expect(asanaSyncOf({ ...base, projectAccounts: ['100'] }).state).toBe('other-account')
  expect(asanaSyncOf({ ...base, projectAccounts: ['100', '200'] }).state).toBe('waiting-merge')
  expect(asanaSyncOf({ ...base, projectAccounts: [] }).state).toBe('not-allowed')
  expect(
    asanaSyncOf({ ...base, allowed: true, allowedAccount: '200', projectAccounts: ['100'] }).state,
  ).toBe('waiting-merge')
})
