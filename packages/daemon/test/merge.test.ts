import type { CheckRun, Comment, Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, waitUntil } from './helpers.ts'
import {
  approve,
  branchHead,
  commitStep,
  ctx,
  getTask,
  ghCalls,
  leadSteps,
  lines,
  merges,
  originBranches,
  run,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'

useMergeHarness()

describe('Approve and merge', () => {
  test('with no CI, TED merges at once, deletes the branch, removes the worktree and releases blocked Tasks', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    expect(signoff.gate).toEqual({ approveLabel: 'Approve and merge' })
    const blocked = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
      factory: 'NB',
      start: true,
      blockedBy: [task.id],
    })
    const before = await getTask(client, task.id)
    const repo = before.repos[0]
    if (!repo?.pushed) throw new Error('no push')

    await approve(client, signoff)
    const done = await waitForStage(client, task, 'done')

    expect(await merges()).toEqual([
      [
        'pr',
        'merge',
        '7',
        '--repo',
        'acme/widgets',
        '--squash',
        '--match-head-commit',
        repo.pushed.commit,
      ],
    ])
    const deletes = (await ghCalls()).filter((c) => c.args.includes('DELETE'))
    expect(deletes.map((c) => c.args.at(-1))).toEqual([
      `repos/acme/widgets/git/refs/heads/${repo.branch}`,
    ])
    expect(done.repos[0]?.pullRequest).toMatchObject({
      state: 'merged',
      merged: { method: 'squash', noCi: true },
    })
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.removed !== undefined,
      'the worktree to be removed',
    )
    expect(await lines(client, task)).toContain(`No CI on ${repo.name} · merged without waiting`)
    await waitUntil(
      async () => (await getTask(client, blocked.id)).leadRunId !== undefined,
      'the blocked Task to start',
    )
  })

  test('with CI, TED waits for the checks, shows Waiting for CI, and the Task Lead can’t report an outcome', async () => {
    const client = await start({
      files: { '.github/workflows/ci.yml': 'on: pull_request\n' },
      merge: { checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
    })
    const { task, signoff } = await toSignoff(client)
    await approve(client, signoff)

    const waiting = await eventWait(
      client.subscribe,
      async () => {
        const current = await getTask(client, task.id)
        return current.status?.kind === 'waiting-for-github' ? current : undefined
      },
      'Waiting for CI',
    )
    expect(waiting.status).toEqual({ kind: 'waiting-for-github', on: 'ci' })
    expect(waiting.repos[0]?.pushed?.ci).toBe(true)
    expect(await merges()).toEqual([])

    await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.merged).toMatchObject({ method: 'squash', noCi: false })
    expect(await merges()).toHaveLength(1)
    expect(await lines(client, task)).toContain(`Merged ${done.repos[0]?.name}`)
  })

  test('a conflict-free rebase onto a moved base reruns Checks and merges without a new sign-off', async () => {
    const client = await start({
      merge: { mergeState: 'BEHIND' },
      workflow: [
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Tests, run: "test -f work.txt" }',
      ],
    })
    const { task, signoff } = await toSignoff(client, {
      title: leadSteps(client, `[ -e stub-built ] || { ${commitStep.run[2]}; touch stub-built; }`),
    })
    const branch = (await getTask(client, task.id)).repos[0]?.branch ?? ''
    await commitToOrigin(ctx.scratch, { 'other.txt': 'someone else’s change\n' })

    await approve(client, signoff)
    const done = await waitForStage(client, task, 'done')

    const rebased = await branchHead(branch)
    const [merge] = await merges()
    expect(merge?.at(-1)).toBe(rebased)
    expect(done.repos[0]?.pushed?.commit).toBe(rebased)
    const checkRuns = await client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)
    expect(checkRuns.filter((r) => r.trigger === 'merge').map((r) => r.outcome)).toEqual(['passed'])
    const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    expect(comments.filter((c) => c.kind === 'signoff')).toHaveLength(1)
    expect(await lines(client, task)).toContain(
      `Rebased ${done.repos[0]?.name} onto main with no conflicts · running Checks again`,
    )
    expect(await originBranches()).toContain(branch)
  })
})

describe('Merging only what the human signed off', () => {
  const commitIn = (cwd: string, file: string) =>
    run(
      'sh',
      [
        '-c',
        `echo x >> ${file} && git add ${file} && git -c user.name=T -c user.email=t@example.com commit -qm ${file}`,
      ],
      { cwd },
    )

  test('TED merges the signed-off commit, never a commit the Task Lead made after it', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    const before = (await getTask(client, task.id)).repos[0]
    const signedOff = before?.pushed?.commit
    await commitIn(before?.worktree ?? '', 'late.txt')

    await approve(client, signoff)
    const done = await waitForStage(client, task, 'done')

    const [merge] = await merges()
    expect(merge?.at(-1)).toBe(signedOff)
    expect(done.repos[0]?.pullRequest?.signedOff).toBe(signedOff)
    expect(await branchHead(done.repos[0]?.branch ?? '')).toBe(signedOff)
  })
})

describe('Request changes at Review', () => {
  test('the Task Lead sends the Task back to Work, and it returns through Validate with a new sign-off', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)

    await client.ok('POST', `/comments/${signoff.id}/answer`, {
      action: 'request-changes',
      text: 'Make the button bigger.',
    })

    const second = await waitUntil(async () => {
      const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
      const signoffs = comments.filter((c) => c.kind === 'signoff')
      return signoffs.length === 2 ? signoffs[1] : undefined
    }, 'a new sign-off')
    expect(second?.answer).toBeUndefined()
    const text = await lines(client, task)
    expect(text).toContain('Review sent this back to Work')
    const stages = (
      await client.ok<{ stage: string }[]>('GET', `/tasks/${task.id}/stage-entries`)
    ).map((e) => e.stage)
    expect(stages.slice(-4)).toEqual(['review', 'work', 'validate', 'review'])
  })
})
