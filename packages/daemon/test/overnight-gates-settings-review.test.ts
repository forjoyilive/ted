import type { SendBack } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { waitUntil } from './helpers.ts'
import { getTask, lines, merges, start, useMergeHarness, waitForStage } from './merge-harness.ts'
import {
  advance,
  advanceTo,
  begin,
  gateRequests,
  gates,
  kept,
  lateSettingsCommit,
  open,
  overnight,
  row,
  settingsStep,
  verifyCurrent,
} from './support/overnight-gates.ts'

useMergeHarness()

describe('Autopilot and a Task that changes .ted/', () => {
  test('with every sign-off off in the Workflow, it stops for the human before Merge', async () => {
    const client = await start(open)
    await overnight(client, true)
    const task = await begin(client, {}, settingsStep)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'review')
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'review' },
      message: 'Waiting for the human at the Review sign-off. Ted sends you their answer.',
    })
    const [request] = await gateRequests(client, task)
    expect(request?.request.stage).toBe('review')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await merges()).toEqual([])
    expect(await lines(client, task)).toContain(kept('Review'))
    const view = await gates(client, task)
    expect(row(view, 'review')).toMatchObject({ effective: true, required: true })
    expect(view.rows.some((r) => r.overnight)).toBe(false)

    await client.ok('POST', `/comments/${request?.request.id}/answer`, { action: 'approve' })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
  })

  test('the same Task that only edits other files runs to Done unattended', async () => {
    const client = await start(open)
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await gateRequests(client, task)).toEqual([])
    const all = await client.ok<{ gate?: unknown }[]>('GET', `/tasks/${task.id}/comments`)
    expect(all.filter((c) => c.gate !== undefined)).toEqual([])
  })

  test('a Review approval given after the worktree moved on binds nothing, so Ted pushes nothing and sends the Task back to Validate', async () => {
    const client = await start(open)
    await overnight(client, true)
    const task = await begin(client, {}, settingsStep)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'review')
    await advance(client, task)
    const [review] = await gateRequests(client, task)
    const repo = (await getTask(client, task.id)).repos[0]
    expect(repo?.pushed).toBeUndefined()
    await lateSettingsCommit(repo?.worktree ?? '')
    await verifyCurrent(client, task)

    await client.ok('POST', `/comments/${review?.request.id}/answer`, { action: 'approve' })
    const back = await waitUntil(async () => {
      const backs = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      return backs.find((b) => b.from === 'merge')
    }, 'the send-back from Merge')
    expect(back).toMatchObject({ to: 'validate' })
    expect(back.findings).toContain('changed after the human signed it off')
    expect(await merges()).toEqual([])
    const current = await getTask(client, task.id)
    expect(current.repos[0]?.pushed).toBeUndefined()
    expect(current.repos[0]?.pullRequest).toBeUndefined()
  })
})
