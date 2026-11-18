import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { commitToOrigin, waitUntil } from './helpers.ts'
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
  runs,
} from './support/merge-check-decisions.ts'

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
  'checks changed on main while a Task waits in Merge run again, show why, and the Task merges',
  async () => {
    const settings = ['stages:', '  merge:', '    gate: false', '  validate:', '    checks:']
    const client = await start({
      files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
      merge: {
        mergeState: 'BLOCKED',
        checks: [{ name: 'Required', status: 'IN_PROGRESS', required: true }],
      },
      workflow: [...settings, ...checks],
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)
    await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t.stage === 'merge' && t.repos[0]?.pullRequest?.waiting === 'ci'
    }, 'the merge to wait for CI')
    expect(await runs(client, task)).toEqual([])

    const release = path.join(ctx.scratch, 'release-added-check')
    await commitToOrigin(ctx.scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review, merge]',
        ...settings,
        ...checks,
        `      - { name: Added, run: "while [ ! -e '${release}' ]; do sleep 0.1; done" }`,
        '',
      ].join('\n'),
    })
    await client.ok('GET', `/factories/${task.factoryId}/settings?refresh=first`)
    await setGh({
      mergeState: 'CLEAN',
      checks: [{ name: 'Required', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
    })
    await waitUntil(async () => (await runs(client, task)).length === 1, 'a Merge check run')
    const held = await waitUntil(
      async () => (await getTask(client, task.id)).mergeHeld,
      'the held reason on the Task',
    )
    expect(held).toContain('running the checks')
    await polls(client)
    expect(await merges()).toEqual([])

    await writeFile(release, '')
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
    expect((await runs(client, task)).map((r) => [r.outcome, r.checks.map((c) => c.name)])).toEqual(
      [['passed', ['Prefix', 'First', 'Later', 'Added']]],
    )
    expect((await getTask(client, task.id)).mergeHeld).toBeUndefined()
  },
  long,
)
