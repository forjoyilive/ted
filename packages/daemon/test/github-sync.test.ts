import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { GitHubIssueUrl, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from 'vitest'
import { GhError } from '../src/github/gh.ts'
import {
  type GitHubIssueSyncApi,
  gitHubIssueSyncApi,
  type IssueSyncState,
  issueKey,
} from '../src/github/issue-sync.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import type { TrackersArea } from '../src/store/trackers.ts'
import { createGitHubSync, fixedText, leftOpenNote, startedText } from '../src/tasks/github-sync.ts'
import { pullRequestBody, withIssueLine } from '../src/tasks/pull-requests.ts'
import type { TrackerSync } from '../src/tasks/tracker-sync/sync.ts'
import { ManualClock } from './support/manual-clock.ts'

expectTypeOf<TedStore>().toExtend<TrackersArea>()

interface FakeIssue {
  state: IssueSyncState
  comments: { author: string; body: string }[]
}

type Write =
  | { kind: 'comment'; issue: string; body: string }
  | { kind: 'close'; issue: string }
  | { kind: 'body'; pr: string; body: string }

const everyMs = 60_000
const viewer = 'octo'
const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`
const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`

let dir: string
let store: TedStore
let factoryId: string
let issues: Map<string, FakeIssue>
let bodies: Map<string, string>
let writes: Write[]
let reads: number
let lostReply: boolean
let incomplete: Set<string>
let duringBodyRead: { pr: string; run: () => void } | undefined
let archived: string[]
let live: Set<string>
let syncs: TrackerSync[]
let jobs: Promise<void>[]
let clock: ManualClock

const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`

const api: GitHubIssueSyncApi = {
  async states(list) {
    reads++
    const found = new Map<string, IssueSyncState>()
    for (const issue of list) {
      const fake = issues.get(issueKey(issue))
      if (fake) found.set(issueKey(issue), { ...fake.state })
    }
    return found
  },
  async comments(issue) {
    return {
      viewer,
      comments: [...(issues.get(issueKey(issue))?.comments ?? [])],
      complete: !incomplete.has(issueKey(issue)),
    }
  },
  async comment(issue, body) {
    writes.push({ kind: 'comment', issue: issueKey(issue), body })
    issues.get(issueKey(issue))?.comments.push({ author: viewer, body })
    if (lostReply) {
      lostReply = false
      throw new Error('reply lost')
    }
  },
  async close(issue) {
    writes.push({ kind: 'close', issue: issueKey(issue) })
    const fake = issues.get(issueKey(issue))
    if (fake) fake.state = { open: false, closedAs: 'completed', openSubIssues: 0 }
  },
  async pullRequestBody(pr) {
    const body = bodies.get(prKey(pr)) ?? ''
    if (duringBodyRead?.pr === prKey(pr)) {
      const { run } = duringBodyRead
      duringBodyRead = undefined
      run()
    }
    return body
  },
  async setPullRequestBody(pr, body) {
    writes.push({ kind: 'body', pr: prKey(pr), body })
    bodies.set(prKey(pr), body)
  },
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-github-sync-'))
  store = await openStore({ directory: dir })
  factoryId = store.addFactory({
    key: 'NB',
    name: 'Notebooks',
    repo: 'acme/notes',
    cloneUrl: path.join(dir, 'notes.git'),
    defaultBranch: 'main',
  }).id
  issues = new Map()
  bodies = new Map()
  writes = []
  reads = 0
  lostReply = false
  incomplete = new Set()
  duringBodyRead = undefined
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

function startSync(): void {
  syncs.push(
    createGitHubSync({
      store,
      github: api,
      clock,
      everyMs,
      actions: {
        gone: () => false,
        liveRun: (task) => live.has(task.id),
        openRequests: (taskId) => store.listOpenRequests().filter((c) => c.taskId === taskId),
        archive(task) {
          archived.push(task.id)
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

async function restart(): Promise<void> {
  for (const sync of syncs.splice(0)) sync.close()
  await Promise.all(jobs)
  await store.close()
  store = await openStore({ directory: dir })
  startSync()
}

async function cycle(): Promise<void> {
  await Promise.all(jobs)
  const before = jobs.length
  clock.advance(everyMs)
  await Promise.all(jobs.slice(before))
}

function syncOn(on: boolean): void {
  store.updateSettings({ githubIssueSync: on })
}

async function fromIssue(n: number, extra: Partial<IssueSyncState> = {}): Promise<Task> {
  issues.set(`acme/notes#${n}`, {
    state: { open: true, openSubIssues: 0, ...extra },
    comments: [{ author: 'someone', body: 'Please fix this.' }],
  })
  return store.createTask({
    title: `Issue ${n}`,
    factoryId,
    source: {
      url: issueUrl('acme/notes', n),
      github: {
        repo: 'acme/notes',
        number: n,
        title: `Issue ${n}`,
        state: 'open',
        locked: false,
        comments: 1,
        hiddenComments: 0,
        importedAt: new Date().toISOString(),
        context: '',
        outsiderText: false,
      },
    },
  })
}

function start(task: Task, stage: 'work' | 'clarify' = 'work'): void {
  store.startTask({
    taskId: task.id,
    stage,
    branch: `task-${task.displayId}`,
    worktree: dir,
    entry: { layers: [], order: [{ stage, enabled: true }] },
    repo: { name: 'notes', repo: 'acme/notes', copied: [], skipped: [] },
  })
}

function openPullRequest(task: Task, name: string, repo: string, n: number, body = 'Goal'): void {
  if (name !== 'notes') {
    store.worktreeCreated(task.id, {
      name,
      repo,
      branch: `task-${name}`,
      worktree: dir,
      copied: [],
      skipped: [],
    })
  }
  bodies.set(`${repo}#${n}`, body)
  store.pullRequestOpened(task.id, name, { number: n, url: prUrl(repo, n), base: 'main' })
}

function merge(task: Task, ...names: string[]): void {
  for (const name of names) store.pullRequestMerged(task.id, name, { noCi: true, byTed: true })
}

const done = (task: Task) => store.changeStage(task.id, 'done')
const commentsOn = (n: number) =>
  writes.flatMap((w) => (w.kind === 'comment' && w.issue === `acme/notes#${n}` ? [w.body] : []))
const openRequests = (task: Task) => store.listOpenRequests().filter((c) => c.taskId === task.id)

test('with the switch off nothing is read or written; with it on a one-repo Task’s issue is commented once at Work, linked, then commented and closed once it merges, across a lost reply and a restart', async () => {
  const task = await fromIssue(4)
  start(task)
  openPullRequest(task, 'notes', 'acme/notes', 7)
  startSync()
  await cycle()
  merge(task, 'notes')
  done(task)
  await cycle()
  expect(reads).toBe(0)
  expect(writes).toEqual([])

  const fresh = await fromIssue(5)
  start(fresh, 'clarify')
  syncOn(true)
  await cycle()
  expect(commentsOn(5)).toEqual([])

  store.changeStage(fresh.id, 'work')
  lostReply = true
  await cycle()
  expect(commentsOn(5)).toEqual([startedText])
  await restart()
  await cycle()
  expect(commentsOn(5)).toEqual([startedText])

  openPullRequest(fresh, 'notes', 'acme/notes', 8, 'Goal\n\n---\n\nOpened by Ted for NB-2.')
  duringBodyRead = { pr: 'acme/notes#8', run: () => syncOn(false) }
  await cycle()
  expect(writes.filter((w) => w.kind === 'body')).toEqual([])
  syncOn(true)
  await cycle()
  expect(bodies.get('acme/notes#8')).toBe(
    'Goal\n\n---\n\nOpened by Ted for NB-2.\n\nFixes acme/notes#5',
  )
  await cycle()
  expect(writes.filter((w) => w.kind === 'body')).toHaveLength(1)

  store.changeStage(fresh.id, 'validate')
  store.changeStage(fresh.id, 'work')
  await cycle()
  expect(commentsOn(5)).toEqual([startedText])

  merge(fresh, 'notes')
  syncOn(false)
  done(fresh)
  await cycle()
  expect(commentsOn(5)).toEqual([startedText])
  syncOn(true)
  lostReply = true
  await cycle()
  await restart()
  await cycle()
  await cycle()
  expect(commentsOn(5)).toEqual([startedText, fixedText([prUrl('acme/notes', 8)])])
  expect(writes.filter((w) => w.kind === 'close')).toEqual([
    { kind: 'close', issue: 'acme/notes#5' },
  ])
  expect(writes.some((w) => 'issue' in w && w.issue === 'acme/notes#4')).toBe(false)
  expect(store.getTask(task.id)?.archived).toBeFalsy()
  expect(openRequests(fresh)).toEqual([])
})

test('a two-repo Task says Part of in each pull request and leaves the issue open until both merge; a parent with an open sub-issue is left open with one note; a Task archived without merging gets nothing more', async () => {
  syncOn(true)
  const task = await fromIssue(10)
  start(task)
  openPullRequest(task, 'notes', 'acme/notes', 20)
  openPullRequest(task, 'api', 'acme/api', 21)
  const parent = await fromIssue(11, { openSubIssues: 2 })
  start(parent)
  openPullRequest(parent, 'notes', 'acme/notes', 22)
  const dropped = await fromIssue(12)
  start(dropped)
  const gainsSubIssue = await fromIssue(13)
  start(gainsSubIssue)
  openPullRequest(gainsSubIssue, 'notes', 'acme/notes', 23)
  const crowded = await fromIssue(14)
  start(crowded)
  incomplete.add('acme/notes#14')
  startSync()
  await cycle()
  expect(bodies.get('acme/notes#20')).toBe('Goal\n\nPart of acme/notes#10')
  expect(bodies.get('acme/api#21')).toBe('Goal\n\nPart of acme/notes#10')
  expect(bodies.get('acme/notes#22')).toBe('Goal\n\nPart of acme/notes#11')
  expect(bodies.get('acme/notes#23')).toBe('Goal\n\nFixes acme/notes#13')
  expect(commentsOn(12)).toEqual([startedText])
  expect(commentsOn(14)).toEqual([])

  const sub = issues.get('acme/notes#13')
  if (sub) sub.state = { open: true, openSubIssues: 1 }
  openPullRequest(dropped, 'notes', 'acme/notes', 24)
  duringBodyRead = { pr: 'acme/notes#24', run: () => store.archiveTask(dropped.id) }
  await cycle()
  await cycle()
  expect(bodies.get('acme/notes#24')).toBe('Goal')
  expect(bodies.get('acme/notes#23')).toBe('Goal\n\nPart of acme/notes#13')
  incomplete.delete('acme/notes#14')

  merge(task, 'notes')
  await cycle()
  expect(writes.filter((w) => w.kind === 'close')).toEqual([])
  merge(task, 'api')
  done(task)
  merge(parent, 'notes')
  done(parent)
  await cycle()
  await cycle()
  expect(commentsOn(10)).toEqual([
    startedText,
    fixedText([prUrl('acme/notes', 20), prUrl('acme/api', 21)]),
  ])
  expect(commentsOn(11)).toEqual([startedText, fixedText([prUrl('acme/notes', 22)])])
  expect(writes.filter((w) => w.kind === 'close')).toEqual([
    { kind: 'close', issue: 'acme/notes#10' },
  ])
  expect(
    store
      .listComments(parent.id)
      .filter((c) => c.kind === 'note')
      .map((c) => c.body),
  ).toEqual([leftOpenNote('acme/notes#11', 2)])
  expect(commentsOn(12)).toEqual([startedText])
  expect(commentsOn(14)).toEqual([startedText])
})

test('closing the issue on GitHub archives an unstarted Task and asks for a started one; a close by the Task’s own pull request doesn’t count, and reopening withdraws the question', async () => {
  syncOn(true)
  const unstarted = await fromIssue(30)
  const working = await fromIssue(31)
  start(working)
  live.add(working.id)
  const merging = await fromIssue(32)
  start(merging)
  openPullRequest(merging, 'notes', 'acme/notes', 40)
  startSync()
  await cycle()

  const closed = (closedAs: IssueSyncState['closedAs'], closedBy?: string): FakeIssue['state'] => ({
    open: false,
    ...(closedAs !== undefined && { closedAs }),
    ...(closedBy !== undefined && { closedBy }),
    openSubIssues: 0,
  })
  const set = (n: number, state: IssueSyncState) => {
    const fake = issues.get(`acme/notes#${n}`)
    if (fake) fake.state = state
  }
  set(30, closed('not planned'))
  set(31, closed('completed', prUrl('acme/other', 1)))
  set(32, closed('completed', prUrl('acme/notes', 40)))
  merge(merging, 'notes')
  store.changeStage(merging.id, 'merge')
  await cycle()
  expect(archived).toEqual([unstarted.id])
  expect(openRequests(merging)).toEqual([])
  const asked = openRequests(working)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({
    title: 'acme/notes#31 was closed as completed on GitHub',
    choices: ['Archive', 'Keep going'],
    purpose: { kind: 'tracker-closed', tracker: 'github' },
  })

  set(31, { open: true, openSubIssues: 0 })
  await cycle()
  expect(openRequests(working)).toEqual([])
  expect(store.getComment(asked[0]?.id ?? '')?.answer).toMatchObject({
    kind: 'withdrawn',
    tracker: 'reopened',
  })
  expect(writes.filter((w) => w.kind === 'close')).toEqual([])
})

describe('the pull request line', () => {
  test('Fixes for one repo, Part of for several, only when asked for, replacing an out-of-date line', () => {
    const task = { id: 't', displayId: 'NB-1', title: 'T', goal: 'Goal' }
    expect(pullRequestBody(task, [])).not.toMatch(/Fixes|Part of/)
    expect(pullRequestBody({ ...task, issue: () => undefined }, [])).not.toMatch(/Fixes|Part of/)
    expect(
      pullRequestBody({ ...task, issue: () => ({ ref: 'acme/notes#4', several: false }) }, []),
    ).toMatch(/\n\nFixes acme\/notes#4$/)
    expect(
      pullRequestBody({ ...task, issue: () => ({ ref: 'acme/notes#4', several: true }) }, []),
    ).toMatch(/\n\nPart of acme\/notes#4$/)
    const fixes = 'Goal\n\nFixes acme/notes#4'
    expect(withIssueLine(fixes, { ref: 'acme/notes#4', several: false })).toBe(fixes)
    expect(withIssueLine(fixes, { ref: 'ACME/notes#4', several: true })).toBe(
      'Goal\n\nPart of ACME/notes#4',
    )
    expect(
      withIssueLine('Goal\n\nFixes NOTEBOOK-1A', { ref: 'acme/notes#4', several: false }),
    ).toBe('Goal\n\nFixes NOTEBOOK-1A\n\nFixes acme/notes#4')
  })
})

describe('the gh calls', () => {
  interface Call {
    kind: 'graphql' | 'api'
    path?: string
    method?: string
    body?: unknown
    variables?: Record<string, unknown>
  }

  function fakeGh(answer: (call: Call) => unknown) {
    const calls: Call[] = []
    return {
      calls,
      gh: {
        async graphql(query: string, variables: Record<string, unknown> = {}) {
          const call: Call = { kind: 'graphql', variables, path: query }
          calls.push(call)
          return answer(call)
        },
        async api(p: string, options: { method?: string; body?: unknown } = {}) {
          const call: Call = {
            kind: 'api',
            path: p,
            method: options.method ?? 'GET',
            body: options.body,
          }
          calls.push(call)
          return answer(call)
        },
      },
    }
  }

  const issue = (n: number): GitHubIssueUrl => ({
    owner: 'acme',
    repo: 'notes',
    number: n,
    url: issueUrl('acme/notes', n),
  })

  test('states are read in batches, with the close reason, the closing pull request and open sub-issues; one unreadable issue doesn’t hide the rest', async () => {
    const raw = (n: number) =>
      n === 2
        ? {
            state: 'CLOSED',
            stateReason: 'NOT_PLANNED',
            subIssuesSummary: { total: 3, completed: 1 },
            timelineItems: {
              nodes: [{ closer: { __typename: 'PullRequest', url: prUrl('acme/notes', 9) } }],
            },
          }
        : { state: 'OPEN', subIssuesSummary: { total: 0, completed: 0 } }
    const { gh, calls } = fakeGh((call) => {
      const vars = call.variables ?? {}
      const numbers = Object.keys(vars)
        .filter((k) => k.startsWith('i'))
        .map((k) => vars[k] as number)
      if (numbers.length > 1 && numbers.includes(61)) throw new GhError('failed', 'one is missing')
      if (numbers.length === 1 && numbers[0] === 61)
        throw new GhError('failed', 'Could not resolve')
      return {
        data: Object.fromEntries(
          Object.keys(vars)
            .filter((k) => k.startsWith('i'))
            .map((k) => [`r${k.slice(1)}`, { issue: raw(vars[k] as number) }]),
        ),
      }
    })
    const list = Array.from({ length: 62 }, (_, i) => issue(i + 1))
    const states = await gitHubIssueSyncApi(gh).states(list)
    expect(states?.size).toBe(61)
    expect(states?.get('acme/notes#2')).toEqual({
      open: false,
      closedAs: 'not planned',
      closedBy: prUrl('acme/notes', 9),
      openSubIssues: 2,
    })
    expect(states?.get('acme/notes#1')).toEqual({ open: true, openSubIssues: 0 })
    expect(states?.has('acme/notes#61')).toBe(false)
    expect(calls.filter((c) => Object.keys(c.variables ?? {}).length > 3)).toHaveLength(2)

    const limited = fakeGh(() => {
      throw new GhError('rate-limit', 'limited')
    })
    expect(await gitHubIssueSyncApi(limited.gh).states([issue(1)])).toBeUndefined()
  })

  test('writes go only to the issue’s own fixed paths, as fixed JSON', async () => {
    const page = (older: boolean, nodes: unknown[]) => ({
      data: {
        viewer: { login: viewer },
        repository: {
          issue: {
            comments: { pageInfo: { hasPreviousPage: older, startCursor: 'c1' }, nodes },
          },
        },
      },
    })
    const { gh, calls } = fakeGh((call) =>
      call.kind === 'graphql'
        ? call.variables?.before === 'c1'
          ? page(false, [{ author: { login: 'b' }, body: 'older' }])
          : page(true, [{ author: { login: 'a' }, body: 'hi' }, null])
        : call.method === 'GET'
          ? { body: 'Goal' }
          : undefined,
    )
    const github = gitHubIssueSyncApi(gh)
    expect(await github.comments(issue(4))).toEqual({
      viewer,
      comments: [
        { author: 'a', body: 'hi' },
        { author: 'b', body: 'older' },
      ],
      complete: true,
    })
    const endless = fakeGh(() => page(true, [{ author: { login: 'a' }, body: 'hi' }]))
    expect(await gitHubIssueSyncApi(endless.gh).comments(issue(4))).toMatchObject({
      complete: false,
    })
    expect(endless.calls).toHaveLength(5)
    await github.comment(issue(4), startedText)
    await github.close(issue(4))
    expect(await github.pullRequestBody({ repo: 'acme/notes', number: 7 })).toBe('Goal')
    await github.setPullRequestBody({ repo: 'acme/notes', number: 7 }, 'Goal\n\nFixes acme/notes#4')
    expect(calls.filter((c) => c.kind === 'api')).toEqual([
      {
        kind: 'api',
        path: 'repos/acme/notes/issues/4/comments',
        method: 'POST',
        body: { body: startedText },
      },
      {
        kind: 'api',
        path: 'repos/acme/notes/issues/4',
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'completed' },
      },
      { kind: 'api', path: 'repos/acme/notes/pulls/7', method: 'GET', body: undefined },
      {
        kind: 'api',
        path: 'repos/acme/notes/pulls/7',
        method: 'PATCH',
        body: { body: 'Goal\n\nFixes acme/notes#4' },
      },
    ])
    await expect(github.comment({ ...issue(4), repo: '..' }, 'x')).rejects.toThrow()
    await expect(
      github.setPullRequestBody({ repo: 'acme/notes/x', number: 7 }, 'x'),
    ).rejects.toThrow()
  })
})
