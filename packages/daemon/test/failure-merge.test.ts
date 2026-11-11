import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type Comment,
  type FailureCase,
  type FailureContext,
  tedPaths,
  type ValidationObligations,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, stubClaudePath, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  merges,
  readGh,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
} from './merge-harness.ts'

useMergeHarness()

async function leadFor(taskId: string, runId: string) {
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(runId))
  const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
    const response = await lead.call('POST', `/tasks/${taskId}${suffix}`, body)
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
    return response.body as T
  }
  return { lead, post }
}

test('a case holds Gate approval without answering it or changing legacy results', async () => {
  const client = await start()
  const { task, signoff } = await toSignoff(client)
  const current = await getTask(client, task.id)
  const { post } = await leadFor(task.id, current.leadRunId ?? '')
  const value = await post<FailureCase>('/failures', {
    source: { kind: 'finding', runId: current.leadRunId, finding: 'A remaining failure' },
    evidence: 'Reproduced',
  })
  await writeFile(client.mergingFile, '')
  expect(
    (await client.call('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })).status,
  ).toBe(409)
  const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
  expect(comments.find((c) => c.id === signoff.id)?.answer).toBeUndefined()
  expect((await getTask(client, task.id)).stage).toBe('review')
  expect(await merges()).toEqual([])
  expect(await client.ok('GET', `/tasks/${task.id}/validation-obligations`)).toMatchObject({
    satisfied: false,
    blockers: [value.id],
  })
})

test('acceptance, obligations and Gate approval each verify worktree edits made while GitHub is pending', async () => {
  const client = await start({ mergePollMs: 60_000 })
  const { task, signoff } = await toSignoff(client)
  await writeFile(client.mergingFile, '')
  const github = await readGh()
  for (const boundary of ['acceptance', 'obligations', 'gate']) {
    const current = await getTask(client, task.id)
    const { post } = await leadFor(task.id, current.leadRunId ?? '')
    const context = await post<FailureContext>('/failure-contexts')
    const value = await post<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Known failure' },
      evidence: 'Observed before editing',
      contextId: context.id,
    })
    await post(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      recommendation: 'Accept in the tested context',
    })
    const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
    const resolve = () =>
      client.call('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
        requestId: asked.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    if (boundary !== 'acceptance') expect((await resolve()).status).toBe(200)
    const entered = path.join(ctx.scratch, 'github-waiting')
    const release = path.join(ctx.scratch, 'github-release')
    await writeFile(
      ctx.ghState,
      JSON.stringify({
        ...(await readGh()),
        graphqlGate: { entered, release, after: boundary === 'acceptance' ? 1 : 0 },
      }),
    )
    const pending =
      boundary === 'acceptance'
        ? resolve()
        : boundary === 'gate'
          ? client.call('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
          : client.call('GET', `/tasks/${task.id}/validation-obligations`)
    try {
      await waitUntil(() => readFile(entered, 'utf8').catch(() => undefined), 'GitHub waiting')
      await writeFile(path.join(current.repos[0]?.worktree ?? '', 'changed.txt'), 'new code')
    } finally {
      await writeFile(release, '')
    }
    const response = await pending
    expect(response.status).toBe(boundary === 'obligations' ? 200 : 409)
    if (boundary === 'obligations') {
      const observed = response.body as ValidationObligations
      expect(observed.satisfied).toBe(false)
      expect(observed.cases.find((c) => c.id === value.id)).toMatchObject({
        disposition: 'invalidated',
      })
    }
    const obligations = await client.ok<ValidationObligations>(
      'GET',
      `/tasks/${task.id}/validation-obligations`,
    )
    expect(obligations).toMatchObject({
      satisfied: false,
      blockers: [value.id],
    })
    expect(
      obligations.cases.find((c) => c.id === value.id),
      boundary,
    ).toMatchObject({
      disposition: boundary === 'acceptance' ? 'unresolved' : 'invalidated',
    })
    const stored = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
    expect(stored.find((c) => c.id === value.id)?.resolutions, boundary).toHaveLength(
      boundary === 'acceptance' ? 0 : 1,
    )
    const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    expect(comments.find((c) => c.id === signoff.id)?.answer).toBeUndefined()
    expect((await getTask(client, task.id)).stage).toBe('review')
    expect(await merges()).toEqual([])
    await rm(path.join(current.repos[0]?.worktree ?? '', 'changed.txt'))
    await post(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      recommendation: 'Close this completed test scenario',
    })
    const closing = await post<FailureCase>(`/failures/${value.id}/decision`)
    await client.ok('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
      requestId: closing.decisions.at(-1)?.commentId,
      resolution: 'no-longer-applicable',
      reason: 'The test edit was removed before the next scenario.',
    })
    expect(await client.ok('GET', `/tasks/${task.id}/validation-obligations`)).toMatchObject({
      satisfied: true,
      blockers: [],
    })
    await writeFile(ctx.ghState, JSON.stringify(github))
    await rm(entered)
    await rm(release)
  }
}, 90_000)

test('opening a case disables TED auto-merge; external merges remain factual and cannot finish the Task', async () => {
  const client = await start({
    files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
    merge: {
      mergeState: 'BLOCKED',
      autoMergeAllowed: true,
      checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
    },
  })
  const { task, signoff } = await toSignoff(client)
  await approve(client, signoff)
  const pending = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.repos[0]?.pullRequest?.autoMerge ? t : undefined
  }, 'TED auto-merge')
  const { post } = await leadFor(task.id, pending.leadRunId ?? '')
  await post('/failures', {
    source: { kind: 'finding', runId: pending.leadRunId, finding: 'Do not merge yet' },
    evidence: 'Explicit hold',
  })
  expect((await readGh()).merge.autoMerge).toBeUndefined()
  expect((await merges()).some((args) => args.includes('--disable-auto'))).toBe(true)
  await setGh({ merged: true })
  await waitUntil(
    async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.state === 'merged',
    'external merge to be recorded',
  )
  expect((await getTask(client, task.id)).stage).toBe('merge')
})

test('a same-SHA CI attempt replacement invalidates acceptance and holds Merge sign-off', async () => {
  const client = await start({
    files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
    merge: { checks: [{ name: 'test', conclusion: 'SUCCESS' }] },
  })
  const { task } = await toSignoff(client)
  const current = await getTask(client, task.id)
  const { post } = await leadFor(task.id, current.leadRunId ?? '')
  const context = await post<FailureContext>('/failure-contexts')
  const value = await post<FailureCase>('/failures', {
    source: { kind: 'finding', runId: current.leadRunId, finding: 'Unrelated failure' },
    evidence: 'Observed',
    contextId: context.id,
  })
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Accept this case',
  })
  const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
  expect(
    (
      await client.call('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
        requestId: asked.decisions[0]?.commentId,
        resolution: 'accepted',
      })
    ).status,
  ).toBe(200)
  await setGh({
    checks: [
      { id: 'replacement', name: 'test', status: 'IN_PROGRESS', startedAt: '2026-11-09T00:00:00Z' },
    ],
  })
  await waitUntil(async () => {
    const cases = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
    return cases[0]?.invalidations.length === 1
  }, 'CI attempt invalidation to persist')
  expect(await client.ok('GET', `/tasks/${task.id}/validation-obligations`)).toMatchObject({
    satisfied: false,
    blockers: [value.id],
  })
})

test('failure holds persist even when GitHub refuses to disable auto-merge', async () => {
  const client = await start({
    files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
    merge: {
      mergeState: 'BLOCKED',
      autoMergeAllowed: true,
      checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
    },
  })
  const { task, signoff } = await toSignoff(client)
  await approve(client, signoff)
  const pending = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.repos[0]?.pullRequest?.autoMerge ? t : undefined
  }, 'auto-merge')
  await setGh({ disableAutoFails: true })
  const { lead } = await leadFor(task.id, pending.leadRunId ?? '')
  expect(
    (
      await lead.call('POST', `/tasks/${task.id}/failures`, {
        source: {
          kind: 'finding',
          runId: pending.leadRunId,
          finding: 'Hold despite GitHub failure',
        },
        evidence: 'Failure remains open',
      })
    ).status,
  ).toBe(502)
  const cases = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
  expect(cases).toHaveLength(1)
  expect(cases[0]?.resolutions).toEqual([])
  const warnings = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
  expect(warnings.some((comment) => comment.body.includes('GitHub may still merge it'))).toBe(true)
  expect((await getTask(client, task.id)).stage).toBe('merge')
  await setGh({ disableAutoFails: false })
  await waitUntil(
    async () => (await readGh()).merge.autoMerge === undefined,
    'auto-merge disable retry',
  )
})

test('a known empty CI rollup permits acceptance while missing and truncated reads revoke it', async () => {
  const client = await start({ merge: { rollup: 'empty' } })
  const { task } = await toSignoff(client)
  await writeFile(client.mergingFile, '')
  const current = await getTask(client, task.id)
  const { post, lead } = await leadFor(task.id, current.leadRunId ?? '')
  const context = await post<FailureContext>('/failure-contexts')
  const value = await post<FailureCase>('/failures', {
    source: { kind: 'finding', runId: current.leadRunId, finding: 'No CI in this repo' },
    evidence: 'Observed locally',
    contextId: context.id,
  })
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Accept',
  })
  const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
  expect(
    (
      await client.call('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
        requestId: asked.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    ).status,
  ).toBe(200)
  for (const rollup of ['missing', 'truncated'] as const) {
    await setGh({ rollup })
    expect((await lead.call('POST', `/tasks/${task.id}/failure-contexts`, {})).status).toBe(409)
    expect(await client.ok('GET', `/tasks/${task.id}/validation-obligations`)).toMatchObject({
      satisfied: false,
      blockers: [value.id],
    })
  }
  await setGh({ rollup: 'empty' })
  const restored = await post<FailureContext>('/failure-contexts')
  expect({
    repos: restored.repos,
    ci: restored.ci,
    checks: restored.checks,
    failed: restored.ciFailures,
  }).toEqual({
    repos: context.repos,
    ci: context.ci,
    checks: context.checks,
    failed: context.ciFailures,
  })
  expect(await client.ok('GET', `/tasks/${task.id}/validation-obligations`)).toMatchObject({
    cases: [{ id: value.id, disposition: 'invalidated', context: 'current' }],
  })
})

test('CI acceptance binds the observed failed attempt and head; historical failures remain unknown', async () => {
  const client = await start()
  const { task } = await toSignoff(client)
  await writeFile(client.mergingFile, '')
  const current = await getTask(client, task.id)
  const { post, lead } = await leadFor(task.id, current.leadRunId ?? '')
  const failed = {
    id: 'failed-attempt',
    name: 'test',
    conclusion: 'FAILURE',
    startedAt: '2026-11-09T00:00:00Z',
    completedAt: '2026-11-09T00:01:00Z',
  }
  await setGh({ checks: [failed] })
  const context = await post<FailureContext>('/failure-contexts')
  expect(context.ciFailures).toHaveLength(1)
  expect(JSON.stringify(context)).not.toContain('failed-attempt')
  const pr = current.repos[0]?.pullRequest
  const source = {
    kind: 'github-ci',
    repo: current.repos[0]?.repo,
    number: pr?.number,
    head: context.repos[0]?.head,
    attempt: `${failed.id}:${failed.startedAt}:${failed.completedAt}`,
  }
  const record = (changed: Record<string, unknown>, contextId?: string) =>
    lead.call('POST', `/tasks/${task.id}/failures`, {
      source: { ...source, ...changed },
      evidence: 'CI execution',
      ...(contextId && { contextId }),
    })
  expect((await record({ head: 'b'.repeat(40) }, context.id)).status).toBe(409)
  expect((await record({ attempt: 'older-attempt' }, context.id)).status).toBe(409)
  const historical = await record({ attempt: 'older-attempt' })
  expect(historical.status).toBe(201)
  const old = historical.body as FailureCase
  expect(old.contextId).toBeUndefined()
  await post(`/failures/${old.id}/assessments`, {
    assessment: 'uncertain',
    recommendation: 'Investigate',
  })
  const oldRequest = await post<FailureCase>(`/failures/${old.id}/decision`)
  expect(
    (
      await client.call('POST', `/tasks/${task.id}/failures/${old.id}/resolve`, {
        requestId: oldRequest.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    ).status,
  ).toBe(409)
  const recorded = await record({}, context.id)
  expect(recorded.status).toBe(201)
  const value = recorded.body as FailureCase
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Accept this attempt',
  })
  const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
  const recaptured = await post<FailureContext>('/failure-contexts')
  expect({
    repos: recaptured.repos,
    ci: recaptured.ci,
    checks: recaptured.checks,
    failed: recaptured.ciFailures,
  }).toEqual({
    repos: context.repos,
    ci: context.ci,
    checks: context.checks,
    failed: context.ciFailures,
  })
  expect(
    (
      await client.call('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
        requestId: asked.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    ).status,
  ).toBe(200)
  await setGh({ checks: [{ ...failed, id: 'replacement-attempt' }] })
  const replacement = await post<FailureContext>('/failure-contexts')
  await post(`/failures/${value.id}/evidence`, {
    evidence: 'A different execution failed',
    contextId: replacement.id,
  })
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'uncertain',
    recommendation: 'Review the replacement',
  })
  const next = await post<FailureCase>(`/failures/${value.id}/decision`)
  expect(
    (
      await client.call('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
        requestId: next.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    ).status,
  ).toBe(409)
})

test('completed acceptance survives background reads, explicit queries and daemon restart', async () => {
  const client = await start()
  const { task, signoff } = await toSignoff(client)
  await writeFile(client.mergingFile, '')
  const current = await getTask(client, task.id)
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
  const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
    const result = await lead.call('POST', `/tasks/${task.id}${suffix}`, body)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
    return result.body as T
  }
  const context = await post<FailureContext>('/failure-contexts')
  const value = await post<FailureCase>('/failures', {
    source: { kind: 'finding', runId: current.leadRunId, finding: 'Known unrelated issue' },
    evidence: 'Observed',
    contextId: context.id,
  })
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Accept',
  })
  const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
  await client.ok('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
    requestId: asked.decisions.at(-1)?.commentId,
    resolution: 'accepted',
  })
  await approve(client, signoff)
  await waitUntil(async () => (await getTask(client, task.id)).stage === 'done', 'Done')
  await rm(client.mergingFile)
  await toSignoff(client)

  const query = `/tasks/${task.id}/validation-obligations`
  expect(await client.ok('GET', query)).toMatchObject({
    satisfied: true,
    cases: [{ id: value.id, disposition: 'accepted', context: 'historical' }],
  })
  const history = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
  expect(history[0]?.invalidations).toEqual([])
  expect(history[0]?.resolutions[0]?.resolution).toBe('accepted')
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    mergePollMs: 100,
  })
  const restarted = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  expect((await restarted.call('GET', query)).body).toMatchObject({
    satisfied: true,
    cases: [{ id: value.id, disposition: 'accepted', context: 'historical' }],
  })
  expect((await restarted.call('GET', `/tasks/${task.id}/failures`)).body).toEqual(history)
}, 90_000)

test('final changed and unavailable acceptance observations each invalidate other cases durably', async () => {
  const client = await start({ mergePollMs: 60000 })
  const { task } = await toSignoff(client)
  await writeFile(client.mergingFile, '')
  const current = await getTask(client, task.id)
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
  const root = `/tasks/${task.id}`
  const post = async <T>(suffix: string, body: unknown = {}) => {
    const r = await lead.call('POST', `${root}${suffix}`, body)
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300)
    return r.body as T
  }
  const context = await post<FailureContext>('/failure-contexts')
  const assess = async (id: string) => {
    await post(`/failures/${id}/assessments`, {
      assessment: 'unrelated',
      recommendation: 'Accept context',
    })
    return post<FailureCase>(`/failures/${id}/decision`)
  }
  const ask = async () => {
    const value = await post<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Known failure' },
      evidence: 'Observed',
      contextId: context.id,
    })
    return assess(value.id)
  }
  const resolve = (v: FailureCase) =>
    client.call('POST', `${root}/failures/${v.id}/resolve`, {
      requestId: v.decisions.at(-1)?.commentId,
      resolution: 'accepted',
    })
  const a = await ask()
  expect((await resolve(a)).status, 'first acceptance of the other case').toBe(200)
  const b = await ask()
  const worktree = current.repos[0]?.worktree ?? '',
    file = path.join(worktree, 'changed.bin'),
    moved = `${worktree}-unavailable`
  let saved: FailureCase[] = []
  for (const [round, observation] of (['changed', 'unavailable'] as const).entries()) {
    if (round > 0)
      expect(
        (await resolve(await assess(a.id))).status,
        `${observation}: the other case is accepted again`,
      ).toBe(200)
    const entered = path.join(ctx.scratch, `entered-${observation}`),
      release = path.join(ctx.scratch, `release-${observation}`)
    await writeFile(
      ctx.ghState,
      JSON.stringify({ ...(await readGh()), graphqlGate: { entered, release, after: 1 } }),
    )
    const pending = resolve(b)
    let altered = false
    try {
      await waitUntil(
        () => readFile(entered, 'utf8').catch(() => undefined),
        `${observation}: final snapshot wait`,
      )
      if (observation === 'changed') await writeFile(file, new Uint8Array([0, 1, 255]))
      else await rename(worktree, moved)
      altered = true
    } finally {
      await writeFile(release, '')
    }
    try {
      expect((await pending).status, observation).toBe(409)
    } finally {
      if (altered) {
        if (observation === 'changed') await rm(file)
        else await rename(moved, worktree)
      }
    }
    saved = await client.ok<FailureCase[]>('GET', `${root}/failures`)
    const other = saved.find((c) => c.id === a.id)
    expect(other?.invalidations, `${observation}: invalidations`).toHaveLength(round + 1)
    expect(other?.resolutions, `${observation}: resolutions`).toHaveLength(round + 1)
    expect(
      other?.resolutions.map((r) => r.requestId),
      `${observation}: every acceptance is invalidated`,
    ).toEqual(other?.invalidations.map((i) => i.requestId))
    expect(
      saved.find((c) => c.id === b.id)?.resolutions,
      `${observation}: the pending case stays unresolved`,
    ).toHaveLength(0)
    expect(other?.evidence, `${observation}: evidence`).toBe(a.evidence)
  }
  await client.ok('POST', `${root}/stop`)
  await ctx.daemon?.stop()
  const directory = path.join(tedPaths(ctx.home).store, 'ted')
  for (const file of await readdir(directory))
    if (file.startsWith('state')) await rm(path.join(directory, file), { force: true })
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    mergePollMs: 60000,
  })
  const replay = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  expect(await replay.call('GET', `${root}/failures`), 'replay').toMatchObject({ body: saved })
  const response = await replay.call('GET', `${root}/validation-obligations`)
  expect(response.status).toBe(200)
  const result = response.body as {
    cases: { id: string; disposition: string; context: string }[]
  }
  expect(result.cases.find((c) => c.id === a.id)).toMatchObject({
    disposition: 'invalidated',
    context: 'current',
  })
}, 60000)
