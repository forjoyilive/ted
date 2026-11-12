import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Banner,
  CheckRun,
  Comment,
  FailureCase,
  Task,
  ValidationObligations,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, commitToOrigin, hostsStarted, stubClaudePath, waitUntil } from './helpers.ts'
import {
  approve,
  type Client,
  commitStep,
  ctx,
  getTask,
  ghCalls,
  leadSteps,
  merges,
  readGh,
  run,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'

useMergeHarness()

const long = 120_000
const checks = [
  '      - { name: Prefix, run: "echo prefix >> stub-prefix" }',
  '      - { name: First, run: "test ! -e base-only || test -e stub-first-fixed" }',
  '      - { name: Later, run: "test ! -e base-only || test -e stub-later-fixed" }',
]

async function rebased(gate = false, ci = false) {
  const client = await start({
    ...(ci && { files: { '.github/workflows/ci.yml': 'on: pull_request\n' } }),
    merge: {
      mergeState: 'BEHIND',
      ...(ci && {
        checks: [{ name: 'Required', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
      }),
    },
    workflow: ['stages:', '  merge:', `    gate: ${gate}`, '  validate:', '    checks:', ...checks],
  })
  const { task, signoff } = await toSignoff(client, {
    title: leadSteps(client, `[ -e stub-built ] || { ${commitStep.run[2]}; touch stub-built; }`),
  })
  await commitToOrigin(ctx.scratch, { 'base-only': 'A base change breaks existing Checks.\n' })
  await approve(client, signoff)
  const failure = await failed(client, task)
  return { client, task, failure }
}

const runs = (client: Client, task: Task) =>
  client
    .ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)
    .then((rs) => rs.filter((r) => r.trigger === 'merge'))
const cases = (client: Client, task: Task) =>
  client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
const obligations = (client: Client, task: Task) =>
  client.ok<ValidationObligations>('GET', `/tasks/${task.id}/validation-obligations`)

async function failed(client: Client, task: Task, count = 1) {
  return waitUntil(async () => {
    const values = await cases(client, task)
    const t = await getTask(client, task.id)
    return values.length === count &&
      !t.markers.some((m) => m.kind === 'test-activity' && m.source === 'checks')
      ? values.at(-1)
      : undefined
  }, 'post-rebase failure ready for diagnosis')
}

async function lead(client: Client, task: Task) {
  const t = await getTask(client, task.id)
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  return api(ctx.daemon?.port ?? 0, tokens.issue(t.leadRunId ?? ''))
}

async function assess(client: Client, task: Task, failure: FailureCase, assessment = 'unrelated') {
  const agent = await lead(client, task)
  const root = `/tasks/${task.id}/failures/${failure.id}`
  const result = await agent.call('POST', `${root}/assessments`, {
    assessment,
    recommendation:
      assessment === 'regression'
        ? 'Fix this Task and revalidate.'
        : 'Accept this known base failure and continue the remaining Checks.',
  })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return agent
}

async function ask(client: Client, task: Task, failure: FailureCase) {
  const agent = await assess(client, task, failure)
  const response = await agent.call('POST', `/tasks/${task.id}/failures/${failure.id}/decision`)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return (response.body as FailureCase).decisions.at(-1)?.commentId ?? ''
}

async function resolve(
  client: Client,
  task: Task,
  failure: FailureCase,
  requestId: string,
  resolution: 'accepted' | 'retry' | 'fix',
) {
  return client.call('POST', `/tasks/${task.id}/failures/${failure.id}/resolve`, {
    requestId,
    resolution,
  })
}

async function polls(client: Client) {
  const before = (await ghCalls()).filter(
    (c) => c.args[0] === 'api' && c.args[1] === 'graphql',
  ).length
  await waitUntil(
    async () =>
      (await ghCalls()).filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql').length >=
      before + 3,
    'three later GitHub polls',
  )
  expect(ctx.daemon).toBeDefined()
  return client
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

test(
  'an unrelated failure holds Merge without repeated execution or questions; each later failure needs its own decision',
  async () => {
    const { client, task, failure } = await rebased()
    expect(failure.source.kind).toBe('post-rebase-check')
    expect(failure.contextId).toBeTruthy()
    expect(failure.validation).toBe(true)
    expect((await getTask(client, task.id)).stage).toBe('merge')
    const request = await ask(client, task, failure)
    const before = await comments(client, task)
    await polls(client)
    expect(await runs(client, task)).toHaveLength(1)
    expect(await comments(client, task)).toHaveLength(before.length)
    expect(await merges()).toEqual([])
    const agent = await lead(client, task)
    expect(
      (await agent.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(409)
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
    const later = await failed(client, task, 2)
    expect(later.id).not.toBe(failure.id)
    expect((await obligations(client, task)).satisfied).toBe(false)
    expect((await runs(client, task)).map((r) => r.checks.map((c) => c.state))).toEqual([
      ['passed', 'failed', 'not-run'],
      ['failed'],
    ])
    expect(await merges()).toEqual([])
    await polls(client)
    expect(await runs(client, task)).toHaveLength(2)
    const second = await ask(client, task, later)
    expect((await resolve(client, task, later, second, 'accepted')).status).toBe(200)
    await waitForStage(client, task, 'done')
    expect(await runs(client, task)).toHaveLength(2)
    expect(await merges()).toHaveLength(1)
    expect((await runs(client, task))[0]?.outcome).toBe('failed')
  },
  long,
)

test(
  'Retry resumes at the failed position, verifies only a passing execution and keeps the passed prefix',
  async () => {
    const { client, task, failure } = await rebased()
    const request = await ask(client, task, failure)
    const t = await getTask(client, task.id)
    const worktree = t.repos[0]?.worktree ?? ''
    await writeFile(path.join(worktree, 'stub-first-fixed'), '')
    await writeFile(path.join(worktree, 'stub-later-fixed'), '')
    expect((await resolve(client, task, failure, request, 'retry')).status).toBe(200)
    await waitForStage(client, task, 'done')
    expect((await runs(client, task)).map((r) => r.checks.map((c) => c.name))).toEqual([
      ['Prefix', 'First', 'Later'],
      ['First', 'Later'],
    ])
    expect((await cases(client, task))[0]?.verifications).toHaveLength(1)
    expect((await cases(client, task))[0]?.resolutions.at(-1)?.resolution).toBe('retry')
    expect((await runs(client, task))[0]?.outcome).toBe('failed')
  },
  long,
)

test(
  'a pending post-rebase decision survives restart without rerunning, then acceptance continues its suffix',
  async () => {
    const initial = await rebased()
    const { task, failure } = initial
    const request = await ask(initial.client, task, failure)
    const client = await restart(initial.client)
    await polls(client)
    expect(await runs(client, task)).toHaveLength(1)
    expect(
      (await comments(client, task)).filter((c) => c.kind === 'question' && !c.answer),
    ).toHaveLength(1)
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
    await failed(client, task, 2)
    expect(await runs(client, task)).toHaveLength(2)
    expect(await merges()).toEqual([])
  },
  long,
)

test(
  'a supported regression assessment sends Merge through the existing Work repair path',
  async () => {
    const { client, task, failure } = await rebased()
    await assess(client, task, failure, 'regression')
    await waitForStage(client, task, 'work')
    const history = await client.ok<{ from: string; to: string; checkRunId?: string }[]>(
      'GET',
      `/tasks/${task.id}/send-backs`,
    )
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ from: 'merge', to: 'work' })
    expect(await merges()).toEqual([])
    const work = await getTask(client, task.id)
    const worktree = work.repos[0]?.worktree ?? ''
    await run('git', ['rm', 'base-only'], { cwd: worktree })
    await run(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-qm',
        'Repair the base Check failure',
      ],
      { cwd: worktree },
    )
    const agent = await lead(client, task)
    expect(
      (
        await agent.call('POST', `/tasks/${task.id}/brief`, {
          text: await readFile(client.briefFile, 'utf8'),
        })
      ).status,
    ).toBe(200)
    expect(
      (await agent.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(200)
    await waitForStage(client, task, 'validate')
    await waitUntil(
      async () => (await obligations(client, task)).satisfied,
      'repaired Checks to pass in Validate',
    )
    expect((await cases(client, task))[0]?.verifications).toHaveLength(1)
    const validating = await lead(client, task)
    expect(
      (await validating.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(200)
    const signoff = await waitUntil(
      async () =>
        (await comments(client, task)).find(
          (c) => c.stage === 'review' && c.kind === 'signoff' && !c.answer,
        ),
      'Review re-sign-off after repair',
    )
    expect(await merges()).toEqual([])
    await approve(client, signoff)
    await waitForStage(client, task, 'done')
    expect((await runs(client, task))[0]?.outcome).toBe('failed')
    expect(await merges()).toHaveLength(1)
  },
  long,
)

test(
  'a second rebase invalidates a prior acceptance and reruns the full current Check plan before the Merge sign-off',
  async () => {
    const { client, task, failure } = await rebased(true)
    const t = await getTask(client, task.id)
    await writeFile(path.join(t.repos[0]?.worktree ?? '', 'stub-later-fixed'), '')
    const request = await ask(client, task, failure)
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
    await waitUntil(
      async () =>
        (await comments(client, task)).find(
          (c) => c.stage === 'merge' && c.kind === 'signoff' && !c.answer,
        ),
      'Merge sign-off after accepted Check',
    )
    await commitToOrigin(ctx.scratch, { 'another-base-change': 'A second rebase.\n' })
    await setGh({ mergeState: 'BEHIND' })
    const fresh = await failed(client, task, 2)
    expect(fresh.contextId).not.toBe(failure.contextId)
    expect((await cases(client, task))[0]?.invalidations).toHaveLength(1)
    expect((await runs(client, task)).at(-1)?.checks.map((c) => c.name)).toEqual([
      'Prefix',
      'First',
      'Later',
    ])
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(409)
    expect(await merges()).toEqual([])
    expect((await readGh()).merge.merged).not.toBe(true)
  },
  long,
)

test(
  'a failed Retry creates a new case; the user’s Fix decision uses the normal send-back path',
  async () => {
    const { client, task, failure } = await rebased()
    const request = await ask(client, task, failure)
    expect((await resolve(client, task, failure, request, 'retry')).status).toBe(200)
    const replacement = await failed(client, task, 2)
    expect(replacement.id).not.toBe(failure.id)
    expect((await cases(client, task))[0]?.verifications?.at(-1)?.replacedBy).toBe(replacement.id)
    const next = await ask(client, task, replacement)
    expect((await resolve(client, task, replacement, next, 'fix')).status).toBe(200)
    await waitForStage(client, task, 'work')
    expect(await client.ok('GET', `/tasks/${task.id}/send-backs`)).toHaveLength(1)
    expect(await merges()).toEqual([])
  },
  long,
)

test(
  'accepted local failures survive restart at the Merge sign-off and never bypass required GitHub Checks',
  async () => {
    const initial = await rebased(true, true)
    const { task, failure } = initial
    const t = await getTask(initial.client, task.id)
    await writeFile(path.join(t.repos[0]?.worktree ?? '', 'stub-later-fixed'), '')
    const request = await ask(initial.client, task, failure)
    expect((await resolve(initial.client, task, failure, request, 'accepted')).status).toBe(200)
    await waitUntil(
      async () =>
        (await comments(initial.client, task)).find(
          (c) => c.stage === 'merge' && c.kind === 'signoff' && !c.answer,
        ),
      'Merge sign-off',
    )
    const client = await restart(initial.client)
    const before = (await runs(client, task)).length
    await polls(client)
    expect(await runs(client, task)).toHaveLength(before)
    expect((await obligations(client, task)).satisfied).toBe(true)
    expect(await merges()).toEqual([])
    await setGh({
      mergeState: 'BLOCKED',
      checks: [{ name: 'Required', status: 'IN_PROGRESS', required: true }],
      autoMergeAllowed: true,
    })
    await polls(client)
    expect((await obligations(client, task)).satisfied).toBe(false)
    expect(await merges()).toEqual([])
    expect((await readGh()).merge.autoMerge).toBeUndefined()
  },
  long,
)

test(
  'a post-rebase failure in one repo holds both repos until local obligations are satisfied',
  async () => {
    const saved = { ...process.env }
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${ctx.scratch}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    try {
      const client = await start({
        workflow: [
          'repos:',
          '  - name: widgets',
          '  - name: api',
          '    remote: https://github.com/acme/api.git',
          'stages:',
          '  validate:',
          '    checks:',
          ...checks,
          '      - { name: API, repo: api, run: "test -e work.txt" }',
        ],
      })
      const apiOrigin = path.join(ctx.scratch, 'acme/api.git')
      await run('git', ['clone', '--bare', ctx.origin, apiOrigin])
      await writeFile(
        ctx.ghState,
        JSON.stringify({
          ...(await readGh()),
          merge: {
            origin: ctx.origin,
            origins: { 'acme/widgets': ctx.origin, 'acme/api': apiOrigin },
            prs: { '7': { mergeState: 'BEHIND' }, '8': { mergeState: 'CLEAN' } },
          },
          pr: { numbers: { 'acme/widgets': 7, 'acme/api': 8 } },
          paths: {
            'repos/acme/api': {
              body: { full_name: 'acme/api', default_branch: 'main', permissions: { push: true } },
            },
            'repos/acme/api/commits?per_page=1': { body: [] },
          },
        }),
      )
      for (const banner of await client.ok<Banner[]>('GET', '/banners')) {
        if (banner.problem === 'repo-in-workflow')
          await client.ok('POST', `/banners/${encodeURIComponent(banner.id)}/action`, {})
      }
      const commit = (repo: string) =>
        `(cd ${repo} && { [ -e stub-built ] || { ${commitStep.run[2]}; touch stub-built; }; })`
      const script = [
        `[ -e '${client.mergingFile}' ] && exit 0`,
        commit('widgets'),
        commit('api'),
        `ted brief write --file '${client.briefFile}'`,
        'ted outcome advance',
      ].join('\n')
      const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
      const { task, signoff } = await toSignoff(client, {
        title: JSON.stringify({
          steps: [{ everyMessage: each }, { run: ['ted', 'task', 'repos', 'add', 'api'] }, ...each],
        }),
      })
      await waitUntil(
        async () =>
          (await getTask(client, task.id)).repos.every((r) => r.pullRequest?.state === 'ready'),
        'both repos ready',
      )
      await commitToOrigin(ctx.scratch, { 'base-only': 'Base regression.\n' })
      await approve(client, signoff)
      const failure = await failed(client, task)
      await polls(client)
      expect((await getTask(client, task.id)).repos).toHaveLength(2)
      expect(await merges()).toEqual([])
      const current = await getTask(client, task.id)
      await writeFile(
        path.join(
          current.repos.find((r) => r.name === 'widgets')?.worktree ?? '',
          'stub-later-fixed',
        ),
        '',
      )
      const request = await ask(client, task, failure)
      expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
      await waitForStage(client, task, 'done')
      expect((await merges()).map((args) => args[args.indexOf('--repo') + 1])).toEqual([
        'acme/widgets',
        'acme/api',
      ])
      expect((await runs(client, task)).at(-1)?.checks.at(-1)).toMatchObject({
        name: 'API',
        state: 'passed',
      })
    } finally {
      process.env = saved
    }
  },
  long,
)

test(
  'a Merge Check decision reuses the shared repair wait and remains held across restart',
  async () => {
    const initial = await rebased()
    const { task, failure } = initial
    const request = await ask(initial.client, task, failure)
    const repair = await initial.client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: 'Repair the existing base Check failure',
    })
    const response = await initial.client.call(
      'POST',
      `/tasks/${task.id}/failures/${failure.id}/resolve`,
      {
        requestId: request,
        resolution: 'repair',
        repair: { kind: 'existing', taskId: repair.id },
      },
    )
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const waiting = await getTask(initial.client, task.id)
    expect(waiting.stage).toBe('merge')
    expect(waiting.blockedBy).toContain(repair.id)
    const client = await restart(initial.client)
    await polls(client)
    expect(await runs(client, task)).toHaveLength(1)
    expect((await cases(client, task))[0]?.resolutions.at(-1)).toMatchObject({
      resolution: 'repair',
      repairTask: { id: repair.id },
    })
    expect((await obligations(client, task)).satisfied).toBe(false)
    expect(await merges()).toEqual([])
  },
  long,
)
