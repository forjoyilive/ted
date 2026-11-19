import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, expectTypeOf, test } from 'vitest'
import { openStore, type TedStore } from '../src/store/index.ts'
import type { TrackersArea } from '../src/store/trackers.ts'
import type { TrackerConnector, TrackerItem } from '../src/tasks/tracker-sync/connector.ts'
import { createTrackerConsent } from '../src/tasks/tracker-sync/consent.ts'
import { trackerRecords } from '../src/tasks/tracker-sync/records.ts'
import { createTrackerSync, type TrackerSync } from '../src/tasks/tracker-sync/sync.ts'
import { ManualClock } from './support/manual-clock.ts'

expectTypeOf<TedStore>().toExtend<TrackersArea>()

interface FakeItem {
  closed: boolean
  state: string
  group: string
}

const everyMs = 60_000
const itemUrl = (id: string) => `https://tracker.test/items/${id}`

let dir: string
let store: TedStore
let factoryId: string
let items: Map<string, FakeItem>
let links: { item: string; url: string }[]
let reads: number
let archived: { taskId: string; why: string }[]
let live: Set<string>
let syncs: TrackerSync[]
let jobs: Promise<void>[]
let clock: ManualClock

const connector: TrackerConnector<string, string> = {
  id: 'fake',
  name: 'Fake',
  groupNoun: 'board',
  enabled: () => true,
  source: (url) => url.match(/^https:\/\/tracker\.test\/items\/(\w+)$/)?.[1],
  key: (id) => id,
  label: (id) => `F-${id}`,
  async read(ids) {
    reads++
    const found = new Map<string, TrackerItem<string>>()
    for (const id of ids) {
      const item = items.get(id)
      if (item) found.set(id, { ...item, group: { key: item.group, name: item.group }, handle: id })
    }
    return { items: found }
  },
  steps: ['started', 'done'],
  async advance({ task, merged, step }) {
    if (merged) return { step: 'done', moved: 'Done' }
    if (step === undefined && task.stage !== 'backlog') return { step: 'started', moved: 'Doing' }
    return undefined
  },
  async link(item, { url }) {
    links.push({ item: item.handle, url })
  },
  texts: {
    closedTitle: (label, state) => `${label} was marked ${state} in Fake`,
    closedBody: (label, state) => `Someone marked ${label} ${state} in Fake.`,
    childArchived: (child, label, state) => `${child} was archived: ${label} is ${state} in Fake.`,
    groupTitle: (group, factory) => `Sync ${group.name} with Fake in ${factory}?`,
    groupBody: ({ label }) => `An Automation made a Task from ${label}.`,
  },
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-tracker-sync-'))
  store = await openStore({ directory: dir })
  factoryId = store.addFactory({
    key: 'NB',
    name: 'Notebooks',
    repo: 'acme/notes',
    cloneUrl: path.join(dir, 'notes.git'),
    defaultBranch: 'main',
  }).id
  items = new Map()
  links = []
  reads = 0
  archived = []
  live = new Set()
  syncs = []
  jobs = []
  clock = new ManualClock()
})

afterEach(async () => {
  for (const sync of syncs) sync.close()
  await Promise.all(jobs)
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

const records = () => trackerRecords<string>(store, 'fake')
const consent = () => createTrackerConsent(store, connector, records())
const openRequests = (taskId: string) => store.listOpenRequests().filter((c) => c.taskId === taskId)

function startSync(): void {
  syncs.push(
    createTrackerSync({
      store,
      connector,
      records: records(),
      clock,
      everyMs,
      actions: {
        gone: () => false,
        liveRun: (task) => live.has(task.id),
        openRequests,
        archive(task, why) {
          archived.push({ taskId: task.id, why })
          store.archiveTask(task.id)
        },
        under: (taskId) =>
          store
            .childrenOf(taskId)
            .flatMap((id) => store.getTask(id) ?? [])
            .filter((t) => !t.archived),
      },
      inBackground(_what, work) {
        jobs.push(work())
      },
    }),
  )
}

async function cycle(): Promise<void> {
  const before = jobs.length
  clock.advance(everyMs)
  await Promise.all(jobs.slice(before))
}

async function trackedTask(id: string, item: FakeItem): Promise<Task> {
  items.set(id, item)
  return store.createTask({ title: `Item ${id}`, factoryId, source: { url: itemUrl(id) } })
}

function startWithPullRequest(task: Task): void {
  store.startTask({
    taskId: task.id,
    stage: 'work',
    branch: `task-${task.displayId}`,
    worktree: dir,
    entry: { layers: [], order: [{ stage: 'work', enabled: true }] },
    repo: { name: 'notes', repo: 'acme/notes', copied: [], skipped: [] },
  })
  store.pullRequestOpened(task.id, 'notes', {
    number: 7,
    url: 'https://github.com/acme/notes/pull/7',
    base: 'main',
  })
}

test('a Task waits until it is allowed, then moves forward and links each pull request once, across a reopened store', async () => {
  const task = await trackedTask('1', { closed: false, state: 'Open', group: 'B1' })
  startWithPullRequest(task)
  startSync()
  await cycle()
  expect(reads).toBe(1)
  expect(records().record(task.id)).toMatchObject({ seen: { closed: false, state: 'Open' } })
  expect(records().syncState(store.getTask(task.id) as Task)).toBe('ask')
  expect(links).toEqual([])
  expect(records().record(task.id).step).toBeUndefined()

  consent().allowTask(store.getTask(task.id) as Task)
  expect(records().syncState(store.getTask(task.id) as Task)).toBe('on')
  await cycle()
  expect(links).toEqual([{ item: '1', url: 'https://github.com/acme/notes/pull/7' }])
  expect(records().record(task.id)).toMatchObject({ step: 'started' })
  await cycle()
  expect(links).toHaveLength(1)

  for (const sync of syncs.splice(0)) sync.close()
  await Promise.all(jobs)
  await store.close()
  store = await openStore({ directory: dir })
  expect([...records().record(task.id).linked]).toEqual(['https://github.com/acme/notes/pull/7'])
  expect(records().syncState(store.getTask(task.id) as Task)).toBe('on')
  startSync()
  await cycle()
  expect(links).toHaveLength(1)
})

test('the group question asks once, Allow turns on the group’s waiting Tasks, and Not now stops further questions', async () => {
  const first = await trackedTask('1', { closed: false, state: 'Open', group: 'B1' })
  const second = await trackedTask('2', { closed: false, state: 'Open', group: 'B1' })
  startSync()
  await cycle()
  const ask = consent()
  ask.askGroup(first.id, 'Nightly triage', { key: 'B1', name: 'Board one' })
  ask.askGroup(second.id, 'Nightly triage', { key: 'B1', name: 'Board one' })
  const questions = store.listOpenRequests().filter((c) => ask.asks(c))
  expect(questions).toHaveLength(1)
  expect(questions[0]).toMatchObject({
    taskId: first.id,
    title: 'Sync Board one with Fake in Notebooks?',
    choices: ['Allow', 'Not now'],
    purpose: { kind: 'tracker-group', tracker: 'fake', group: { key: 'B1' } },
  })

  const question = questions[0]
  if (!question) throw new Error('no group question')
  ask.answerGroup(store.getTask(first.id) as Task, question, 'Allow', '')
  expect(store.settings().trackerSyncGroups).toEqual({ fake: { [factoryId]: ['B1'] } })
  expect(store.getComment(question.id)?.answer).toMatchObject({ kind: 'answered', choice: 'Allow' })
  for (const task of [first, second]) {
    expect(records().syncState(store.getTask(task.id) as Task)).toBe('on')
  }

  const third = await trackedTask('3', { closed: false, state: 'Open', group: 'B2' })
  await cycle()
  ask.askGroup(third.id, 'Nightly triage', { key: 'B2', name: 'Board two' })
  const declined = store.listOpenRequests().find((c) => ask.asks(c))
  if (!declined) throw new Error('no group question for B2')
  ask.answerGroup(store.getTask(third.id) as Task, declined, 'Not now', '')
  expect(store.settings().trackerSyncDeclined).toEqual({ fake: { [factoryId]: ['B2'] } })
  ask.askGroup(third.id, 'Nightly triage', { key: 'B2', name: 'Board two' })
  expect(store.listOpenRequests().filter((c) => ask.asks(c))).toEqual([])
  expect(records().syncState(store.getTask(third.id) as Task)).toBe('ask')
})

test('an item closed outside Ted archives an idle Task with nothing under it, asks for a working one or a parent, and withdraws the question on reopen or finish', async () => {
  const baseline = await trackedTask('1', { closed: true, state: 'Done', group: 'B1' })
  const idle = await trackedTask('2', { closed: false, state: 'Open', group: 'B1' })
  const working = await trackedTask('3', { closed: false, state: 'Open', group: 'B1' })
  const parent = await trackedTask('4', { closed: false, state: 'Open', group: 'B1' })
  store.setTaskParent(idle.id, parent.id)
  store.setTaskParent(working.id, parent.id)
  for (const task of [baseline, idle, working, parent]) consent().allowTask(task)
  live.add(working.id)
  startSync()
  await cycle()
  expect(archived).toEqual([])

  items.set('2', { closed: true, state: 'Done', group: 'B1' })
  items.set('3', { closed: true, state: 'Done', group: 'B1' })
  await cycle()
  expect(archived).toEqual([{ taskId: idle.id, why: 'F-2 was marked Done in Fake' }])
  expect(store.getTask(baseline.id)?.archived).toBeFalsy()
  expect(store.getTask(parent.id)?.archived).toBeFalsy()
  expect(openRequests(parent.id)).toEqual([])
  expect(
    store
      .listComments(parent.id)
      .filter((c) => c.kind === 'note')
      .map((c) => [c.author.kind, c.body]),
  ).toEqual([['ted', `${idle.displayId} was archived: F-2 is Done in Fake.`]])
  const asked = openRequests(working.id)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({
    title: 'F-3 was marked Done in Fake',
    choices: ['Archive', 'Keep going'],
    purpose: { kind: 'tracker-closed', tracker: 'fake' },
  })
  await cycle()
  expect(openRequests(working.id)).toHaveLength(1)

  items.set('4', { closed: true, state: 'Done', group: 'B1' })
  await cycle()
  expect(archived).toHaveLength(1)
  const parentAsked = openRequests(parent.id)
  expect(parentAsked).toHaveLength(1)
  expect(parentAsked[0]?.body).toContain(
    `Archive also archives the Task under it: ${working.displayId} Item 3.`,
  )

  items.set('3', { closed: false, state: 'Open', group: 'B1' })
  await cycle()
  expect(openRequests(working.id)).toEqual([])
  expect(store.getComment(asked[0]?.id ?? '')?.answer).toMatchObject({
    kind: 'withdrawn',
    tracker: 'reopened',
  })

  items.set('3', { closed: true, state: 'Done', group: 'B1' })
  await cycle()
  const again = openRequests(working.id)
  expect(again).toHaveLength(1)
  store.changeStage(working.id, 'done')
  await cycle()
  expect(openRequests(working.id)).toEqual([])
  expect(store.getComment(again[0]?.id ?? '')?.answer).toMatchObject({
    kind: 'withdrawn',
    tracker: 'done',
  })
})
