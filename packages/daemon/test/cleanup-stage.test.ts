import type { Comment, Task } from '@ted/protocol'
import { expect, test } from 'vitest'
import { commitToOrigin, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  lines,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'

useMergeHarness()

const leadRuns = (script: string) =>
  JSON.stringify({ steps: [{ run: ['sh', '-c', script] }, { endTurn: true }] })

const workflow = (dropDb: string) => [
  'stages:',
  '  cleanup:',
  '    enabled: true',
  '    steps:',
  '      - name: Post note',
  '        instruction: |',
  '          Post the merged link to the tracker.',
  `          ${leadRuns("ted cleanup report 'Post note' done 'Posted the link' && ted cleanup report 'Drop db' failed 'Login refused' && ted outcome advance")}`,
  '      - name: Drop db',
  '        instruction: |',
  `          ${dropDb}`,
]

const openFailure = (client: Awaited<ReturnType<typeof start>>, task: Task, after = '') =>
  waitUntil(
    async () =>
      (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
        (c) => c.cleanupFailure !== undefined && c.answer === undefined && c.createdAt > after,
      ),
    'the Cleanup failure question',
  )

test('a merged Task goes through Cleanup: blockers are released at the merge, a failed step asks Try again or Finish anyway, and the worktree goes only at Done', async () => {
  const client = await start({ workflow: workflow('Drop the staging database.') })
  const { task, signoff } = await toSignoff(client)
  const blocked = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
    factory: 'NB',
    start: true,
    blockedBy: [task.id],
  })

  await approve(client, signoff)
  await waitForStage(client, task, 'cleanup')
  await waitUntil(
    async () => (await getTask(client, blocked.id)).leadRunId !== undefined,
    'the blocked Task to start at the merge',
  )

  const first = await openFailure(client, task)
  expect(first).toMatchObject({
    author: { kind: 'ted' },
    choices: ['Try again', 'Finish anyway'],
    cleanupFailure: { steps: ['Drop db'] },
    title: 'A Cleanup step failed: Drop db',
  })
  expect(first.body).toContain('Login refused')
  const inCleanup = await getTask(client, task.id)
  expect(inCleanup).toMatchObject({ stage: 'cleanup', activity: 'Cleanup failed · waiting on you' })
  expect(inCleanup.repos[0]?.removed).toBeUndefined()
  const markDone = await client.call('POST', `/tasks/${task.id}/mark-done`)
  expect(markDone.status).toBe(409)
  expect(JSON.stringify(markDone.body)).toContain('its Cleanup is running')

  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, validate, review, merge]',
      ...workflow(
        leadRuns("ted cleanup report 'Drop db' failed 'Second try refused' && ted outcome advance"),
      ),
      '',
    ].join('\n'),
  })
  await client.ok('POST', `/comments/${first.id}/answer`, {
    action: 'answer',
    choice: 'Try again',
  })
  const second = await openFailure(client, task, first.createdAt)
  expect(second.body).toContain('Second try refused')
  expect((await getTask(client, task.id)).repos[0]?.removed).toBeUndefined()

  await client.ok('POST', `/comments/${second.id}/answer`, {
    action: 'answer',
    choice: 'Finish anyway',
  })
  await waitForStage(client, task, 'done')
  await waitUntil(
    async () => (await getTask(client, task.id)).repos[0]?.removed !== undefined,
    'the worktree to be removed at Done',
  )
  const thread = await lines(client, task)
  expect(thread.filter((line) => line === 'Cleanup step “Post note”: done')).toHaveLength(1)
  expect(thread).toEqual(
    expect.arrayContaining([
      'Cleanup step “Drop db”: failed',
      'Trying the failed Cleanup step “Drop db” again',
      'Finished without the failed Cleanup step “Drop db”',
    ]),
  )
  const notes = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
  expect(notes.map((c) => c.body)).toContain(
    'The user chose Finish anyway. These Cleanup steps didn’t happen: “Drop db”.',
  )
})
