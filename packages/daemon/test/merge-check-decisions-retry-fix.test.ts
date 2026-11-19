import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tedPaths } from '@ted/protocol'
import { expect, expectTypeOf, test } from 'vitest'
import type { ChecksArea } from '../src/store/checks.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { commitToOrigin, hostsStarted, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  merges,
  run,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import {
  ask,
  assess,
  cases,
  checks,
  comments,
  failed,
  lead,
  long,
  obligations,
  polls,
  rebased,
  resolve,
  restart,
  runs,
} from './support/merge-check-decisions.ts'

expectTypeOf<TedStore>().toExtend<ChecksArea>()

useMergeHarness()

test(
  'Retry resumes at the failed position, verifies only a passing execution and keeps the passed prefix',
  async () => {
    const { client, task, failure } = await rebased()
    const request = await ask(client, task, failure)
    const t = await getTask(client, task.id)
    const worktree = t.repos[0]?.worktree ?? ''
    await writeFile(path.join(worktree, 'stub-first-fixed'), '')
    await writeFile(path.join(worktree, 'stub-later-fixed'), '')
    expect((await resolve(client, task, failure, request, 'retry')).status).toBe(200)
    await waitForStage(client, task, 'done')
    expect((await runs(client, task)).map((r) => r.checks.map((c) => c.name))).toEqual([
      ['Prefix', 'First', 'Later'],
      ['First', 'Later'],
    ])
    const original = (await cases(client, task)).find((value) => value.id === failure.id)
    expect(original?.verifications).toHaveLength(1)
    expect(original?.resolutions.at(-1)?.resolution).toBe('retry')
    expect((await runs(client, task))[0]?.outcome).toBe('failed')
  },
  long,
)

test(
  'a supported regression assessment sends Merge through the existing Work repair path',
  async () => {
    const { client, task, failure } = await rebased()
    await assess(client, task, failure, 'regression')
    await waitForStage(client, task, 'work')
    const history = await client.ok<{ from: string; to: string; checkRunId?: string }[]>(
      'GET',
      `/tasks/${task.id}/send-backs`,
    )
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ from: 'merge', to: 'work' })
    expect(await merges()).toEqual([])
    const work = await getTask(client, task.id)
    const worktree = work.repos[0]?.worktree ?? ''
    await run('git', ['rm', 'base-only'], { cwd: worktree })
    await run(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-qm',
        'Repair the base Check failure',
      ],
      { cwd: worktree },
    )
    const agent = await lead(client, task)
    expect(
      (
        await agent.call('POST', `/tasks/${task.id}/brief`, {
          text: await readFile(client.briefFile, 'utf8'),
        })
      ).status,
    ).toBe(201)
    expect(
      (await agent.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(200)
    await waitForStage(client, task, 'validate')
    await waitUntil(
      async () => (await obligations(client, task)).satisfied,
      'repaired Checks to pass in Validate',
    )
    expect(
      (await cases(client, task)).find((value) => value.id === failure.id)?.verifications,
    ).toHaveLength(1)
    const validating = await lead(client, task)
    expect(
      (await validating.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(200)
    await waitForStage(client, task, 'review')
    const reviewing = await lead(client, task)
    expect(
      (
        await reviewing.call('POST', `/tasks/${task.id}/brief`, {
          text: await readFile(client.briefFile, 'utf8'),
        })
      ).status,
    ).toBe(201)
    expect(
      (await reviewing.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(200)
    const signoff = await waitUntil(
      async () =>
        (await comments(client, task)).find(
          (c) => c.stage === 'review' && c.kind === 'signoff' && !c.answer,
        ),
      'Review re-sign-off after repair',
    )
    expect(await merges()).toEqual([])
    await approve(client, signoff)
    await waitForStage(client, task, 'done')
    expect((await runs(client, task))[0]?.outcome).toBe('failed')
    expect(await merges()).toHaveLength(1)
  },
  long,
)

test(
  'a failed Retry creates a new case; the user’s Fix decision uses the normal send-back path',
  async () => {
    const { client, task, failure } = await rebased()
    const request = await ask(client, task, failure)
    expect((await resolve(client, task, failure, request, 'retry')).status).toBe(200)
    const replacement = await failed(client, task, 2)
    expect(replacement.id).not.toBe(failure.id)
    expect(replacement.source).toMatchObject({
      kind: 'post-rebase-check',
      checkRunId: (await runs(client, task)).at(-1)?.id,
    })
    expect(replacement.source).not.toEqual(failure.source)
    expect(
      (await cases(client, task)).find((value) => value.id === failure.id)?.verifications?.at(-1)
        ?.replacedBy,
    ).toBe(replacement.id)
    const next = await ask(client, task, replacement)
    expect((await resolve(client, task, replacement, next, 'fix')).status).toBe(200)
    await waitForStage(client, task, 'work')
    expect(await client.ok('GET', `/tasks/${task.id}/send-backs`)).toHaveLength(1)
    expect(await merges()).toEqual([])
  },
  long,
)

test(
  'a restarted daemon runs Merge checks for progress reset to pending and says when the code changed under them; checks changed on main while a Task waits in Merge run again; the banner says why it waits, a failure holds the merge, and a passing Retry merges',
  async () => {
    const settings = ['stages:', '  merge:', '    gate: false', '  validate:', '    checks:']
    const armed = path.join(ctx.scratch, 'touch-armed')
    const released = path.join(ctx.scratch, 'touch-released')
    const touch = `      - { name: Touch, run: "test -e changed-while-checking || test ! -e '${armed}' || { touch changed-while-checking; while [ ! -e '${released}' ]; do sleep 0.1; done; }" }`
    let client = await start({
      files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
      merge: {
        mergeState: 'BLOCKED',
        checks: [{ name: 'Required', status: 'IN_PROGRESS', required: true }],
      },
      workflow: [...settings, ...checks, touch],
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)
    await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t.stage === 'merge' && t.repos[0]?.pullRequest?.waiting === 'ci'
    }, 'the merge to wait for CI')
    expect(await runs(client, task)).toEqual([])

    await hostsStarted(ctx.home)
    await ctx.daemon?.stop()
    ctx.daemon = undefined
    const store = await openStore({ directory: tedPaths(ctx.home).store })
    const progress = store.failures.progress(task.id)
    if (!progress) throw new Error('missing saved Check progress')
    store.failures.saveProgress({
      taskId: task.id,
      visit: progress.visit,
      checks: progress.checks.map(({ name, repo, command, timeout, builtIn }) => ({
        name,
        ...(repo !== undefined && { repo }),
        ...(command !== undefined && { command }),
        timeout,
        ...(builtIn !== undefined && { builtIn }),
        state: 'not-run',
      })),
      executions: [],
      next: 0,
      pending: true,
    })
    await store.persisted()
    await store.close()
    await writeFile(armed, '')
    client = await restart(client)
    const reasons: string[] = []
    const unsubscribe = await client.subscribe((event) => {
      if (event.type === 'task-updated' && event.task.id === task.id && event.task.mergeHeld)
        reasons.push(event.task.mergeHeld)
    })
    await waitUntil(
      async () => (await runs(client, task)).length === 1,
      'a Merge check run from the pending progress',
    )
    await writeFile(released, '')
    await waitUntil(
      async () =>
        reasons.includes('The Task’s code changed while the checks ran, so Ted runs them again.'),
      'the code-changed reason on the Task',
    )
    unsubscribe()
    await waitUntil(async () => {
      const t = await getTask(client, task.id)
      const done = await runs(client, task)
      return (
        done.length === 2 &&
        done.every((r) => r.outcome === 'passed') &&
        !t.markers.some((m) => m.kind === 'test-activity' && m.source === 'checks')
      )
    }, 'the Merge checks to pass on the changed code')
    expect(await merges()).toEqual([])

    const passes = path.join(ctx.scratch, 'added-check-passes')
    const fails = path.join(ctx.scratch, 'added-check-fails')
    await commitToOrigin(ctx.scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review, merge]',
        ...settings,
        ...checks,
        touch,
        `      - { name: Added, run: "test -e '${passes}' || { while [ ! -e '${fails}' ]; do sleep 0.1; done; exit 1; }" }`,
        '',
      ].join('\n'),
    })
    await client.ok('GET', `/factories/${task.factoryId}/settings?refresh=first`)
    await setGh({
      mergeState: 'CLEAN',
      checks: [{ name: 'Required', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
    })
    await waitUntil(async () => (await runs(client, task)).length === 3, 'a Merge check run')
    const running = await waitUntil(
      async () => (await getTask(client, task.id)).mergeHeld,
      'the checks-running reason on the Task',
    )
    expect(running).toContain('running the checks')
    expect(await merges()).toEqual([])

    await writeFile(fails, '')
    const failure = await failed(client, task)
    const reason = await waitUntil(async () => {
      const why = (await getTask(client, task.id)).mergeHeld
      return why?.includes('A check failed') ? why : undefined
    }, 'the failed-check reason on the Task')
    expect(reason).toContain(failure.id.slice(0, 6))
    await polls(client)
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('merge')

    await writeFile(passes, '')
    const request = await ask(client, task, failure)
    expect((await resolve(client, task, failure, request, 'retry')).status).toBe(200)
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
    const first = ['Prefix', 'First', 'Later', 'Touch']
    expect((await runs(client, task)).map((r) => [r.outcome, r.checks.map((c) => c.name)])).toEqual(
      [
        ['passed', first],
        ['passed', first],
        ['failed', [...first, 'Added']],
        ['passed', ['Added']],
      ],
    )
    expect((await getTask(client, task.id)).mergeHeld).toBeUndefined()
  },
  long,
)
