import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type NewStageEntry, openStore, type TedStore } from '../src/store/index.ts'

let dir: string
let store: TedStore
let id: string
const initial = Date.parse('2026-11-01T12:00:00.000Z')
const entry: NewStageEntry = {
  stageFile: { layer: 'ted', path: 'work.md' },
  layers: [],
  order: [],
}
const fail = (
  runId: string,
  recovery: 'resume' | 'fresh' | 'failed' = 'resume',
  resumeFailed = false,
) => store.leadFailed({ taskId: id, runId, reason: 'exited with code 1', recovery, resumeFailed })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-history-'))
  store = await openStore({ directory: dir })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(initial)
  id = (await store.createTask({ title: 'History', clarifyDepth: 'few' })).id
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('Task first-start time survives later Stages, resume and reopening', async () => {
  const task = () => store.listTasks().find((task) => task.id === id)
  expect(task()?.startedAt).toBeUndefined()
  store.queueTask(id, 'intake')
  expect(task()?.startedAt).toBeUndefined()
  vi.setSystemTime(initial + 60_000)
  store.startTask({
    taskId: id,
    stage: 'intake',
    branch: 'task',
    worktree: dir,
    entry,
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  expect(task()?.startedAt).toBe('2026-11-01T12:01:00.000Z')
  vi.setSystemTime(initial + 120_000)
  store.changeStage(id, 'work', entry)
  store.stopTask(id, { runs: 0, why: 'human' })
  store.resumeTask(id, { waitForBlockers: false })
  expect(task()?.startedAt).toBe('2026-11-01T12:01:00.000Z')
  await store.close()
  store = await openStore({ directory: dir })
  expect(task()?.startedAt).toBe('2026-11-01T12:01:00.000Z')
})

test('merge history shares pending/canceled facts and isolates Stage visits', () => {
  store.startTask({
    taskId: id,
    stage: 'merge',
    branch: 'task',
    worktree: dir,
    entry,
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  store.pullRequestOpened(id, 'widgets', {
    number: 1,
    url: 'https://github.com/acme/widgets/pull/1',
    base: 'main',
  })
  expect(store.mergePending(id)).toBe(false)
  expect(store.mergeHistory(id)).toEqual({ started: false, awaitsLead: false })
  store.mergeStarted(id)
  expect(store.mergePending(id)).toBe(true)
  store.mergeCanceled(id, 'comment')
  expect(store.mergePending(id)).toBe(false)
  store.mergeStarted(id)
  expect(store.mergeHistory(id)).toEqual({
    started: true,
    latest: 'started',
    canceledAt: new Date().toISOString(),
    awaitsLead: false,
  })
  store.changeStage(id, 'work', entry)
  vi.setSystemTime(initial + 1000)
  store.changeStage(id, 'merge', entry)
  expect(store.mergeHistory(id)).toEqual({ started: false, awaitsLead: true })
})

test('rebases and edits respect inclusive timestamp boundaries and Task identity', async () => {
  const other = (await store.createTask({ title: 'Other' })).id
  expect(store.latestRebase(id, '')).toBeUndefined()
  expect(store.editedSince(id, '')).toBe(false)
  store.branchRebased(other, 'widgets', { commit: 'other', onto: 'base' })
  expect(store.latestRebase(id, '')).toBeUndefined()
  store.branchRebased(id, 'widgets', { commit: 'one', onto: 'base' })
  store.editTask(id, { title: 'New title' })
  const at = new Date().toISOString()
  expect(store.latestRebase(id, at)).toBe(at)
  expect(store.editedSince(id, at)).toBe(true)
  expect(store.latestRebase(id, '2099')).toBeUndefined()
  expect(store.editedSince(id, '2099')).toBe(false)
})

test('sign-off query selects the first recorded commit per repo after approval', () => {
  expect(store.signedOffCommit(id, 'widgets', '')).toBeUndefined()
  store.pullRequestSignedOff(id, 'widgets', undefined)
  store.pullRequestSignedOff(id, 'other', 'other')
  store.pullRequestSignedOff(id, 'widgets', 'first')
  store.pullRequestSignedOff(id, 'widgets', 'second')
  expect(store.signedOffCommit(id, 'widgets', '')).toBe('first')
  expect(store.signedOffCommit(id, 'other', '')).toBe('other')
  expect(store.signedOffCommit(id, 'widgets', '2099')).toBeUndefined()
})

test('human Clarify depth ignores agent changes and treats auto as unset', () => {
  expect(store.humanClarifyDepth(id)).toBe('few')
  store.setClarifyDepth(id, { depth: 'none', by: 'task-lead' })
  expect(store.humanClarifyDepth(id)).toBe('few')
  store.setClarifyDepth(id, { depth: 'grilling', by: 'human' })
  expect(store.humanClarifyDepth(id)).toBe('grilling')
  store.setClarifyDepth(id, { depth: 'auto', by: 'human' })
  expect(store.humanClarifyDepth(id)).toBeUndefined()
})

test('fresh Run requests use event order when timestamps match and preserve reasons', () => {
  expect(store.freshRunRequest(id)).toBeUndefined()
  store.resumeTask(id, { waitForBlockers: false })
  expect(store.freshRunRequest(id)).toEqual({ kind: 'resumed', pending: true })
  store.startRun({ id: 'run', agent: 'codex', prompt: 'Go', cwd: dir, taskId: id })
  expect(store.freshRunRequest(id)).toEqual({ kind: 'resumed', pending: false })
  fail('run', 'fresh', true)
  expect(store.freshRunRequest(id)).toMatchObject({
    kind: 'failure',
    pending: true,
    failure: { runId: 'run', resumeFailed: true },
  })
  store.retryTask(id, { waitForBlockers: false })
  expect(store.freshRunRequest(id)).toEqual({ kind: 'retried', pending: true })
  const notices = [{ key: 'ci', sig: 'failed', kind: 'ci', where: 'widgets' }]
  store.gitHubActivityQueued(id, notices)
  expect(store.freshRunRequest(id)).toEqual({ kind: 'github', pending: true, notices })
  store.requeueAfterBlockers(id)
  expect(store.freshRunRequest(id)).toEqual({ kind: 'blockers', pending: true })
  store.startAfterPlanning(id, 'work', entry)
  expect(store.freshRunRequest(id)).toEqual({ kind: 'planning', pending: true })
  store.archiveTask(id)
  store.unarchiveTask(id, { queue: false, waitForBlockers: false })
  expect(store.freshRunRequest(id)?.kind).toBe('planning')
  store.archiveTask(id)
  store.unarchiveTask(id, { queue: true, waitForBlockers: false })
  expect(store.freshRunRequest(id)).toEqual({ kind: 'unarchived', pending: true })
  store.resumeTask(id, { waitForBlockers: false, overnight: true })
  expect(store.freshRunRequest(id)).toEqual({ kind: 'overnight', pending: true })
})

test('failure history preserves resume failures for explanation but excludes them from the limit', () => {
  expect(store.failureHistory(id, initial)).toEqual({ recent: [], sinceFirst: [] })
  expect(store.latestLeadFailure(id)).toBeUndefined()
  expect(store.alreadyFailed(id, 'run', '')).toBe(false)
  fail('old')
  store.resumeTask(id, { waitForBlockers: false })
  fail('first')
  fail('first', 'fresh', true)
  expect(store.failureHistory(id, initial).recent.map((f) => f.runId)).toEqual(['first'])
  expect(store.failureHistory(id, initial).sinceFirst.map((f) => f.resumeFailed)).toEqual([
    false,
    true,
  ])
  expect(store.latestLeadFailure(id)).toMatchObject({
    runId: 'first',
    recovery: 'fresh',
    resumeFailed: true,
  })
  expect(store.alreadyFailed(id, 'first', new Date().toISOString())).toBe(true)
  expect(store.alreadyFailed(id, 'first', '2099')).toBe(false)
  expect(store.alreadyFailed(id, 'another', '')).toBe(false)
  expect(store.failureHistory(id, initial + 30 * 60_000).recent).toEqual([])
  store.retryTask(id, { waitForBlockers: false })
  expect(store.failureHistory(id, initial).recent).toEqual([])
})

test('nudge history is isolated by Run and Task', async () => {
  expect(store.latestNudge(id, 'one')).toBeUndefined()
  store.leadNudged(id, 'one')
  const first = new Date().toISOString()
  vi.setSystemTime(initial + 1000)
  store.leadNudged(id, 'two')
  const other = (await store.createTask({ title: 'Other' })).id
  store.leadNudged(other, 'one')
  expect(store.latestNudge(id, 'one')).toBe(first)
  expect(store.latestNudge(id, 'two')).toBe(new Date().toISOString())
})

test('Gate approval bindings select their commit and Task', async () => {
  const other = (await store.createTask({ title: 'Other' })).id
  expect(store.approvalsBoundToCommit(id, 'signed')).toEqual([])
  store.gateApprovalBound(other, 'other-task', 'widgets', 'signed')
  store.gateApprovalBound(id, 'review', 'widgets', 'signed')
  store.gateApprovalBound(id, 'merge', 'widgets', 'signed')
  store.gateApprovalBound(id, 'old', 'widgets', 'old-commit')
  expect(store.approvalsBoundToCommit(id, 'signed')).toEqual(['review', 'merge'])
})

test('Gate request commit selects the first record for the requested Comment and repo', () => {
  expect(store.gateRequestCommit(id, 'review', 'widgets')).toBeUndefined()
  store.gateRequestedFor(id, 'other', 'widgets', 'other-commit')
  store.gateRequestedFor(id, 'review', 'widgets', 'first')
  store.gateRequestedFor(id, 'review', 'api', 'api-commit')
  store.gateRequestedFor(id, 'review', 'widgets', 'second')
  expect(store.gateRequestCommit(id, 'review', 'widgets')).toBe('first')
  expect(store.gateRequestCommit(id, 'review', 'api')).toBe('api-commit')
  expect(store.gateRequestCommit(id, 'review', 'docs')).toBeUndefined()
})

test('Approved and chosen Merge commits are read per repo', () => {
  store.gateApprovalBound(id, 'approved', 'widgets', 'widgets-commit')
  expect(store.approvalBoundCommit(id, 'approved', 'widgets')).toBe('widgets-commit')
  expect(store.approvalBoundCommit(id, 'approved', 'api')).toBeUndefined()
  const since = new Date().toISOString()
  expect(store.chosenMergeCommit(id, 'widgets', since)).toBeUndefined()
  store.mergeCommitChosen(id, 'widgets', 'first')
  store.mergeCommitChosen(id, 'api', undefined)
  store.mergeCommitChosen(id, 'widgets', 'second')
  expect(store.chosenMergeCommit(id, 'widgets', since)).toBe('second')
  expect(store.chosenMergeCommit(id, 'api', since)).toBeNull()
  expect(store.chosenMergeCommit(id, 'widgets', '9999-01-01T00:00:00.000Z')).toBeUndefined()
})

test('Overnight Gate history respects Stage and inclusive visit boundaries', () => {
  const at = new Date().toISOString()
  expect(store.overnightGateHistory(id, 'merge', at)).toEqual({ kept: false, skipped: false })
  store.gateKeptOvernight(id, 'review', 'settings')
  store.gateSkippedOvernight(id, 'merge')
  expect(store.overnightGateHistory(id, 'merge', at)).toEqual({ kept: false, skipped: true })
  store.gateKeptOvernight(id, 'merge', 'unreadable')
  expect(store.overnightGateHistory(id, 'merge', at)).toEqual({ kept: true, skipped: true })
  expect(store.overnightGateHistory(id, 'merge', '2099')).toEqual({ kept: false, skipped: false })
})

test('Dashboard history keeps archived completions and reads first Intake and latest Done without Runs', async () => {
  const created = store.getTask(id)
  if (!created) throw new Error('missing Task')
  vi.setSystemTime(initial + 60_000)
  store.changeStage(id, 'intake', entry)
  vi.setSystemTime(initial + 120_000)
  store.changeStage(id, 'done', entry)
  store.archiveTask(id)
  vi.setSystemTime(initial + 180_000)
  const setup = await store.createTask({ title: 'Setup', setup: true })
  store.changeStage(setup.id, 'done', entry)
  vi.setSystemTime(initial + 240_000)
  const result = store.dashboard([created.factoryId], 'today', initial + 240_000)
  expect(result.current.taskIds).toEqual([id])
  expect(result.current.created.value).toBe(120_000)
  expect(result.current.intake.value).toBe(60_000)
  expect(result.tasks).toMatchObject([
    { id, archived: true, doneAt: new Date(initial + 120_000).toISOString() },
  ])
})

test('preparation intent and ready holds survive reopening and are consumed on Resume', async () => {
  store.queueTask(id, 'intake', { prepare: true })
  expect(store.getTask(id)?.preparation).toBe('preparing')
  store.stopTask(id, { runs: 0, why: 'human' })
  store.resumeTask(id, { waitForBlockers: false })
  expect(store.getTask(id)?.preparation).toBe('preparing')
  store.changeStage(id, 'work', entry, { prepare: true })
  expect(store.getTask(id)).toMatchObject({
    preparation: 'ready',
    stopped: true,
    status: { kind: 'stopped', prepared: true },
    activity: 'Ready for Work · Resume or turn on Autopilot.',
  })
  await store.close()
  store = await openStore({ directory: dir })
  expect(store.getTask(id)?.preparation).toBe('ready')
  store.archiveTask(id)
  store.unarchiveTask(id, { queue: true, waitForBlockers: false })
  expect(store.getTask(id)?.status).toMatchObject({ kind: 'stopped', prepared: true })
  expect(store.queue().some((entry) => entry.id === id)).toBe(false)
  store.resumeTask(id, { waitForBlockers: false })
  expect(store.getTask(id)?.preparation).toBeUndefined()
  expect(store.getTask(id)?.stopped).toBe(false)
  store.changeStage(id, 'work', entry)
  expect(store.getTask(id)?.stopped).toBe(false)
})

test('a reset keeps the Task, its Linear consent and its original request, and clears the thread', async () => {
  const blocker = await store.createTask({ title: 'Earlier' })
  const task = await store.createTask({
    title: 'From Linear',
    description: 'The original request',
    priority: 'high',
    clarifyDepth: 'few',
    blockedBy: [blocker.id],
    source: { url: 'https://linear.app/acme/issue/ACM-7/from-linear' },
  })
  const read = () => store.listTasks().find((t) => t.id === task.id)
  store.linearSyncAllowed(task.id, 'ACM-7')
  store.queueTask(task.id, 'intake', { cause: { cause: 'blockers-merged', blockers: ['NB-1'] } })
  const queued = store.taskLog(task.id).find((e) => e.name === 'v1.TaskQueued')
  expect(store.taskLog(task.id).find((e) => e.name === 'v1.TaskStartCause')).toMatchObject({
    at: queued?.at,
    data: { cause: 'blockers-merged', blockers: ['NB-1'] },
  })
  store.startTask({
    taskId: task.id,
    stage: 'intake',
    branch: 'task',
    worktree: dir,
    entry,
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  store.changeStage(task.id, 'clarify', entry)
  store.setClarifyDepth(task.id, { depth: 'grilling', by: 'task-lead' })
  store.editTask(task.id, { description: 'An edited request' })
  store.writeBrief({ taskId: task.id, text: '## Goal' })
  store.postComment({
    taskId: task.id,
    kind: 'question',
    author: { kind: 'ted' },
    body: 'Go on?',
    choices: ['Yes', 'No'],
  })
  expect(store.waiting().some((w) => 'taskId' in w && w.taskId === task.id)).toBe(true)
  const rank = read()?.rank

  store.resetTask(task.id)

  const check = () => {
    expect(read()).toMatchObject({
      id: task.id,
      displayId: task.displayId,
      title: 'From Linear',
      description: 'The original request',
      priority: 'high',
      clarifyDepth: 'few',
      stage: 'backlog',
      blockedBy: [blocker.id],
      linearSync: 'on',
      rank,
      repos: [],
      runs: [],
    })
    expect(read()?.startedAt).toBeUndefined()
    expect(read()?.branch).toBeUndefined()
    expect(store.listComments(task.id)).toEqual([])
    expect(store.latestBrief(task.id)).toBeUndefined()
    expect(store.descriptionVersions(task.id).map((v) => v.text)).toEqual(['The original request'])
    expect(store.waiting().some((w) => 'taskId' in w && w.taskId === task.id)).toBe(false)
    expect(
      store
        .taskLog(task.id)
        .map((e) => e.name)
        .filter((name) => !name.startsWith('v1.Linear')),
    ).toEqual(['v1.TaskReset'])
  }
  check()
  await store.close()
  store = await openStore({ directory: dir })
  check()
})

test('a moved Task keeps its thread, gets the new Factory’s ID and is still found by its old one', async () => {
  const notes = store.createFactory({
    key: 'NB',
    name: 'Notebook',
    repos: [],
    defaultBranch: 'main',
  })
  const web = store.createFactory({ key: 'WEB', name: 'Website', repos: [], defaultBranch: 'main' })
  store.factoryCloned(notes.id)
  store.factoryCloned(web.id)
  await store.createTask({ factoryId: web.id, title: 'Already there', clarifyDepth: 'few' })
  const blocker = await store.createTask({
    factoryId: notes.id,
    title: 'Blocker',
    clarifyDepth: 'few',
  })
  const task = await store.createTask({
    factoryId: notes.id,
    title: 'Offline editing',
    description: 'The original request',
    clarifyDepth: 'few',
    blockedBy: [blocker.id],
    source: { url: 'https://linear.app/acme/issue/ACM-8/offline' },
  })
  const child = await store.createTask({
    factoryId: notes.id,
    title: 'Local cache',
    clarifyDepth: 'few',
    parentId: task.id,
  })
  const read = (taskId: string) => store.listTasks().find((t) => t.id === taskId)
  store.linearSyncAllowed(task.id, 'ACM-8')
  store.queueTask(task.id, 'intake')
  store.startTask({
    taskId: task.id,
    stage: 'intake',
    branch: 'task',
    worktree: dir,
    entry,
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  store.editTask(task.id, { description: 'An edited request' })
  store.writeBrief({ taskId: task.id, text: '## Goal' })
  store.postComment({ taskId: task.id, kind: 'note', author: { kind: 'human' }, body: 'Keep me' })
  const question = store.postComment({
    taskId: task.id,
    kind: 'question',
    author: { kind: 'ted' },
    body: 'Go on?',
    choices: ['Yes', 'No'],
  })

  const moved = store.moveTask({
    moves: [
      { taskId: task.id, factoryId: web.id, started: true },
      { taskId: child.id, factoryId: web.id, started: false },
    ],
    unlink: [{ taskId: task.id, blockerId: blocker.id }],
    notes: [{ taskId: blocker.id, body: 'NB-2 moved to Website as WEB-2.' }],
    by: 'human',
  })

  expect(moved).toEqual([
    { id: task.id, from: 'NB-2', to: 'WEB-2' },
    { id: child.id, from: 'NB-3', to: 'WEB-3' },
  ])
  const check = () => {
    expect(read(task.id)).toMatchObject({
      factoryId: web.id,
      displayId: 'WEB-2',
      stage: 'backlog',
      repos: [],
    })
    expect(read(task.id)?.blockedBy ?? []).not.toContain(blocker.id)
    expect(read(task.id)?.linearSync).not.toBe('on')
    expect(read(child.id)).toMatchObject({ displayId: 'WEB-3', parentId: task.id })
    expect(store.getTask('NB-2')?.id).toBe(task.id)
    expect(store.getTask('WEB-2')?.id).toBe(task.id)
    expect(store.listComments(task.id).find((c) => c.body === 'Keep me')).toBeDefined()
    expect(store.listComments(task.id).find((c) => c.id === question.id)?.answer).toMatchObject({
      kind: 'withdrawn',
      movedToFactory: web.id,
    })
    expect(store.latestBrief(task.id)?.text).toBe('## Goal')
    expect(store.descriptionVersions(task.id).map((v) => v.text)).toEqual([
      'The original request',
      'An edited request',
    ])
    expect(store.listComments(blocker.id).map((c) => c.body)).toContain(
      'NB-2 moved to Website as WEB-2.',
    )
    expect(store.freshRunRequest(task.id)).toMatchObject({
      kind: 'moved',
      from: 'NB-2',
      pending: true,
    })
    expect(store.nextTaskNumber(notes.id)).toBe(4)
  }
  check()
  await store.close()
  store = await openStore({ directory: dir })
  check()
})
