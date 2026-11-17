import { writeFile } from 'node:fs/promises'
import type { Comment, FailureCase } from '@ted/protocol'
import { expect, test } from 'vitest'
import { waitUntil } from './helpers.ts'
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
import { leadFor } from './support/failure-merge.ts'

useMergeHarness()

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

test('opening a case disables Ted auto-merge and a good read clears an earlier sign-in wait; external merges remain factual and cannot finish the Task', async () => {
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
  }, 'Ted auto-merge')
  const waitingOn = async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.waiting
  await writeFile(ctx.ghState, JSON.stringify({ ...(await readGh()), api: { result: 'auth' } }))
  await waitUntil(async () => (await waitingOn()) === 'sign-in', 'the sign-in wait')
  const { post } = await leadFor(task.id, pending.leadRunId ?? '')
  await post('/failures', {
    source: { kind: 'finding', runId: pending.leadRunId, finding: 'Do not merge yet' },
    evidence: 'Explicit hold',
  })
  await writeFile(ctx.ghState, JSON.stringify({ ...(await readGh()), api: undefined }))
  await waitUntil(async () => (await waitingOn()) !== 'sign-in', 'the sign-in wait to clear')
  expect((await readGh()).merge.autoMerge).toBeUndefined()
  expect((await merges()).some((args) => args.includes('--disable-auto'))).toBe(true)
  await setGh({ merged: true })
  await waitUntil(
    async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.state === 'merged',
    'external merge to be recorded',
  )
  expect((await getTask(client, task.id)).stage).toBe('merge')
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
