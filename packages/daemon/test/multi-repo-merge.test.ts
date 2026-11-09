import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Banner, Comment, Factory, InboxItem, Task, ThreadEvent } from '@ted/protocol'
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
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const numbers = { 'acme/widgets': 7, 'acme/api': 8, 'acme/web': 9 }
const savedEnv = { ...process.env }

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let ghLog: string
let ghState: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-multi-merge-')))
  origin = await makeOriginRepo(scratch)
  await makeOrigin('api')
  await makeOrigin('web')
  ghLog = path.join(scratch, 'gh.jsonl')
  ghState = path.join(scratch, 'gh.json')
  process.env.TED_STUB_GH = ghState
  process.env.TED_STUB_GH_LOG = ghLog
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.file://${scratch}/.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  process.env = { ...savedEnv }
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function makeOrigin(name: string): Promise<void> {
  const bare = path.join(scratch, 'acme', `${name}.git`)
  const seed = path.join(scratch, `${name}-seed`)
  await mkdir(bare, { recursive: true })
  await run('git', ['init', '--bare', '--initial-branch=main'], { cwd: bare })
  await mkdir(seed)
  await run('git', ['init', '--initial-branch=main'], { cwd: seed })
  await writeFile(path.join(seed, 'README.md'), `# ${name}\n`)
  await run('git', ['add', '-A'], { cwd: seed, env: gitEnv })
  await run('git', ['commit', '-m', 'first'], { cwd: seed, env: gitEnv })
  await run('git', ['push', bare, 'main'], { cwd: seed, env: gitEnv })
}

const brief = `## Goal

Let notes sync between the app and the API.

## Decisions so far

None.

## Current state

Built.

## Open questions

None.

## Next step

Merge it.
`

interface PrState {
  mergeState?: string
  reviewDecision?: string | null
  autoMergeAllowed?: boolean
  mergeFails?: string | undefined
}

interface GhState {
  merge: { prs: Record<string, PrState> }
  pr: { numbers: Record<string, number> }
}

const readGh = async () => JSON.parse(await readFile(ghState, 'utf8')) as GhState

async function setPr(number: number, change: PrState) {
  const state = await readGh()
  state.merge.prs[String(number)] = { ...state.merge.prs[String(number)], ...change }
  await writeFile(ghState, JSON.stringify(state))
}

async function start(prs: Record<number, PrState> = {}) {
  const origins = Object.fromEntries(
    Object.keys(numbers).map((repo) => [repo, path.join(scratch, `${repo}.git`)]),
  )
  await writeFile(
    ghState,
    JSON.stringify({
      merge: {
        origin,
        origins,
        prs: Object.fromEntries(Object.values(numbers).map((n) => [String(n), prs[n] ?? {}])),
      },
      pr: { numbers },
      paths: Object.fromEntries(
        ['acme/api', 'acme/web'].flatMap((repo) => [
          [
            `repos/${repo}`,
            { body: { full_name: repo, default_branch: 'main', permissions: { push: true } } },
          ],
          [`repos/${repo}/commits?per_page=1`, { body: [] }],
        ]),
      ),
    }),
  )
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, validate, review, merge]',
      'repos:',
      '  - name: widgets',
      '  - name: api',
      '    remote: https://github.com/acme/api.git',
      '  - name: web',
      '    remote: https://github.com/acme/web.git',
      '',
    ].join('\n'),
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
  for (const banner of await ok<Banner[]>('GET', '/banners')) {
    if (banner.problem !== 'repo-in-workflow') continue
    await ok('POST', `/banners/${encodeURIComponent(banner.id)}/action`, {})
  }
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  const findingsFile = path.join(scratch, 'findings.md')
  await writeFile(findingsFile, 'The human asked for changes.\n')
  return { ...client, ok, briefFile, findingsFile }
}

type Client = Awaited<ReturnType<typeof start>>

function leadSteps(client: Client) {
  const commit = (dir: string) =>
    `(cd ${dir} && echo $$ >> work.txt && git add work.txt && git -c user.name=T -c user.email=t@example.com commit -qm work)`
  const script = [
    'ted task repos add web >/dev/null 2>&1 || true',
    'ted task repos add api >/dev/null 2>&1 || true',
    commit('widgets'),
    commit('web'),
    commit('api'),
    `ted brief write --file '${client.briefFile}'`,
    `out=$(ted outcome advance 2>&1) || case "$out" in *"asked for changes"*) ted outcome back --to work --findings '${client.findingsFile}';; esac`,
  ].join('\n')
  const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
  return JSON.stringify({ steps: [{ everyMessage: each }, ...each] })
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

async function nextSignoff(client: Client, task: Task, count: number): Promise<Comment> {
  const item = await waitUntil(
    async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
      if (comments.filter((c) => c.kind === 'signoff').length < count) return undefined
      return items.find((i) => i.request.kind === 'signoff' && i.task.id === task.id)
    },
    `sign-off ${count}`,
    20_000,
  )
  return item.request
}

async function toSignoff(client: Client) {
  const task = await client.ok<Task>('POST', '/tasks', { title: leadSteps(client), factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  const signoff = await nextSignoff(client, task, 1)
  await waitUntil(
    async () => {
      const repos = (await getTask(client, task.id)).repos.filter((r) => !r.removed)
      return repos.length === 3 && repos.every((r) => r.pullRequest?.state === 'ready')
    },
    'three ready pull requests',
    20_000,
  )
  const blocked = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
    factory: 'NB',
    start: true,
    blockedBy: [task.id],
  })
  return { task, signoff, blocked }
}

const approve = (client: Client, signoff: Comment) =>
  client.ok('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })

const ghCalls = async () =>
  (await readFile(ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { args: string[] })

const merges = async () =>
  (await ghCalls())
    .filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge')
    .map((c) => ({ repo: c.args[c.args.indexOf('--repo') + 1], auto: c.args.includes('--auto') }))

const events = (client: Client, task: Task) =>
  client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)

const waitForStage = (client: Client, task: Task, stage: string) =>
  waitUntil(
    async () => {
      const current = await getTask(client, task.id)
      return current.stage === stage ? current : undefined
    },
    `${task.displayId} to reach ${stage}`,
    20_000,
  )

describe('Merging a multi-repo Task', () => {
  test('TED merges nothing until every pull request is green, then merges in repos order', async () => {
    const client = await start({
      8: { mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', autoMergeAllowed: true },
    })
    const { task, signoff, blocked } = await toSignoff(client)
    expect((await getTask(client, task.id)).repos.map((r) => r.name)).toEqual([
      'widgets',
      'web',
      'api',
    ])

    await approve(client, signoff)
    await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.status?.kind === 'waiting-for-github' ? current : undefined
    }, 'Waiting for GitHub review')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await merges()).toEqual([])
    expect((await getTask(client, blocked.id)).leadRunId).toBeUndefined()

    await setPr(8, { mergeState: 'CLEAN', reviewDecision: 'APPROVED' })
    const done = await waitForStage(client, task, 'done')

    expect(await merges()).toEqual([
      { repo: 'acme/widgets', auto: false },
      { repo: 'acme/api', auto: false },
      { repo: 'acme/web', auto: false },
    ])
    expect(done.repos.every((r) => r.pullRequest?.state === 'merged')).toBe(true)
    await waitUntil(
      async () => (await getTask(client, blocked.id)).leadRunId !== undefined,
      'the blocked Task to start',
    )
  }, 60_000)

  test('a merge that fails partway shows Partly merged, reverts nothing, and the rest merges after a short re-sign-off', async () => {
    const client = await start({
      9: { mergeFails: 'GraphQL: Pull request is not mergeable (mergePullRequest)' },
    })
    const { task, signoff, blocked } = await toSignoff(client)

    await approve(client, signoff)
    const partly = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.status?.kind === 'partly-merged' ? current : undefined
    }, 'Partly merged')
    expect(partly.activity).toBe('widgets and api merged · web not yet')
    expect(
      Object.fromEntries(partly.repos.map((r) => [r.name, r.pullRequest?.state])),
    ).toMatchObject({ widgets: 'merged', api: 'merged' })
    expect(partly.repos.find((r) => r.name === 'web')?.pullRequest?.state).not.toBe('merged')

    const back = await waitUntil(async () => {
      const found = (await events(client, task)).find((e) =>
        e.text.startsWith('Merge sent this back to Work'),
      )
      return found
    }, 'the send-back to Work')
    const thread = await events(client, task)
    expect(thread.map((e) => e.text)).toContain(
      'Merge stopped partway · widgets and api merged, web didn’t. TED doesn’t revert a merged pull request.',
    )
    expect(back?.findings).toContain('TED couldn’t merge acme/web#9')
    expect(back?.findings).toContain('Fix only web')
    expect((await getTask(client, blocked.id)).leadRunId).toBeUndefined()

    await setPr(9, { mergeFails: undefined })
    const second = await nextSignoff(client, task, 2)
    expect((await getTask(client, task.id)).status?.kind).toBe('partly-merged')
    await approve(client, second)
    const done = await waitForStage(client, task, 'done')

    expect(done.repos.every((r) => r.pullRequest?.state === 'merged')).toBe(true)
    const repos = (await merges()).map((m) => m.repo)
    expect(repos.slice(0, 3)).toEqual(['acme/widgets', 'acme/api', 'acme/web'])
    expect(repos.slice(2).every((repo) => repo === 'acme/web')).toBe(true)
    expect((await ghCalls()).some((c) => c.args.includes('revert'))).toBe(false)
    await waitUntil(
      async () => (await getTask(client, blocked.id)).leadRunId !== undefined,
      'the blocked Task to start',
    )
  }, 60_000)
})
