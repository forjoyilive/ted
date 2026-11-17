import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { systemClock } from '../src/clock.ts'
import { RequestError } from '../src/errors.ts'
import { type Gh, GhError } from '../src/github/gh.ts'
import { type NewStageEntry, openStore, type TedStore } from '../src/store/index.ts'
import type { PullRequestRead, RemotePullRequest } from '../src/tasks/merge.ts'
import {
  createMergeWatcher,
  type MergePort,
  type MergeWork,
  mergeMode,
} from '../src/tasks/merge-watcher.ts'
import { resolveWorkflow } from '../src/workflow/resolve.ts'
import type { WorkflowResolution } from '../src/workflow/workflows.ts'
import { commitToOrigin, makeOriginRepo } from './helpers.ts'

let dir: string
let store: TedStore
let id: string
let now: number
let resolution: WorkflowResolution
let port: MergePort
let gh: Gh
let watcher: ReturnType<typeof createMergeWatcher>
const entry: NewStageEntry = {
  stageFile: { layer: 'ted', path: 'merge.md' },
  layers: [],
  order: [],
}
const head = 'signed-off'
const remote = (over: Partial<RemotePullRequest> = {}): RemotePullRequest => ({
  id: 'PR_7',
  title: 'Fix it',
  url: 'https://github.com/acme/widgets/pull/7',
  baseRefName: 'main',
  state: 'OPEN',
  isDraft: false,
  headRefOid: head,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  autoMerge: false,
  checks: [],
  threads: [],
  reviews: [],
  deployments: [],
  allowed: ['squash', 'merge', 'rebase'],
  autoMergeAllowed: false,
  deleteBranchOnMerge: false,
  ...over,
})
const read = (pr = remote(), name = 'widgets'): PullRequestRead => ({
  pulls: new Map([[`${id}:${name}`, pr]]),
  failed: new Map(),
  hostOf: new Map([[`${id}:${name}`, 'github.com']]),
})
const current = () => {
  const task = store.getTask(id)
  if (!task) throw new Error('missing Task')
  return task
}
const pr = () => current().repos[0]?.pullRequest
const ci = () => {
  store.branchPushed(id, 'widgets', { commit: head, ci: true, ciSignals: [] })
  store.pullRequestSignedOff(id, 'widgets', head)
  now = Date.now()
}

const pending = { name: 'test', state: 'pending' as const, required: false }
const passed = { ...pending, state: 'passed' as const }
const question = () => store.listComments(id).findLast((c) => c.kind === 'question')
const gate = () => {
  resolution.workflow.settings.stages.merge = { gate: true }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-merge-cycle-'))
  store = await openStore({ directory: dir })
  now = Date.now()
  resolution = { workflow: resolveWorkflow([]), layers: [] }
  resolution.workflow.stages = ['work', 'validate', 'review', 'merge']
  id = (await store.createTask({ title: 'Merge it' })).id
  store.startTask({
    taskId: id,
    stage: 'merge',
    branch: 'task',
    worktree: dir,
    entry,
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  store.branchPushed(id, 'widgets', { commit: head, ci: false, ciSignals: [] })
  store.pullRequestOpened(id, 'widgets', {
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
    base: 'main',
  })
  store.pullRequestMarkedReady(id, 'widgets')
  store.pullRequestSignedOff(id, 'widgets', head)
  gh = {
    run: vi.fn(async () => ''),
    api: vi.fn(async () => undefined),
    graphql: vi.fn(async () => undefined),
  }
  port = {
    find: () => current(),
    busy: () => false,
    untilFree: async () => {},
    holding: async (_, work) => work(),
    resolve: async () => resolution,
    targets: async (task) =>
      task.repos.flatMap((r): MergeWork[] =>
        r.pullRequest?.state !== 'merged' && r.pullRequest
          ? [
              {
                name: r.name,
                repo: r.repo,
                number: r.pullRequest.number,
                branch: r.branch,
                base: 'main',
                expectedHead: r.pullRequest.signedOff ?? '',
                hasCi: r.pushed?.ci ?? true,
                method: 'squash',
                url: '',
                worktree: dir,
              },
            ]
          : [],
      ),
    checks: vi.fn(async () => true),
    sendBack: vi.fn(async (_, findings, __, validate) => {
      store.postComment({ taskId: id, author: { kind: 'ted' }, body: findings })
      store.changeStage(id, validate ? 'validate' : 'work', entry)
      return 'done' as const
    }),
    finish: vi.fn(async () => {
      store.changeStage(id, 'done', entry)
      return 'done' as const
    }),
    postGate: vi.fn(async () => {}),
    recordPullRequests: vi.fn(),
    requireObligations: vi.fn(async () => {}),
    read: vi.fn(async () => undefined),
  }
  watcher = createMergeWatcher({
    store,
    gh,
    clock: { ...systemClock, now: () => now },
    ciStuckMs: { noChecks: 600_000, pending: 3_600_000 },
    port,
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('merges the signed-off head, records no-CI and deletes the branch', async () => {
  expect(await watcher.cycle(id, read())).toBe('done')
  expect(gh.run).toHaveBeenCalledWith([
    'pr',
    'merge',
    '7',
    '--repo',
    'acme/widgets',
    '--squash',
    '--match-head-commit',
    head,
  ])
  expect(gh.api).toHaveBeenCalledWith('repos/acme/widgets/git/refs/heads/task', {
    method: 'DELETE',
  })
  expect(pr()).toMatchObject({ state: 'merged', merged: { noCi: true } })
  expect(current().stage).toBe('done')
  expect(gh.graphql).not.toHaveBeenCalled()
})

test('waits for CI then merges when the poller reports success', async () => {
  ci()
  expect(await watcher.cycle(id, read(remote({ checks: [pending] })))).toBe('wait')
  expect(pr()?.waiting).toBe('ci')
  expect(gh.run).not.toHaveBeenCalled()
  expect(await watcher.cycle(id, read(remote({ checks: [passed] })))).toBe('done')
  expect(pr()?.merged?.noCi).toBe(false)
})

test('failed CI without an attempt identity sends back before any merge', async () => {
  ci()
  port.ciFailures = vi.fn(async () => {})
  await watcher.cycle(
    id,
    read(remote({ checks: [{ ...pending, required: true, state: 'failed' }] })),
  )
  expect(current().stage).toBe('work')
  expect(port.sendBack).toHaveBeenCalledWith(id, expect.stringContaining('CI failed'))
  expect(gh.run).not.toHaveBeenCalled()
})

test('failed CI with attempt identities is handed to diagnosis; acceptance merges only when GitHub allows', async () => {
  ci()
  const failed = { ...pending, required: true, state: 'failed' as const, identity: 'run-1:a:b' }
  const scoped = (over: Partial<RemotePullRequest> = {}) =>
    read(remote({ checks: [failed], checksComplete: true, ...over }))
  port.ciFailures = vi.fn(async () => {})
  port.ciBlocked = vi.fn(async () => {})
  expect(await watcher.cycle(id, scoped())).toBe('wait')
  expect(port.ciFailures).toHaveBeenCalledTimes(1)
  expect(port.sendBack).not.toHaveBeenCalled()
  expect(current().stage).toBe('merge')
  port.acceptedCi = () => new Set(['run-1:a:b'])
  expect(await watcher.cycle(id, scoped({ mergeStateStatus: 'BLOCKED' }))).toBe('wait')
  expect(pr()?.waiting).toBe('required-check')
  expect(port.ciBlocked).toHaveBeenCalledWith(id, expect.anything(), expect.anything(), [failed])
  expect(gh.run).not.toHaveBeenCalled()
  expect(await watcher.cycle(id, scoped({ mergeStateStatus: 'UNSTABLE' }))).toBe('done')
  expect(gh.run).toHaveBeenCalledTimes(1)
  expect(port.sendBack).not.toHaveBeenCalled()
})

test.each([
  ['draft', { isDraft: true }, true],
  ['changed head', { headRefOid: 'unapproved' }, true],
  ['conflict', { mergeable: 'CONFLICTING' }, false],
] as const)('%s sends back to the appropriate Stage', async (_, changes, validate) => {
  await watcher.cycle(id, read(remote(changes)))
  expect(current().stage).toBe(validate ? 'validate' : 'work')
  expect(gh.run).not.toHaveBeenCalled()
  const cause = vi.mocked(port.sendBack).mock.calls[0]?.[4]?.cause
  expect(cause).toBe(validate ? undefined : 'base-conflict')
})

test('a missing signed-off head goes back to Validate even without a read', async () => {
  store.pullRequestSignedOff(id, 'widgets', undefined)
  await watcher.cycle(id, undefined)
  expect(current().stage).toBe('validate')
  expect(port.sendBack).toHaveBeenCalledWith(
    id,
    expect.stringContaining('no signed-off commit'),
    undefined,
    true,
  )
})

test('missing reads or pull requests wait without merging', async () => {
  expect(await watcher.cycle(id, undefined)).toBe('wait')
  const missing = read()
  missing.pulls.clear()
  expect(await watcher.cycle(id, missing)).toBe('wait')
  expect(gh.run).not.toHaveBeenCalled()
})

test('read authentication errors set the sign-in wait and release the in-flight cycle; a good read clears it while obligations hold the merge, and the hold is logged once', async () => {
  const failed = read()
  failed.failed.set('github.com', new GhError('auth', 'sign in'))
  await expect(watcher.cycle(id, failed)).rejects.toThrow('sign in')
  expect(pr()?.waiting).toBe('sign-in')
  expect(watcher.inFlightCount()).toBe(0)
  await watcher.settled(id)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(port.requireObligations).mockRejectedValue(
    new RequestError(409, 'Unresolved failure cases hold this Task: abc'),
  )
  await expect(watcher.cycle(id, read())).rejects.toThrow('Unresolved')
  expect(pr()?.waiting).toBeUndefined()
  await expect(watcher.cycle(id, read())).rejects.toThrow('Unresolved')
  expect(log.mock.calls).toEqual([
    [expect.stringContaining('merge is waiting: Unresolved failure cases hold this Task: abc')],
  ])
  expect(gh.run).not.toHaveBeenCalled()
  vi.mocked(port.requireObligations).mockResolvedValue(undefined)
  expect(await watcher.cycle(id, read())).toBe('done')
  expect(pr()?.state).toBe('merged')
})

test('auto-merge uses an allowed method once and observes an external merge', async () => {
  const waiting = read(
    remote({
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'BLOCKED',
      autoMergeAllowed: true,
      allowed: ['merge'],
    }),
  )
  await watcher.cycle(id, waiting)
  await watcher.cycle(id, waiting)
  expect(pr()?.waiting).toBe('review')
  expect(pr()?.autoMerge).toBe('merge')
  expect(gh.run).toHaveBeenCalledTimes(1)
  expect(gh.run).toHaveBeenCalledWith(
    expect.arrayContaining(['--auto', '--merge', '--match-head-commit', head]),
  )
  await watcher.cycle(id, read(remote({ state: 'MERGED' })))
  expect(pr()?.merged).toMatchObject({ method: 'merge' })
})

test('the Merge Gate waits for CI, permits a missing review and never enables auto-merge', async () => {
  gate()
  ci()
  const waiting = {
    reviewDecision: 'REVIEW_REQUIRED',
    autoMergeAllowed: true,
    mergeStateStatus: 'BLOCKED',
  }
  await watcher.cycle(id, read(remote({ ...waiting, checks: [pending] })))
  expect(port.postGate).not.toHaveBeenCalled()
  await watcher.cycle(id, read(remote({ ...waiting, checks: [passed] })))
  expect(port.postGate).toHaveBeenCalledWith(current(), [
    expect.objectContaining({ target: expect.objectContaining({ name: 'widgets' }) }),
  ])
  expect(gh.run).not.toHaveBeenCalled()
})

test('a Task that enters Merge waits for the Task Lead’s advance: no merge, auto-merge or Merge Gate before it, the usual merge after it; a Task already at Merge merges as before', async () => {
  expect(mergeMode(store, current(), resolution.workflow)).toBe('merge')
  store.changeStage(id, 'merge', entry)
  gate()
  expect(mergeMode(store, current(), resolution.workflow)).toBe('lead')
  const waiting = { autoMergeAllowed: true, mergeStateStatus: 'BLOCKED' }
  expect(await watcher.cycle(id, read(remote({ ...waiting, checks: [pending] })))).toBe('wait')
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.postGate).not.toHaveBeenCalled()
  expect(gh.run).not.toHaveBeenCalled()
  expect(store.mergeHistory(id).started).toBe(false)

  store.mergeLeadAdvanced(id, 'lead')
  expect(mergeMode(store, current(), resolution.workflow)).toBe('gate')
  await watcher.cycle(id, read())
  expect(port.postGate).toHaveBeenCalledTimes(1)
  resolution.workflow.settings.stages.merge = {}
  expect(await watcher.cycle(id, read())).toBe('done')
  expect(pr()).toMatchObject({ state: 'merged' })
})

test('an approved Merge Gate merges', async () => {
  gate()
  const comment = store.postComment({
    taskId: id,
    author: { kind: 'ted' },
    kind: 'signoff',
    body: '',
    gate: { approveLabel: 'Merge' },
  })
  store.answerComment(comment.id, { kind: 'approved', at: new Date().toISOString() })
  expect(mergeMode(store, current(), resolution.workflow)).toBe('merge')
  await watcher.cycle(id, read())
  expect(current().stage).toBe('done')
})

test('changes requested prevents merging or a replacement Gate', async () => {
  gate()
  const comment = store.postComment({
    taskId: id,
    author: { kind: 'ted' },
    kind: 'signoff',
    body: '',
    gate: { approveLabel: 'Merge' },
  })
  store.answerComment(comment.id, {
    kind: 'changes-requested',
    text: 'Fix it',
    at: new Date().toISOString(),
  })
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(gh.run).not.toHaveBeenCalled()
  expect(port.postGate).not.toHaveBeenCalled()
})

test('Merge off observes external merges and does not finish while a pull request is open', async () => {
  resolution.workflow.stages = resolution.workflow.stages.filter((s) => s !== 'merge')
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(pr()?.waiting).toBe('merge')
  expect(await watcher.cycle(id, read(remote({ state: 'MERGED' })))).toBe('done')
  expect(pr()?.state).toBe('merged')
  expect(gh.run).not.toHaveBeenCalled()
})

test('legacy Done Tasks with open pull requests are observed without a second finish', async () => {
  store.changeStage(id, 'done', entry)
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(await watcher.cycle(id, read(remote({ state: 'MERGED' })))).toBe('done')
  expect(port.finish).not.toHaveBeenCalled()
})

test('a canceled merge retries disabling auto-merge, keeps watching and finishes when GitHub merges by hand', async () => {
  store.autoMergeEnabled(id, 'widgets', { method: 'squash', requested: 'squash' })
  store.mergeCanceled(id, 'comment')
  vi.mocked(gh.run).mockRejectedValueOnce(new Error('offline'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(pr()?.autoMerge).toBe('squash')
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(pr()?.autoMerge).toBeUndefined()
  expect(pr()?.waiting).toBeUndefined()
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(pr()?.waiting).toBeUndefined()
  expect(current().stage).toBe('merge')
  expect(gh.run).toHaveBeenLastCalledWith([
    'pr',
    'merge',
    '7',
    '--repo',
    'acme/widgets',
    '--disable-auto',
  ])
  expect(await watcher.cycle(id, read(remote({ state: 'MERGED' })))).toBe('done')
  expect(pr()).toMatchObject({ state: 'merged', merged: { noCi: false } })
  expect(port.finish).toHaveBeenCalled()
  expect(current().stage).toBe('done')
  expect(gh.api).toHaveBeenLastCalledWith('repos/acme/widgets/git/refs/heads/task', {
    method: 'DELETE',
  })
  expect(gh.run).toHaveBeenCalledTimes(2)
})

test('mode is checked again immediately before merging', async () => {
  port.beforeMerge = async () => {
    store.mergeCanceled(id, 'comment')
  }
  expect(await watcher.cycle(id, read())).toBe('busy')
  expect(gh.run).not.toHaveBeenCalled()
  expect(pr()?.state).toBe('ready')
})

test('busy and overlapping cycles do no work; settled waits for completion', async () => {
  port.busy = () => true
  expect(await watcher.cycle(id, read())).toBe('busy')
  port.busy = () => false
  let release = () => {}
  let reached = () => {}
  const atMerge = new Promise<void>((resolve) => {
    reached = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  port.beforeMerge = async () => {
    reached()
    await blocked
  }
  const cycle = watcher.cycle(id, read())
  await atMerge
  expect(watcher.inFlight(id)).toBe(true)
  expect(await watcher.cycle(id, read())).toBe('busy')
  const settled = watcher.settled(id)
  release()
  expect(await cycle).toBe('done')
  await settled
  expect(watcher.inFlightCount()).toBe(0)
})

test('no checks after ten minutes asks once, Keep waiting resets the clock, and Merge anyway merges', async () => {
  ci()
  now += 600_001
  const waiting = read()
  await watcher.cycle(id, waiting)
  const first = question()
  if (!first) throw new Error('no CI question')
  expect(first.choices).toEqual([
    'Send to Task Lead',
    'Keep waiting',
    'Merge anyway',
    'Merge, and don’t wait for CI on widgets again',
  ])
  await watcher.cycle(id, waiting)
  expect(store.listComments(id)).toHaveLength(1)
  store.answerComment(first.id, {
    kind: 'answered',
    choice: 'Keep waiting',
    at: new Date(now).toISOString(),
  })
  now += 3_599_999
  await watcher.cycle(id, waiting)
  expect(store.listComments(id)).toHaveLength(1)
  now += 2
  await watcher.cycle(id, waiting)
  const second = question()
  if (!second) throw new Error('no follow-up question')
  expect(second.id).not.toBe(first.id)
  store.answerComment(second.id, {
    kind: 'answered',
    choice: 'Merge anyway',
    at: new Date(now).toISOString(),
  })
  expect(await watcher.cycle(id, waiting)).toBe('done')
})

test('Merge and don’t wait again merges, and isn’t offered when the base requires a check', async () => {
  ci()
  now += 600_001
  await watcher.cycle(id, read())
  const asked = question()
  if (!asked) throw new Error('no CI question')
  store.answerComment(asked.id, {
    kind: 'answered',
    choice: 'Merge, and don’t wait for CI on widgets again',
    at: new Date(now).toISOString(),
  })
  expect(await watcher.cycle(id, read())).toBe('done')
})

test('a base that requires a check never offers Merge and don’t wait again', async () => {
  ci()
  store.branchPushed(id, 'widgets', { commit: head, ci: true, ciSignals: ['required-checks'] })
  store.pullRequestSignedOff(id, 'widgets', head)
  now += 600_001
  await watcher.cycle(id, read())
  expect(question()?.choices).toEqual(['Send to Task Lead', 'Keep waiting', 'Merge anyway'])
})

test('CI stuck is noticed while review is missing and is withdrawn when CI reports', async () => {
  ci()
  now += 600_001
  await watcher.cycle(id, read(remote({ reviewDecision: 'REVIEW_REQUIRED' })))
  expect(question()).toBeDefined()
  await watcher.cycle(id, read(remote({ checks: [passed] })))
  expect(question()?.answer).toMatchObject({ kind: 'withdrawn', ciReported: true })
})

test('required pending CI never offers Merge anyway and stays unmergeable', async () => {
  ci()
  now += 3_600_001
  const waiting = read(remote({ checks: [{ ...pending, required: true }] }))
  await watcher.cycle(id, waiting)
  expect(question()?.choices).toEqual(['Send to Task Lead', 'Keep waiting'])
  expect(gh.run).not.toHaveBeenCalled()
})

test('a rebase command conflict sends back without adopting an unverified head', async () => {
  vi.mocked(gh.graphql).mockRejectedValueOnce(new Error('conflict'))
  await watcher.cycle(id, read(remote({ mergeStateStatus: 'BEHIND' })))
  expect(current().stage).toBe('work')
  expect(port.sendBack).toHaveBeenCalledWith(
    id,
    expect.stringContaining('conflicts with main'),
    undefined,
    false,
    { cause: 'base-conflict' },
  )
  expect(gh.run).not.toHaveBeenCalled()
})

test('a requested rebase is remembered and a previously recorded rebase reruns Checks', async () => {
  vi.mocked(gh.graphql).mockResolvedValue({
    data: { updatePullRequestBranch: { pullRequest: { headRefOid: 'rebased' } } },
  })
  const behind = read(remote({ mergeStateStatus: 'BEHIND' }))
  await watcher.cycle(id, behind)
  await watcher.cycle(id, behind)
  expect(gh.graphql).toHaveBeenCalledTimes(1)
  expect(pr()?.waiting).toBe('ci')
  store.branchRebased(id, 'widgets', { commit: 'rebased', onto: 'main' })
  vi.mocked(port.checks).mockClear()
  vi.mocked(port.checks).mockResolvedValue(false)
  expect(await watcher.cycle(id, read(remote({ headRefOid: 'rebased' })))).toBe('wait')
  expect(port.checks).toHaveBeenCalledTimes(1)
  expect(gh.run).not.toHaveBeenCalled()
})

const secondRepo = () => {
  store.worktreeCreated(id, {
    name: 'api',
    repo: 'acme/api',
    branch: 'task-api',
    worktree: dir,
    copied: [],
    skipped: [],
  })
  store.branchPushed(id, 'api', { commit: head, ci: false, ciSignals: [] })
  store.pullRequestOpened(id, 'api', {
    number: 8,
    url: 'https://github.com/acme/api/pull/8',
    base: 'main',
  })
  store.pullRequestMarkedReady(id, 'api')
  store.pullRequestSignedOff(id, 'api', head)
}
const both = (other = remote()) => {
  const reads = read()
  reads.pulls.set(`${id}:api`, other)
  return reads
}

test('all repos must be ready before any merge, and multi-repo never enables auto-merge', async () => {
  secondRepo()
  const waiting = both(remote({ reviewDecision: 'REVIEW_REQUIRED', autoMergeAllowed: true }))
  expect(await watcher.cycle(id, waiting)).toBe('wait')
  expect(gh.run).not.toHaveBeenCalled()
  expect(await watcher.cycle(id, both())).toBe('done')
  expect(vi.mocked(gh.run).mock.calls.map(([args]) => args[2])).toEqual(['7', '8'])
})

test('a later repo failure sends back before the first ready repo merges', async () => {
  secondRepo()
  await watcher.cycle(id, both(remote({ headRefOid: 'changed' })))
  expect(current().stage).toBe('validate')
  expect(gh.run).not.toHaveBeenCalled()
})

test('a failure partway rereads through the poller before sending back the unmerged repos', async () => {
  secondRepo()
  vi.mocked(gh.run).mockResolvedValueOnce('').mockRejectedValueOnce(new Error('merge refused'))
  await watcher.cycle(id, both())
  expect(port.read).toHaveBeenCalledTimes(1)
  expect(pr()?.state).toBe('merged')
  expect(current().repos[1]?.pullRequest?.state).toBe('ready')
  expect(port.sendBack).toHaveBeenCalledWith(id, expect.stringContaining('merge refused'))
})

test('a failed merge command that actually merged is recorded from the poller read', async () => {
  vi.mocked(gh.run).mockRejectedValueOnce(new Error('connection dropped'))
  vi.mocked(port.read).mockResolvedValue(read(remote({ state: 'MERGED' })))
  expect(await watcher.cycle(id, read())).toBe('done')
  expect(pr()?.state).toBe('merged')
  expect(port.sendBack).not.toHaveBeenCalled()
})

test('a Gate disables existing auto-merge before asking for sign-off', async () => {
  gate()
  store.autoMergeEnabled(id, 'widgets', { method: 'squash', requested: 'squash' })
  await watcher.cycle(id, read())
  expect(gh.run).toHaveBeenCalledWith(expect.arrayContaining(['--disable-auto']))
  expect(pr()?.autoMerge).toBeUndefined()
  expect(port.postGate).toHaveBeenCalledTimes(1)
})

test('overnight records its skipped Gate and does not restore it when overnight ends', async () => {
  resolution.workflow.overnightGates = ['merge']
  await watcher.cycle(id, undefined)
  expect(store.overnightGateHistory(id, 'merge', '').skipped).toBe(true)
  gate()
  delete resolution.workflow.overnightGates
  expect(mergeMode(store, current(), resolution.workflow)).toBe('merge')
})

test('an already posted Gate remains active overnight and forced unseen Gates stay closed', async () => {
  resolution.workflow.overnightGates = ['merge']
  store.postComment({
    taskId: id,
    author: { kind: 'ted' },
    kind: 'signoff',
    body: '',
    gate: { approveLabel: 'Merge' },
  })
  expect(mergeMode(store, current(), resolution.workflow)).toBe('gate')
  resolution.workflow.overnightKept = { reason: 'unreadable', stages: ['merge'], unseen: true }
  expect(mergeMode(store, current(), resolution.workflow)).toBe('gate')
})

test('mutation authentication failure waits for sign-in without claiming a merge, and the next cycle merges', async () => {
  vi.mocked(gh.run).mockRejectedValueOnce(new GhError('auth', 'sign in'))
  await expect(watcher.cycle(id, read())).rejects.toThrow('sign in')
  expect(pr()?.waiting).toBe('sign-in')
  expect(port.read).not.toHaveBeenCalled()
  expect(pr()?.state).toBe('ready')
  expect(await watcher.cycle(id, read())).toBe('done')
  expect(pr()?.state).toBe('merged')
})

test.each(['pure', 'extra commit', 'file mode', 'local commit'] as const)(
  'a real GitHub rebase is adopted only with the signed-off tree: %s',
  async (variant) => {
    const origin = await makeOriginRepo(dir)
    const work = path.join(dir, 'task')
    const github = path.join(dir, 'github')
    const exec = promisify(execFile)
    const git = async (cwd: string, ...args: string[]) =>
      (
        await exec('git', args, {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
          },
        })
      ).stdout.trim()
    await git(dir, 'clone', '-q', origin, work)
    await git(work, 'checkout', '-qb', 'task')
    await writeFile(path.join(work, 'feature.txt'), 'feature\n')
    await git(work, 'add', 'feature.txt')
    await git(work, 'commit', '-qm', 'feature')
    const signed = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', '-q', origin, 'task')
    store.branchPushed(id, 'widgets', { commit: signed, ci: false, ciSignals: [] })
    store.pullRequestSignedOff(id, 'widgets', signed)
    await commitToOrigin(dir, { 'base.txt': 'base moved\n' })
    await git(dir, 'clone', '-q', origin, github)
    await git(github, 'checkout', '-q', 'task')
    await git(github, 'rebase', 'main')
    if (variant === 'extra commit') {
      await writeFile(path.join(github, 'unapproved.txt'), 'extra\n')
      await git(github, 'add', 'unapproved.txt')
      await git(github, 'commit', '-qm', 'unapproved')
    }
    if (variant === 'file mode') {
      await git(github, 'update-index', '--chmod=+x', 'feature.txt')
      await git(github, 'commit', '-qm', 'mode')
    }
    if (variant === 'local commit') {
      await writeFile(path.join(work, 'local.txt'), 'local\n')
      await git(work, 'add', 'local.txt')
      await git(work, 'commit', '-qm', 'local')
    }
    const rebased = await git(github, 'rev-parse', 'HEAD')
    await git(github, 'push', '-q', '--force', origin, 'task')
    const targets = port.targets
    port.targets = async (task, resolved) =>
      (await targets(task, resolved)).map((target) => ({ ...target, url: origin, worktree: work }))
    watcher = createMergeWatcher({
      store,
      gh,
      clock: systemClock,
      ciStuckMs: { noChecks: 600_000, pending: 3_600_000 },
      port,
    })
    vi.mocked(gh.graphql).mockResolvedValue({
      data: { updatePullRequestBranch: { pullRequest: { headRefOid: rebased } } },
    })
    await watcher.cycle(id, read(remote({ headRefOid: signed, mergeStateStatus: 'BEHIND' })))
    vi.mocked(port.checks).mockResolvedValue(false)
    vi.mocked(port.requireObligations).mockRejectedValue(new Error('old consent is stale'))
    const result = await watcher.cycle(id, read(remote({ headRefOid: rebased })))
    if (variant === 'pure') {
      expect(result).toBe('busy')
      expect(await git(work, 'rev-parse', 'HEAD')).toBe(rebased)
      expect(store.latestRebase(id, '')).toBeDefined()
      expect(pr()?.signedOff).toBe(rebased)
      expect(await watcher.cycle(id, read(remote({ headRefOid: rebased })))).toBe('wait')
    } else {
      expect(result).toBe('done')
      expect(current().stage).toBe('validate')
      expect(store.latestRebase(id, '')).toBeUndefined()
      expect(await git(work, 'rev-parse', 'HEAD')).not.toBe(rebased)
    }
    expect(gh.run).not.toHaveBeenCalled()
  },
)

test('a historical passing post-rebase run cannot bypass the current Check determination', async () => {
  store.branchRebased(id, 'widgets', { commit: head, onto: 'main' })
  const previous = store.startChecks({ taskId: id, trigger: 'merge', stage: 'merge', checks: [] })
  store.finishChecks(previous.id, 'passed')
  vi.mocked(port.checks).mockResolvedValue(false)
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.checks).toHaveBeenCalledTimes(1)
  expect(gh.run).not.toHaveBeenCalled()
  expect(port.postGate).not.toHaveBeenCalled()
})

test('all repos wait for current local Check obligations before the first merge', async () => {
  secondRepo()
  store.branchRebased(id, 'widgets', { commit: head, onto: 'main' })
  vi.mocked(port.checks).mockResolvedValue(false)
  await watcher.cycle(id, both())
  await watcher.cycle(id, both())
  expect(gh.run).not.toHaveBeenCalled()
  vi.mocked(port.checks).mockResolvedValue(true)
  expect(await watcher.cycle(id, both())).toBe('done')
  expect(vi.mocked(gh.run).mock.calls.map(([args]) => args[2])).toEqual(['7', '8'])
})

test('post-rebase Check decisions hold the Merge Gate and cannot override cancellation or Merge off', async () => {
  gate()
  store.branchRebased(id, 'widgets', { commit: head, onto: 'main' })
  vi.mocked(port.checks).mockResolvedValue(false)
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.postGate).not.toHaveBeenCalled()
  vi.mocked(port.checks).mockResolvedValue(true)
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.postGate).toHaveBeenCalledTimes(1)
  expect(gh.run).not.toHaveBeenCalled()
  vi.mocked(port.checks).mockClear()
  store.mergeCanceled(id, 'human-cancellation')
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.checks).not.toHaveBeenCalled()
  resolution.workflow.stages = ['work', 'validate', 'review']
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.checks).not.toHaveBeenCalled()
  expect(gh.run).not.toHaveBeenCalled()
})

test('cancelling while local Check coverage settles prevents posting a Merge sign-off', async () => {
  gate()
  vi.mocked(port.checks).mockImplementation(async () => {
    store.mergeCanceled(id, 'human-cancellation')
    return true
  })
  expect(await watcher.cycle(id, read())).toBe('busy')
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.postGate).not.toHaveBeenCalled()
  expect(gh.run).not.toHaveBeenCalled()
})

test('pending requests hold merging while incorporated repair Checks can be verified', async () => {
  port.held = () => true
  expect(await watcher.cycle(id, read())).toBe('wait')
  expect(port.checks).toHaveBeenCalledTimes(1)
  expect(gh.run).not.toHaveBeenCalled()
  expect(port.postGate).not.toHaveBeenCalled()
  port.held = () => false
  expect(await watcher.cycle(id, read())).toBe('done')
})

test('a pull request merged outside TED finishes the Task before any other merge step, even while held', async () => {
  port.held = () => true
  gate()
  ci()
  expect(await watcher.cycle(id, read(), { onlyMergedOutside: true })).toBe('wait')
  expect(port.checks).not.toHaveBeenCalled()
  expect(port.recordPullRequests).not.toHaveBeenCalled()
  vi.mocked(port.checks).mockResolvedValue(false)
  expect(
    await watcher.cycle(id, read(remote({ state: 'MERGED', headRefOid: 'other' })), {
      onlyMergedOutside: true,
    }),
  ).toBe('done')
  expect(pr()).toMatchObject({ state: 'merged', merged: { noCi: false } })
  expect(current().stage).toBe('done')
  expect(gh.api).toHaveBeenCalledWith('repos/acme/widgets/git/refs/heads/task', {
    method: 'DELETE',
  })
  expect(port.checks).not.toHaveBeenCalled()
  expect(port.sendBack).not.toHaveBeenCalled()
  expect(port.postGate).not.toHaveBeenCalled()
  expect(gh.run).not.toHaveBeenCalled()
})

test('a multi-repo Task merged only partly outside TED takes the usual path, and finishes once every pull request is recorded as merged', async () => {
  secondRepo()
  port.held = () => true
  expect(
    await watcher.cycle(id, both(remote({ state: 'MERGED' })), { onlyMergedOutside: true }),
  ).toBe('wait')
  expect(pr()?.state).toBe('ready')
  const failed = both(remote({ state: 'MERGED' }))
  failed.hostOf.set(`${id}:api`, 'ghe.example')
  failed.failed.set('ghe.example', new Error('host down'))
  expect(await watcher.cycle(id, failed, { onlyMergedOutside: true })).toBe('wait')
  expect(
    await watcher.cycle(id, both(remote({ state: 'MERGED' })), { onlyMergedOutside: false }),
  ).toBe('wait')
  expect(current().stage).toBe('merge')
  expect(gh.run).not.toHaveBeenCalled()
  store.pullRequestMerged(id, 'widgets', { noCi: false, byTed: false })
  store.pullRequestMerged(id, 'api', { noCi: false, byTed: false })
  expect(await watcher.cycle(id, undefined, { onlyMergedOutside: true })).toBe('done')
  expect(current().stage).toBe('done')
})
