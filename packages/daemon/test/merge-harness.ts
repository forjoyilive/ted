import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Comment, Factory, InboxItem, Task, ThreadEvent } from '@ted/protocol'
import { afterEach, beforeEach } from 'vitest'
import type { DaemonOptions } from '../src/daemon.ts'
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
import { eventWait } from './support/event-wait.ts'
import { createGhFixture } from './support/execution-gh.ts'
import type { ManualClock } from './support/manual-clock.ts'

export const run = promisify(execFile)

export const ctx = {
  home: '',
  scratch: '',
  origin: '',
  ghLog: '',
  ghState: '',
  daemon: undefined as RunningDaemon | undefined,
  cleanup: async () => {},
}

export interface MergeCleanupEvent {
  step: string
  state: 'start' | 'end' | 'failed'
  elapsedMs: number
}

export async function cleanupMergeHarness(
  report: (event: MergeCleanupEvent) => void = (event) =>
    console.error('[merge-cleanup]', JSON.stringify(event)),
): Promise<void> {
  const { home, scratch, daemon, cleanup, ghState, ghLog } = ctx
  if (!home) return
  let active: { step: string; since: number } | undefined
  const finish = (state: 'end' | 'failed') => {
    if (active)
      report({
        step: active.step,
        state,
        elapsedMs: Math.round(performance.now() - active.since),
      })
    active = undefined
  }
  const begin = (step: string) => {
    finish('end')
    active = { step, since: performance.now() }
    report({ step, state: 'start', elapsedMs: 0 })
  }
  try {
    begin('daemon')
    await daemon?.stop((step) => begin(`daemon.${step}`))
    if (ctx.daemon === daemon) ctx.daemon = undefined
    begin('run-hosts')
    await killRunHosts(home)
    if (process.env.TED_STUB_GH === ghState) delete process.env.TED_STUB_GH
    if (process.env.TED_STUB_GH_LOG === ghLog) delete process.env.TED_STUB_GH_LOG
    begin('home')
    await cleanup()
    begin('scratch')
    await rm(scratch, { recursive: true, force: true })
    finish('end')
  } catch (error) {
    finish('failed')
    throw error
  }
}

export function useMergeHarness(): void {
  beforeEach(async () => {
    const temp = await makeTempHome()
    ctx.home = temp.home
    ctx.cleanup = temp.cleanup
    ctx.scratch = await mkdtemp(path.join(tmpdir(), 'ted-merge-'))
    ctx.origin = await makeOriginRepo(ctx.scratch)
    const gh = await createGhFixture(ctx.scratch)
    ctx.ghLog = gh.log
    ctx.ghState = gh.state
    process.env.TED_STUB_GH = ctx.ghState
    process.env.TED_STUB_GH_LOG = ctx.ghLog
  })

  afterEach(async (context) => {
    await cleanupMergeHarness((event) =>
      console.error('[merge-cleanup]', JSON.stringify({ test: context.task.name, ...event })),
    )
  })
}

export const brief = `## Goal

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

export interface GhMerge {
  disableAutoFails?: boolean
  rollup?: 'empty' | 'missing' | 'truncated'
  title?: string
  origin?: string
  mergeState?: string
  reviewDecision?: string | null
  checks?: {
    id?: string
    startedAt?: string
    completedAt?: string
    createdAt?: string
    name: string
    status?: string
    conclusion?: string | null
    required?: boolean
    url?: string
    app?: string
  }[]
  mergeable?: string
  closed?: boolean
  threads?: {
    id: string
    resolved?: boolean
    path?: string
    line?: number
    comments: {
      id: string
      author: { login: string; bot?: boolean; association?: string }
      body: string
    }[]
  }[]
  reviews?: {
    id: string
    state: string
    author: { login: string; bot?: boolean; association?: string }
    body: string
  }[]
  deployments?: { environment: string; state: string; url?: string }[]
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

export const readGh = async () =>
  JSON.parse(await readFile(ctx.ghState, 'utf8')) as {
    merge: GhMerge
    heads?: Record<string, string>
  }

export async function setGh(merge: Partial<GhMerge>) {
  const state = await readGh()
  state.merge = { ...state.merge, ...merge }
  await writeFile(ctx.ghState, JSON.stringify(state))
}

export async function start(
  options: {
    files?: Record<string, string>
    merge?: GhMerge
    workflow?: string[]
    order?: string
    ciStuckMs?: { noChecks: number; pending: number }
    mergePollMs?: number
    daemon?: Partial<DaemonOptions>
  } = {},
) {
  await writeFile(ctx.ghState, JSON.stringify({ merge: { origin: ctx.origin, ...options.merge } }))
  await commitToOrigin(ctx.scratch, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml': [
      'version: 1',
      `order: [${options.order ?? 'intake, work, validate, review, merge'}]`,
      ...(options.workflow ?? []),
      '',
    ].join('\n'),
    ...options.files,
  })
  const daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    mergePollMs: options.mergePollMs ?? 100,
    ...(options.ciStuckMs && { ciStuckMs: options.ciStuckMs }),
    ...options.daemon,
  })
  ctx.daemon = daemon
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: ctx.origin, key: 'NB' })
  const briefFile = path.join(ctx.scratch, 'brief.md')
  await writeFile(briefFile, brief)
  const findingsFile = path.join(ctx.scratch, 'findings.md')
  await writeFile(findingsFile, 'The human asked for a bigger button.\n')
  const mergingFile = path.join(ctx.scratch, 'merging')
  return { ...client, ok, briefFile, findingsFile, mergingFile }
}

export type Client = Awaited<ReturnType<typeof start>>

export const commitStep = {
  run: [
    'sh',
    '-c',
    'echo $$ >> work.txt && git add work.txt && git -c user.name=T -c user.email=t@example.com commit -qm work',
  ],
}

export const mergeAdvance =
  'ted task list | grep -q "^$TED_TASK  Merge  " && ted outcome advance >/dev/null 2>&1'

export const quietGuard = (client: Client) =>
  `[ -e '${client.mergingFile}' ] && { ${mergeAdvance}; exit 0; }`

export function leadSteps(client: Client, commit = commitStep.run[2]) {
  const outcome = `out=$(ted outcome advance 2>&1) || case "$out" in *"asked for changes"*) ted outcome back --to work --findings '${client.findingsFile}';; esac`
  const script = [
    quietGuard(client),
    commit,
    `ted brief write --file '${client.briefFile}'`,
    outcome,
  ].join('\n')
  const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
  return JSON.stringify({
    steps: [{ everyMessage: each }, { run: ['sh', '-c', outcome] }, { endTurn: true }],
  })
}

// A Task reaches its sign-off in 3 to 6 seconds on an idle machine, took up to 14 beside five
// other daemon test files, and passed 20 in a full `pnpm check`.
const signoffWaitMs = 60_000

export async function toSignoff(
  client: Client,
  extra: Record<string, unknown> = {},
  clock?: ManualClock,
) {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: leadSteps(client),
    factory: 'NB',
    ...extra,
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return { task, signoff: await reviewSignoff(client, task.id, clock) }
}

export async function reviewSignoff(client: Client, taskId: string, clock?: ManualClock) {
  const item = await waitUntil(
    async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      const item = items.find((i) => i.request.kind === 'signoff' && i.task.id === taskId)
      if (!item && clock?.pending.includes(100)) clock.advance(100)
      return item
    },
    'the Review sign-off',
    signoffWaitMs,
  )
  return item.request
}

export const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

export async function approve(client: Client, signoff: Comment) {
  await writeFile(client.mergingFile, '')
  await client.ok('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
}

export const waitForStage = (client: Client, task: Task, stage: string) =>
  eventWait(
    client.subscribe,
    async () => {
      const current = await getTask(client, task.id)
      return current.stage === stage ? current : undefined
    },
    `${task.displayId} to reach ${stage}`,
  )

export const ghCalls = async () =>
  (await readFile(ctx.ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map(
      (line) => JSON.parse(line) as { args: string[]; stdin?: string; env: Record<string, string> },
    )

export const merges = async () =>
  (await ghCalls()).filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge').map((c) => c.args)

export const lines = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

export const branchHead = async (branch: string) =>
  (await run('git', ['rev-parse', `refs/heads/${branch}`], { cwd: ctx.origin })).stdout.trim()

export const originBranches = async () =>
  (await run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: ctx.origin }))
    .stdout
