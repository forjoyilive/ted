import { writeFile } from 'node:fs/promises'
import type { Comment, FailureCase, Task } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, hostsStarted, stubClaudePath, waitUntil } from './helpers.ts'
import {
  approve,
  type Client,
  ctx,
  type GhMerge,
  getTask,
  ghCalls,
  merges,
  readGh,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForPullRequest,
  waitForStage,
} from './merge-harness.ts'

useMergeHarness()

const long = 120_000
type Check = NonNullable<GhMerge['checks']>[number]
const job = 'https://github.com/acme/widgets/actions/runs/5/job/42'
const running: Check = { name: 'build', status: 'IN_PROGRESS' }
const failing = (over: Partial<Check> = {}): Check => ({
  id: 'build-1',
  name: 'build',
  conclusion: 'FAILURE',
  url: job,
  ...over,
})

async function atMerge(merge: GhMerge, checks: Check[]) {
  const client = await start({
    files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
    merge: { ...merge, checks: [running] },
  })
  const { task, signoff } = await toSignoff(client)
  await approve(client, signoff)
  await waitForStage(client, task, 'merge')
  await waitForPullRequest(client, task.id)
  const state = await readGh()
  await writeFile(
    ctx.ghState,
    JSON.stringify({
      ...state,
      logs: { '42': 'compiling\nError: the build broke' },
      merge: { ...state.merge, checks },
    }),
  )
  return { client, task }
}

const cases = (client: Client, task: Task) =>
  client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const recorded = (client: Client, task: Task, count = 1) =>
  waitUntil(async () => {
    const values = await cases(client, task)
    return values.length === count ? values : undefined
  }, `${count} CI failure case(s)`)

const closed = (client: Client, task: Task, id: string) =>
  waitUntil(async () => {
    const value = (await cases(client, task)).find((v) => v.id === id)
    return value?.verifications?.length ? value : undefined
  }, 'the CI failure to be closed')

async function lead(client: Client, task: Task) {
  const t = await getTask(client, task.id)
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  return api(ctx.daemon?.port ?? 0, tokens.issue(t.leadRunId ?? ''))
}

async function assess(client: Client, task: Task, failure: FailureCase, assessment = 'unrelated') {
  const agent = await lead(client, task)
  const result = await agent.call('POST', `/tasks/${task.id}/failures/${failure.id}/assessments`, {
    assessment,
    recommendation:
      assessment === 'regression'
        ? 'Fix this Task and revalidate.'
        : 'Accept it: the job fails on the base branch too.',
  })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return agent
}

async function ask(client: Client, task: Task, failure: FailureCase) {
  const agent = await assess(client, task, failure)
  const response = await agent.call('POST', `/tasks/${task.id}/failures/${failure.id}/decision`)
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return (response.body as FailureCase).decisions.at(-1)?.commentId ?? ''
}

const resolve = (
  client: Client,
  task: Task,
  failure: FailureCase,
  requestId: string,
  resolution: 'accepted' | 'retry' | 'fix' | 'repair',
  extra: Record<string, unknown> = {},
) =>
  client.call('POST', `/tasks/${task.id}/failures/${failure.id}/resolve`, {
    requestId,
    resolution,
    ...extra,
  })

const reads = async () =>
  (await ghCalls()).filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql').length

async function polls() {
  const before = await reads()
  await waitUntil(async () => (await reads()) >= before + 3, 'three later GitHub polls')
}

async function restart(previous: Client): Promise<Client> {
  await hostsStarted(ctx.home)
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    mergePollMs: 100,
  })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  return {
    ...previous,
    ...client,
    ok: async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const response = await client.call(method, route, body)
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
      return response.body as T
    },
  }
}

const startedWorkflows = async () =>
  (await ghCalls()).filter((c) => c.args[0] === 'run' || c.args[0] === 'workflow')

test(
  'an unrelated failure of a check GitHub doesn’t require is recorded and asked once across polls and a restart, and merges after acceptance',
  async () => {
    const first = await atMerge({ mergeState: 'UNSTABLE' }, [failing()])
    const { task } = first
    const [failure] = await recorded(first.client, task)
    expect(failure).toMatchObject({
      validation: true,
      source: { kind: 'github-ci', repo: 'acme/widgets', check: 'build', required: false },
    })
    expect(failure?.source).toMatchObject({ attempt: expect.stringContaining('build-1') })
    expect(failure?.contextId).toBeTruthy()
    expect(failure?.evidence).toContain('Error: the build broke')
    expect(failure?.evidence).toMatch(/<<<GITHUB [0-9a-f-]+>>>\nCheck: build \(failure\)/)
    if (!failure) throw new Error('no failure')
    const request = await ask(first.client, task, failure)
    const before = await comments(first.client, task)
    const asked = before.find((c) => c.id === request)?.body
    expect(asked).toContain('a CI check on acme/widgets#')
    expect(asked).not.toContain('build')
    const agent = await lead(first.client, task)
    const seen = (await agent.call('GET', `/tasks/${task.id}/failures`)).body as FailureCase[]
    expect(seen[0]?.source).toMatchObject({ kind: 'github-ci', required: false })
    expect(seen[0]?.source).not.toHaveProperty('check')
    await polls()
    const client = await restart(first.client)
    await polls()
    expect(await cases(client, task)).toHaveLength(1)
    const after = await comments(client, task)
    expect(after.filter((c) => c.kind === 'question')).toHaveLength(
      before.filter((c) => c.kind === 'question').length,
    )
    expect(after.filter((c) => c.title === 'CI failed at Merge')).toHaveLength(1)
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await merges()).toEqual([])
    const answer = await resolve(client, task, failure, request, 'accepted')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
    const [accepted] = await cases(client, task)
    expect(accepted?.resolutions.at(-1)?.resolution).toBe('accepted')
    expect(accepted?.verifications ?? []).toEqual([])
    expect(await startedWorkflows()).toEqual([])
  },
  long,
)

test(
  'an accepted failure of a required check never merges while GitHub blocks it; a passing rerun closes it and the Task merges',
  async () => {
    const { client, task } = await atMerge({ mergeState: 'BLOCKED' }, [failing({ required: true })])
    const [failure] = await recorded(client, task)
    if (!failure) throw new Error('no failure')
    expect(failure.source).toMatchObject({ required: true })
    const request = await ask(client, task, failure)
    const answer = await resolve(client, task, failure, request, 'accepted')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const blocked = (all: Comment[]) =>
      all.filter((c) => c.title === 'GitHub still blocks this merge')
    await waitUntil(
      async () => blocked(await comments(client, task)).length === 1,
      'the note that GitHub still blocks the merge',
    )
    await polls()
    expect(blocked(await comments(client, task))).toHaveLength(1)
    expect((await getTask(client, task.id)).repos[0]?.pullRequest?.waiting).toBe('required-check')
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await merges()).toEqual([])
    await setGh({
      mergeState: 'CLEAN',
      checks: [failing({ id: 'build-2', conclusion: 'SUCCESS', required: true })],
    })
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
    expect((await closed(client, task, failure.id)).verifications?.at(-1)?.evidence).toContain(
      'Passed on a later attempt',
    )
  },
  long,
)

test(
  'two failed checks get a case each; Retry only waits; a failed rerun is a new case, a passing one closes it, and a regression is sent back',
  async () => {
    const lint = failing({ id: 'lint-1', name: 'lint', app: 'some-app' })
    const { client, task } = await atMerge({ mergeState: 'UNSTABLE' }, [failing(), lint])
    const both = await recorded(client, task, 2)
    const build = both.find((v) => v.source.kind === 'github-ci' && v.source.check === 'build')
    const other = both.find((v) => v.id !== build?.id)
    if (!build || !other) throw new Error('missing cases')
    expect(other.source).not.toHaveProperty('check')
    const request = await ask(client, task, build)
    expect((await resolve(client, task, build, request, 'retry')).status).toBe(200)
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.waiting === 'rerun',
      'the Task to wait for a rerun',
    )
    await polls()
    expect(await cases(client, task)).toHaveLength(2)
    expect(await startedWorkflows()).toEqual([])
    expect(await merges()).toEqual([])
    await setGh({ checks: [failing({ id: 'build-2' }), lint] })
    const three = await recorded(client, task, 3)
    const again = three.find((v) => v.id !== build.id && v.id !== other.id)
    if (!again) throw new Error('no replacement case')
    expect(again.source).toMatchObject({ attempt: expect.stringContaining('build-2') })
    expect((await closed(client, task, build.id)).verifications?.at(-1)?.replacedBy).toBe(again.id)
    await setGh({ checks: [failing({ id: 'build-3', conclusion: 'SUCCESS' }), lint] })
    await closed(client, task, again.id)
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await merges()).toEqual([])
    await assess(client, task, other, 'regression')
    await waitForStage(client, task, 'work')
    expect((await closed(client, task, other.id)).verifications?.at(-1)?.evidence).toContain(
      'left Merge',
    )
    expect(await merges()).toEqual([])
  },
  long,
)

test(
  'a rerun that passes before the user answers withdraws the question and the Task merges',
  async () => {
    const { client, task } = await atMerge({}, [failing()])
    const [failure] = await recorded(client, task)
    if (!failure) throw new Error('no failure')
    const request = await ask(client, task, failure)
    await setGh({ checks: [failing({ id: 'build-2', conclusion: 'SUCCESS' })] })
    const answer = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.id === request)?.answer,
      'the question to be answered',
    )
    expect(answer.kind).toBe('withdrawn')
    await waitUntil(
      async () => ((await merges()).length > 0 ? true : undefined),
      'the pull request to be merged',
    )
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(409)
  },
  long,
)

test(
  'Wait for a repair Task holds Merge on the repair without merging or accepting the failure',
  async () => {
    const { client, task } = await atMerge({ mergeState: 'UNSTABLE' }, [failing()])
    const [failure] = await recorded(client, task)
    if (!failure) throw new Error('no failure')
    const request = await ask(client, task, failure)
    const answer = await resolve(client, task, failure, request, 'repair', {
      repair: {
        kind: 'new',
        title: 'Fix the broken build job',
        description: 'The build job fails on main.',
        start: false,
      },
    })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const [waiting] = await cases(client, task)
    const repair = waiting?.resolutions.at(-1)?.repairTask
    expect(waiting?.resolutions.at(-1)?.resolution).toBe('repair')
    expect((await getTask(client, task.id)).blockedBy).toContain(repair?.id)
    await polls()
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await cases(client, task)).toHaveLength(1)
    expect(await merges()).toEqual([])
  },
  long,
)
