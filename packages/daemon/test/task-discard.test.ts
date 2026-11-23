import { rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type Comment, type Factory, type Task, tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { makeOriginRepo, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  ghCalls,
  readGh,
  start,
  toSignoff,
  useMergeHarness,
} from './merge-harness.ts'

useMergeHarness()

test.each(['reset', 'moved'] as const)(
  '%s refuses failed pull request and branch cleanup before discarding Task data',
  { timeout: 90_000 },
  async (verb) => {
    const client = await start({
      files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
      merge: { checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
    })
    const targetOrigin = await makeOriginRepo(path.join(ctx.scratch, 'target'))
    const targetRepo = path.join(path.dirname(targetOrigin), 'target.git')
    await rename(targetOrigin, targetRepo)
    const target = await client.ok<Factory>('POST', '/dev/factories', {
      repo: targetRepo,
      key: 'DEST',
    })
    const { task, signoff } = await toSignoff(client)
    const leadRunId = (await getTask(client, task.id)).leadRunId
    if (!leadRunId) throw new Error('Expected a Task Lead Run')
    const runDir = path.join(tedPaths(ctx.home).runs, leadRunId)
    expect((await stat(runDir)).isDirectory()).toBe(true)
    await approve(client, signoff)
    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.status?.kind === 'waiting-for-github' ? current : undefined
    }, 'the Task to wait for CI')
    const repo = waiting.repos[0]
    if (!repo?.pullRequest) throw new Error('Expected a pull request')
    const route = `repos/${repo.repo}/git/refs/heads/${repo.branch.split('/').map(encodeURIComponent).join('/')}`
    const state = await readGh()
    const request = () =>
      verb === 'reset'
        ? client.call('POST', `/tasks/${task.id}/reset`)
        : client.call('POST', `/tasks/${task.id}/move-to-factory`, { factoryId: target.id })
    const comments = () => client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    const commentIds = async () => (await comments()).map(({ id }) => id)
    const thread = await commentIds()
    expect(thread).toContain(signoff.id)

    await writeFile(ctx.ghState, JSON.stringify({ ...state, pr: { closeFails: 'Close refused' } }))
    expect(await request()).toEqual({
      status: 409,
      body: {
        error: `Ted couldn’t close ${repo.repo}#${repo.pullRequest.number}, so ${task.displayId} wasn’t ${verb}. It is stopped and nothing was discarded.`,
      },
    })
    expect((await getTask(client, task.id)).statuses).toContain('stopped')
    expect((await stat(repo.worktree)).isDirectory()).toBe(true)
    expect((await ghCalls()).some(({ args }) => args.includes(route))).toBe(false)

    await writeFile(
      ctx.ghState,
      JSON.stringify({
        ...state,
        paths: { [route]: { status: 422, message: 'Protected branch' } },
      }),
    )
    expect(await request()).toEqual({
      status: 409,
      body: {
        error: `Ted couldn’t delete the branch ${repo.branch} on ${repo.repo}, so ${task.displayId} wasn’t ${verb}: gh api failed: gh: Protected branch (HTTP 422). It is stopped and its thread is kept.`,
      },
    })
    const kept = await getTask(client, task.id)
    expect(kept).toMatchObject({ factoryId: waiting.factoryId, stage: 'merge' })
    expect(kept.repos[0]?.pullRequest?.state).toBe('closed')
    expect(await commentIds()).toEqual(expect.arrayContaining(thread))

    await writeFile(ctx.ghState, JSON.stringify(state))
    const done = await request()
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    const fresh = await getTask(client, task.id)
    expect(fresh.repos.every((entry) => entry.pullRequest === undefined)).toBe(true)
    if (verb === 'reset') {
      expect(fresh.factoryId).toBe(waiting.factoryId)
      expect(await comments()).toEqual([])
      await expect(stat(runDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(done.body).toMatchObject({ task: { id: task.id, factoryId: target.id } })
      expect(await commentIds()).toEqual(expect.arrayContaining(thread))
      expect((await stat(runDir)).isDirectory()).toBe(true)
    }
  },
)

test('Delete requires hierarchy confirmation and deletes the Task and its descendants', async () => {
  const client = await start()
  const parent = await client.ok<Task>('POST', '/tasks', { factory: 'NB', title: 'Parent' })
  const child = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: 'Child',
    parent: parent.id,
  })
  const url = `/tasks/${parent.id}/delete`
  expect(await client.call('POST', url)).toEqual({
    status: 409,
    body: {
      error: 'Hierarchy changed or was not confirmed; read the hierarchy preview and confirm again',
    },
  })
  const { revision } = await client.ok<{ revision: string }>(
    'GET',
    `/tasks/${parent.id}/hierarchy/preview`,
  )
  await client.ok('POST', url, { hierarchyRevision: revision, children: 'delete' })
  const tasks = await client.ok<Task[]>('GET', '/tasks')
  expect(tasks.map(({ id }) => id)).not.toContain(parent.id)
  expect(tasks.map(({ id }) => id)).not.toContain(child.id)
}, 30_000)
