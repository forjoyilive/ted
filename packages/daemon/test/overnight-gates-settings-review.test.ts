import { describe, expect, test } from 'vitest'
import {
  getTask,
  lines,
  merges,
  run,
  start,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import {
  advance,
  advanceTo,
  begin,
  gateRequests,
  gates,
  kept,
  lateSettingsCommit,
  mergeCard,
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

  test('a Review approval given after the worktree moved on binds nothing', async () => {
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
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: repo?.worktree ?? '' })
    const requested = head.stdout.trim()
    await lateSettingsCommit(repo?.worktree ?? '')
    await verifyCurrent(client, task)

    await client.ok('POST', `/comments/${review?.request.id}/answer`, { action: 'approve' })
    await mergeCard(client, task)
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).repos[0]?.pullRequest?.signedOff).toBe(requested)
  })
})
