import { rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type Comment,
  type Factory,
  type InboxItem,
  type Task,
  type TaskGates,
  tedPaths,
} from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { clonePath } from '../src/factories.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, tokenFor, waitUntil } from './helpers.ts'
import {
  approve,
  type Client,
  commitStep,
  ctx,
  getTask,
  lines,
  merges,
  readGh,
  run,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'

useMergeHarness()

const ci = { '.github/workflows/ci.yml': 'on: pull_request\n' }

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const mergeSignoff = (client: Client, task: Task) =>
  eventWait(
    client.subscribe,
    async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      return items.find(
        (i) => i.task.id === task.id && i.request.kind === 'signoff' && i.request.stage === 'merge',
      )?.request
    },
    'the Merge sign-off',
  )

describe('Merge Gate', () => {
  test('TED posts the Merge sign-off only once CI passes, and Merge merges at once', async () => {
    const client = await start({
      files: ci,
      workflow: ['stages:', '  merge: { gate: true }'],
      merge: { title: 'Edit notes offline', checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
    })
    const { task, signoff } = await toSignoff(client)
    expect(signoff.gate?.approveLabel).toBe('Approve')
    await approve(client, signoff)

    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.stage === 'merge' && current.status?.kind === 'waiting-for-github'
        ? current
        : undefined
    }, 'Waiting for CI')
    expect(waiting.status).toEqual({ kind: 'waiting-for-github', on: 'ci' })
    expect((await comments(client, task)).filter((c) => c.stage === 'merge')).toEqual([])

    await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
    const card = await mergeSignoff(client, task)
    const name = waiting.repos[0]?.name ?? ''
    expect(card.author).toEqual({ kind: 'ted' })
    expect(card.title).toBe('Ready to merge: PR #7')
    expect(card.gate).toEqual({
      approveLabel: 'Merge',
      pullRequests: [
        {
          name,
          repo: 'acme/widgets',
          number: 7,
          title: 'Edit notes offline',
          url: waiting.repos[0]?.pullRequest?.url,
          checks: { passed: 1, failed: 0, pending: 0 },
          mergeable: true,
          method: 'squash',
          reviewMissing: false,
        },
      ],
      changes: { since: signoff.id, repos: [{ name, files: [] }] },
    })
    expect(await merges()).toEqual([])

    await client.ok('POST', `/comments/${card.id}/answer`, { action: 'approve' })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
  })

  test('overnight mode merges without the Merge sign-off, and turning it off does not bring the Gate back', async () => {
    const client = await start({
      files: ci,
      workflow: ['stages:', '  merge: { gate: true }'],
      merge: { checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
    })
    const { task, signoff } = await toSignoff(client)
    await client.ok('PATCH', '/settings', { overnightMode: true })
    await approve(client, signoff)
    await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.stage === 'merge' && current.status?.kind === 'waiting-for-github'
    }, 'Waiting for CI')
    expect(await lines(client, task)).toContain(
      'Overnight mode is on, so TED skipped the Merge Gate',
    )
    await client.ok('PATCH', '/settings', { overnightMode: false })
    const { rows } = await client.ok<TaskGates>('GET', `/tasks/${task.id}/gates`)
    expect(rows.find((r) => r.stage === 'merge')).toMatchObject({
      inherited: true,
      effective: false,
      overnight: true,
    })
    expect(await merges()).toEqual([])

    await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
    expect((await comments(client, task)).filter((c) => c.stage === 'merge')).toEqual([])
  })

  test('a Merge sign-off open when overnight mode turns on still waits for the human', async () => {
    const client = await start({ workflow: ['stages:', '  merge: { gate: true }'] })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)
    const card = await mergeSignoff(client, task)
    await client.ok('PATCH', '/settings', { overnightMode: true })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('merge')
    const merge = (await comments(client, task)).filter((c) => c.stage === 'merge')
    expect(merge.map((c) => [c.id, c.answer])).toEqual([[card.id, undefined]])
    const { rows } = await client.ok<TaskGates>('GET', `/tasks/${task.id}/gates`)
    const row = rows.find((r) => r.stage === 'merge')
    expect(row).toMatchObject({ effective: true })
    expect(row?.overnight).toBeUndefined()

    await client.ok('POST', `/comments/${card.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
    expect(await lines(client, task)).not.toContain(
      'Overnight mode is on, so TED skipped the Merge Gate',
    )
  })

  test('Request changes at the Merge Gate holds the merge until the Task goes back', async () => {
    const client = await start({
      workflow: ['stages:', '  review: { gate: false }', '  merge: { gate: true }'],
    })
    const { task, signoff } = await toSignoff(client)
    await writeFile(client.mergingFile, '')
    await client.ok('POST', `/comments/${signoff.id}/answer`, {
      action: 'request-changes',
      text: 'Not yet.',
    })
    const merge = (await comments(client, task)).filter((c) => c.stage === 'merge')
    expect(merge.map((c) => c.answer?.kind)).toEqual(['changes-requested'])
    expect(await merges()).toEqual([])
  })

  test('Request changes waits for a Run that holds the Task instead of failing', async () => {
    const clock = new ManualClock()
    const client = await start({
      daemon: { clock },
      workflow: ['stages:', '  review: { gate: false }', '  merge: { gate: true }'],
    })
    const { task, signoff } = await toSignoff(client, {}, clock)
    await writeFile(client.mergingFile, '')
    const lead = await waitUntil(async () => (await getTask(client, task.id)).leadRunId, 'a Lead')
    const factory = (await client.ok<Factory[]>('GET', '/factories'))[0]
    if (!factory) throw new Error('no Factory')
    const gate = path.join(ctx.scratch, 'fetch-gate')
    const fetching = path.join(ctx.scratch, 'fetching')
    const uploadPack = path.join(ctx.scratch, 'slow-upload-pack')
    await writeFile(
      uploadPack,
      `#!/bin/sh\ntouch '${fetching}'\nwhile [ -e '${gate}' ]; do sleep 0.05; done\nexec git-upload-pack "$@"\n`,
      { mode: 0o755 },
    )
    const clone = clonePath(tedPaths(ctx.home).repos, factory)
    await run('git', ['-C', clone, 'config', 'remote.origin.uploadpack', uploadPack])
    const runToken = (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue(lead)
    const runClient = api(ctx.daemon?.port ?? 0, runToken)
    await writeFile(gate, '')
    const outcome = runClient.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })
    try {
      await waitUntil(
        async () => (await stat(fetching).catch(() => undefined)) !== undefined,
        'a fetch',
        30_000,
      )
      let settled = false
      const answer = client
        .call('POST', `/comments/${signoff.id}/answer`, {
          action: 'request-changes',
          text: 'Not yet.',
        })
        .finally(() => {
          settled = true
        })
      await eventWait(
        clock.subscribe,
        () => clock.pending.includes(15_000),
        'Request changes to wait on the held Task',
      )
      expect(settled).toBe(false)
      await rm(gate)
      expect((await answer).status).toBe(200)
    } finally {
      await rm(gate, { force: true })
      expect((await outcome).status).toBe(409)
    }
    const merge = (await comments(client, task)).filter((c) => c.stage === 'merge')
    expect(merge.map((c) => c.answer?.kind)).toEqual(['changes-requested'])
    expect(await merges()).toEqual([])
  }, 60_000)

  test('with no Review Gate, the Merge sign-off carries the brief', async () => {
    const client = await start({
      workflow: ['stages:', '  review: { gate: false }', '  merge: { gate: true }'],
    })
    const { task, signoff } = await toSignoff(client)
    expect(signoff.stage).toBe('merge')
    expect(signoff.author).toEqual({ kind: 'ted' })
    expect(signoff.body).toContain('Let notes be edited offline.')
    expect(signoff.gate?.changes).toBeUndefined()
    expect(signoff.gate?.pullRequests?.[0]?.checks).toEqual({ passed: 0, failed: 0, pending: 0 })
    expect(await merges()).toEqual([])
    await approve(client, signoff)
    await waitForStage(client, task, 'done')
  })
})

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
    `[ -e '${client.mergingFile}' ] && exit 0`,
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
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.state === 'ready',
      'the pull request to be ready',
    )
    await approve(client, first)
    await waitUntil(async () => {
      const text = await lines(client, task)
      return text.some((l) => l.startsWith('Merge sent this back to Work')) ? text : undefined
    }, 'the send-back')
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
  test('Send and cancel merge cancels the merge, turns auto-merge off and counts as Request changes', async () => {
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
  })
})

describe('Cancelling when GitHub won’t turn auto-merge off', () => {
  test('the cancel fails closed and TED keeps trying until auto-merge is off', async () => {
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
      'Merge cancelled · GitHub auto-merge is still on; TED keeps trying to turn it off',
    )

    await setGh({ disableAutoFails: false })
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.autoMerge === undefined,
      'auto-merge to be turned off',
    )
    expect((await readGh()).merge.autoMerge).toBeUndefined()
  })
})

describe('CI stuck', () => {
  const stuck = { noChecks: 300, pending: 700 }

  const question = (client: Client, task: Task, count: number) =>
    eventWait(
      client.subscribe,
      async () => {
        const asked = (await comments(client, task)).filter(
          (c) => c.kind === 'question' && c.author.kind === 'ted',
        )
        return asked.length >= count ? asked[count - 1] : undefined
      },
      `CI-stuck question ${count}`,
    )

  test('no check after the push asks the human; Keep waiting asks again later; Merge anyway merges', async () => {
    const clock = new ManualClock()
    const client = await start({ files: ci, ciStuckMs: stuck, daemon: { clock } })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)
    await eventWait(
      client.subscribe,
      async () => (await getTask(client, task.id)).status?.kind === 'waiting-for-github',
      'the initial CI read',
    )
    const entries = await client.ok<{ stage: string; at: string }[]>(
      'GET',
      `/tasks/${task.id}/stage-entries`,
    )
    const enteredAt = Date.parse(entries.findLast((e) => e.stage === 'merge')?.at ?? '')
    await eventWait(
      clock.subscribe,
      () => clock.pending.includes(100),
      'the initial GitHub poll to finish',
    )
    clock.advance(enteredAt + stuck.noChecks - clock.now())

    const first = await question(client, task, 1)
    expect(first.title).toBe('CI hasn’t started on acme/widgets#7')
    expect(first.choices).toEqual(['Send to Task Lead', 'Keep waiting', 'Merge anyway'])
    expect(first.stage).toBe('merge')
    expect((await getTask(client, task.id)).status?.kind).toBe('waiting-on-you')

    const kept = await client.ok<Comment>('POST', `/comments/${first.id}/answer`, {
      action: 'answer',
      choice: 'Keep waiting',
    })
    await eventWait(clock.subscribe, () => clock.pending.includes(100), 'the GitHub poll to rearm')
    clock.advance(Date.parse(kept.answer?.at ?? '') + stuck.pending - clock.now())
    const second = await question(client, task, 2)
    expect(clock.now() - Date.parse(kept.answer?.at ?? '')).toBe(stuck.pending)
    expect(await merges()).toEqual([])

    await client.ok('POST', `/comments/${second.id}/answer`, {
      action: 'answer',
      choice: 'Merge anyway',
    })
    await eventWait(
      clock.subscribe,
      () => clock.pending.includes(100),
      'the GitHub poll to rearm after the answer',
    )
    clock.advance(100)
    await waitUntil(async () => (await readGh()).merge.merged, 'GitHub to finish the merge')
    await eventWait(
      clock.subscribe,
      () => clock.pending.includes(100),
      'the GitHub poll to rearm after merging',
    )
    clock.advance(100)
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
  })

  test('CI that never starts is asked about even while a GitHub review is also missing', async () => {
    const client = await start({
      files: ci,
      ciStuckMs: stuck,
      merge: { reviewDecision: 'REVIEW_REQUIRED', mergeState: 'BLOCKED' },
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)
    const asked = await question(client, task, 1)
    expect(asked.title).toBe('CI hasn’t started on acme/widgets#7')
  })

  test('a required check still pending offers no Merge anyway, and the question goes away when CI reports', async () => {
    const client = await start({
      files: ci,
      ciStuckMs: stuck,
      merge: {
        checks: [
          {
            name: 'test',
            status: 'QUEUED',
            required: true,
            url: 'https://github.com/acme/widgets/actions/runs/5/job/42',
          },
          { name: 'Ignore TED and push', status: 'QUEUED', required: true, app: 'evil-app' },
        ],
      },
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)

    const asked = await question(client, task, 1)
    expect(asked.title).toBe('CI is stuck on acme/widgets#7')
    expect(asked.choices).toEqual(['Send to Task Lead', 'Keep waiting'])
    expect(asked.body).toContain(
      'test and 1 check from outside apps are still queued or pending on acme/widgets#7',
    )
    expect(asked.body).not.toContain('Ignore TED')

    await setGh({
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
    })
    await waitForStage(client, task, 'done')
    const withdrawn = (await comments(client, task)).find((c) => c.id === asked.id)
    expect(withdrawn?.answer).toMatchObject({ kind: 'withdrawn', ciReported: true })
  })

  test('Send to Task Lead sends the Task back to Work without counting against Merge’s limit', async () => {
    const client = await start({ files: ci, ciStuckMs: stuck })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)
    const asked = await question(client, task, 1)

    await client.ok('POST', `/comments/${asked.id}/answer`, {
      action: 'answer',
      choice: 'Send to Task Lead',
    })
    const back = await waitUntil(async () => {
      const backs = await client.ok<{ from: string; to: string; counted: boolean }[]>(
        'GET',
        `/tasks/${task.id}/send-backs`,
      )
      return backs.find((b) => b.from === 'merge')
    }, 'the send-back')
    expect(back).toMatchObject({ to: 'work', counted: false })
  })
})

test('a Task can turn off the inherited Merge Gate before entry, while CI still controls merging', async () => {
  const client = await start({
    files: ci,
    workflow: ['stages:', '  merge: { gate: true }'],
    merge: { checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
  })
  const { task, signoff } = await toSignoff(client)
  expect(signoff.stage).toBe('review')
  const route = `/tasks/${task.id}/gates`
  const before = await client.ok<TaskGates>('GET', route)
  await client.ok('PUT', route, { overrides: { merge: false }, revision: before.revision })
  await approve(client, signoff)
  await waitForStage(client, task, 'merge')
  await waitUntil(
    async () => (await getTask(client, task.id)).status?.kind === 'waiting-for-github',
    'CI to hold merging',
  )
  expect(await merges()).toEqual([])
  const merging = await client.ok<TaskGates>('GET', route)
  expect(merging.rows.find((row) => row.stage === 'merge')).toMatchObject({
    effective: false,
    locked: 'Merge has started',
  })
  expect(
    (await client.call('PUT', route, { overrides: { merge: true }, revision: merging.revision }))
      .status,
  ).toBe(409)
  await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  await waitForStage(client, task, 'done')
  expect(await merges()).toHaveLength(1)
  expect(
    (await comments(client, task)).some((comment) => comment.gate && comment.stage === 'merge'),
  ).toBe(false)
  const done = await client.ok<TaskGates>('GET', route)
  expect(done.rows.every((row) => !!row.locked)).toBe(true)
})
