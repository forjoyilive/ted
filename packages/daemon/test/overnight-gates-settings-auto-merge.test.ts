import type { FailureCase } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { waitUntil } from './helpers.ts'
import { getTask, merges, readGh, setGh, start, useMergeHarness } from './merge-harness.ts'
import {
  advanceTo,
  begin,
  ci,
  lateSettingsCommit,
  lead,
  mergeCard,
  open,
  overnight,
  plainMerges,
  verifyCurrent,
} from './support/overnight-gates.ts'

useMergeHarness()

describe('Autopilot and a Task that changes .ted/', () => {
  test('GitHub auto-merge is turned off when a .ted/ commit appears while CI is pending', async () => {
    const client = await start({
      ...open,
      files: ci,
      merge: {
        mergeState: 'BLOCKED',
        autoMergeAllowed: true,
        checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
      },
    })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const auto = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.repos[0]?.pullRequest?.autoMerge ? current : undefined
    }, 'auto-merge to be on')
    expect((await readGh()).merge.autoMerge).toBeDefined()
    await lateSettingsCommit(auto.repos[0]?.worktree ?? '')

    await waitUntil(
      async () => (await readGh()).merge.autoMerge === undefined,
      'auto-merge to be turned off',
    )
    expect((await merges()).at(-1)).toContain('--disable-auto')
    await waitUntil(
      async () =>
        (await getTask(client, task.id)).repos[0]?.pullRequest?.autoMerge === undefined ||
        undefined,
      'the Task to record auto-merge as off',
    )

    await verifyCurrent(client, task)
    await setGh({
      mergeState: 'CLEAN',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
    })
    await mergeCard(client, task)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await plainMerges()).toEqual([])
    expect((await readGh()).merge.autoMerge).toBeUndefined()
    expect((await getTask(client, task.id)).stage).toBe('merge')
  })

  test('verified failure history cannot delay disabling auto-merge for a late settings edit', async () => {
    const client = await start({
      ...open,
      files: ci,
      workflow: [
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Tests, run: "n=$(cat stub-runs 2>/dev/null || echo 0); n=$((n+1)); echo $n > stub-runs; [ $n -ne 2 ]" }',
      ],
      merge: {
        mergeState: 'BLOCKED',
        autoMergeAllowed: true,
        checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
      },
    })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    const token = await lead(client, task)
    const post = async <T>(route: string, body = {}): Promise<T> => {
      const res = await token.call('POST', `/tasks/${task.id}${route}`, body)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
      return res.body as T
    }
    await waitUntil(
      async () => (await token.call('POST', `/tasks/${task.id}/checks`, {})).status === 201,
      'the Checks to run again in Validate',
    )
    const finding = await waitUntil(
      async () => (await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)).at(-1),
      'failed Check recorded',
    )
    await post(`/failures/${finding.id}/assessments`, {
      assessment: 'uncertain',
      recommendation: 'Retry the transient fixture failure.',
    })
    const asked = await post<FailureCase>(`/failures/${finding.id}/decision`)
    await client.ok('POST', `/comments/${asked.decisions.at(-1)?.commentId}/answer`, {
      action: 'answer',
      choice: 'Retry',
    })
    await waitUntil(
      async () =>
        (await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)).find(
          (f) => f.id === finding.id,
        )?.verifications?.length,
      'retry verifies the historical failure',
    )
    await advanceTo(client, task, 'merge')
    const auto = await waitUntil(async () => {
      const value = await getTask(client, task.id)
      return value.repos[0]?.pullRequest?.autoMerge ? value : undefined
    }, 'auto-merge enabled')
    await lateSettingsCommit(auto.repos[0]?.worktree ?? '')
    await waitUntil(
      async () => (await readGh()).merge.autoMerge === undefined,
      'auto-merge disabled despite verified failure history',
    )
    expect((await merges()).at(-1)).toContain('--disable-auto')
    const obligations = await client.ok<{ satisfied: boolean }>(
      'GET',
      `/tasks/${task.id}/validation-obligations`,
    )
    expect(obligations.satisfied).toBe(false)
    expect(await plainMerges()).toEqual([])
  }, 90_000)
})
