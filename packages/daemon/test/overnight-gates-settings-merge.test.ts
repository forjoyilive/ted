import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { waitUntil } from './helpers.ts'
import {
  branchHead,
  getTask,
  lines,
  merges,
  setGh,
  start,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import {
  advance,
  advanceTo,
  begin,
  ci,
  gateRequests,
  kept,
  lateSettingsCommit,
  mergeCard,
  open,
  overnight,
  passed,
  pending,
  settingsStep,
  verifyCurrent,
  waitingForCi,
} from './support/overnight-gates.ts'

useMergeHarness()

describe('Autopilot and a Task that changes .ted/', () => {
  test('a .ted/ commit made after the Review approval is not merged without a new sign-off', async () => {
    const client = await start({ ...open, files: ci, merge: pending })
    await overnight(client, true)
    const task = await begin(client, {}, settingsStep)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'review')
    await advance(client, task)
    const [review] = await gateRequests(client, task)
    await client.ok('POST', `/comments/${review?.request.id}/answer`, { action: 'approve' })
    const waiting = await waitingForCi(client, task)
    const repo = waiting.repos[0]
    const reviewed = repo?.pullRequest?.signedOff
    expect(reviewed).toBeDefined()
    await lateSettingsCommit(repo?.worktree ?? '')
    await verifyCurrent(client, task)

    await setGh(passed)
    const card = await mergeCard(client, task)
    expect(await merges()).toEqual([])
    expect(await lines(client, task)).toContain(kept('Merge'))

    await client.ok('POST', `/comments/${card.request.id}/answer`, { action: 'approve' })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
    expect(await branchHead(repo?.branch ?? '')).toBe(reviewed)
  })

  test('a .ted/ commit that appears after the Task entered Merge holds the merge for sign-off', async () => {
    const client = await start({ ...open, files: ci, merge: pending })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const waiting = await waitingForCi(client, task)
    expect(await gateRequests(client, task)).toEqual([])
    await lateSettingsCommit(waiting.repos[0]?.worktree ?? '')
    await verifyCurrent(client, task)

    await setGh(passed)
    const card = await mergeCard(client, task)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await lines(client, task)).toContain(kept('Merge'))

    await client.ok('POST', `/comments/${card.request.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
  })

  test('a .ted/ commit that lands right before the merge call still gets a Merge sign-off', async () => {
    const flip = { worktree: '', done: false }
    const client = await start({
      ...open,
      files: ci,
      merge: pending,
      daemon: {
        beforeMerge: async () => {
          if (flip.worktree === '' || flip.done) return
          flip.done = true
          await lateSettingsCommit(flip.worktree)
        },
      },
    })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const waiting = await waitingForCi(client, task)
    flip.worktree = waiting.repos[0]?.worktree ?? ''

    await setGh(passed)
    await waitUntil(async () => flip.done, 'late settings edit before the merge')
    await verifyCurrent(client, task)
    await mergeCard(client, task)
    expect(flip.done).toBe(true)
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('merge')
  })

  test('an uncommitted .ted/ edit made at Merge holds the merge for sign-off', async () => {
    const client = await start({ ...open, files: ci, merge: pending })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const waiting = await waitingForCi(client, task)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await writeFile(path.join(waiting.repos[0]?.worktree ?? '', '.ted', 'notes.md'), 'Edited.\n')
    await verifyCurrent(client, task)

    await setGh(passed)
    await mergeCard(client, task)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await merges()).toEqual([])
    expect(await lines(client, task)).toContain(kept('Merge'))
  })
})
