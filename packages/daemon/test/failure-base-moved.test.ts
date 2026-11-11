import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type Comment,
  type FailureCase,
  type FailureContext,
  type Task,
  tedPaths,
  type ValidationObligations,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { api, commitToOrigin, waitUntil } from './helpers.ts'
import { ctx, getTask, run, start, useMergeHarness } from './merge-harness.ts'

useMergeHarness()

const changedMessage =
  'The Task’s code or Checks changed since this failure was assessed, so it can’t be accepted as it is. Ask the Task Lead to assess it again.'

async function setup() {
  const client = await start({ order: 'intake, work, merge' })
  const task = await client.ok<Task>('POST', '/tasks', {
    title: '{"steps":[{"endTurn":true}]}',
    factory: 'NB',
    start: true,
  })
  const current = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.runs[0]?.state === 'idle' ? t : undefined
  }, 'idle lead')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
  const root = `/tasks/${task.id}`
  async function ok<T>(route: string, body: unknown = {}): Promise<T> {
    const result = await lead.call('POST', root + route, body)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
    return result.body as T
  }
  const capture = () => ok<FailureContext>('/failure-contexts')
  const assess = (value: FailureCase) =>
    ok(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      recommendation: 'Accept for this context',
    })
  const ask = async (value: FailureCase) => {
    await assess(value)
    const asked = await ok<FailureCase>(`/failures/${value.id}/decision`)
    return asked.decisions.at(-1)?.commentId ?? ''
  }
  const evidence = (value: FailureCase, contextId?: string) =>
    ok(`/failures/${value.id}/evidence`, {
      evidence: 'Looked again',
      ...(contextId && { contextId }),
    })
  const context = await capture()
  const value = await ok<FailureCase>('/failures', {
    source: {
      kind: 'finding',
      runId: current.leadRunId,
      finding: 'Original Finding',
      category: 'test',
    },
    evidence: 'Reproduced in the stub',
    contextId: context.id,
  })
  const requestId = await ask(value)
  const answer = (choice: string, text?: string, id = requestId) =>
    client.call('POST', `/comments/${id}/answer`, {
      action: 'answer',
      choice,
      ...(text !== undefined && { text }),
    })
  const moveBase = async () => {
    await commitToOrigin(ctx.scratch, { [`base-${Date.now()}.txt`]: 'Someone else’s work\n' })
    await client.ok('GET', `/factories/${current.factoryId}/settings`)
    const moved = await capture()
    expect(moved.repos[0]?.base).not.toBe(context.repos[0]?.base)
    expect(moved.repos[0]?.head).toBe(context.repos[0]?.head)
    expect(moved.repos[0]?.mergeBase).toBe(context.repos[0]?.mergeBase)
    return moved
  }
  const obligations = () =>
    client.ok<ValidationObligations>('GET', `${root}/validation-obligations`)
  const stored = async () =>
    (await client.ok<FailureCase[]>('GET', `${root}/failures`)).find(
      (v) => v.id === value.id,
    ) as FailureCase
  const git = (...args: string[]) =>
    run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
      cwd: current.repos[0]?.worktree ?? '',
    })
  return {
    client,
    task: current,
    context,
    value,
    requestId,
    lead,
    capture,
    assess,
    evidence,
    comments: () => client.ok<Comment[]>('GET', `${root}/comments`),
    ask,
    answer,
    moveBase,
    obligations,
    stored,
    git,
  }
}

test('Accept this failure works after only the base branch moved, and stays current when it moves again', async () => {
  const s = await setup()
  const question = (await s.comments()).find((c) => c.id === s.requestId)
  expect(question?.choices).toEqual(['Accept this failure', 'Fixed', 'No longer applicable'])
  await s.moveBase()
  const accepted = await s.answer('Accept this failure')
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
  expect((await s.comments()).some((c) => c.title === 'Failure acceptance refused')).toBe(false)
  expect((await s.stored()).resolutions.at(-1)).toMatchObject({
    resolution: 'accepted',
    contextId: s.context.id,
  })
  await s.moveBase()
  expect(await s.obligations()).toMatchObject({
    satisfied: true,
    cases: [{ id: s.value.id, disposition: 'accepted', context: 'current' }],
  })
  expect((await s.stored()).invalidations).toEqual([])
})

test('asking again after the base moved, with evidence that names no context, can still be accepted', async () => {
  const s = await setup()
  await s.moveBase()
  await s.evidence(s.value)
  const again = await s.ask(s.value)
  expect(again).not.toBe(s.requestId)
  expect((await s.stored()).decisions.at(-1)?.contextId).toBe(s.context.id)
  expect((await s.answer('Accept this failure')).status).toBe(409)
  const accepted = await s.answer('Accept this failure', undefined, again)
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
  expect((await s.obligations()).satisfied).toBe(true)
})

test.each(['Fixed', 'No longer applicable'])(
  '%s needs a reason and closes the case after the base branch moved',
  async (choice) => {
    const s = await setup()
    await s.moveBase()
    for (const text of [undefined, '', '   ']) {
      const refused = await s.answer(choice, text)
      expect(refused).toMatchObject({
        status: 400,
        body: { error: 'closing a failure needs a reason' },
      })
    }
    expect((await s.stored()).resolutions).toEqual([])
    const closed = await s.answer(choice, 'A rerun on the new base passed.')
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect((await s.obligations()).satisfied).toBe(true)
  },
)

test.each(['tree', 'head'])(
  'Accept is refused in plain words after the Task’s %s changed',
  async (what) => {
    const s = await setup()
    await s.moveBase()
    if (what === 'tree')
      await writeFile(path.join(s.task.repos[0]?.worktree ?? '', 'edit.txt'), 'New work\n')
    else await s.git('commit', '--allow-empty', '-qm', 'New ancestry')
    expect(await s.answer('Accept this failure')).toMatchObject({
      status: 409,
      body: { error: changedMessage },
    })
    expect((await s.answer('Accept this failure')).status).toBe(409)
    expect((await s.stored()).resolutions).toEqual([])
    const told = await waitUntil(async () => {
      const notes = (await s.comments()).filter((c) => c.title === 'Failure acceptance refused')
      return notes.length > 0 && notes.every((c) => c.delivered !== undefined) ? notes : undefined
    }, 'the Task Lead is told about the refusal')
    expect(told).toHaveLength(1)
    expect(told[0]?.author).toEqual({ kind: 'ted' })
    expect(told[0]?.body).toContain(`ted failure evidence ${s.value.id} --file <json>`)
    expect(told[0]?.body).toContain('"contextId":"<new context ID>"')
    await s.evidence(s.value)
    await s.assess(s.value)
    const stale = await s.lead.call(
      'POST',
      `/tasks/${s.task.id}/failures/${s.value.id}/decision`,
      {},
    )
    expect(stale.status).toBe(409)
    expect((stale.body as { error: string }).error).toContain('ted failure context')
    const fresh = await s.capture()
    await s.evidence(s.value, fresh.id)
    const again = await s.ask(s.value)
    const accepted = await s.answer('Accept this failure', undefined, again)
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
  },
)

test('an acceptance is invalidated when the Task merges the new base in', async () => {
  const s = await setup()
  expect((await s.answer('Accept this failure')).status).toBe(200)
  const moved = await s.moveBase()
  expect((await s.obligations()).satisfied).toBe(true)
  await s.git('merge', '-q', '--no-edit', 'origin/main')
  const merged = await s.client.ok<ValidationObligations>(
    'GET',
    `/tasks/${s.task.id}/validation-obligations`,
  )
  expect(merged).toMatchObject({
    satisfied: false,
    cases: [{ id: s.value.id, disposition: 'invalidated', context: 'changed' }],
  })
  expect(moved.repos[0]?.base).not.toBe(s.context.repos[0]?.base)
  expect((await s.stored()).invalidations.at(-1)?.reason).toBe('Tested context changed')
  const notice = (await s.comments()).find((c) => c.title === 'Failure acceptance invalidated')
  expect(notice?.body).toContain(`ted failure evidence ${s.value.id} --file <json>`)
})
