import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Task } from '@ted/protocol'
import { expect, test } from 'vitest'
import { waitUntil } from './helpers.ts'
import { getTask, merges, readGh, setGh, useMergeHarness } from './merge-harness.ts'
import {
  ask,
  cases,
  comments,
  failed,
  long,
  obligations,
  polls,
  rebased,
  resolve,
  restart,
  runs,
} from './support/merge-check-decisions.ts'

useMergeHarness()

test(
  'a pending post-rebase decision survives restart without rerunning, then acceptance continues its suffix',
  async () => {
    const initial = await rebased()
    const { task, failure } = initial
    const request = await ask(initial.client, task, failure)
    const client = await restart(initial.client)
    await polls(client)
    expect(await runs(client, task)).toHaveLength(1)
    expect(
      (await comments(client, task)).filter((c) => c.kind === 'question' && !c.answer),
    ).toHaveLength(1)
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
    await failed(client, task, 2)
    expect(await runs(client, task)).toHaveLength(2)
    expect(await merges()).toEqual([])
  },
  long,
)

test(
  'accepted local failures survive restart at the Merge sign-off and never bypass required GitHub Checks',
  async () => {
    const initial = await rebased(true, true)
    const { task, failure } = initial
    const t = await getTask(initial.client, task.id)
    await writeFile(path.join(t.repos[0]?.worktree ?? '', 'stub-later-fixed'), '')
    const request = await ask(initial.client, task, failure)
    expect((await resolve(initial.client, task, failure, request, 'accepted')).status).toBe(200)
    await waitUntil(
      async () =>
        (await comments(initial.client, task)).find(
          (c) => c.stage === 'merge' && c.kind === 'signoff' && !c.answer,
        ),
      'Merge sign-off',
    )
    const client = await restart(initial.client)
    const before = (await runs(client, task)).length
    await polls(client)
    expect(await runs(client, task)).toHaveLength(before)
    expect((await obligations(client, task)).satisfied).toBe(true)
    expect(await merges()).toEqual([])
    await setGh({
      mergeState: 'BLOCKED',
      checks: [{ name: 'Required', status: 'IN_PROGRESS', required: true }],
      autoMergeAllowed: true,
    })
    await polls(client)
    expect((await obligations(client, task)).satisfied).toBe(false)
    expect(await merges()).toEqual([])
    expect((await readGh()).merge.autoMerge).toBeUndefined()
  },
  long,
)

test(
  'a Merge Check decision reuses the shared repair wait and remains held across restart',
  async () => {
    const initial = await rebased()
    const { task, failure } = initial
    const request = await ask(initial.client, task, failure)
    const repair = await initial.client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: 'Repair the existing base Check failure',
    })
    const response = await initial.client.call(
      'POST',
      `/tasks/${task.id}/failures/${failure.id}/resolve`,
      {
        requestId: request,
        resolution: 'repair',
        repair: { kind: 'existing', taskId: repair.id },
      },
    )
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const waiting = await getTask(initial.client, task.id)
    expect(waiting.stage).toBe('merge')
    expect(waiting.blockedBy).toContain(repair.id)
    const client = await restart(initial.client)
    await polls(client)
    expect(await runs(client, task)).toHaveLength(1)
    expect(
      (await cases(client, task)).find((value) => value.id === failure.id)?.resolutions.at(-1),
    ).toMatchObject({
      resolution: 'repair',
      repairTask: { id: repair.id },
    })
    expect((await obligations(client, task)).satisfied).toBe(false)
    expect(await merges()).toEqual([])
  },
  long,
)
