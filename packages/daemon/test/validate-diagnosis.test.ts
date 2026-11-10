import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CheckRun,
  Comment,
  FailureCase,
  SendBack,
  Task,
  ValidationObligations,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { api, stubClaudePath, waitUntil } from './helpers.ts'
import { ctx, getTask, start, useMergeHarness } from './merge-harness.ts'

useMergeHarness()

async function setup(
  checks = [
    '      - { name: Tests, run: "echo broken; exit 1" }',
    '      - { name: Lint, run: "echo linted" }',
  ],
  order = 'intake, work, validate, review',
) {
  const client = await start({
    order,
    workflow: ['stages:', '  validate:', '    max_back: 1', '    checks:', ...checks],
  })
  const task = await client.ok<Task>('POST', '/tasks', {
    title: '{"steps":[{"endTurn":true}]}',
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
  const post = async <T>(route: string, body = {}): Promise<T> => {
    const res = await lead.call('POST', root + route, body)
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
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

test('a failed Check stays in Validate with evidence and no send-back; acceptance continues remaining Checks', async () => {
  const s = await setup()
  expect((await getTask(s.client, s.task.id)).stage).toBe('validate')
  expect(await s.backs()).toEqual([])
  expect(s.one.evidence).toContain('broken')
  expect(s.one.contextId).toBeTruthy()
  expect((await s.runs())[0]?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
  expect((await s.lead.call('POST', `${s.root}/outcome`, { outcome: 'advance' })).status).toBe(409)
  const decision = await s.ask(s.one)
  const comment = (await s.client.ok<Comment[]>('GET', `${s.root}/comments`)).find(
    (c) => c.id === decision.decisions.at(-1)?.commentId,
  )
  expect(comment?.choices).toEqual(['Retry', 'Fix in this Task', 'Accept this failure'])
  expect((await s.answer(decision, 'Accept this failure')).status).toBe(200)
  await waitUntil(async () => (await s.obligations()).satisfied, 'remaining Checks completed')
  const runs = await s.runs()
  expect(runs.map((r) => r.checks.map((c) => c.state))).toEqual([['failed', 'not-run'], ['passed']])
  expect((await s.obligations()).progress?.checks.map((c) => c.state)).toEqual(['failed', 'passed'])
  expect(await s.backs()).toEqual([])
  expect((await s.answer(decision, 'Accept this failure')).status).toBe(409)
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

test('Retry failing creates a new independent failure requiring reassessment', async () => {
  const s = await setup()
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
})

test('human Fix uses the counted send-back path with assessment and evidence', async () => {
  const s = await setup()
  expect((await s.answer(await s.ask(s.one), 'Fix in this Task')).status).toBe(200)
  expect((await getTask(s.client, s.task.id)).stage).toBe('work')
  expect(await s.backs()).toMatchObject([{ counted: true, round: 1, from: 'validate', to: 'work' }])
  expect((await s.backs())[0]?.findings).toContain('Assessment: unrelated')
})

test('changed context refuses stale acceptance without answering the request', async () => {
  const s = await setup()
  const decision = await s.ask(s.one)
  const task = await getTask(s.client, s.task.id)
  const repo = task.repos[0]
  if (!repo) throw new Error('missing worktree')
  await writeFile(path.join(repo.worktree, 'work.txt'), 'changed again\n')
  expect((await s.answer(decision, 'Accept this failure')).status).toBe(409)
  expect((await s.obligations()).satisfied).toBe(false)
  expect(await s.backs()).toEqual([])
})

test('a regression assessment uses the existing send-back path and preserves max_back', async () => {
  const s = await setup()
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
  const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
  expect(comments.some((c) => !c.answer && c.title?.includes('its limit'))).toBe(true)
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

test('extra Findings stay blocking after Retry until fresh verification evidence is recorded', async () => {
  const s = await setup()
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
})

test('a new execution cannot inherit an earlier failure’s acceptance', async () => {
  const s = await setup()
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
})

async function restart() {
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  return {
    ...client,
    async read<T>(route: string): Promise<T> {
      const response = await client.call('GET', route)
      expect(response.status).toBe(200)
      return response.body as T
    },
  }
}

test('restart reconstructs a persisted failed execution before its case was recorded and preserves remaining Checks', async () => {
  const s = await setup()
  await ctx.daemon?.stop()
  ctx.daemon = undefined
  const store = await openStore({ directory: tedPaths(ctx.home).store })
  const progress = store.failures.progress(s.task.id)
  expect(progress).toBeDefined()
  if (!progress) throw new Error('Validate progress missing')
  const run = store.startChecks({
    taskId: s.task.id,
    trigger: 'validate',
    stage: 'validate',
    checks: progress.checks.map((check) => ({ ...check, state: 'waiting' })),
  })
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
  await store.persisted()
  await store.close()
  const client = await restart()
  const recovered = await waitUntil(async () => {
    const cases = await client.read<FailureCase[]>(`${s.root}/failures`)
    return cases.find((f) => f.source.kind === 'factory-check' && f.source.checkRunId === run.id)
  }, 'reconstructed failure case')
  const obligations = await waitUntil(async () => {
    const value = await client.read<ValidationObligations>(`${s.root}/validation-obligations`)
    return value.progress?.pending === false ? value : undefined
  }, 'recovered diagnosis hold')
  expect(obligations.progress?.failureId).toBe(recovered.id)
  expect(obligations.progress?.checks.map((c) => c.state)).toEqual(['failed', 'not-run'])
  expect(obligations.satisfied).toBe(false)
  expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toEqual([])
  expect((await client.read<CheckRun[]>(`${s.root}/check-runs`)).at(-1)).toEqual(finished)
})

test.each([false, true])(
  'restart resumes a persisted Finding Fix once (send-back recorded: %s)',
  async (recorded) => {
    const s = await setup()
    await s.answer(await s.ask(s.one), 'Accept this failure')
    await waitUntil(async () => (await s.obligations()).satisfied, 'Checks complete')
    const context = await s.post<{ id: string }>('/failure-contexts')
    const current = await getTask(s.client, s.task.id)
    const value = await s.post<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Authorization missing' },
      contextId: context.id,
      evidence: 'A guest can reproduce the protected action.',
    })
    const decision = await s.ask(value)
    await ctx.daemon?.stop()
    ctx.daemon = undefined
    const store = await openStore({ directory: tedPaths(ctx.home).store })
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
    if (recorded) {
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
    await store.persisted()
    await store.close()
    let client = await restart()
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
    client = await restart()
    expect(await client.read<SendBack[]>(`${s.root}/send-backs`)).toEqual(backs)
    expect((await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage).toBe(
      'work',
    )
  },
)

test.each([false, true])(
  'restart preserves a handled Fix escalation (answered: %s)',
  async (answered) => {
    const s = await setup()
    await s.assess(s.one, 'regression')
    await s.post('/outcome', { outcome: 'back', to: 'work', findings: s.one.evidence })
    await s.post('/outcome', { outcome: 'advance' })
    const second = await s.failure(2)
    await s.answer(await s.ask(second), 'Fix in this Task')
    const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
    const question = comments.find((c) => !c.answer && c.title?.includes('its limit'))
    if (!question) throw new Error('Send-back limit question missing')
    if (answered) {
      expect(
        (
          await s.client.call('POST', `/comments/${question.id}/answer`, {
            action: 'answer',
            text: 'Keep this Task in Validate while I investigate.',
          })
        ).status,
      ).toBe(200)
    }
    const before = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
    const client = await restart()
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
  },
)

test.each(['fixed', 'no-longer-applicable'])(
  'legacy closure %s cannot silently close a modern Validate request',
  async (resolution) => {
    const s = await setup([
      '      - { name: Tests, run: "if [ -e stub-repaired ]; then exit 0; else exit 1; fi" }',
      '      - { name: Lint, run: "echo linted" }',
    ])
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
    const client = await restart()
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
  },
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
