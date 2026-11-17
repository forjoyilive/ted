import { rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type Factory, type StageEntry, type Task, tedPaths } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { clonePath } from '../src/factories.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, waitUntil } from './helpers.ts'
import {
  approve,
  type Client,
  ctx,
  getTask,
  merges,
  run,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'
import { ci, comments } from './support/merge-gate.ts'

useMergeHarness()

describe('Merge sign-off', () => {
  test.each(['approve', 'request-changes', 'timeout'] as const)(
    'a Merge sign-off %s waits atomically for a busy Task',
    async (action) => {
      const clock = new ManualClock()
      const client = await start({
        daemon: { clock },
        workflow: ['stages:', '  review: { gate: false }', '  merge: { gate: true }'],
      })
      const { task, signoff } = await toSignoff(client, {}, clock)
      await writeFile(client.mergingFile, '')
      const lead = await waitUntil(async () => (await getTask(client, task.id)).leadRunId, 'a Lead')
      await waitUntil(
        async () => (await client.getRun(lead)).run.state === 'idle',
        'the Lead to go idle, which arms its one-minute nudge timer',
      )
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
      const outcome = runClient.call('POST', `/tasks/${task.id}/outcome`, {
        outcome: 'back',
        to: 'validate',
        findings: 'Hold the Task while Ted fetches.',
      })
      try {
        await waitUntil(
          async () => (await stat(fetching).catch(() => undefined)) !== undefined,
          'a fetch',
          30_000,
        )
        const request = {
          action: action === 'timeout' ? ('approve' as const) : action,
          ...(action === 'request-changes' && { text: 'Not yet.' }),
        }
        const route = `/comments/${signoff.id}/answer`
        const minuteWaits = () => clock.pending.filter((ms) => ms === 60_000).length
        const before = minuteWaits()
        const answers = [client.call('POST', route, request)]
        await eventWait(
          clock.subscribe,
          () => minuteWaits() === before + 1,
          'the sign-off to wait on the held Task',
        )
        if (action === 'approve') {
          answers.push(client.call('POST', route, request))
          await eventWait(
            clock.subscribe,
            () => minuteWaits() === before + 2,
            'both approvals to wait on the held Task',
          )
        }
        clock.advance(15_000)
        expect(
          (await comments(client, task)).find((c) => c.id === signoff.id)?.answer,
        ).toBeUndefined()
        if (action === 'timeout') {
          clock.advance(45_000)
          const [result] = await Promise.all(answers)
          expect(result?.status).toBe(409)
          expect(JSON.stringify(result?.body)).toContain('No answer was applied')
          expect(
            (await comments(client, task)).find((c) => c.id === signoff.id)?.answer,
          ).toBeUndefined()
        } else {
          await rm(gate)
          const results = await Promise.all(answers)
          expect(results.map((r) => r.status).sort()).toEqual(
            action === 'approve' ? [200, 409] : [200],
          )
          if (action === 'approve') {
            expect(JSON.stringify(results.find((r) => r.status === 409)?.body)).toContain(
              'already been answered',
            )
          }
        }
      } finally {
        await rm(gate, { force: true })
        expect((await outcome).status).toBe(409)
      }
      const merge = (await comments(client, task)).filter((c) => c.stage === 'merge')
      expect(merge.map((c) => c.answer?.kind)).toEqual([
        action === 'approve'
          ? 'approved'
          : action === 'request-changes'
            ? 'changes-requested'
            : undefined,
      ])
      if (action === 'approve') {
        await waitUntil(async () => {
          const current = await getTask(client, task.id)
          if (current.stage === 'done') return current
          if (clock.pending.includes(100)) clock.advance(100)
          return undefined
        }, `${task.displayId} to reach done`)
        expect(await merges()).toHaveLength(1)
      } else {
        expect(await merges()).toEqual([])
      }
    },
    60_000,
  )
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

  test('Send to Task Lead sends the Task back to Work without counting against Merge’s limit', async () => {
    const clock = new ManualClock()
    const client = await start({ files: ci, ciStuckMs: stuck, daemon: { clock } })
    const { task, signoff } = await toSignoff(client, {}, clock)
    await approve(client, signoff)
    const merging = await waitForStage(client, task, 'merge')
    const pushed = merging.repos[0]?.pushed?.at
    const entries = await client.ok<StageEntry[]>('GET', `/tasks/${task.id}/stage-entries`)
    const entered = entries.findLast((entry) => entry.stage === 'merge')?.at
    if (!pushed || !entered) throw new Error('missing Merge entry or push time')
    const from = Math.max(Date.parse(pushed), Date.parse(entered))
    await eventWait(clock.subscribe, () => clock.pending.includes(100), 'the GitHub poll to rearm')
    clock.advance(Math.max(0, from + stuck.noChecks + 100 - clock.now()))
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
