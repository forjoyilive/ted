import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CheckRun, Comment, Factory, InboxItem, Task, ThreadEvent } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const run = promisify(execFile)

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let ghLog: string
let ghState: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-merge-'))
  origin = await makeOriginRepo(scratch)
  ghLog = path.join(scratch, 'gh.jsonl')
  ghState = path.join(scratch, 'gh.json')
  process.env.TED_STUB_GH = ghState
  process.env.TED_STUB_GH_LOG = ghLog
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  delete process.env.TED_STUB_GH
  delete process.env.TED_STUB_GH_LOG
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const brief = `## Goal

Let notes be edited offline.

## Decisions so far

None.

## Current state

Built. How to try it: open a note offline.

## Open questions

None.

## Next step

Merge it.
`

interface GhMerge {
  origin?: string
  mergeState?: string
  reviewDecision?: string | null
  checks?: { name: string; status?: string; conclusion?: string | null; required?: boolean }[]
  allowed?: string[]
  autoMergeAllowed?: boolean
  rebaseConflict?: boolean
  rebaseAddsCommit?: boolean
  rebaseChangesMode?: boolean
  isDraft?: boolean
  merged?: boolean
  autoMerge?: string
  mergedWith?: string
}

const readGh = async () =>
  JSON.parse(await readFile(ghState, 'utf8')) as { merge: GhMerge; heads?: Record<string, string> }

async function setGh(merge: Partial<GhMerge>) {
  const state = await readGh()
  state.merge = { ...state.merge, ...merge }
  await writeFile(ghState, JSON.stringify(state))
}

async function start(
  options: { files?: Record<string, string>; merge?: GhMerge; workflow?: string[] } = {},
) {
  await writeFile(ghState, JSON.stringify({ merge: { origin, ...options.merge } }))
  await commitToOrigin(scratch, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, validate, review, merge]',
      ...(options.workflow ?? []),
      '',
    ].join('\n'),
    ...options.files,
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    mergePollMs: 100,
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  const findingsFile = path.join(scratch, 'findings.md')
  await writeFile(findingsFile, 'The human asked for a bigger button.\n')
  const mergingFile = path.join(scratch, 'merging')
  return { ...client, ok, briefFile, findingsFile, mergingFile }
}

type Client = Awaited<ReturnType<typeof start>>

const commitStep = {
  run: [
    'sh',
    '-c',
    'echo $$ >> work.txt && git add work.txt && git -c user.name=T -c user.email=t@example.com commit -qm work',
  ],
}

function leadSteps(client: Client) {
  const outcome = `out=$(ted outcome advance 2>&1) || case "$out" in *"asked for changes"*) ted outcome back --to work --findings '${client.findingsFile}';; esac`
  const script = [
    `[ -e '${client.mergingFile}' ] && exit 0`,
    commitStep.run[2],
    `ted brief write --file '${client.briefFile}'`,
    outcome,
  ].join('\n')
  const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
  return JSON.stringify({
    steps: [{ everyMessage: each }, { run: ['sh', '-c', outcome] }, { endTurn: true }],
  })
}

async function toSignoff(client: Client, extra: Record<string, unknown> = {}) {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: leadSteps(client),
    factory: 'NB',
    ...extra,
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  const item = await waitUntil(async () => {
    const items = await client.ok<InboxItem[]>('GET', '/inbox')
    return items.find((i) => i.request.kind === 'signoff' && i.task.id === task.id)
  }, 'the Review sign-off')
  await waitUntil(
    async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.state === 'ready',
    'the pull request to be ready',
  )
  return { task, signoff: item.request }
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

async function approve(client: Client, signoff: Comment) {
  await writeFile(client.mergingFile, '')
  await client.ok('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
}

const waitForStage = (client: Client, task: Task, stage: string) =>
  waitUntil(async () => {
    const current = await getTask(client, task.id)
    return current.stage === stage ? current : undefined
  }, `${task.displayId} to reach ${stage}`)

const ghCalls = async () =>
  (await readFile(ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { args: string[]; stdin?: string })

const merges = async () =>
  (await ghCalls()).filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge').map((c) => c.args)

const lines = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

const branchHead = async (branch: string) =>
  (await run('git', ['rev-parse', `refs/heads/${branch}`], { cwd: origin })).stdout.trim()

const originBranches = async () =>
  (await run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: origin })).stdout

describe('Approve and merge', () => {
  test('with no CI, TED merges at once, deletes the branch, removes the worktree and releases blocked Tasks', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    expect(signoff.gate).toEqual({ approveLabel: 'Approve and merge' })
    const blocked = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
      factory: 'NB',
      start: true,
      blockedBy: [task.id],
    })
    const before = await getTask(client, task.id)
    const repo = before.repos[0]
    if (!repo?.pushed) throw new Error('no push')

    await approve(client, signoff)
    const done = await waitForStage(client, task, 'done')

    expect(await merges()).toEqual([
      [
        'pr',
        'merge',
        '7',
        '--repo',
        'acme/widgets',
        '--squash',
        '--match-head-commit',
        repo.pushed.commit,
      ],
    ])
    const deletes = (await ghCalls()).filter((c) => c.args.includes('DELETE'))
    expect(deletes.map((c) => c.args.at(-1))).toEqual([
      `repos/acme/widgets/git/refs/heads/${repo.branch}`,
    ])
    expect(done.repos[0]?.pullRequest).toMatchObject({
      state: 'merged',
      merged: { method: 'squash', noCi: true },
    })
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.removed !== undefined,
      'the worktree to be removed',
    )
    expect(await lines(client, task)).toContain(`No CI on ${repo.name} · merged without waiting`)
    await waitUntil(
      async () => (await getTask(client, blocked.id)).leadRunId !== undefined,
      'the blocked Task to start',
    )
  })

  test('with CI, TED waits for the checks, shows Waiting for CI, and the Task Lead can’t report an outcome', async () => {
    const client = await start({
      files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
      merge: { checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)

    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.status?.kind === 'waiting-for-github' ? current : undefined
    }, 'Waiting for CI')
    expect(waiting.status).toEqual({ kind: 'waiting-for-github', on: 'ci' })
    expect(waiting.repos[0]?.pushed?.ci).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await merges()).toEqual([])

    await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.merged).toMatchObject({ method: 'squash', noCi: false })
    expect(await merges()).toHaveLength(1)
    expect(await lines(client, task)).toContain(`Merged ${done.repos[0]?.name}`)
  })

  test('a failing required check sends the Task back to Work', async () => {
    const client = await start({
      files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
      merge: {
        checks: [
          { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', required: true },
        ],
      },
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)

    await waitUntil(async () => {
      const text = await lines(client, task)
      return text.includes('Merge sent this back to Work (round 1 of 3)') ? text : undefined
    }, 'the send-back')
    expect(await merges()).toEqual([])
  })

  test('with auto-merge allowed and a required review, TED turns on auto-merge and shows Waiting for GitHub review', async () => {
    const client = await start({
      merge: {
        mergeState: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        autoMergeAllowed: true,
        allowed: ['merge', 'rebase'],
      },
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)

    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.repos[0]?.pullRequest?.autoMerge &&
        current.status?.kind === 'waiting-for-github'
        ? current
        : undefined
    }, 'auto-merge')
    expect(waiting.status).toEqual({ kind: 'waiting-for-github', on: 'review' })
    const [auto] = await merges()
    expect(auto).toContain('--auto')
    expect(auto).toContain('--merge')
    const name = waiting.repos[0]?.name
    expect(await lines(client, task)).toContain(
      `Turned on auto-merge for ${name} · squash isn’t allowed on GitHub, so TED used merge`,
    )

    await setGh({ merged: true, reviewDecision: 'APPROVED' })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.merged?.method).toBe('merge')
    expect(await lines(client, task)).toContain(`The pull request for ${name} merged on GitHub`)
    expect(await merges()).toHaveLength(1)
  })

  test('a conflict-free rebase onto a moved base reruns Checks and merges without a new sign-off', async () => {
    const client = await start({
      merge: { mergeState: 'BEHIND' },
      workflow: [
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Tests, run: "test -f work.txt" }',
      ],
    })
    const { task, signoff } = await toSignoff(client)
    const branch = (await getTask(client, task.id)).repos[0]?.branch ?? ''
    await commitToOrigin(scratch, { 'other.txt': 'someone else’s change\n' })

    await approve(client, signoff)
    const done = await waitForStage(client, task, 'done')

    const rebased = await branchHead(branch)
    const [merge] = await merges()
    expect(merge?.at(-1)).toBe(rebased)
    expect(done.repos[0]?.pushed?.commit).toBe(rebased)
    const checkRuns = await client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)
    expect(checkRuns.filter((r) => r.trigger === 'merge').map((r) => r.outcome)).toEqual(['passed'])
    const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    expect(comments.filter((c) => c.kind === 'signoff')).toHaveLength(1)
    expect(await lines(client, task)).toContain(
      `Rebased ${done.repos[0]?.name} onto main with no conflicts · running Checks again`,
    )
    expect(await originBranches()).toContain(branch)
  })

  test('a rebase with conflicts sends the Task back to Work', async () => {
    const client = await start({ merge: { mergeState: 'BEHIND', rebaseConflict: true } })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)

    const back = await waitUntil(async () => {
      const events = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
      return events.find((e) => e.text.startsWith('Merge sent this back to Work'))
    }, 'the send-back')
    expect(back.findings).toContain('conflicts with main')
    expect(await merges()).toEqual([])
  })

  test('when gh is signed out, the Task shows Waiting for GitHub sign-in', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    const state = await readGh()
    await writeFile(ghState, JSON.stringify({ ...state, api: { result: 'auth' } }))
    await approve(client, signoff)

    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.status?.kind === 'waiting-for-github' ? current : undefined
    }, 'Waiting for GitHub sign-in')
    expect(waiting.status).toEqual({ kind: 'waiting-for-github', on: 'sign-in' })
  })
})

describe('Merging only what the human signed off', () => {
  const sentBack = (client: Client, task: Task) =>
    waitUntil(async () => {
      const events = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
      return events.find((e) => e.text.startsWith('Merge sent this back to Validate'))
    }, 'the send-back to Validate')

  const commitIn = (cwd: string, file: string) =>
    run(
      'sh',
      [
        '-c',
        `echo x >> ${file} && git add ${file} && git -c user.name=T -c user.email=t@example.com commit -qm ${file}`,
      ],
      { cwd },
    )

  test('TED merges the signed-off commit, never a commit the Task Lead made after it', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    const before = (await getTask(client, task.id)).repos[0]
    const signedOff = before?.pushed?.commit
    await commitIn(before?.worktree ?? '', 'late.txt')

    await approve(client, signoff)
    const done = await waitForStage(client, task, 'done')

    const [merge] = await merges()
    expect(merge?.at(-1)).toBe(signedOff)
    expect(done.repos[0]?.pullRequest?.signedOff).toBe(signedOff)
    expect(await branchHead(done.repos[0]?.branch ?? '')).toBe(signedOff)
  })

  test('a pull request still a draft at Merge goes back to Validate, and nothing is pushed', async () => {
    const client = await start({ merge: { isDraft: true } })
    const { task, signoff } = await toSignoff(client)
    const pushedAt = (await getTask(client, task.id)).repos[0]?.pushed?.at
    await approve(client, signoff)

    const back = await sentBack(client, task)
    expect(back.findings).toContain('still a draft')
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).repos[0]?.pushed?.at).toBe(pushedAt)
  })

  test('a branch changed on GitHub after sign-off goes back to Validate', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    const branch = (await getTask(client, task.id)).repos[0]?.branch ?? ''
    const work = await mkdtemp(path.join(scratch, 'other-'))
    await run('git', ['clone', '-q', origin, 'repo'], { cwd: work })
    const repo = path.join(work, 'repo')
    await run('git', ['checkout', '-q', branch], { cwd: repo })
    await commitIn(repo, 'sneaky.txt')
    await run('git', ['push', '-q', 'origin', 'HEAD'], { cwd: repo })

    await approve(client, signoff)
    const back = await sentBack(client, task)
    expect(back.findings).toContain('changed on GitHub after sign-off')
    expect(await merges()).toEqual([])
  })

  test.each([
    ['adds a commit', { rebaseAddsCommit: true }],
    ['changes only a file mode', { rebaseChangesMode: true }],
  ])(
    'a rebase that %s goes back to Validate, with the signed-off commit cleared',
    async (_, extra) => {
      const client = await start({ merge: { mergeState: 'BEHIND', ...extra } })
      const { task, signoff } = await toSignoff(client)
      await commitToOrigin(scratch, { 'other.txt': 'someone else’s change\n' })
      await approve(client, signoff)

      const back = await sentBack(client, task)
      expect(back.findings).toContain('isn’t the signed-off work rebased onto main')
      expect(await merges()).toEqual([])
      expect((await getTask(client, task.id)).repos[0]?.pullRequest?.signedOff).toBeUndefined()
    },
  )
})

describe('Request changes at Review', () => {
  test('the Task Lead sends the Task back to Work, and it returns through Validate with a new sign-off', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)

    await client.ok('POST', `/comments/${signoff.id}/answer`, {
      action: 'request-changes',
      text: 'Make the button bigger.',
    })

    const second = await waitUntil(async () => {
      const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
      const signoffs = comments.filter((c) => c.kind === 'signoff')
      return signoffs.length === 2 ? signoffs[1] : undefined
    }, 'a new sign-off')
    expect(second?.answer).toBeUndefined()
    const text = await lines(client, task)
    expect(text).toContain('Review sent this back to Work')
    const stages = (
      await client.ok<{ stage: string }[]>('GET', `/tasks/${task.id}/stage-entries`)
    ).map((e) => e.stage)
    expect(stages.slice(-4)).toEqual(['review', 'work', 'validate', 'review'])
  })
})
