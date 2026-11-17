import { rm } from 'node:fs/promises'
import path from 'node:path'
import { type Comment, type SendBack, type Task, tedPaths } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { api, commitToOrigin, tokenFor, waitUntil } from './helpers.ts'
import {
  approve,
  type Client,
  commitStep,
  ctx,
  getTask,
  lines,
  merges,
  quietGuard,
  readGh,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'
import { ci, comments } from './support/merge-gate.ts'

useMergeHarness()

describe('Merge off', () => {
  test('the Task waits as Waiting for merge, keeps its blocked Tasks waiting, and reaches Done when merged on GitHub', async () => {
    const client = await start({ workflow: ['stages:', '  merge: { enabled: false }'] })
    const { task, signoff } = await toSignoff(client)
    expect(signoff.gate).toEqual({
      approveLabel: 'Approve',
      caption: 'Merge is off for this Factory. You’ll merge on GitHub.',
    })
    const blocked = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
      factory: 'NB',
      start: true,
      blockedBy: [task.id],
    })
    await approve(client, signoff)

    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.status?.kind === 'waiting-for-github' ? current : undefined
    }, 'Waiting for merge')
    expect(waiting.stage).toBe('merge')
    expect(waiting.status).toEqual({ kind: 'waiting-for-github', on: 'merge' })
    expect((await getTask(client, task.id)).repos[0]?.removed).toBeUndefined()
    expect((await getTask(client, blocked.id)).leadRunId).toBeUndefined()

    await setGh({ merged: true })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toEqual([])
    await waitUntil(
      async () => (await getTask(client, blocked.id)).leadRunId !== undefined,
      'the blocked Task to start',
    )
  })
})

function resignoffSteps(client: Client, summary: string) {
  const outcome = `out=$(ted outcome advance --changes '${summary}' 2>&1) || case "$out" in *"asked for changes"*) ted outcome back --to work --findings '${client.findingsFile}';; esac`
  const script = [
    quietGuard(client),
    commitStep.run[2],
    `ted brief write --file '${client.briefFile}'`,
    outcome,
  ].join('\n')
  const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
  return JSON.stringify({ steps: [{ everyMessage: each }, ...each] })
}

describe('Re-sign-off', () => {
  test('a rebase with conflicts brings the Task back through Validate to a short re-sign-off with the changes since approval', async () => {
    const client = await start({ merge: { mergeState: 'BEHIND', rebaseConflict: true } })
    const summary = 'Kept main’s change and moved the guard after it.'
    const task = await client.ok<Task>('POST', '/tasks', {
      title: resignoffSteps(client, summary),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const first = await mergeSignoffOrReview(client, task, 1)
    expect(first.gate?.changes).toBeUndefined()
    await approve(client, first)
    await waitUntil(async () => {
      const text = await lines(client, task)
      return text.some((l) => l.startsWith('Merge sent this back to Work')) ? text : undefined
    }, 'the send-back')
    const [sentBack] = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
    expect(sentBack).toMatchObject({ from: 'merge', cause: 'base-conflict', counted: true })
    await setGh({ mergeState: 'CLEAN', rebaseConflict: false })
    await rm(client.mergingFile)
    await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'Go ahead.' })

    const second = await mergeSignoffOrReview(client, task, 2)
    const name = (await getTask(client, task.id)).repos[0]?.name ?? ''
    expect(second.gate?.approveLabel).toBe('Approve and merge')
    expect(second.gate?.changes?.since).toBe(first.id)
    expect(second.gate?.changes?.summary).toBe(summary)
    const [repo] = second.gate?.changes?.repos ?? []
    expect(repo?.name).toBe(name)
    expect(repo?.files.map((f) => f.path)).toEqual(['work.txt'])
    expect(repo?.files[0]?.added).toBeGreaterThan(0)

    await approve(client, second)
    const done = await waitForStage(client, task, 'done')
    expect((await merges()).at(-1)?.at(-1)).toBe(done.repos[0]?.pullRequest?.signedOff)
  })
})

async function mergeSignoffOrReview(client: Client, task: Task, count: number) {
  const signoffs = await waitUntil(async () => {
    const all = (await comments(client, task)).filter((c) => c.kind === 'signoff')
    return all.length >= count && all[count - 1]?.answer === undefined ? all : undefined
  }, `sign-off ${count}`)
  const found = signoffs[count - 1]
  if (!found) throw new Error('no sign-off')
  return found
}

describe('Sending after sign-off', () => {
  test('Send and cancel merge cancels the merge, turns auto-merge off and counts as Request changes; a Coordinator then marks it done', async () => {
    const clock = new ManualClock()
    const client = await start({
      daemon: { clock },
      files: ci,
      merge: {
        mergeState: 'BLOCKED',
        autoMergeAllowed: true,
        checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
      },
    })
    const { task, signoff } = await toSignoff(client)
    const early = await client.call('POST', `/tasks/${task.id}/mark-done`)
    expect(early.status).toBe(409)
    expect(JSON.stringify(early.body)).toContain('isn’t at Merge')
    await approve(client, signoff)
    const pending = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.repos[0]?.pullRequest?.autoMerge && current.commentBox === 'merge-pending'
        ? current
        : undefined
    }, 'auto-merge and a pending merge')
    expect(pending.commentBox).toBe('merge-pending')

    const plain = await client.call('POST', `/tasks/${task.id}/comments`, { body: 'Wait.' })
    expect(plain.status).toBe(409)
    const port = ctx.daemon?.port ?? 0
    const runToken = (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue(
      pending.leadRunId ?? '',
    )
    const cancel = { comment: 'Not from here.' }
    for (const caller of [api(port, runToken), api(port, await tokenFor(ctx.home))]) {
      const refused = await caller.call('POST', `/tasks/${task.id}/cancel-merge`, cancel)
      expect(refused.status).toBeGreaterThanOrEqual(401)
      expect(refused.status).toBeLessThan(500)
    }

    const posted = await client.ok<Comment>('POST', `/tasks/${task.id}/cancel-merge`, {
      comment: 'Also log empty queries.',
    })
    expect(posted.author).toEqual({ kind: 'human' })
    const canceled = await getTask(client, task.id)
    expect(canceled.commentBox).toBe('live')
    const calls = await merges()
    expect(calls.at(-1)).toContain('--disable-auto')
    expect((await readGh()).merge.autoMerge).toBeUndefined()

    await setGh({
      mergeState: 'CLEAN',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
    })
    await eventWait(clock.subscribe, () => clock.pending.includes(100), 'the GitHub poll to rearm')
    clock.advance(500)
    await eventWait(
      clock.subscribe,
      () => clock.pending.includes(100),
      'the next GitHub poll to finish',
    )
    expect(
      (await merges()).filter((m) => !m.includes('--auto') && !m.includes('--disable-auto')),
    ).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('merge')
    const again = await client.call('POST', `/tasks/${task.id}/cancel-merge`, { comment: 'Again.' })
    expect(again.status).toBe(409)

    for (const caller of [api(port, runToken), api(port, await tokenFor(ctx.home))]) {
      const refused = await caller.call('POST', `/tasks/${task.id}/mark-done`)
      expect(refused.status).toBeGreaterThanOrEqual(401)
      expect(refused.status).toBeLessThan(500)
    }
    const open = await client.call('POST', `/tasks/${task.id}/mark-done`)
    expect(open.status).toBe(409)
    expect(JSON.stringify(open.body)).toContain('acme/widgets#7 is still open on GitHub')
    const unchanged = await getTask(client, task.id)
    expect(unchanged.stage).toBe('merge')
    expect(unchanged.repos[0]?.pullRequest?.state).not.toBe('merged')

    const lead = api(port, runToken)
    const leadOpen = await lead.call('POST', `/tasks/${task.id}/done`)
    expect(leadOpen.status).toBe(409)
    expect(JSON.stringify(leadOpen.body)).toContain('acme/widgets#7 is still open on GitHub')
    const stranger = (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue('no-such-run')
    for (const caller of [api(port, stranger), api(port, await tokenFor(ctx.home))]) {
      const refused = await caller.call('POST', `/tasks/${task.id}/done`)
      expect(refused.status).toBeGreaterThanOrEqual(401)
      expect(refused.status).toBeLessThan(500)
    }

    await commitToOrigin(ctx.scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review, merge]',
        'stages:',
        '  validate:',
        '    checks: [{ name: "Added after the merge", run: "exit 1" }]',
        '',
      ].join('\n'),
    })
    await client.ok('GET', `/factories/${task.factoryId}/settings?refresh=first`)
    const checkRuns = await client.ok<unknown[]>('GET', `/tasks/${task.id}/check-runs`)
    const started = await client.ok<{ id: string; runId: string }>(
      'POST',
      `/factories/${task.factoryId}/coordinator-chats`,
      {
        text: JSON.stringify({ steps: [{ waitFor: path.join(ctx.scratch, 'coordinator') }] }),
        agent: 'claude',
      },
    )
    await waitUntil(async () => {
      const chat = await client.ok<{ started: boolean; status: string }>(
        'GET',
        `/coordinator-chats/${started.id}`,
      )
      return chat.started && chat.status === 'working' ? chat : undefined
    }, 'the Coordinator to start')
    const coordinator = api(
      port,
      (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue(started.runId),
    )
    const read = await coordinator.call('GET', `/coordinator/tasks/${task.id}`)
    const { version } = JSON.parse(
      (read.body as { context: string }).context.split('\n').slice(1, -1).join('\n'),
    ) as { version: string }

    await setGh({ merged: true })
    const answered = await coordinator.call('POST', `/coordinator/tasks/${task.id}/done`, {
      operation: 'done-1',
      version,
    })
    expect(answered.status).toBe(200)
    expect((answered.body as { text: string }).text).toContain('done')
    const marked = await getTask(client, task.id)
    expect(await client.ok<unknown[]>('GET', `/tasks/${task.id}/check-runs`)).toEqual(checkRuns)
    expect(marked.stage).toBe('done')
    expect(marked.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await lines(client, task)).toContain(
      'The Coordinator marked the Task done after its pull requests merged on GitHub',
    )
    const leadAgain = await lead.call('POST', `/tasks/${task.id}/done`)
    expect(leadAgain.status).toBe(200)
    expect((leadAgain.body as Task).stage).toBe('done')
    expect((await client.ok<Task>('POST', `/tasks/${task.id}/mark-done`)).stage).toBe('done')
  })
})

describe('Cancelling when GitHub won’t turn auto-merge off', () => {
  test('the cancel fails closed and Ted keeps trying until auto-merge is off', async () => {
    const client = await start({
      files: ci,
      merge: {
        mergeState: 'BLOCKED',
        autoMergeAllowed: true,
        disableAutoFails: true,
        checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
      },
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)
    await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.repos[0]?.pullRequest?.autoMerge && current.commentBox === 'merge-pending'
    }, 'auto-merge and a pending merge')

    const failed = await client.call('POST', `/tasks/${task.id}/cancel-merge`, {
      comment: 'Stop.',
    })
    expect(failed.status).toBe(502)
    expect(JSON.stringify(failed.body)).toContain('auto-merge is still on for acme/widgets#7')
    const stuck = await getTask(client, task.id)
    expect(stuck.repos[0]?.pullRequest?.autoMerge).toBeDefined()
    expect(stuck.activity).toBe(
      'Merge cancelled · GitHub auto-merge is still on; Ted keeps trying to turn it off',
    )

    await setGh({ disableAutoFails: false })
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.autoMerge === undefined,
      'auto-merge to be turned off',
    )
    expect((await readGh()).merge.autoMerge).toBeUndefined()
  })
})
