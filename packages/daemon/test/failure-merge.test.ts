import { writeFile } from 'node:fs/promises'
import { type Comment, type FailureCase, type FailureContext, tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { api, waitUntil } from './helpers.ts'
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

test('current acceptance remains verifiable between the remote merge and Done', async () => {
  const client = await start()
  const { task, signoff } = await toSignoff(client)
  const current = await getTask(client, task.id)
  const { post } = await leadFor(task.id, current.leadRunId ?? '')
  const context = await post<FailureContext>('/failure-contexts')
  const value = await post<FailureCase>('/failures', {
    source: { kind: 'finding', runId: current.leadRunId, finding: 'Known unrelated failure' },
    evidence: 'Observed in this exact revision',
    contextId: context.id,
  })
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Accept this failure',
  })
  const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
  await writeFile(client.mergingFile, '')
  expect(
    (
      await client.call('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
        requestId: asked.decisions[0]?.commentId,
        resolution: 'accepted',
      })
    ).status,
  ).toBe(200)
  await approve(client, signoff)
  await waitUntil(
    async () => (await getTask(client, task.id)).stage === 'done',
    'Done after accepted case',
  )
  const saved = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
  expect(saved[0]?.invalidations).toEqual([])
  expect(saved[0]?.resolutions[0]?.resolution).toBe('accepted')
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
