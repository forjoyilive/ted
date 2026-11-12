import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CheckRun,
  Comment,
  FailureCase,
  RunSummary,
  SendBack,
  SubAgent,
  Task,
  ThreadEvent,
  ValidationObligations,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { all, api, commitToOrigin, stubClaudePath, stubCodexPath, waitUntil } from './helpers.ts'
import { type Client, ctx, getTask, run, start, useMergeHarness } from './merge-harness.ts'

useMergeHarness()

const workGate = ['  work:', '    gate: true']
const brief = {
  text: '## Goal\nVerify the change.\n\n## Decisions so far\nNone.\n\n## Current state\nWork is done.\n\n## Open questions\nNone.\n\n## Next step\nValidate.',
}

const usual = [
  '      - { name: Tests, run: "echo broken; exit 1" }',
  '      - { name: Lint, run: "echo linted" }',
]
const usualOrder = 'intake, work, validate, review'
const long = 120_000

function boot(checks = usual, order = usualOrder, loopCheck: false | number = false) {
  return start({
    order,
    daemon: { codexBin: stubCodexPath },
    workflow: [
      'stages:',
      ...(order.indexOf('work') < order.indexOf('validate') ? workGate : []),
      '  validate:',
      '    max_back: 1',
      `    loop_check: ${loopCheck}`,
      '    checks:',
      ...checks,
    ],
  })
}

async function walk(
  client: Client,
  order = usualOrder,
  loopCheck: false | number = false,
  endMessages = false,
) {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [
        ...(endMessages ? [{ everyMessage: [{ endTurn: true }] }] : []),
        ...(loopCheck === false ? [] : [{ say: 'Verdict: converging' }]),
        { endTurn: true },
      ],
    }),
    factory: 'NB',
    start: true,
  })
  const initial = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.runs[0]?.state === 'idle' ? t : undefined
  }, 'idle Task Lead')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(initial.leadRunId ?? ''))
  const root = `/tasks/${task.id}`
  const post = async <T>(route: string, body: Record<string, unknown> = {}): Promise<T> => {
    if (
      route === '/outcome' &&
      body.outcome === 'advance' &&
      (await getTask(client, task.id)).stage === 'work'
    )
      await lead.call('POST', `${root}/brief`, brief)
    const res = await lead.call('POST', root + route, body)
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
    const gate = (res.body as { request?: Comment }).request
    if (route === '/outcome' && gate?.gate && gate.stage === 'work')
      await client.ok('POST', `/comments/${gate.id}/answer`, { action: 'approve' })
    return res.body as T
  }
  const working = await waitUntil(async () => (await getTask(client, task.id)).repos[0], 'worktree')
  await writeFile(path.join(working.worktree, 'work.txt'), 'implemented\n')
  await post('/outcome', { outcome: 'advance' })
  if (order.indexOf('work') < order.indexOf('validate'))
    await post('/outcome', { outcome: 'advance' })
  const cases = () => client.ok<FailureCase[]>('GET', `${root}/failures`)
  const failure = (count = 1) =>
    waitUntil(async () => {
      const values = (await cases()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return values.length >= count ? values.at(-1) : undefined
    }, 'failure case')
  const one = await failure()
  const assess = (value: FailureCase, assessment = 'unrelated') =>
    post<FailureCase>(`/failures/${value.id}/assessments`, {
      assessment,
      recommendation: 'Evidence shows an unrelated failure. Recommend accepting this execution.',
    })
  const ask = async (value: FailureCase, assessment = 'unrelated') => {
    await assess(value, assessment)
    return post<FailureCase>(`/failures/${value.id}/decision`)
  }
  const answer = (value: FailureCase, choice: string) =>
    client.call('POST', `/comments/${value.decisions.at(-1)?.commentId}/answer`, {
      action: 'answer',
      choice,
    })
  const obligations = () =>
    client.ok<ValidationObligations>('GET', `${root}/validation-obligations`)
  const runs = () => client.ok<CheckRun[]>('GET', `${root}/check-runs`)
  const backs = () => client.ok<SendBack[]>('GET', `${root}/send-backs`)
  return {
    client,
    task,
    lead,
    root,
    post,
    cases,
    failure,
    one,
    assess,
    ask,
    answer,
    obligations,
    runs,
    backs,
  }
}

type Scene = Awaited<ReturnType<typeof walk>>

const setup = async (
  checks = usual,
  order = usualOrder,
  loopCheck: false | number = false,
  endMessages = false,
) => walk(await boot(checks, order, loopCheck), order, loopCheck, endMessages)

function together(title: string, scenes: Record<string, (s: Scene) => Promise<void>>) {
  test(
    title,
    async () => {
      const client = await boot()
      await all(Object.keys(scenes), async (name) => scenes[name]?.(await walk(client)))
    },
    long,
  )
}

together('accepting or retrying a failed Check, each on its own Task', {
  'a failed Check stays in Validate with evidence and no send-back; acceptance continues remaining Checks':
    async (s) => {
      expect((await getTask(s.client, s.task.id)).stage).toBe('validate')
      expect(await s.backs()).toEqual([])
      expect(s.one.evidence).toContain('broken')
      expect(s.one.contextId).toBeTruthy()
      expect((await s.runs())[0]?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
      expect((await s.lead.call('POST', `${s.root}/outcome`, { outcome: 'advance' })).status).toBe(
        409,
      )
      const decision = await s.ask(s.one)
      const comment = (await s.client.ok<Comment[]>('GET', `${s.root}/comments`)).find(
        (c) => c.id === decision.decisions.at(-1)?.commentId,
      )
      expect(comment?.choices).toEqual([
        'Retry',
        'Fix in this Task',
        'Accept this failure',
        'Wait for a repair Task',
      ])
      expect((await s.answer(decision, 'Accept this failure')).status).toBe(200)
      await waitUntil(async () => (await s.obligations()).satisfied, 'remaining Checks completed')
      const runs = await s.runs()
      expect(runs.map((r) => r.checks.map((c) => c.state))).toEqual([
        ['failed', 'not-run'],
        ['passed'],
      ])
      expect((await s.obligations()).progress?.checks.map((c) => c.state)).toEqual([
        'failed',
        'passed',
      ])
      expect(await s.backs()).toEqual([])
      expect((await s.answer(decision, 'Accept this failure')).status).toBe(409)
    },
  'Retry failing creates a new independent failure requiring reassessment': async (s) => {
    expect((await s.answer(await s.ask(s.one), 'Retry')).status).toBe(200)
    const next = await s.failure(2)
    expect(next.assessments).toEqual([])
    expect((await s.obligations()).satisfied).toBe(false)
    expect((await s.answer(await s.ask(next), 'Accept this failure')).status).toBe(200)
    await waitUntil(
      async () => (await s.obligations()).satisfied,
      'new failure accepted and remaining Check passed',
    )
    expect(await s.backs()).toEqual([])
  },
  'extra Findings stay blocking after Retry until fresh verification evidence is recorded': async (
    s,
  ) => {
    await s.answer(await s.ask(s.one), 'Accept this failure')
    await waitUntil(async () => (await s.obligations()).satisfied, 'Factory Checks complete')
    const context = await s.post<{ id: string }>('/failure-contexts')
    const current = await getTask(s.client, s.task.id)
    const value = await s.post<FailureCase>('/failures', {
      source: {
        kind: 'finding',
        runId: current.leadRunId,
        finding: 'Extra visual verification failed',
      },
      contextId: context.id,
      evidence: 'Screenshot shows a missing label.',
    })
    expect((await s.obligations()).satisfied).toBe(false)
    expect((await s.answer(await s.ask(value, 'uncertain'), 'Retry')).status).toBe(200)
    expect((await s.obligations()).satisfied).toBe(false)
    await s.post(`/failures/${value.id}/verification`, {
      evidence:
        'Repeated visual verification with the service available: the expected label appears.',
    })
    expect((await s.obligations()).satisfied).toBe(true)
    expect(await s.backs()).toEqual([])
  },
  'a new execution cannot inherit an earlier failure’s acceptance': async (s) => {
    await s.answer(await s.ask(s.one), 'Accept this failure')
    await waitUntil(async () => (await s.obligations()).satisfied, 'initial validation completed')
    await s.post('/checks')
    const next = await s.failure(2)
    expect(next.decisions).toEqual([])
    expect(next.resolutions).toEqual([])
    expect((await s.obligations()).blockers).toEqual([next.id])
    const progress = (await s.obligations()).progress
    expect(progress?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
    const source = next.source
    expect(
      source.kind === 'factory-check' && progress?.executions.at(-1)?.runId === source.checkRunId,
    ).toBe(true)
  },
})

test('each later failing Check needs its own decision, including the final Check', async () => {
  const s = await setup([
    '      - { name: Tests, run: "exit 1" }',
    '      - { name: Lint, run: "exit 2" }',
  ])
  expect((await s.answer(await s.ask(s.one), 'Accept this failure')).status).toBe(200)
  const second = await s.failure(2)
  expect((await s.obligations()).satisfied).toBe(false)
  expect(second.originalCheck?.name).toBe('Lint')
  expect((await s.answer(await s.ask(second, 'uncertain'), 'Accept this failure')).status).toBe(200)
  await waitUntil(async () => (await s.obligations()).satisfied, 'both decisions completed')
  expect((await s.runs()).map((r) => r.outcome)).toEqual(['failed', 'failed'])
  expect(await s.backs()).toEqual([])
})

test('Retry passing records a new execution and resolves only its verified failure', async () => {
  const s = await setup([
    '      - { name: Tests, run: "if [ -e stub-retried ]; then exit 0; else touch stub-retried; exit 1; fi" }',
    '      - { name: Lint, run: "echo linted" }',
  ])
  expect((await s.answer(await s.ask(s.one, 'uncertain'), 'Retry')).status).toBe(200)
  await waitUntil(async () => (await s.obligations()).satisfied, 'retry and remaining Check pass')
  expect((await s.runs()).map((r) => r.outcome)).toEqual(['failed', 'passed'])
  expect((await s.cases())[0]?.verifications?.length).toBe(1)
  expect(await s.backs()).toEqual([])
})

together('sending a failed Check back or refusing to, each on its own Task', {
  'human Fix uses the counted send-back path with assessment and evidence': async (s) => {
    expect((await s.answer(await s.ask(s.one), 'Fix in this Task')).status).toBe(200)
    expect((await getTask(s.client, s.task.id)).stage).toBe('work')
    expect(await s.backs()).toMatchObject([
      { counted: true, round: 1, from: 'validate', to: 'work' },
    ])
    expect((await s.backs())[0]?.findings).toContain('Assessment: unrelated')
  },
  'changed context refuses stale acceptance without answering the request': async (s) => {
    const decision = await s.ask(s.one)
    const task = await getTask(s.client, s.task.id)
    const repo = task.repos[0]
    if (!repo) throw new Error('missing worktree')
    await writeFile(path.join(repo.worktree, 'work.txt'), 'changed again\n')
    expect((await s.answer(decision, 'Accept this failure')).status).toBe(409)
    expect((await s.obligations()).satisfied).toBe(false)
    expect(await s.backs()).toEqual([])
  },
  'a regression assessment uses the existing send-back path and preserves max_back': async (s) => {
    expect(
      (
        await s.lead.call('POST', `${s.root}/outcome`, {
          outcome: 'back',
          to: 'work',
          findings: 'Tests regressed',
        })
      ).status,
    ).toBe(409)
    await s.assess(s.one, 'regression')
    await s.post('/outcome', { outcome: 'back', to: 'work', findings: s.one.evidence })
    expect((await s.backs())[0]).toMatchObject({ round: 1, counted: true })
    await s.post('/outcome', { outcome: 'advance' })
    const second = await s.failure(2)
    expect((await s.answer(await s.ask(second), 'Fix in this Task')).status).toBe(200)
    expect((await getTask(s.client, s.task.id)).stage).toBe('validate')
    expect(await s.backs()).toHaveLength(1)
    const question = await waitUntil(
      async () => {
        const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
        return comments.find((c) => !c.answer && c.title?.includes('its limit'))
      },
      'the limit assessment to ask the human',
      40_000,
    )
    expect(question.kind).toBe('question')
    expect(await s.backs()).toHaveLength(1)
  },
  'Task Lead verification cannot bypass a current failed Check or incomplete repair coverage':
    async (s) => {
      await s.assess(s.one, 'regression')
      const verify = () =>
        s.lead.call('POST', `${s.root}/failures/${s.one.id}/verification`, {
          evidence: 'Claimed repair without complete current verification.',
        })
      expect((await verify()).status).toBe(409)
      await s.post('/outcome', {
        outcome: 'back',
        to: 'work',
        findings: 'Repair the failed Check.',
      })
      await s.post('/outcome', { outcome: 'advance' })
      const second = await s.failure(2)
      const before = await s.cases()
      expect((await verify()).status).toBe(409)
      await s.assess(second, 'regression')
      expect(
        (
          await s.lead.call('POST', `${s.root}/failures/${second.id}/verification`, {
            evidence: 'Claimed repair despite the current failure.',
          })
        ).status,
      ).toBe(409)
      expect((await s.cases()).find((c) => c.id === s.one.id)?.verifications).toEqual(
        before.find((c) => c.id === s.one.id)?.verifications,
      )
      expect((await s.cases()).find((c) => c.id === second.id)?.verifications).toBeUndefined()
      expect((await s.obligations()).satisfied).toBe(false)
    },
})

test('a pending question survives restart, then acceptance resumes the remaining Checks', async () => {
  const s = await setup()
  const decision = await s.ask(s.one, 'uncertain')
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  const read = async <T>(route: string): Promise<T> => {
    const response = await client.call('GET', route)
    expect(response.status).toBe(200)
    return response.body as T
  }
  const result = await client.call(
    'POST',
    `/comments/${decision.decisions.at(-1)?.commentId}/answer`,
    { action: 'answer', choice: 'Accept this failure' },
  )
  expect(result.status).toBe(200)
  await waitUntil(
    async () => (await read<ValidationObligations>(`${s.root}/validation-obligations`)).satisfied,
    'continuation after restart',
  )
  const runs = await read<CheckRun[]>(`${s.root}/check-runs`)
  expect(runs.map((r) => r.checks.map((c) => c.state))).toEqual([['failed', 'not-run'], ['passed']])
})

test('a Workflow without earlier Work refuses Fix and retains the decision', async () => {
  const s = await setup(undefined, 'intake, validate, work, review')
  const decision = await s.ask(s.one)
  expect((await s.answer(decision, 'Fix in this Task')).status).toBe(409)
  const comment = (await s.client.ok<Comment[]>('GET', `${s.root}/comments`)).find(
    (c) => c.id === decision.decisions.at(-1)?.commentId,
  )
  expect(comment?.answer).toBeUndefined()
  expect((await s.answer(decision, 'Accept this failure')).status).toBe(200)
  await waitUntil(async () => (await s.obligations()).satisfied, 'custom Workflow continuation')
})

async function restart() {
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  return {
    ...client,
    port: ctx.daemon.port,
    async read<T>(route: string): Promise<T> {
      const response = await client.call('GET', route)
      expect(response.status).toBe(200)
      return response.body as T
    },
  }
}

test.each(
  (['validate', 'merge'] as const).flatMap((stage) =>
    [
      ...(['retained', 'reset', 'held', 'interrupted'] as const),
      ...(stage === 'validate'
        ? (['complete', 'prefix'] as const)
        : (['replaced', 'retry', 'accept'] as const)),
    ].map((state) => ({ stage, state })),
  ),
)('$stage restart after persisted repair incorporation: $state', async ({ stage, state }) => {
  const matchingCoverage = state === 'complete' || state === 'prefix'
  const continuation = state === 'retry' || state === 'accept'
  const s = await setup(
    [
      ...(matchingCoverage ? ['      - { name: Prefix, run: "true" }'] : []),
      continuation
        ? '      - { name: Tests, run: "test -f timezone.txt && test -f stub-repair-passes" }'
        : '      - { name: Tests, run: "test -f timezone.txt" }',
      ...(continuation ? ['      - { name: Later, run: "true" }'] : []),
    ],
    'intake, work, validate, review, merge',
    false,
    state === 'replaced' || continuation,
  )
  const decision = state === 'replaced' ? undefined : await s.ask(s.one)
  const task = await getTask(s.client, s.task.id)
  const repo = task.repos[0]
  if (!repo) throw new Error('missing worktree')
  await ctx.daemon?.stop()
  ctx.daemon = undefined
  const store = await openStore({ directory: tedPaths(ctx.home).store })
  if (stage === 'merge') store.changeStage(task.id, 'merge')
  const originalFailure = store.failures.get(s.one.id)
  if (!originalFailure) throw new Error('missing original failure')
  let saved: FailureCase = originalFailure
  let requestId = decision?.decisions.at(-1)?.commentId
  if (state === 'replaced') {
    const original = saved.originalCheck
    if (!original) throw new Error('missing failed Check')
    const failed = store.startChecks({
      taskId: task.id,
      stage: 'merge',
      trigger: 'merge',
      checks: [{ ...original, state: 'not-run' }],
    })
    store.checkFinished(failed.id, 0, { state: 'failed', exitCode: 1, durationMs: 1 })
    store.finishChecks(failed.id, 'failed')
    const originalCheck = store.getCheckRun(failed.id)?.checks[0]
    if (!originalCheck) throw new Error('missing failed Merge Check')
    const recorded = store.failures.save(
      {
        id: randomUUID(),
        taskId: task.id,
        recordedBy: task.leadRunId ?? 'ted',
        provenance: 'stored-check',
        source: { kind: 'post-rebase-check', checkRunId: failed.id, position: 0 },
        originalCheck,
        evidence: 'The post-rebase export Check failed before the separate repair.',
        createdAt: new Date().toISOString(),
        assessments: [],
        additions: [],
        decisions: [],
        resolutions: [],
        invalidations: [],
      },
      'recorded',
    )
    const assessed = store.failures.save(
      {
        ...recorded,
        assessments: [
          {
            id: randomUUID(),
            runId: recorded.recordedBy,
            at: new Date().toISOString(),
            assessment: 'unrelated',
            recommendation: 'Wait for a separate export repair.',
          },
        ],
      },
      'assessed',
    )
    saved = store.postFailureDecision(assessed, 'Wait for a separate export repair.', false)
    requestId = saved.decisions.at(-1)?.commentId
  }
  const assessment = saved.assessments.at(-1)
  if (!requestId || !assessment) throw new Error('missing repair decision')
  const resolvedAt = new Date().toISOString()
  const resolved = {
    ...saved,
    resolutions: [
      ...saved.resolutions,
      {
        requestId,
        assessmentId: assessment.id,
        resolution: 'repair' as const,
        at: resolvedAt,
        ...(assessment.contextId && { contextId: assessment.contextId }),
        repair: { kind: 'existing' as const, taskId: 'merged-repair' },
        repairTask: { id: 'merged-repair', displayId: 'NB-2', title: 'Merged repair' },
      },
    ],
  }
  store.resolveFailure(
    resolved,
    requestId,
    { kind: 'answered', at: resolvedAt, choice: 'Wait for a repair Task' },
    [],
  )
  await writeFile(path.join(repo.worktree, 'timezone.txt'), 'restored\n')
  const releaseChecks = path.join(ctx.scratch, 'release-replacement-checks')
  if (state === 'replaced') {
    const file = path.join(repo.worktree, '.ted/workflow.yaml')
    const { readFile } = await import('node:fs/promises')
    const workflow = (await readFile(file, 'utf8'))
      .replace('name: Tests', 'name: Repaired export')
      .replace(
        JSON.stringify('test -f timezone.txt'),
        JSON.stringify(
          `test -f timezone.txt && while [ ! -f '${releaseChecks}' ]; do sleep 0.02; done`,
        ),
      )
    await writeFile(file, workflow)
    await commitToOrigin(ctx.scratch, { '.ted/workflow.yaml': workflow })
    await run('git', ['add', '.ted/workflow.yaml'], { cwd: repo.worktree })
  }
  await run('git', ['add', 'timezone.txt', 'work.txt'], { cwd: repo.worktree })
  await run(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'incorporated repair'],
    { cwd: repo.worktree },
  )
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo.worktree })).stdout.trim()
  const at = new Date().toISOString()
  store.failures.save(
    {
      ...resolved,
      repairProgress: [{ requestId, at, repos: [{ repo: repo.repo, head, onto: head }] }],
    },
    'repair',
  )
  if (matchingCoverage) {
    const progress = store.failures.progress(task.id)
    if (!progress?.coverage) throw new Error('missing previous Check coverage')
    const tree = (
      await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo.worktree })
    ).stdout.trim()
    const previous = JSON.parse(progress.coverage)
    store.failures.saveProgress({
      ...progress,
      coverage: JSON.stringify({
        ...previous,
        repos: previous.repos.map((entry: { repo: string; head: string; tree: string }) =>
          entry.repo === repo.repo ? { ...entry, head, tree } : entry,
        ),
      }),
      checks: progress.checks.map((check, position) => ({
        ...check,
        state: state === 'complete' || position === 0 ? 'passed' : 'not-run',
      })),
      next: state === 'complete' ? progress.checks.length : 1,
      pending: false,
      failureId: undefined,
    })
  }
  const before = store.listCheckRuns(task.id).length
  if (continuation) expect(store.latestRebase(task.id, '')).toBeUndefined()
  if (state === 'interrupted')
    store.startChecks({
      taskId: task.id,
      stage,
      trigger: stage,
      checks: [
        { name: 'Tests', command: 'test -f timezone.txt', timeout: '10s', state: 'not-run' },
      ],
    })
  if (state === 'held')
    store.stopTask(task.id, { runs: task.runs.length, why: 'repair-incorporation' })
  await store.persisted()
  await store.close()
  if (state === 'reset' || state === 'held')
    await run('git', ['reset', '--keep', 'HEAD^'], { cwd: repo.worktree })
  if (state === 'replaced')
    await writeFile(
      path.join(ctx.home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
  const client = await restart()
  if (continuation) {
    const fresh = await waitUntil(async () => {
      const cases = await client.read<FailureCase[]>(`${s.root}/failures`)
      const task = (await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)
      return !task?.markers.some((m) => m.kind === 'test-activity' && m.source === 'checks')
        ? cases.find((value) => value.id !== saved.id && value.source.kind === 'post-rebase-check')
        : undefined
    }, 'failed Merge repair execution')
    expect(fresh.contextId).toBeDefined()
    const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
    const lead = api(client.port, tokens.issue(task.leadRunId ?? ''))
    expect(
      (
        await lead.call('POST', `${s.root}/failures/${fresh.id}/assessments`, {
          assessment: 'unrelated',
          recommendation: 'Retry or accept this separate verification failure.',
        })
      ).status,
    ).toBe(200)
    const asked = await lead.call('POST', `${s.root}/failures/${fresh.id}/decision`)
    expect(asked.status).toBe(201)
    const requestId = (asked.body as FailureCase).decisions.at(-1)?.commentId
    if (state === 'retry') await writeFile(path.join(repo.worktree, 'stub-repair-passes'), '')
    const resolved = await client.call('POST', `${s.root}/failures/${fresh.id}/resolve`, {
      requestId,
      resolution: state === 'retry' ? 'retry' : 'accepted',
    })
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200)
    const runs = await waitUntil(async () => {
      const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
      return runs.length === before + 2 && runs.at(-1)?.outcome === 'passed' ? runs : undefined
    }, 'Merge repair decision to continue Checks without a rebase')
    expect(runs.at(-1)?.checks.map((check) => check.name)).toEqual(
      state === 'retry' ? ['Tests', 'Later'] : ['Later'],
    )
    expect(
      runs.find(
        (run) => fresh.source.kind === 'post-rebase-check' && run.id === fresh.source.checkRunId,
      )?.outcome,
    ).toBe('failed')
    const result = (await client.read<FailureCase[]>(`${s.root}/failures`)).find(
      (value) => value.id === fresh.id,
    )
    if (state === 'retry') expect(result?.verifications).toHaveLength(1)
    else {
      expect(result?.resolutions.at(-1)?.resolution).toBe('accepted')
      expect(result?.verifications).toBeUndefined()
    }
    return
  }
  if (state === 'reset' || state === 'held') {
    await waitUntil(
      async () =>
        (await client.read<Task[]>('/tasks'))
          .find((t) => t.id === task.id)
          ?.statuses.includes('stopped'),
      'old worktree held before validation',
    )
    await waitUntil(
      async () =>
        (await client.read<Task[]>('/tasks'))
          .find((t) => t.id === task.id)
          ?.runs.every((r) => r.state === 'finished'),
      'incorporation hold to stop the restored Lead',
    )
    const failures = await client.read<FailureCase[]>(`${s.root}/failures`)
    expect(failures.find((f) => f.id === s.one.id)?.verifications).toBeUndefined()
    expect(await client.read<CheckRun[]>(`${s.root}/check-runs`)).toHaveLength(before)
    return
  }
  if (state === 'replaced') {
    const resumed = await waitUntil(async () => {
      const task = (await client.read<Task[]>('/tasks')).find((value) => value.id === s.task.id)
      return task?.stage === 'merge' &&
        task.runs.find((run) => run.id === task.leadRunId)?.state === 'idle'
        ? task
        : undefined
    }, 'replacement Merge Lead').catch(async (error: unknown) => {
      const current = (await client.read<Task[]>('/tasks')).find((value) => value.id === s.task.id)
      const checks = await client.read<CheckRun[]>(`${s.root}/check-runs`)
      throw new Error(
        `${String(error)}; last recovery state: ${JSON.stringify({
          stage: current?.stage,
          leadRunId: current?.leadRunId,
          runs: current?.runs,
          statuses: current?.statuses,
          blockedBy: current?.blockedBy,
          checks: checks.map((run) => ({
            id: run.id,
            stage: run.stage,
            outcome: run.outcome,
            checks: run.checks.map(({ name, state }) => ({ name, state })),
          })),
        })}`,
      )
    })
    expect(resumed.leadRunId).toBe(task.leadRunId)
    const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
    const lead = api(client.port, tokens.issue(resumed.leadRunId ?? ''))
    try {
      await waitUntil(
        async () =>
          (await client.read<CheckRun[]>(`${s.root}/check-runs`)).some(
            (run) =>
              run.stage === 'merge' &&
              run.startedAt >= at &&
              run.checks.some((c) => c.state === 'running'),
          ),
        'replacement Merge Check awaiting release',
      )
      const early = await lead.call('POST', `${s.root}/failures/${saved.id}/verification`, {
        evidence: 'The replacement Check has not finished yet.',
      })
      expect(early.status, JSON.stringify(early.body)).toBe(409)
      expect(
        (await client.read<FailureCase[]>(`${s.root}/failures`)).find(
          (value) => value.id === saved.id,
        )?.verifications,
      ).toBeUndefined()
    } finally {
      await writeFile(releaseChecks, '')
    }
    await waitUntil(
      async () =>
        (await client.read<CheckRun[]>(`${s.root}/check-runs`)).some(
          (run) => run.stage === 'merge' && run.startedAt >= at && run.outcome === 'passed',
        ),
      'replacement Merge Check coverage',
    )
    await waitUntil(async () => {
      const task = (await client.read<Task[]>('/tasks')).find((value) => value.id === s.task.id)
      return task && !task.statuses.includes('working') ? task : undefined
    }, 'replacement Merge Checks to release the Task')
    const response = await lead.call('POST', `${s.root}/failures/${saved.id}/verification`, {
      evidence: 'The repair replaced Tests with Repaired export; the complete current plan passed.',
    })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const verified = (await client.read<FailureCase[]>(`${s.root}/failures`)).find(
      (value) => value.id === saved.id,
    )
    expect(verified).toMatchObject({
      source: saved.source,
      originalCheck: saved.originalCheck,
      evidence: saved.evidence,
      createdAt: saved.createdAt,
      resolutions: resolved.resolutions,
    })
    expect(verified?.verifications).toHaveLength(1)
    expect(verified?.contextId).toBeUndefined()
    expect(verified?.validation).toBeUndefined()
    expect(await client.read<CheckRun[]>(`${s.root}/check-runs`)).toHaveLength(before + 1)
    expect(
      (await client.read<CheckRun[]>(`${s.root}/check-runs`)).find(
        (run) =>
          run.id === (saved.source.kind === 'post-rebase-check' ? saved.source.checkRunId : ''),
      )?.outcome,
    ).toBe('failed')
    return
  }
  const verified = await waitUntil(async () => {
    const cases = await client.read<FailureCase[]>(`${s.root}/failures`)
    return cases[0]?.verifications?.at(-1)
  }, 'fresh verification after incorporated repair recovery')
  expect(verified.checkRunId).toBeDefined()
  if (matchingCoverage) {
    const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
    const fresh = runs.find((run) => run.id === verified.checkRunId)
    expect(fresh?.checks.map(({ name, state }) => ({ name, state }))).toEqual([
      { name: 'Prefix', state: 'passed' },
      { name: 'Tests', state: 'passed' },
    ])
  }
  expect(await client.read<CheckRun[]>(`${s.root}/check-runs`)).toHaveLength(
    before + (state === 'interrupted' ? 2 : 1),
  )
  expect((await client.read<FailureCase[]>(`${s.root}/failures`))[0]?.originalCheck?.state).toBe(
    'failed',
  )
})

test(
  'restart reconstructs a persisted failed execution before its case was recorded, with ordinary and unsafe output',
  async () => {
    const kinds = ['ordinary', 'unsafe output']
    const live = await boot()
    const scenes = await Promise.all(kinds.map(() => walk(live)))
    await ctx.daemon?.stop()
    ctx.daemon = undefined
    const store = await openStore({ directory: tedPaths(ctx.home).store })
    const saved: { run: CheckRun; finished: CheckRun; recoveredLog: string }[] = []
    for (const [i, s] of scenes.entries()) {
      const progress = store.failures.progress(s.task.id)
      expect(progress).toBeDefined()
      if (!progress) throw new Error('Validate progress missing')
      const run = store.startChecks({
        taskId: s.task.id,
        trigger: 'validate',
        stage: 'validate',
        checks: progress.checks.map((check) => ({ ...check, state: 'waiting' })),
      })
      const recoveredLog = path.join(
        tedPaths(ctx.home).logs,
        'checks',
        s.task.displayId,
        run.id,
        '1.log',
      )
      if (kinds[i] === 'unsafe output') {
        await mkdir(path.dirname(recoveredLog), { recursive: true })
        await writeFile(
          recoveredLog,
          'https://example.test/api?token=fixture\nhttps://[redacted]@example.test/api',
        )
      }
      store.checkFinished(run.id, 0, { state: 'failed', exitCode: 1, durationMs: 1 })
      const finished = store.finishChecks(run.id, 'failed')
      store.failures.saveProgress({
        ...progress,
        executions: [
          ...progress.executions,
          { runId: run.id, start: 0, ...(progress.contextId && { contextId: progress.contextId }) },
        ],
        checks: finished.checks,
        next: 0,
        pending: true,
        failureId: undefined,
      })
      saved.push({ run, finished, recoveredLog })
    }
    await store.persisted()
    await store.close()
    const client = await restart()
    await all(kinds, async (kind, i) => {
      const s = scenes[i]
      const made = saved[i]
      if (!s || !made) throw new Error('missing scene')
      const { run, finished, recoveredLog } = made
      const recovered = await waitUntil(async () => {
        const cases = await client.read<FailureCase[]>(`${s.root}/failures`)
        return cases.find(
          (f) => f.source.kind === 'factory-check' && f.source.checkRunId === run.id,
        )
      }, 'reconstructed failure case')
      const obligations = await waitUntil(async () => {
        const value = await client.read<ValidationObligations>(`${s.root}/validation-obligations`)
        return value.progress?.pending === false ? value : undefined
      }, 'recovered diagnosis hold')
      if (kind === 'unsafe output') {
        expect(recovered.evidence).toContain('[unsafe or invalid link omitted]')
        expect(recovered.evidence).toContain(recoveredLog)
        expect(recovered.evidence).not.toContain('token=fixture')
      }
      expect(obligations.progress?.failureId).toBe(recovered.id)
      expect(obligations.progress?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
      expect(obligations.satisfied).toBe(false)
      expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toEqual([])
      expect((await client.read<CheckRun[]>(`${s.root}/check-runs`)).at(-1)).toEqual(finished)
    })
  },
  long,
)

test(
  'restart resumes a persisted Finding Fix once, with and without its send-back recorded',
  async () => {
    const recorded = [false, true]
    const live = await boot()
    const scenes = await Promise.all(
      recorded.map(async () => {
        const s = await walk(live)
        await s.answer(await s.ask(s.one), 'Accept this failure')
        await waitUntil(async () => (await s.obligations()).satisfied, 'Checks complete')
        const context = await s.post<{ id: string }>('/failure-contexts')
        const current = await getTask(s.client, s.task.id)
        const value = await s.post<FailureCase>('/failures', {
          source: { kind: 'finding', runId: current.leadRunId, finding: 'Authorization missing' },
          contextId: context.id,
          evidence: 'A guest can reproduce the protected action.',
        })
        return { s, context, value, decision: await s.ask(value) }
      }),
    )
    await ctx.daemon?.stop()
    ctx.daemon = undefined
    const store = await openStore({ directory: tedPaths(ctx.home).store })
    for (const [i, { s, context, value, decision }] of scenes.entries()) {
      const saved = store.failures.get(value.id)
      const requestId = decision.decisions.at(-1)?.commentId
      const assessmentId = saved?.assessments.at(-1)?.id
      if (!saved || !requestId || !assessmentId) throw new Error('Finding decision missing')
      const at = new Date().toISOString()
      store.resolveFailure(
        {
          ...saved,
          resolutions: [
            ...saved.resolutions,
            { requestId, resolution: 'fix', assessmentId, at, contextId: context.id },
          ],
        },
        requestId,
        { kind: 'answered', at, choice: 'Fix in this Task' },
        [],
      )
      if (recorded[i]) {
        store.recordSendBack({
          taskId: s.task.id,
          from: 'validate',
          to: 'work',
          counted: true,
          round: 1,
          limit: 1,
          findings: `Failure ${saved.id} · Fix request ${requestId}\n\nAuthorization missing\n\nA guest can reproduce the protected action.`,
        })
      }
    }
    await store.persisted()
    await store.close()
    let client = await restart()
    const first: SendBack[][] = []
    await all(recorded, async (_, i) => {
      const s = scenes[i]?.s
      if (!s) throw new Error('missing scene')
      await waitUntil(
        async () =>
          (await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage === 'work',
        'recovered Fix send-back',
      )
      const backs = await client.read<SendBack[]>(`${s.root}/send-backs`)
      expect(backs).toHaveLength(1)
      expect(backs[0]).toMatchObject({ counted: true, round: 1 })
      expect(backs[0]?.findings).toContain('Authorization missing')
      expect(backs[0]?.findings).toContain('A guest can reproduce the protected action.')
      first[i] = backs
    })
    client = await restart()
    await all(recorded, async (_, i) => {
      const s = scenes[i]?.s
      if (!s) throw new Error('missing scene')
      expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toEqual(first[i])
      expect((await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage).toBe(
        'work',
      )
    })
  },
  long,
)

test(
  'restart preserves a handled Fix escalation, answered or not',
  async () => {
    const answered = [false, true]
    const live = await boot()
    const scenes = await Promise.all(
      answered.map(async (answer) => {
        const s = await walk(live)
        await s.assess(s.one, 'regression')
        await s.post('/outcome', { outcome: 'back', to: 'work', findings: s.one.evidence })
        await s.post('/outcome', { outcome: 'advance' })
        const second = await s.failure(2)
        await s.answer(await s.ask(second), 'Fix in this Task')
        const question = await waitUntil(
          async () => {
            const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
            return comments.find((c) => !c.answer && c.title?.includes('its limit'))
          },
          'the limit assessment to ask the human',
          40_000,
        )
        if (answer) {
          expect(
            (
              await s.client.call('POST', `/comments/${question.id}/answer`, {
                action: 'answer',
                text: 'Keep this Task in Validate while I investigate.',
              })
            ).status,
          ).toBe(200)
        }
        return { s, before: await s.client.ok<Comment[]>('GET', `${s.root}/comments`) }
      }),
    )
    const client = await restart()
    await all(scenes, async ({ s, before }) => {
      await waitUntil(
        async () =>
          !(await client.read<Task[]>('/tasks'))
            .find((t) => t.id === s.task.id)
            ?.activity?.startsWith('Running Checks'),
        'Validate recovery to settle',
      )
      const after = await client.read<Comment[]>(`${s.root}/comments`)
      expect(after.filter((c) => c.title?.includes('its limit'))).toEqual(
        before.filter((c) => c.title?.includes('its limit')),
      )
      expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toHaveLength(1)
      expect((await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage).toBe(
        'validate',
      )
    })
  },
  long,
)

test(
  'legacy closures fixed and no-longer-applicable cannot silently close a modern Validate request',
  async () => {
    const resolutions = ['fixed', 'no-longer-applicable']
    const live = await boot([
      '      - { name: Tests, run: "if [ -e stub-repaired ]; then exit 0; else exit 1; fi" }',
      '      - { name: Lint, run: "echo linted" }',
    ])
    const scenes = await Promise.all(
      resolutions.map(async (resolution) => {
        const s = await walk(live)
        const decision = await s.ask(s.one)
        const requestId = decision.decisions.at(-1)?.commentId
        const result = await s.client.call('POST', `${s.root}/failures/${s.one.id}/resolve`, {
          requestId,
          resolution,
          reason: 'Repeat verification after repair.',
        })
        expect(result.status).toBe(409)
        expect((await s.cases())[0]?.resolutions).toEqual([])
        expect((await s.obligations()).satisfied).toBe(false)
        return { s, requestId }
      }),
    )
    const client = await restart()
    await all(scenes, async ({ s, requestId }) => {
      const comments = await client.read<Comment[]>(`${s.root}/comments`)
      expect(comments.find((c) => c.id === requestId)?.answer).toBeUndefined()
      const current = (await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)
      const repo = current?.repos[0]
      if (!repo) throw new Error('Worktree missing')
      await writeFile(path.join(repo.worktree, 'stub-repaired'), 'repaired')
      expect(
        (
          await client.call('POST', `/comments/${requestId}/answer`, {
            action: 'answer',
            choice: 'Retry',
          })
        ).status,
      ).toBe(200)
      await waitUntil(
        async () =>
          (await client.read<ValidationObligations>(`${s.root}/validation-obligations`)).satisfied,
        'fresh verification after rejected closure',
      )
      const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
      expect(runs.map((r) => r.checks.map((c) => c.state))).toEqual([
        ['failed', 'not-run'],
        ['passed', 'passed'],
      ])
    })
  },
  long,
)

test('fresh passing Checks resolve invalidated old acceptance', async () => {
  const s = await setup([
    '      - { name: Tests, run: "grep -q repaired work.txt" }',
    '      - { name: Lint, run: "echo linted" }',
  ])
  expect((await s.answer(await s.ask(s.one), 'Accept this failure')).status).toBe(200)
  await waitUntil(async () => (await s.obligations()).satisfied, 'accepted failure and suffix')
  const current = await getTask(s.client, s.task.id)
  const repo = current.repos[0]
  if (!repo) throw new Error('missing worktree')
  await writeFile(path.join(repo.worktree, 'work.txt'), 'repaired\n')
  await s.post('/checks')
  await waitUntil(async () => (await s.runs()).at(-1)?.outcome === 'passed', 'fresh passing run')
  const result = await s.obligations()
  expect(result.progress?.checks.map((c) => c.state)).toEqual(['passed', 'passed'])
  expect(result.satisfied, JSON.stringify(result)).toBe(true)
})

test('restart reconciles durable passing retry before interrupted suffix', async () => {
  const s = await setup([
    '      - { name: Tests, run: "test -e stub-repaired" }',
    '      - { name: Lint, run: "echo linted" }',
  ])
  const current = await getTask(s.client, s.task.id)
  const repo = current.repos[0]
  if (!repo) throw new Error('missing worktree')
  await writeFile(path.join(repo.worktree, 'stub-repaired'), 'repaired')
  const decision = await s.ask(s.one, 'uncertain')
  await ctx.daemon?.stop()
  ctx.daemon = undefined
  const store = await openStore({ directory: tedPaths(ctx.home).store })
  const saved = store.failures.get(s.one.id)
  const progress = store.failures.progress(s.task.id)
  const requestId = decision.decisions.at(-1)?.commentId
  const assessmentId = saved?.assessments.at(-1)?.id
  if (!saved || !progress?.contextId || !requestId || !assessmentId)
    throw new Error('missing retry state')
  const at = new Date().toISOString()
  store.resolveFailure(
    {
      ...saved,
      resolutions: [
        ...saved.resolutions,
        { requestId, assessmentId, resolution: 'retry', at, contextId: progress.contextId },
      ],
    },
    requestId,
    { kind: 'answered', at, choice: 'Retry' },
    [],
  )
  const run = store.startChecks({
    taskId: s.task.id,
    trigger: 'validate',
    stage: 'validate',
    checks: progress.checks.map((c) => ({ ...c, state: 'waiting' })),
  })
  store.checkFinished(run.id, 0, { state: 'passed', exitCode: 0, durationMs: 1 })
  store.checkStarted(run.id, 1)
  const partial = store.getCheckRun(run.id)
  if (!partial) throw new Error('missing interrupted execution')
  store.failures.saveProgress({
    ...progress,
    checks: partial.checks,
    next: 1,
    pending: true,
    executions: [
      ...progress.executions,
      { runId: run.id, start: 0, contextId: progress.contextId },
    ],
  })
  await store.persisted()
  await store.close()
  const client = await restart()
  await waitUntil(async () => {
    const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
    return runs.at(-1)?.id !== run.id && runs.at(-1)?.outcome === 'passed'
  }, 'resumed suffix passes')
  const result = await client.read<ValidationObligations>(`${s.root}/validation-obligations`)
  expect(result.progress?.checks.map((c) => c.state)).toEqual(['passed', 'passed'])
  expect(result.satisfied, JSON.stringify(result)).toBe(true)
})

test.each(['revert', 'remove', 'replace', 'accepted'])(
  'repair has an evidenced completion path when a Check becomes %s',
  async (kind) => {
    const s = await setup(['      - { name: Tests, run: "test ! -f work.txt" }'])
    const before = await s.obligations()
    await s.assess(s.one, 'regression')
    await s.post('/outcome', {
      outcome: 'back',
      to: 'work',
      findings: 'The work.txt change causes this Check failure.',
    })
    const current = await getTask(s.client, s.task.id)
    const repo = current.repos[0]
    if (!repo) throw Error('missing fixture worktree')
    if (kind === 'revert') await rm(path.join(repo.worktree, 'work.txt'))
    else
      await commitToOrigin(ctx.scratch, {
        '.ted/workflow.yaml': [
          'version: 1',
          'order: [intake, work, validate, review]',
          'stages:',
          ...workGate,
          '  validate:',
          kind === 'remove'
            ? '    checks: []'
            : kind === 'accepted'
              ? '    checks: [{ name: Tests, run: "echo repaired" }, { name: Later, run: "exit 1" }]'
              : '    checks: [{ name: Tests, run: "echo repaired" }]',
          '',
        ].join('\n'),
      })
    await s.post('/outcome', { outcome: 'advance' })
    const result = await waitUntil(async () => {
      const o = await s.obligations()
      return o.progress?.visit !== before.progress?.visit && o.progress?.pending === false
        ? o
        : undefined
    }, 'fresh validation finishes')
    expect(result.progress?.checks.map((c) => c.state)).toEqual(
      kind === 'revert'
        ? ['skipped']
        : kind === 'remove'
          ? []
          : kind === 'accepted'
            ? ['passed', 'failed']
            : ['passed'],
    )
    expect(result.satisfied).toBe(false)
    const original = (await s.runs())[0]
    if (kind === 'accepted') {
      const later = await s.failure(2)
      expect((await s.answer(await s.ask(later), 'Accept this failure')).status).toBe(200)
      await waitUntil(async () => {
        const progress = (await s.obligations()).progress
        return progress && !progress.pending && progress.next === progress.checks.length
      }, 'accepted later failure completes coverage')
    }
    if (kind === 'replace') {
      await writeFile(path.join(repo.worktree, 'work.txt'), 'changed after verification\n')
      expect(
        (
          await s.lead.call('POST', `${s.root}/failures/${s.one.id}/verification`, {
            evidence: 'Cannot close using stale coverage.',
          })
        ).status,
      ).toBe(409)
      const rerun = await s.post<CheckRun>('/checks')
      await waitUntil(async () => {
        const progress = (await s.obligations()).progress
        return progress?.executions.at(-1)?.runId === rerun.id && !progress.pending
      }, 'fresh repaired coverage')
    }
    const verified = await s.post<FailureCase>(`/failures/${s.one.id}/verification`, {
      evidence: `The repair ${kind} makes the previous Check obsolete. The current plan completed; original failure is preserved.`,
    })
    expect(verified.verifications?.at(-1)?.evidence).toContain('Original execution remains failed')
    expect((await s.obligations()).satisfied).toBe(true)
    expect((await s.runs())[0]).toEqual(original)
    await ctx.daemon?.stop()
    ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
    const restarted = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
    const after = await waitUntil(async () => {
      const response = await restarted.call('GET', `${s.root}/validation-obligations`)
      expect(response.status).toBe(200)
      const value = response.body as ValidationObligations
      return value.satisfied ? value : undefined
    }, 'restart reconciles completed validation')
    expect(after.satisfied, JSON.stringify(after)).toBe(true)
    expect(after.progress?.checks.map((c) => c.state)).toEqual(
      result.progress?.checks.map((c) => c.state),
    )
  },
)

test('generated Check evidence survives unsafe links', async () => {
  const command = [
    'echo https://user:password@example.test/api',
    "echo 'https://[redacted]@example.test/api'",
    "echo 'https://['",
    "printf 'https://example.test/path?%s=value' token",
    'exit 1',
  ].join('; ')
  const s = await setup([
    `      - { name: Tests, run: ${JSON.stringify(command)} }`,
    '      - { name: Lint, run: "echo linted" }',
  ])
  expect(s.one.evidence.split('[unsafe or invalid link omitted]').length).toBeGreaterThanOrEqual(5)
  for (const unsafe of ['token=value', 'user:password', '[redacted]@', 'https://['])
    expect(s.one.evidence).not.toContain(unsafe)
  expect(s.one.source.kind).toBe('factory-check')
  expect((await s.obligations()).progress?.pending).toBe(false)
  expect((await s.runs())[0]?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
  expect(await s.backs()).toEqual([])
})

test('sanitized Check metadata retains retry identity and manual evidence remains strict', async () => {
  const s = await setup([
    `      - { name: Tests, run: "if [ -f stub-retry ]; then exit 0; else touch stub-retry; echo https://example.test/api?token=fixture; exit 1; fi" }`,
    '      - { name: Lint, run: "echo linted" }',
  ])
  expect(s.one.originalCheck?.command).toContain('[unsafe or invalid link omitted]')
  expect((await s.runs())[0]?.checks[0]?.command).toContain('token=fixture')
  const unsafe = await s.lead.call('POST', `${s.root}/failures/${s.one.id}/evidence`, {
    evidence: 'https://example.test/api?token=fixture',
  })
  expect(unsafe.status).toBe(400)
  expect((await s.cases())[0]?.additions).toEqual([])
  expect((await s.answer(await s.ask(s.one, 'uncertain'), 'Retry')).status).toBe(200)
  await waitUntil(
    async () => (await s.obligations()).satisfied,
    'retry verifies the authoritative source Check',
  )
  expect((await s.cases())[0]?.verifications).toHaveLength(1)
  expect((await s.runs()).map((r) => r.outcome)).toEqual(['failed', 'passed'])
})

together(
  'accepted reviewer failure keeps its failed judgment, whatever the Task Lead reports',
  Object.fromEntries(
    ['omitted', 'explicit failure', 'explicit pass'].map((judgment) => [
      judgment,
      async (s: Scene) => {
        await s.answer(await s.ask(s.one), 'Accept this failure')
        await waitUntil(async () => (await s.obligations()).satisfied, 'initial Checks resolved')
        const repo = (await getTask(s.client, s.task.id)).repos[0]
        if (!repo) throw Error('Missing worktree')
        const doneFile = path.join(repo.worktree, 'stub-review-done')
        const reviewer = await s.post<SubAgent>('/sub-agents', {
          reviewer: true,
          prompt: JSON.stringify({
            steps: [
              { waitFor: doneFile },
              {
                say: 'Blocking Finding: protected action rejects requests due to unavailable fixture service.',
              },
              { endTurn: true },
            ],
          }),
        })
        await waitUntil(async () => {
          const runs = await s.client.ok<RunSummary[]>('GET', `${s.root}/runs`)
          return runs.find((r) => r.id === reviewer.id)?.state === 'working'
        }, 'reviewer is live')
        const context = await s.post<{ id: string }>('/failure-contexts')
        await writeFile(doneFile, 'continue')
        await waitUntil(async () => {
          const r = await s.lead.call('GET', `/sub-agents/${reviewer.id}/wait?timeoutMs=100`)
          return r.body.done ? r.body : undefined
        }, 'reviewer returns')
        const finding = await s.post<FailureCase>('/failures', {
          source: {
            kind: 'finding',
            runId: reviewer.id,
            finding: 'Protected action verification failed during independent review',
          },
          evidence: 'The unavailable fixture service rejects the protected action.',
          contextId: context.id,
        })
        await s.answer(await s.ask(finding, 'unrelated'), 'Accept this failure')
        expect((await s.obligations()).satisfied).toBe(true)
        if (judgment === 'explicit pass') {
          const denied = await s.lead.call('POST', `${s.root}/outcome`, {
            outcome: 'advance',
            judged: { review: { passed: true } },
          })
          expect(denied.status).toBe(409)
          expect((await getTask(s.client, s.task.id)).stage).toBe('validate')
        }
        await s.post('/outcome', {
          outcome: 'advance',
          ...(judgment !== 'omitted' && { judged: { review: { passed: false } } }),
        })
        const events = await s.client.ok<ThreadEvent[]>('GET', `${s.root}/events`)
        const passed = events.findLast((e) => e.validate === 'passed')
        expect(passed?.judgments, JSON.stringify(passed)).toContainEqual({
          name: 'Review',
          passed: false,
        })
        expect((await getTask(s.client, s.task.id)).stage).toBe('review')
        expect(
          (await s.cases()).find((c) => c.id === finding.id)?.resolutions.at(-1)?.resolution,
        ).toBe('accepted')
      },
    ]),
  ),
)

test(
  'busy Fix through answer and through resolve keeps its request open across restart and sends back only after Checks finish',
  async () => {
    const live = await boot([
      '      - { name: Tests, run: "exit 1" }',
      '      - { name: Later, run: "while [ ! -f stub-release ]; do sleep 0.05; done; echo finished" }',
    ])
    const scenes = await Promise.all(
      ['answer', 'resolve'].map(async (route) => {
        const s = await walk(live)
        const current = await getTask(s.client, s.task.id)
        const repo = current.repos[0]
        if (!repo) throw new Error('missing worktree')
        const context = await s.post<{ id: string }>('/failure-contexts')
        const finding = await s.post<FailureCase>('/failures', {
          source: {
            kind: 'finding',
            runId: current.leadRunId,
            finding: 'Extra verification failed',
          },
          contextId: context.id,
          evidence: 'The fixture service is unavailable.',
        })
        const decision = await s.ask(finding, 'uncertain')
        const requestId = decision.decisions.at(-1)?.commentId
        const endpoint =
          route === 'answer'
            ? `/comments/${requestId}/answer`
            : `${s.root}/failures/${finding.id}/resolve`
        const body =
          route === 'answer'
            ? { action: 'answer', choice: 'Fix in this Task' }
            : { requestId, resolution: 'fix' }
        await s.answer(await s.ask(s.one), 'Accept this failure')
        await waitUntil(
          async () => (await s.runs()).at(-1)?.checks.some((c) => c.state === 'running'),
          'remaining Check running',
        )
        const release = () => writeFile(path.join(repo.worktree, 'stub-release'), 'continue')
        try {
          expect((await s.client.call('POST', endpoint, body)).status).toBe(409)
          expect((await getTask(s.client, s.task.id)).stage).toBe('validate')
          expect(await s.backs()).toEqual([])
          expect((await s.cases()).find((c) => c.id === finding.id)?.resolutions).toEqual([])
          const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
          expect(comments.find((c) => c.id === requestId)?.answer).toBeUndefined()
        } catch (error) {
          await release()
          throw error
        }
        return { s, finding, endpoint, body, release }
      }),
    )
    for (const scene of scenes) await scene.release()
    const client = await restart()
    await all(scenes, async ({ s, finding, endpoint, body }) => {
      await waitUntil(async () => {
        const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
        const task = (await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)
        return runs.at(-1)?.outcome === 'passed' && !task?.activity?.startsWith('Running Checks')
      }, 'remaining verification completes after restart')
      expect((await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage).toBe(
        'validate',
      )
      expect(
        (await client.read<FailureCase[]>(`${s.root}/failures`)).find((c) => c.id === finding.id)
          ?.resolutions,
      ).toEqual([])
      expect((await client.call('POST', endpoint, body)).status).toBe(200)
      expect((await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage).toBe(
        'work',
      )
      expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toMatchObject([
        { counted: true, round: 1 },
      ])
    })
  },
  long,
)

test('restart starts a fresh Validate visit rather than reusing the previous failed visit', async () => {
  const s = await setup()
  const before = await s.runs()
  await s.assess(s.one, 'regression')
  await s.post('/outcome', { outcome: 'back', to: 'work', findings: 'Repair the failed Check.' })
  await ctx.daemon?.stop()
  ctx.daemon = undefined
  const store = await openStore({ directory: tedPaths(ctx.home).store })
  store.changeStage(s.task.id, 'validate', {
    layers: [],
    order: [
      { stage: 'work', enabled: true },
      { stage: 'validate', enabled: true },
      { stage: 'review', enabled: true },
    ],
  })
  const visit = store.listStageEntries(s.task.id).at(-1)?.at
  await store.persisted()
  await store.close()
  const client = await restart()
  await waitUntil(async () => {
    const progress = (await client.read<ValidationObligations>(`${s.root}/validation-obligations`))
      .progress
    return progress && progress.visit === visit && !progress.pending
  }, 'new visit checked')
  const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
  expect(runs).toHaveLength(2)
  expect(runs[0]).toEqual(before[0])
  expect(runs[1]?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
  expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toHaveLength(1)
})

test(
  'busy Retry/Accept through answer and through resolve retain every execution and decision',
  async () => {
    const live = await boot([
      '      - { name: Tests, run: "if [ -e stub-started ]; then while [ ! -e stub-release ]; do sleep 0.05; done; fi; touch stub-started; exit 1" }',
      '      - { name: Later, run: "echo later" }',
    ])
    const scenes = await Promise.all(
      ['answer', 'resolve'].map(async (route) => {
        const s = await walk(live)
        const decision = await s.ask(s.one, 'uncertain')
        const requestId = decision.decisions.at(-1)?.commentId
        const repo = (await getTask(s.client, s.task.id)).repos[0]
        if (!repo) throw new Error('missing worktree')
        await s.post('/checks')
        await waitUntil(
          async () => (await s.runs()).at(-1)?.checks.some((c) => c.state === 'running'),
          'manual rerun running',
        )
        try {
          for (const [choice, resolution] of [
            ['Retry', 'retry'],
            ['Accept this failure', 'accepted'],
          ]) {
            const response =
              route === 'answer'
                ? await s.answer(decision, choice ?? '')
                : await s.client.call('POST', `${s.root}/failures/${s.one.id}/resolve`, {
                    requestId,
                    resolution,
                  })
            expect(response.status).toBe(409)
            expect((await s.runs()).filter((r) => !r.finishedAt)).toHaveLength(1)
            expect(await s.runs()).toHaveLength(2)
            expect((await s.cases()).find((c) => c.id === s.one.id)?.resolutions).toEqual([])
            const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
            expect(comments.find((c) => c.id === requestId)?.answer).toBeUndefined()
          }
        } finally {
          await writeFile(path.join(repo.worktree, 'stub-release'), 'continue')
        }
        const second = await s.failure(2)
        await waitUntil(
          async () => (await s.obligations()).progress?.pending === false,
          'manual rerun recorded',
        )
        expect((await s.runs()).map((r) => r.checks.map((c) => c.state))).toEqual([
          ['failed', 'not-run'],
          ['failed', 'not-run'],
        ])
        expect((await s.obligations()).satisfied).toBe(false)
        await s.answer(await s.ask(second, 'uncertain'), 'Accept this failure')
        await waitUntil(async () => (await s.obligations()).satisfied, 'remaining Check completes')
        return s
      }),
    )
    const client = await restart()
    await all(scenes, async (s) => {
      await waitUntil(
        async () =>
          (await client.read<ValidationObligations>(`${s.root}/validation-obligations`)).satisfied,
        'recovered accepted suffix',
      )
      expect((await client.read<CheckRun[]>(`${s.root}/check-runs`)).map((r) => r.outcome)).toEqual(
        ['failed', 'failed', 'passed'],
      )
      expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toEqual([])
    })
  },
  long,
)

together(
  'accepted visual Finding keeps its failed judgment, whatever the Task Lead reports',
  Object.fromEntries(
    ['omitted', 'explicit failure', 'explicit pass'].map((judgment) => [
      judgment,
      async (s: Scene) => {
        await s.answer(await s.ask(s.one), 'Accept this failure')
        await waitUntil(async () => (await s.obligations()).satisfied, 'Checks resolved')
        const task = await getTask(s.client, s.task.id)
        const context = await s.post<{ id: string }>('/failure-contexts')
        const finding = await s.post<FailureCase>('/failures', {
          source: {
            kind: 'finding',
            runId: task.leadRunId,
            category: 'visual',
            finding: 'Protected action overlaps text',
          },
          evidence: 'The captured screenshot shows overlapping text.',
          contextId: context.id,
        })
        expect(finding.source).toMatchObject({ category: 'visual' })
        await s.answer(await s.ask(finding, 'unrelated'), 'Accept this failure')
        if (judgment === 'explicit pass') {
          const denied = await s.lead.call('POST', `${s.root}/outcome`, {
            outcome: 'advance',
            judged: { visual: { passed: true } },
          })
          expect(denied.status).toBe(409)
          expect((await getTask(s.client, s.task.id)).stage).toBe('validate')
        }
        await s.post('/outcome', {
          outcome: 'advance',
          ...(judgment !== 'omitted' && { judged: { visual: { passed: false } } }),
        })
        const events = await s.client.ok<ThreadEvent[]>('GET', `${s.root}/events`)
        expect(events.findLast((e) => e.validate === 'passed')?.judgments).toContainEqual({
          name: 'Visual',
          passed: false,
        })
        expect((await getTask(s.client, s.task.id)).stage).toBe('review')
      },
    ]),
  ),
)

test('accepted continuation waits for the machine Check slot and keeps its failure history', async () => {
  const s = await setup([
    '      - { name: Tests, run: "if [ ! -e stub-hold ]; then exit 1; fi; touch stub-running; while [ ! -e stub-release ]; do sleep 0.05; done" }',
    '      - { name: Later, run: "echo later" }',
  ])
  await s.client.ok('PATCH', '/settings', { maxChecksAtOnce: 1 })
  const other = await s.client.ok<Task>('POST', '/tasks', {
    title: '{"steps":[{"endTurn":true}]}',
    factory: 'NB',
    start: true,
  })
  const current = await waitUntil(async () => {
    const task = await getTask(s.client, other.id)
    return task.runs[0]?.state === 'idle' && task.repos[0] ? task : undefined
  }, 'other Task Lead ready')
  const repo = current.repos[0]
  if (!repo) throw new Error('missing other worktree')
  await writeFile(path.join(repo.worktree, 'work.txt'), 'implemented\n')
  await writeFile(path.join(repo.worktree, 'stub-hold'), 'hold')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
  for (let i = 0; i < 2; i++) {
    if (i === 1) await lead.call('POST', `/tasks/${other.id}/brief`, brief)
    const response = await lead.call('POST', `/tasks/${other.id}/outcome`, { outcome: 'advance' })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const gate = (response.body as { request?: Comment }).request
    if (gate?.gate) await s.client.ok('POST', `/comments/${gate.id}/answer`, { action: 'approve' })
  }
  await waitUntil(async () => {
    const runs = await s.client.ok<CheckRun[]>('GET', `/tasks/${other.id}/check-runs`)
    return runs.at(-1)?.checks[0]?.state === 'running'
  }, 'other Task holds Check slot')
  try {
    expect((await s.answer(await s.ask(s.one, 'uncertain'), 'Accept this failure')).status).toBe(
      200,
    )
    await waitUntil(async () => (await s.runs()).at(-1)?.waiting, 'accepted suffix waits for slot')
    expect((await s.runs()).at(-1)?.checks.map((c) => c.state)).toEqual(['waiting'])
    expect((await s.obligations()).satisfied).toBe(false)
    expect(await s.backs()).toEqual([])
  } finally {
    await writeFile(path.join(repo.worktree, 'stub-release'), 'continue')
  }
  await waitUntil(async () => (await s.obligations()).satisfied, 'accepted suffix completes')
  expect((await s.runs()).map((r) => r.outcome)).toEqual(['failed', 'passed'])
  expect((await s.runs())[0]?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
})

test('an assessed regression uses the loop check before recording its counted send-back', async () => {
  const s = await setup(undefined, undefined, 1)
  await s.assess(s.one, 'regression')
  await s.post('/outcome', { outcome: 'back', to: 'work', findings: s.one.evidence })
  await waitUntil(
    async () => (await getTask(s.client, s.task.id)).stage === 'work',
    'converging loop send-back',
    40_000,
  )
  expect(await s.backs()).toMatchObject([{ round: 1, counted: true }])
  const runs = await s.client.ok<RunSummary[]>('GET', `${s.root}/runs`)
  expect(runs.filter((run) => run.name === 'Loop check · Validate')).toHaveLength(1)
  const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
  expect(comments.some((comment) => !comment.answer && comment.kind === 'question')).toBe(false)
})
