import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckRun, FailureCase, Task } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { api, commitToOrigin, waitUntil } from './helpers.ts'
import { ctx, getTask, run, useMergeHarness } from './merge-harness.ts'
import { backInValidate, long, restart, setup } from './support/validate-diagnosis.ts'

useMergeHarness()

test.each(
  (['validate', 'merge'] as const).flatMap((stage) =>
    [
      ...(['retained', 'reset', 'held', 'interrupted'] as const),
      ...(stage === 'validate'
        ? (['complete', 'prefix'] as const)
        : (['replaced', 'retry', 'accept'] as const)),
    ].map((state) => ({ stage, state })),
  ),
)(
  '$stage restart after persisted repair incorporation: $state',
  async ({ stage, state }) => {
    const matchingCoverage = state === 'complete' || state === 'prefix'
    const continuation = state === 'retry' || state === 'accept'
    const s = await setup(
      [
        ...(matchingCoverage ? ['      - { name: Prefix, run: "true" }'] : []),
        continuation
          ? '      - { name: Tests, run: "test -f timezone.txt && test -f stub-repair-passes" }'
          : '      - { name: Tests, run: "test -f timezone.txt" }',
        ...(continuation ? ['      - { name: Later, run: "true" }'] : []),
      ],
      'intake, work, validate, review, merge',
      false,
      state === 'replaced' || continuation,
    )
    const decision = state === 'replaced' ? undefined : await s.ask(s.one)
    const task = await getTask(s.client, s.task.id)
    const repo = task.repos[0]
    if (!repo) throw new Error('missing worktree')
    await ctx.daemon?.stop()
    ctx.daemon = undefined
    const store = await openStore({ directory: tedPaths(ctx.home).store })
    if (stage === 'merge') store.changeStage(task.id, 'merge')
    else backInValidate(store, task.id)
    const originalFailure = store.failures.get(s.one.id)
    if (!originalFailure) throw new Error('missing original failure')
    let saved: FailureCase = originalFailure
    let requestId = decision?.decisions.at(-1)?.commentId
    if (state === 'replaced') {
      const original = saved.originalCheck
      if (!original) throw new Error('missing failed Check')
      const failed = store.startChecks({
        taskId: task.id,
        stage: 'merge',
        trigger: 'merge',
        checks: [{ ...original, state: 'not-run' }],
      })
      store.checkFinished(failed.id, 0, { state: 'failed', exitCode: 1, durationMs: 1 })
      store.finishChecks(failed.id, 'failed')
      const originalCheck = store.getCheckRun(failed.id)?.checks[0]
      if (!originalCheck) throw new Error('missing failed Merge Check')
      const recorded = store.failures.save(
        {
          id: randomUUID(),
          taskId: task.id,
          recordedBy: task.leadRunId ?? 'ted',
          provenance: 'stored-check',
          source: { kind: 'post-rebase-check', checkRunId: failed.id, position: 0 },
          originalCheck,
          evidence: 'The post-rebase export Check failed before the separate repair.',
          createdAt: new Date().toISOString(),
          assessments: [],
          additions: [],
          decisions: [],
          resolutions: [],
          invalidations: [],
        },
        'recorded',
      )
      const assessed = store.failures.save(
        {
          ...recorded,
          assessments: [
            {
              id: randomUUID(),
              runId: recorded.recordedBy,
              at: new Date().toISOString(),
              assessment: 'unrelated',
              recommendation: 'Wait for a separate export repair.',
            },
          ],
        },
        'assessed',
      )
      saved = store.postFailureDecision(assessed, 'Wait for a separate export repair.', false)
      requestId = saved.decisions.at(-1)?.commentId
    }
    const assessment = saved.assessments.at(-1)
    if (!requestId || !assessment) throw new Error('missing repair decision')
    const resolvedAt = new Date().toISOString()
    const resolved = {
      ...saved,
      resolutions: [
        ...saved.resolutions,
        {
          requestId,
          assessmentId: assessment.id,
          resolution: 'repair' as const,
          at: resolvedAt,
          ...(assessment.contextId && { contextId: assessment.contextId }),
          repair: { kind: 'existing' as const, taskId: 'merged-repair' },
          repairTask: { id: 'merged-repair', displayId: 'NB-2', title: 'Merged repair' },
        },
      ],
    }
    store.resolveFailure(
      resolved,
      requestId,
      { kind: 'answered', at: resolvedAt, choice: 'Wait for a repair Task' },
      [],
    )
    await writeFile(path.join(repo.worktree, 'timezone.txt'), 'restored\n')
    const releaseChecks = path.join(ctx.scratch, 'release-replacement-checks')
    if (state === 'replaced') {
      const file = path.join(repo.worktree, '.ted/workflow.yaml')
      const { readFile } = await import('node:fs/promises')
      const workflow = (await readFile(file, 'utf8'))
        .replace('name: Tests', 'name: Repaired export')
        .replace(
          JSON.stringify('test -f timezone.txt'),
          JSON.stringify(
            `test -f timezone.txt && while [ ! -f '${releaseChecks}' ]; do sleep 0.02; done`,
          ),
        )
      await writeFile(file, workflow)
      await commitToOrigin(ctx.scratch, { '.ted/workflow.yaml': workflow })
      await run('git', ['add', '.ted/workflow.yaml'], { cwd: repo.worktree })
    }
    await run('git', ['add', 'timezone.txt', 'work.txt'], { cwd: repo.worktree })
    await run(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-qm',
        'incorporated repair',
      ],
      { cwd: repo.worktree },
    )
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo.worktree })).stdout.trim()
    const at = new Date().toISOString()
    store.failures.save(
      {
        ...resolved,
        repairProgress: [{ requestId, at, repos: [{ repo: repo.repo, head, onto: head }] }],
      },
      'repair',
    )
    if (matchingCoverage) {
      const progress = store.failures.progress(task.id)
      if (!progress?.coverage) throw new Error('missing previous Check coverage')
      const tree = (
        await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo.worktree })
      ).stdout.trim()
      const previous = JSON.parse(progress.coverage)
      store.failures.saveProgress({
        ...progress,
        coverage: JSON.stringify({
          ...previous,
          repos: previous.repos.map((entry: { repo: string; head: string; tree: string }) =>
            entry.repo === repo.repo ? { ...entry, head, tree } : entry,
          ),
        }),
        checks: progress.checks.map((check, position) => ({
          ...check,
          state: state === 'complete' || position === 0 ? 'passed' : 'not-run',
        })),
        next: state === 'complete' ? progress.checks.length : 1,
        pending: false,
        failureId: undefined,
      })
    }
    const before = store.listCheckRuns(task.id).length
    if (continuation) expect(store.latestRebase(task.id, '')).toBeUndefined()
    if (state === 'interrupted')
      store.startChecks({
        taskId: task.id,
        stage,
        trigger: stage,
        checks: [
          { name: 'Tests', command: 'test -f timezone.txt', timeout: '10s', state: 'not-run' },
        ],
      })
    if (state === 'held')
      store.stopTask(task.id, { runs: task.runs.length, why: 'repair-incorporation' })
    await store.persisted()
    await store.close()
    if (state === 'reset' || state === 'held')
      await run('git', ['reset', '--keep', 'HEAD^'], { cwd: repo.worktree })
    if (state === 'replaced')
      await writeFile(
        path.join(ctx.home, 'stub-claude.json'),
        JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
      )
    const client = await restart(stage === 'merge' ? 60_000 : undefined)
    if (continuation) {
      const fresh = await waitUntil(async () => {
        const cases = await client.read<FailureCase[]>(`${s.root}/failures`)
        const task = (await client.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)
        return !task?.markers.some((m) => m.kind === 'test-activity' && m.source === 'checks')
          ? cases.find(
              (value) => value.id !== saved.id && value.source.kind === 'post-rebase-check',
            )
          : undefined
      }, 'failed Merge repair execution')
      expect(fresh.contextId).toBeDefined()
      const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
      const lead = api(client.port, tokens.issue(task.leadRunId ?? ''))
      expect(
        (
          await lead.call('POST', `${s.root}/failures/${fresh.id}/assessments`, {
            assessment: 'unrelated',
            recommendation: 'Retry or accept this separate verification failure.',
          })
        ).status,
      ).toBe(200)
      const asked = await lead.call('POST', `${s.root}/failures/${fresh.id}/decision`)
      expect(asked.status).toBe(201)
      const requestId = (asked.body as FailureCase).decisions.at(-1)?.commentId
      if (state === 'retry') await writeFile(path.join(repo.worktree, 'stub-repair-passes'), '')
      const resolved = await client.call('POST', `${s.root}/failures/${fresh.id}/resolve`, {
        requestId,
        resolution: state === 'retry' ? 'retry' : 'accepted',
      })
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200)
      const runs = await waitUntil(async () => {
        const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
        return runs.length === before + 2 && runs.at(-1)?.outcome === 'passed' ? runs : undefined
      }, 'Merge repair decision to continue Checks without a rebase')
      expect(runs.at(-1)?.checks.map((check) => check.name)).toEqual(
        state === 'retry' ? ['Tests', 'Later'] : ['Later'],
      )
      expect(
        runs.find(
          (run) => fresh.source.kind === 'post-rebase-check' && run.id === fresh.source.checkRunId,
        )?.outcome,
      ).toBe('failed')
      const result = (await client.read<FailureCase[]>(`${s.root}/failures`)).find(
        (value) => value.id === fresh.id,
      )
      if (state === 'retry') expect(result?.verifications).toHaveLength(1)
      else {
        expect(result?.resolutions.at(-1)?.resolution).toBe('accepted')
        expect(result?.verifications).toBeUndefined()
      }
      return
    }
    if (state === 'reset' || state === 'held') {
      await waitUntil(
        async () =>
          (await client.read<Task[]>('/tasks'))
            .find((t) => t.id === task.id)
            ?.statuses.includes('stopped'),
        'old worktree held before validation',
      )
      await waitUntil(
        async () =>
          (await client.read<Task[]>('/tasks'))
            .find((t) => t.id === task.id)
            ?.runs.every((r) => r.state === 'finished'),
        'incorporation hold to stop the restored Lead',
      )
      const failures = await client.read<FailureCase[]>(`${s.root}/failures`)
      expect(failures.find((f) => f.id === s.one.id)?.verifications).toBeUndefined()
      expect(await client.read<CheckRun[]>(`${s.root}/check-runs`)).toHaveLength(before)
      return
    }
    if (state === 'replaced') {
      const resumed = await waitUntil(async () => {
        const task = (await client.read<Task[]>('/tasks')).find((value) => value.id === s.task.id)
        return task?.stage === 'merge' &&
          task.runs.find((run) => run.id === task.leadRunId)?.state === 'idle'
          ? task
          : undefined
      }, 'replacement Merge Lead').catch(async (error) => {
        const current = (await client.read<Task[]>('/tasks')).find(
          (value) => value.id === s.task.id,
        )
        const checks = await client.read<CheckRun[]>(`${s.root}/check-runs`)
        throw new Error(
          `${String(error)}; last recovery state: ${JSON.stringify({
            stage: current?.stage,
            leadRunId: current?.leadRunId,
            runs: current?.runs,
            statuses: current?.statuses,
            blockedBy: current?.blockedBy,
            checks: checks.map((run) => ({
              id: run.id,
              stage: run.stage,
              outcome: run.outcome,
              checks: run.checks.map(({ name, state }) => ({ name, state })),
            })),
          })}`,
        )
      })
      expect(resumed.leadRunId).toBe(task.leadRunId)
      const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
      const lead = api(client.port, tokens.issue(resumed.leadRunId ?? ''))
      try {
        await waitUntil(
          async () =>
            (await client.read<CheckRun[]>(`${s.root}/check-runs`)).some(
              (run) =>
                run.stage === 'merge' &&
                run.startedAt >= at &&
                run.checks.some((c) => c.state === 'running'),
            ),
          'replacement Merge Check awaiting release',
        )
        const early = await lead.call('POST', `${s.root}/failures/${saved.id}/verification`, {
          evidence: 'The replacement Check has not finished yet.',
        })
        expect(early.status, JSON.stringify(early.body)).toBe(409)
        expect(
          (await client.read<FailureCase[]>(`${s.root}/failures`)).find(
            (value) => value.id === saved.id,
          )?.verifications,
        ).toBeUndefined()
      } finally {
        await writeFile(releaseChecks, '')
      }
      await waitUntil(
        async () =>
          (await client.read<CheckRun[]>(`${s.root}/check-runs`)).some(
            (run) => run.stage === 'merge' && run.startedAt >= at && run.outcome === 'passed',
          ),
        'replacement Merge Check coverage',
      )
      await waitUntil(async () => {
        const task = (await client.read<Task[]>('/tasks')).find((value) => value.id === s.task.id)
        return task && !task.statuses.includes('working') && !task.checksActive ? task : undefined
      }, 'replacement Merge Checks to release the Task')
      const response = await lead.call('POST', `${s.root}/failures/${saved.id}/verification`, {
        evidence:
          'The repair replaced Tests with Repaired export; the complete current plan passed.',
      })
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      const verified = (await client.read<FailureCase[]>(`${s.root}/failures`)).find(
        (value) => value.id === saved.id,
      )
      expect(verified).toMatchObject({
        source: saved.source,
        originalCheck: saved.originalCheck,
        evidence: saved.evidence,
        createdAt: saved.createdAt,
        resolutions: resolved.resolutions,
      })
      expect(verified?.verifications).toHaveLength(1)
      expect(verified?.contextId).toBeUndefined()
      expect(verified?.validation).toBeUndefined()
      expect(await client.read<CheckRun[]>(`${s.root}/check-runs`)).toHaveLength(before + 1)
      expect(
        (await client.read<CheckRun[]>(`${s.root}/check-runs`)).find(
          (run) =>
            run.id === (saved.source.kind === 'post-rebase-check' ? saved.source.checkRunId : ''),
        )?.outcome,
      ).toBe('failed')
      return
    }
    const verified = await waitUntil(async () => {
      const cases = await client.read<FailureCase[]>(`${s.root}/failures`)
      return cases[0]?.verifications?.at(-1)
    }, 'fresh verification after incorporated repair recovery')
    expect(verified.checkRunId).toBeDefined()
    if (matchingCoverage) {
      const runs = await client.read<CheckRun[]>(`${s.root}/check-runs`)
      const fresh = runs.find((run) => run.id === verified.checkRunId)
      expect(fresh?.checks.map(({ name, state }) => ({ name, state }))).toEqual([
        { name: 'Prefix', state: 'passed' },
        { name: 'Tests', state: 'passed' },
      ])
    }
    expect(await client.read<CheckRun[]>(`${s.root}/check-runs`)).toHaveLength(
      before + (state === 'interrupted' ? 2 : 1),
    )
    expect((await client.read<FailureCase[]>(`${s.root}/failures`))[0]?.originalCheck?.state).toBe(
      'failed',
    )
  },
  long,
)
