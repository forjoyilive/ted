import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Comment, Factory, InboxItem, Task, TaskRepo } from '@ted/protocol'
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-prs-'))
  origin = await makeOriginRepo(scratch)
  ghLog = path.join(scratch, 'gh.jsonl')
  ghState = path.join(scratch, 'gh.json')
  await writeFile(ghState, '{}')
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

Built.

## Open questions

None.

## Next step

Review it.
`

async function start() {
  await commitToOrigin(scratch, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, validate, review]\n',
  })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  return { ...client, ok, briefFile }
}

type Client = Awaited<ReturnType<typeof start>>

const commitStep = {
  run: [
    'sh',
    '-c',
    'echo $$ >> work.txt && git add work.txt && git -c user.name=T -c user.email=t@example.com commit -qm work',
  ],
}

async function walkToSignoff(client: Client, withCommits: boolean, extra = {}) {
  const list = [
    {
      everyMessage: [
        ...(withCommits ? [commitStep] : []),
        { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ],
    },
    { run: ['ted', 'outcome', 'advance'] },
    { endTurn: true },
  ]
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: list }),
    factory: 'NB',
    ...extra,
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  const item = await waitUntil(async () => {
    const [item] = await client.ok<InboxItem[]>('GET', '/inbox')
    return item?.request.kind === 'signoff' ? item : undefined
  }, 'the Review sign-off')
  return { task, signoff: item.request }
}

const taskOf = async (client: Client, task: Task): Promise<Task | undefined> =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)

const repoOf = async (client: Client, task: Task): Promise<TaskRepo | undefined> =>
  (await taskOf(client, task))?.repos[0]

const approve = (client: Client, signoff: Comment) =>
  client.ok('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })

async function toPullRequest(client: Client): Promise<Task> {
  const { task, signoff } = await walkToSignoff(client, true)
  await approve(client, signoff)
  await waitUntil(
    async () => (await repoOf(client, task))?.pullRequest?.state === 'ready',
    'the pull request to be ready',
  )
  return task
}

const ghCalls = async () =>
  (await readFile(ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { args: string[]; stdin?: string })

const prCalls = async (sub: string) =>
  (await ghCalls()).filter((c) => c.args[0] === 'pr' && c.args[1] === sub)

const originBranches = async () =>
  (await run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: origin })).stdout

describe('Pushing and pull requests', () => {
  test('Ted pushes nothing before Merge, then pushes the signed-off commit and opens one ready pull request', async () => {
    const client = await start()
    const { task, signoff } = await walkToSignoff(client, true)

    const signedOff = await repoOf(client, task)
    expect(signedOff?.pullRequest).toBeUndefined()
    expect(signedOff?.pushed).toBeUndefined()
    expect(await originBranches()).not.toContain('ted/')
    expect(await prCalls('create')).toEqual([])

    await approve(client, signoff)
    const repo = await waitUntil(async () => {
      const found = await repoOf(client, task)
      return found?.pullRequest?.state === 'ready' ? found : undefined
    }, 'the pull request to be ready')
    expect((await taskOf(client, task))?.stage).toBe('merge')
    expect(repo.pullRequest).toEqual({
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      base: 'main',
      state: 'ready',
    })

    const creates = await prCalls('create')
    expect(creates).toHaveLength(1)
    const [create] = creates
    const flag = (name: string) => create?.args[create.args.indexOf(name) + 1]
    expect(create?.args).not.toContain('--draft')
    expect(flag('--repo')).toBe('acme/widgets')
    expect(flag('--head')).toBe(repo.branch)
    expect(flag('--base')).toBe('main')
    expect(flag('--title')).toBe(task.title)
    expect(create?.stdin).toContain('Let notes be edited offline.')
    expect(create?.stdin).toContain(task.displayId)

    expect(await prCalls('ready')).toEqual([])

    const pushed = (
      await run('git', ['rev-parse', `refs/heads/${repo.branch}`], { cwd: origin })
    ).stdout.trim()
    expect(repo.pushed?.commit).toBe(pushed)
    expect(repo.pushed).toMatchObject({ ci: false, ciSignals: [] })
    const ahead = (
      await run('git', ['rev-list', '--count', `main..refs/heads/${repo.branch}`], { cwd: origin })
    ).stdout.trim()
    expect(ahead).toBe('3')
  })

  test('a Task from a Sentry issue says Fixes <short ID> in its pull request body', async () => {
    const client = await start()
    const url = 'https://acme.sentry.io/issues/4242/'
    for (const [body, error] of [
      [{ sentryId: 'NOTEBOOK-1A' }, 'sentryId needs a source'],
      [
        { source: url, sentryId: 'not an id' },
        'sentryId must be a Sentry short ID, such as NOTEBOOK-1A',
      ],
    ] as const) {
      expect(
        await client.call('POST', '/tasks', { title: 'Crash', factory: 'NB', ...body }),
      ).toEqual({ status: 400, body: { error } })
    }
    const { task, signoff } = await walkToSignoff(client, true, {
      source: url,
      sentryId: 'NOTEBOOK-1A',
    })
    await approve(client, signoff)
    expect(task.source).toEqual({ url, sentry: { shortId: 'NOTEBOOK-1A' } })

    const [create] = await waitUntil(async () => {
      const found = await prCalls('create')
      return found.length > 0 ? found : undefined
    }, 'the pull request')
    expect(create?.stdin).toContain('\n\nFixes NOTEBOOK-1A')
    expect(create?.stdin).toContain(url)
  })

  test('a Task with no commits gets no push and no pull request', async () => {
    const client = await start()
    const { task, signoff } = await walkToSignoff(client, false)
    await approve(client, signoff)
    await waitUntil(async () => (await taskOf(client, task))?.stage === 'merge', 'Merge')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const repo = await repoOf(client, task)
    expect(repo?.pullRequest).toBeUndefined()
    expect(repo?.pushed).toBeUndefined()
    expect(await prCalls('create')).toEqual([])
    expect(await originBranches()).not.toContain('ted/')
  })

  test('Archive closes the Task’s open pull requests when asked', async () => {
    const client = await start()
    const task = await toPullRequest(client)
    await client.ok('POST', `/tasks/${task.id}/archive`, { closePullRequests: true })
    await waitUntil(
      async () => (await repoOf(client, task))?.pullRequest?.state === 'closed',
      'the pull request to close',
    )
    expect((await prCalls('close')).map((c) => c.args.slice(2))).toEqual([
      ['7', '--repo', 'acme/widgets'],
    ])
    expect(await originBranches()).toContain('ted/')
  })

  test('Remove Factory closes open pull requests when asked and keeps the branches', async () => {
    const client = await start()
    await toPullRequest(client)
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const summary = await client.ok<{ openPullRequests: number }>(
      'GET',
      `/factories/${factory?.id}/removal`,
    )
    expect(summary.openPullRequests).toBe(1)
    await client.ok('POST', `/factories/${factory?.id}/remove`, {
      key: 'NB',
      closePullRequests: true,
    })
    expect((await prCalls('close')).map((c) => c.args.slice(2))).toEqual([
      ['7', '--repo', 'acme/widgets'],
    ])
    expect(await originBranches()).toContain('ted/')
  })

  test('Remove Factory leaves open pull requests alone when not asked', async () => {
    const client = await start()
    await toPullRequest(client)
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    await client.ok('POST', `/factories/${factory?.id}/remove`, {
      key: 'NB',
      closePullRequests: false,
    })
    expect(await prCalls('close')).toEqual([])
    expect(await client.ok<Task[]>('GET', '/tasks')).toEqual([])
  })

  test('Archive names the pull requests it closed, and Unarchive reopens them', async () => {
    const client = await start()
    const task = await toPullRequest(client)
    await client.ok('POST', `/tasks/${task.id}/archive`, { closePullRequests: true })
    await waitUntil(
      async () =>
        (await repoOf(client, task))?.pullRequest?.state === 'closed' &&
        (await repoOf(client, task))?.removed !== undefined,
      'the pull request to close and the worktree to go',
    )
    const events = await client.ok<{ text: string }[]>('GET', `/tasks/${task.id}/events`)
    expect(events.map((e) => e.text)).toContain(
      'You archived this Task · closed widgets #7 on GitHub · kept the branch',
    )

    await client.ok('POST', `/tasks/${task.id}/unarchive`)

    await waitUntil(
      async () => (await repoOf(client, task))?.pullRequest?.state === 'ready',
      'the pull request to reopen',
    )
    expect((await prCalls('reopen')).map((c) => c.args.slice(2))).toEqual([
      ['7', '--repo', 'acme/widgets'],
    ])
  })

  test('a failed push is recorded on the repo without its credentials', async () => {
    const client = await start()
    await writeFile(
      path.join(origin, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "denied for https://user:hunter2secret@example.com" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const { task, signoff } = await walkToSignoff(client, true)
    expect((await repoOf(client, task))?.pushFailed).toBeUndefined()
    await approve(client, signoff)
    const repo = await waitUntil(async () => {
      const found = await repoOf(client, task)
      return found?.pushFailed ? found : undefined
    }, 'the push to fail')
    expect(repo.pushFailed?.message).toContain('git push failed')
    expect(repo.pushFailed?.message).not.toContain('hunter2secret')
    expect(repo.pullRequest).toBeUndefined()
    expect(await prCalls('create')).toEqual([])
    expect((await taskOf(client, task))?.stage).toBe('merge')
  })
})
