import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { eventlogFile } from '../src/store/files.ts'
import { openStore, type TedStore } from '../src/store/index.ts'

let directory: string
let store: TedStore
let taskId: string
const epoch = Date.parse('2026-11-01T12:00:00.000Z')
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString()
const tick = (seconds: number) => vi.setSystemTime(epoch + seconds * 1000)

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ted-intervals-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  tick(0)
  store = await openStore({ directory })
  taskId = (await store.createTask({ title: 'Interval evidence' })).id
})

afterEach(async () => {
  await store.close()
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

test('unions overlapping requests and ends an unanswered request at a stop', () => {
  tick(1)
  const first = store.postComment({
    taskId,
    body: 'First?',
    kind: 'question',
    author: { kind: 'ted' },
  })
  tick(2)
  store.postComment({ taskId, body: 'Second?', kind: 'question', author: { kind: 'ted' } })
  tick(3)
  store.answerComment(first.id, { kind: 'answered', text: 'Yes', at: at(3) })
  tick(4)
  store.stopTask(taskId, { runs: 0, why: 'human' })
  tick(5)
  store.resumeTask(taskId, { waitForBlockers: false })
  tick(6)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'user-request')).toMatchObject([
    {
      start: at(1),
      end: at(4),
      contributors: [
        {
          id: first.id,
          start: at(1),
          end: at(3),
          startSource: 'CommentPosted',
          endSource: 'CommentAnswered',
        },
        { start: at(2), end: at(4), endSource: 'v1.TaskStopped' },
      ],
    },
  ])
  expect(history.intervals.filter((i) => i.reason === 'stopped')).toMatchObject([
    { start: at(4), end: at(5) },
  ])
})

test('overnight resume ends a preparation stop and begins its durable queue interval', () => {
  tick(1)
  store.stopTask(taskId, { runs: 0, why: 'prepared' })
  tick(2)
  store.resumeTask(taskId, { waitForBlockers: false, overnight: true })
  tick(3)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'stopped')).toMatchObject([
    {
      start: at(1),
      end: at(2),
      contributors: [{ endSource: 'v1.TaskResumedOvernight' }],
    },
  ])
  expect(history.intervals.filter((i) => i.reason === 'run-slot')).toMatchObject([
    {
      start: at(2),
      end: at(3),
      contributors: expect.arrayContaining([
        expect.objectContaining({ startSource: 'v1.TaskResumedOvernight' }),
      ]),
    },
  ])
})

test('unions observed working Runs without recording output batches as transitions', () => {
  tick(1)
  store.startRun({ id: 'lead', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(2)
  store.startRun({
    id: 'child',
    taskId,
    parentRunId: 'lead',
    agent: 'claude',
    prompt: '',
    cwd: directory,
  })
  tick(3)
  store.recordRunOutput('lead', { toOffset: 10, state: 'idle' })
  tick(4)
  store.recordRunOutput('child', { toOffset: 10, state: 'idle' })
  tick(5)
  expect(
    store.taskIntervalHistory(taskId).intervals.filter((i) => i.reason === 'run-working'),
  ).toMatchObject([
    {
      start: at(1),
      end: at(4),
      contributors: [
        {
          id: 'lead',
          start: at(1),
          end: at(3),
          startSource: 'v5.RunStarted',
          endSource: 'v1.RunStateChanged',
        },
        { id: 'child', start: at(2), end: at(4) },
      ],
    },
  ])
})

test('keeps queue holds, agent pauses and GitHub waits overlapping with independent boundaries', () => {
  store.setTaskLead(taskId, { agent: 'codex' })
  tick(1)
  store.queueTask(taskId, 'work')
  tick(2)
  store.holdWhenBusy({ loadRatio: 2 })
  tick(3)
  store.pauseAgent('codex', 'offline')
  tick(4)
  store.holdNewWork('disk full')
  tick(5)
  store.pauseAgent('codex', undefined)
  tick(6)
  store.dequeue(taskId)
  tick(7)
  const reasons = store.taskIntervalHistory(taskId).intervals
  expect(reasons.filter((i) => i.reason === 'run-slot')).toMatchObject([
    { start: at(1), end: at(6) },
  ])
  expect(reasons.filter((i) => i.reason === 'run-slot').flatMap((i) => i.contributors)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ startSource: 'v1.TaskQueued', endSource: 'v1.TaskDequeued' }),
    ]),
  )
  expect(reasons.filter((i) => i.reason === 'agent-paused')).toMatchObject([
    { start: at(3), end: at(5) },
  ])
})

test('keeps downtime and saved Run state unknown until host reconciliation', async () => {
  tick(1)
  store.startRun({ id: 'lead', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(4)
  await store.close()
  tick(10)
  store = await openStore({ directory })
  tick(12)
  store.reconcileRunState('lead')
  tick(13)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'run-working')).toMatchObject([
    { start: at(1), end: at(4) },
    { start: at(12), end: at(13), contributors: [{ startSource: 'v1.RunStateObserved' }] },
  ])
  expect(history.coverage).toContainEqual({
    reason: 'run-working',
    start: at(4),
    end: at(10),
    state: 'unknown',
    source: 'daemon-gap',
  })
  expect(history.coverage).toContainEqual({
    reason: 'run-working',
    start: at(10),
    end: at(12),
    state: 'unknown',
    source: 'unreconciled',
  })
})

test('retains blocker overlap while stopped and clips working at archive and Done boundaries', async () => {
  const blocker = (await store.createTask({ title: 'Prerequisite' })).id
  const entry = { layers: [], order: [] }
  tick(1)
  store.addBlocker(taskId, blocker)
  store.startRun({ id: 'lead', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(2)
  store.stopTask(taskId, { runs: 1, why: 'human' })
  tick(3)
  store.changeStage(blocker, 'done', entry)
  tick(4)
  store.archiveTask(taskId)
  tick(5)
  store.unarchiveTask(taskId, { queue: false, waitForBlockers: false })
  tick(6)
  store.startRun({ id: 'next', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(7)
  store.changeStage(taskId, 'done', entry)
  tick(8)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'blocker')).toMatchObject([
    { start: at(1), end: at(3) },
  ])
  expect(history.intervals.filter((i) => i.reason === 'stopped')).toMatchObject([
    { start: at(2), end: at(4) },
  ])
  expect(history.intervals.filter((i) => i.reason === 'run-working')).toMatchObject([
    { start: at(1), end: at(2) },
    { start: at(6), end: at(7) },
  ])
  expect(history.lifecycle).toEqual(
    expect.arrayContaining([
      { at: at(4), event: 'v2.TaskArchived' },
      { at: at(7), event: 'v1.TaskStageChanged' },
      { at: at(7), event: 'v4.TaskStageEntered' },
    ]),
  )
})

async function rebuildWithoutRecording(onlyShutdown = false) {
  const file = await eventlogFile(directory)
  if (!file) throw new Error('missing fixture event log')
  const db = new DatabaseSync(file)
  try {
    const condition = onlyShutdown
      ? "name = 'v1.IntervalObservationEnded'"
      : "name IN ('v1.IntervalObservationStarted', 'v1.IntervalObservationEnded', 'v1.TaskWaitObserved', 'v1.RunStateObserved')"
    db.exec(
      `UPDATE eventlog SET name = 'v1.MachineSettingsChanged', argsJson = json_object('changes', '{}', 'at', json_extract(argsJson, '$.at')) WHERE ${condition}`,
    )
  } finally {
    db.close()
  }
  for (const name of await readdir(path.join(directory, 'ted'))) {
    if (name.startsWith('state')) await rm(path.join(directory, 'ted', name), { force: true })
  }
}

test('an unexpected shutdown leaves the tail after the last meaningful observation unknown on replay', async () => {
  tick(1)
  store.startRun({ id: 'lead', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(3)
  store.pauseAgent('codex', 'offline')
  tick(4)
  await store.close()
  await rebuildWithoutRecording(true)
  tick(10)
  store = await openStore({ directory })
  tick(11)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'run-working')).toMatchObject([
    { start: at(1), end: at(3), contributors: [{ endSource: 'last-observation' }] },
  ])
  expect(history.coverage).toContainEqual({
    reason: 'run-working',
    start: at(3),
    end: at(10),
    state: 'unknown',
    source: 'daemon-gap',
  })
  expect(history.coverage).toContainEqual({
    reason: 'run-working',
    start: at(10),
    end: at(11),
    state: 'unknown',
    source: 'unreconciled',
  })
})

test('old homes preserve pauses established by durable queue and hold attribution', async () => {
  store.setTaskLead(taskId, { agent: 'codex' })
  tick(1)
  store.queueTask(taskId, 'work')
  tick(2)
  store.pauseAgent('codex', 'offline')
  tick(3)
  store.holdTaskRun({ taskId, agent: 'codex' })
  store.dequeue(taskId)
  tick(4)
  store.pauseAgent('codex', undefined)
  tick(5)
  store.releaseTaskRun(taskId)
  tick(6)
  await store.close()
  await rebuildWithoutRecording()
  tick(10)
  store = await openStore({ directory })
  tick(11)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'agent-paused')).toMatchObject([
    {
      start: at(2),
      end: at(4),
      contributors: [{ id: taskId, startSource: 'v1.AgentPaused', endSource: 'v1.AgentResumed' }],
    },
  ])
  expect(history.coverage).toContainEqual({
    reason: 'agent-paused',
    start: at(2),
    end: at(4),
    state: 'known',
    source: 'durable-history',
  })
  tick(12)
  await store.close()
  for (const name of await readdir(path.join(directory, 'ted')))
    if (name.startsWith('state')) await rm(path.join(directory, 'ted', name), { force: true })
  tick(15)
  store = await openStore({ directory })
  expect(store.taskIntervalHistory(taskId, at(11))).toEqual(history)
})

test('a paused Run ending during downtime has no known pause before host catch-up', async () => {
  tick(1)
  store.startRun({ id: 'ended-while-down', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(2)
  store.pauseAgent('codex', 'offline')
  tick(4)
  await store.close()
  await rebuildWithoutRecording(true)
  tick(10)
  store = await openStore({ directory })
  tick(11)
  const pending = store.taskIntervalHistory(taskId)
  expect(pending.intervals.filter((i) => i.reason === 'agent-paused')).toEqual([])
  expect(pending.coverage).toContainEqual({
    reason: 'agent-paused',
    start: at(10),
    end: at(11),
    state: 'unknown',
    source: 'unreconciled',
  })
  tick(12)
  store.recordRunOutput('ended-while-down', { toOffset: 1, state: 'finished' })
  tick(13)
  const caughtUp = store.taskIntervalHistory(taskId)
  expect(caughtUp.intervals.filter((i) => i.reason === 'agent-paused')).toEqual([])
  expect(caughtUp.coverage).toContainEqual({
    reason: 'agent-paused',
    start: at(10),
    end: at(12),
    state: 'unknown',
    source: 'unreconciled',
  })
  expect(caughtUp.coverage).toContainEqual({
    reason: 'agent-paused',
    start: at(12),
    end: at(13),
    state: 'known',
    source: 'observation',
  })
})

test('a live Run pause becomes known only after recovery reconciliation', async () => {
  tick(1)
  store.startRun({ id: 'still-live', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(2)
  store.pauseAgent('codex', 'offline')
  tick(3)
  await store.close()
  tick(10)
  store = await openStore({ directory })
  tick(12)
  store.reconcileRunState('still-live')
  tick(13)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'agent-paused')).toMatchObject([
    { start: at(2), end: at(3) },
    { start: at(12), end: at(13), contributors: [{ startSource: 'v1.RunStateObserved' }] },
  ])
  expect(history.coverage).toContainEqual({
    reason: 'agent-paused',
    start: at(10),
    end: at(12),
    state: 'unknown',
    source: 'unreconciled',
  })
})

test('old homes retain durable requests, stops and queues while missing Run observations stay unknown', async () => {
  store.setTaskLead(taskId, { agent: 'codex' })
  tick(1)
  const request = store.postComment({
    taskId,
    kind: 'question',
    body: 'Proceed?',
    author: { kind: 'ted' },
  })
  store.startRun({ id: 'old', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(2)
  store.recordRunOutput('old', { toOffset: 1, state: 'finished' })
  tick(3)
  store.answerComment(request.id, { kind: 'answered', text: 'Yes', at: at(3) })
  tick(4)
  store.stopTask(taskId, { runs: 0, why: 'human' })
  tick(5)
  store.resumeTask(taskId, { waitForBlockers: false })
  tick(6)
  await store.close()
  await rebuildWithoutRecording()
  tick(10)
  store = await openStore({ directory })
  tick(11)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'user-request')).toMatchObject([
    { start: at(1), end: at(3) },
  ])
  expect(history.intervals.filter((i) => i.reason === 'stopped')).toMatchObject([
    { start: at(4), end: at(5) },
  ])
  expect(history.intervals.filter((i) => i.reason === 'run-working')).toEqual([])
  expect(history.coverage).toContainEqual({
    reason: 'run-working',
    start: at(0),
    end: at(10),
    state: 'unknown',
    source: 'not-recorded',
  })
  expect(history.intervals.filter((i) => i.reason === 'run-slot')).toMatchObject([
    { start: at(5), end: at(11) },
  ])
  expect(history.coverage).toContainEqual({
    reason: 'run-slot',
    start: at(0),
    end: at(11),
    state: 'known',
    source: 'durable-history',
  })
  tick(12)
  await store.close()
  for (const name of await readdir(path.join(directory, 'ted')))
    if (name.startsWith('state')) await rm(path.join(directory, 'ted', name), { force: true })
  tick(15)
  store = await openStore({ directory })
  expect(store.taskIntervalHistory(taskId, at(11))).toEqual(history)
})

test('unions GitHub waits across repos and queues across the Task Lead and sub-agents', () => {
  store.startTask({
    taskId,
    stage: 'merge',
    branch: 'task',
    worktree: directory,
    entry: { layers: [], order: [] },
    repo: { name: 'one', repo: 'acme/one', copied: [], skipped: [] },
  })
  store.worktreeCreated(taskId, {
    name: 'two',
    repo: 'acme/two',
    branch: 'task',
    worktree: directory,
    copied: [],
    skipped: [],
  })
  for (const name of ['one', 'two'])
    store.pullRequestOpened(taskId, name, {
      number: 1,
      url: `https://github.com/acme/${name}/pull/1`,
      base: 'main',
    })
  tick(1)
  store.pullRequestWaiting(taskId, 'one', 'ci')
  store.queueTask(taskId, 'merge')
  tick(2)
  store.pullRequestWaiting(taskId, 'two', 'review')
  store.requestSubAgent({
    id: 'child',
    taskId,
    parentRunId: 'lead',
    name: 'Reviewer',
    agent: 'claude',
    prompt: '',
    ownWorktree: false,
  })
  tick(3)
  store.pullRequestWaiting(taskId, 'one', undefined)
  store.dequeue(taskId)
  store.holdWhenBusy({ loadRatio: 2 })
  tick(4)
  store.pullRequestWaiting(taskId, 'two', undefined)
  store.holdNewWork('disk full')
  tick(5)
  store.dropSubAgentRequest('child')
  tick(6)
  const history = store.taskIntervalHistory(taskId)
  expect(history.intervals.filter((i) => i.reason === 'github')).toMatchObject([
    {
      start: at(1),
      end: at(4),
      contributors: [
        {
          id: 'one',
          start: at(1),
          end: at(3),
          startSource: 'v1.PullRequestWaitChanged',
          detail: 'ci',
        },
        { id: 'two', start: at(2), end: at(4), detail: 'review' },
      ],
    },
  ])
  expect(history.intervals.filter((i) => i.reason === 'run-slot')).toMatchObject([
    { start: at(1), end: at(5) },
  ])
  expect(history.intervals.flatMap((i) => i.contributors)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'child', start: at(4), end: at(5), detail: 'disk full' }),
    ]),
  )
})

test('records an agent pause while a sub-agent is still queued', () => {
  tick(1)
  store.requestSubAgent({
    id: 'waiting-child',
    taskId,
    parentRunId: 'lead',
    name: 'Reviewer',
    agent: 'claude',
    prompt: '',
    ownWorktree: false,
  })
  tick(2)
  store.pauseAgent('claude', 'signed out')
  tick(4)
  store.pauseAgent('claude', undefined)
  tick(5)
  expect(
    store.taskIntervalHistory(taskId).intervals.filter((i) => i.reason === 'agent-paused'),
  ).toMatchObject([{ start: at(2), end: at(4), contributors: [{ id: 'waiting-child' }] }])
})

test('a blocker ends only when Done and its pull requests have merged', async () => {
  const blocker = (await store.createTask({ title: 'Prerequisite' })).id
  store.pullRequestOpened(blocker, 'one', {
    number: 1,
    url: 'https://github.com/acme/one/pull/1',
    base: 'main',
  })
  tick(1)
  store.addBlocker(taskId, blocker)
  tick(2)
  store.changeStage(blocker, 'done', { layers: [], order: [] })
  tick(3)
  store.pullRequestMerged(blocker, 'one', { noCi: false, byTed: true })
  tick(4)
  expect(
    store.taskIntervalHistory(taskId).intervals.filter((i) => i.reason === 'blocker'),
  ).toMatchObject([{ start: at(1), end: at(3) }])
})

test('unions overlapping agent pauses while retaining each Run’s boundaries', () => {
  tick(1)
  store.startRun({ id: 'lead', taskId, agent: 'codex', prompt: '', cwd: directory })
  tick(2)
  store.startRun({
    id: 'child',
    taskId,
    parentRunId: 'lead',
    agent: 'claude',
    prompt: '',
    cwd: directory,
  })
  tick(3)
  store.pauseAgent('codex', 'offline')
  tick(4)
  store.pauseAgent('claude', 'signed out')
  tick(5)
  store.pauseAgent('codex', undefined)
  tick(6)
  store.pauseAgent('claude', undefined)
  tick(7)
  expect(
    store.taskIntervalHistory(taskId).intervals.filter((i) => i.reason === 'agent-paused'),
  ).toMatchObject([
    {
      start: at(3),
      end: at(6),
      contributors: [
        { id: 'lead', start: at(3), end: at(5) },
        { id: 'child', start: at(4), end: at(6) },
      ],
    },
  ])
})

test('a historical query never projects observations into the future or before Task creation', () => {
  tick(1)
  store.startRun({ id: 'lead', taskId, agent: 'codex', prompt: '', cwd: directory })
  expect(() => store.taskIntervalHistory(taskId, at(10))).toThrow(/asOf/)
  expect(() => store.taskIntervalHistory(taskId, 'not a date')).toThrow(/asOf/)
  expect(store.taskIntervalHistory(taskId, new Date(epoch - 1000).toISOString())).toMatchObject({
    intervals: [],
    coverage: [],
    lifecycle: [],
  })
})

test('orders request creation and lifecycle boundaries even when their timestamps match', () => {
  tick(1)
  store.stopTask(taskId, { runs: 0, why: 'human' })
  const request = store.postComment({
    taskId,
    kind: 'question',
    body: 'Resume?',
    author: { kind: 'ted' },
  })
  tick(2)
  store.resumeTask(taskId, { waitForBlockers: false })
  tick(3)
  expect(
    store.taskIntervalHistory(taskId).intervals.filter((i) => i.reason === 'user-request'),
  ).toMatchObject([
    { start: at(1), end: at(3), contributors: [{ id: request.id, endSource: 'query' }] },
  ])
})

test('a restart writes no wait observation for a Task with nothing waiting', async () => {
  await store.createTask({ title: 'Also idle' })
  await store.persisted()
  await store.close()
  store = await openStore({ directory })
  await store.persisted()
  const file = await eventlogFile(directory)
  if (!file) throw new Error('missing event log')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM eventlog WHERE name = 'v1.TaskWaitObserved'")
      .get() as { count: number }
    expect(row.count).toBe(0)
  } finally {
    db.close()
  }
  expect(store.taskIntervalHistory(taskId).intervals).toEqual([])
})
