import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type Comment, DaemonClient, type DaemonEvent, type Task } from '@ted/protocol'
import { expect, onTestFinished, test } from 'vitest'
import { commitToOrigin, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  lines,
  setGh,
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
  '      - name: Stop env',
  '        command: echo run >> stub-cleanup-fail && echo env refused && exit 3',
  '        timeout: 1m',
  '      - name: Prune',
  '        command: echo run >> stub-cleanup-ok',
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

const runs = async (worktree: string, file: string) =>
  (await readFile(path.join(worktree, file), 'utf8')).split('\n').filter(Boolean).length

test('a merged Task goes through Cleanup: blockers are released at the merge, Ted runs the commands before the Task Lead, a failed step asks Try again or Finish anyway, and the worktree goes only at Done', async () => {
  const client = await start({ workflow: workflow('Drop the staging database.') })
  const { task, signoff } = await toSignoff(client)
  const blocked = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
    factory: 'NB',
    start: true,
    blockedBy: [task.id],
  })
  const waiting = await client.ok<Task>('POST', '/tasks', {
    title: 'Waits in Backlog',
    factory: 'NB',
    blockedBy: [task.id],
  })
  const daemon = ctx.daemon
  if (!daemon) throw new Error('no daemon')
  const updates: Task[] = []
  const events = await new DaemonClient(
    { port: daemon.port, token: '', pid: 0, version: 'test' },
    '',
    { appKey: daemon.appToken },
  ).subscribe((event: DaemonEvent) => {
    if (event.type === 'task-updated' && event.task.id === waiting.id) updates.push(event.task)
  })
  onTestFinished(() => events.close())

  await approve(client, signoff)
  await waitForStage(client, task, 'cleanup')
  await waitUntil(
    async () => (await getTask(client, blocked.id)).leadRunId !== undefined,
    'the blocked Task to start at the merge',
  )

  await waitUntil(
    async () => updates.some((t) => !t.markers.some((m) => m.kind === 'blocked-by')),
    'an update releasing the blocked Backlog Task while the first Task is in Cleanup',
  )
  const first = await openFailure(client, task)
  expect(first).toMatchObject({
    author: { kind: 'ted' },
    choices: ['Try again', 'Finish anyway'],
    cleanupFailure: { steps: ['Stop env', 'Drop db'] },
    title: '2 Cleanup steps failed',
  })
  expect(first.body).toContain('Login refused')
  expect(first.body).toContain('it failed with exit code 3')
  const firstThread = await lines(client, task)
  const failedCommand = 'Cleanup command “Stop env”: failed with exit code 3'
  expect(firstThread.indexOf(failedCommand)).toBeGreaterThan(-1)
  expect(firstThread.indexOf(failedCommand)).toBeLessThan(
    firstThread.indexOf('Cleanup command “Prune”: passed'),
  )
  expect(firstThread.indexOf('Cleanup command “Prune”: passed')).toBeLessThan(
    firstThread.indexOf('Cleanup step “Post note”: done'),
  )
  const inCleanup = await getTask(client, task.id)
  const worktree = inCleanup.repos[0]?.worktree ?? ''
  expect(await runs(worktree, 'stub-cleanup-fail')).toBe(1)
  expect(await runs(worktree, 'stub-cleanup-ok')).toBe(1)
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
  expect(second.cleanupFailure).toEqual({ steps: ['Stop env', 'Drop db'] })
  expect(await runs(worktree, 'stub-cleanup-fail')).toBe(2)
  expect(await runs(worktree, 'stub-cleanup-ok')).toBe(1)
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
  expect(thread.filter((line) => line === failedCommand)).toHaveLength(2)
  expect(thread.filter((line) => line === 'Cleanup command “Prune”: passed')).toHaveLength(1)
  expect(thread).toEqual(
    expect.arrayContaining([
      'Cleanup step “Drop db”: failed',
      'Trying the failed Cleanup steps “Stop env”, “Drop db” again',
      'Finished without the failed Cleanup steps “Stop env”, “Drop db”',
    ]),
  )
  const notes = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
  expect(notes.map((c) => c.body)).toContain(
    'The user chose Finish anyway. These Cleanup steps didn’t happen: “Stop env”, “Drop db”.',
  )
})

test('a Cleanup with only commands runs the unfinished ones again after a stop, finishes without a Task Lead turn, and its logs go with the Task', async () => {
  const client = await start({
    workflow: [
      'stages:',
      '  cleanup:',
      '    enabled: true',
      '    steps:',
      '      - name: Wait',
      '        command: until [ -e stub-go ]; do sleep 0.1; done',
      '      - name: Prune',
      '        command: echo run >> stub-cleanup-ok',
    ],
  })
  const { task, signoff } = await toSignoff(client)
  await approve(client, signoff)
  await waitUntil(
    async () => (await getTask(client, task.id)).activity === 'Running Cleanup commands',
    'the Cleanup commands to start',
  )
  const before = await getTask(client, task.id)
  await client.ok('POST', `/tasks/${task.id}/stop`)
  await writeFile(path.join(before.repos[0]?.worktree ?? '', 'stub-go'), '')
  await client.ok('POST', `/tasks/${task.id}/resume`, {})
  await waitForStage(client, task, 'done')

  expect(before.leadRunId).toBeDefined()
  expect((await getTask(client, task.id)).leadRunId).toBe(before.leadRunId)
  const thread = await lines(client, task)
  expect(thread.filter((line) => line === 'Cleanup command “Wait”: passed')).toHaveLength(1)
  expect(thread.filter((line) => line === 'Cleanup command “Prune”: passed')).toHaveLength(1)
  expect(thread.some((line) => line.startsWith('Cleanup step '))).toBe(false)
  const logs = path.join(ctx.home, 'logs', 'checks', task.displayId)
  expect((await readdir(logs)).some((name) => name.startsWith('cleanup-'))).toBe(true)
  await client.ok('POST', `/tasks/${task.id}/delete`, {})
  await expect(readdir(logs)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('Tasks in Cleanup get their Task Lead turn while the computer is busy, whether the Task Lead is idle or has ended, while a new Task stays held', async () => {
  let ratio = 0
  const client = await start({
    workflow: [
      'stages:',
      '  cleanup:',
      '    enabled: true',
      '    steps:',
      '      - name: Wait',
      '        command: until [ -e stub-go ]; do sleep 0.1; done',
      '      - name: Post note',
      '        instruction: |',
      `          ${leadRuns("ted cleanup report 'Post note' done 'Posted' && ted outcome advance")}`,
    ],
    daemon: { load: { ratio: () => ratio, memoryAvailable: () => 1, checkEveryMs: 50 } },
  })
  const { task, signoff } = await toSignoff(client)
  const idle = await getTask(client, task.id)
  await writeFile(path.join(idle.repos[0]?.worktree ?? '', 'stub-go'), '')
  const ended = await toSignoff(client)
  const never = path.join(ctx.scratch, 'never')
  const working = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ waitFor: never }, { endTurn: true }] }),
    factory: 'NB',
    start: true,
  })
  await waitUntil(
    async () => (await getTask(client, working.id)).runs[0]?.state === 'working' || undefined,
    'another Task Lead to hold a working-Run slot',
  )
  ratio = 3
  const held = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
    factory: 'NB',
    start: true,
  })
  await waitUntil(
    async () => ((await getTask(client, held.id)).status?.kind === 'queued' ? true : undefined),
    'the new Task to wait in the queue',
  )
  expect((await getTask(client, held.id)).status).toMatchObject({
    kind: 'queued',
    hold: 'computer is busy',
  })

  await approve(client, signoff)
  await waitForStage(client, task, 'done')

  expect(await lines(client, task)).toContain('Cleanup step “Post note”: done')
  expect((await getTask(client, task.id)).leadRunId).toBe(idle.leadRunId)
  expect((await getTask(client, held.id)).status).toMatchObject({
    kind: 'queued',
    hold: 'computer is busy',
  })

  await setGh({ merged: false })
  await approve(client, ended.signoff)
  await waitUntil(
    async () => (await getTask(client, ended.task.id)).activity === 'Running Cleanup commands',
    'the second Task’s Cleanup commands to start',
  )
  const stopped = await getTask(client, ended.task.id)
  await client.ok('POST', `/tasks/${ended.task.id}/stop`)
  await waitUntil(
    async () =>
      (await client.getRun(stopped.leadRunId ?? '')).run.state === 'finished' || undefined,
    'the second Task Lead’s Run to end',
  )
  await writeFile(path.join(stopped.repos[0]?.worktree ?? '', 'stub-go'), '')
  await client.ok('POST', `/tasks/${ended.task.id}/resume`, {})
  await waitForStage(client, ended.task, 'done')

  expect(await lines(client, ended.task)).toContain('Cleanup step “Post note”: done')
  expect((await getTask(client, ended.task.id)).leadRunId).not.toBe(stopped.leadRunId)
  expect((await getTask(client, held.id)).status).toMatchObject({
    kind: 'queued',
    hold: 'computer is busy',
  })
  expect((await getTask(client, held.id)).runs).toEqual([])
}, 150_000)
