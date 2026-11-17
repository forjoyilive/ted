import { readFile, writeFile } from 'node:fs/promises'
import type { CheckRun, Comment, SendBack, Task } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { api, commitToOrigin, waitUntil } from './helpers.ts'
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
  waitForPullRequest,
  waitForStage,
} from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'

useMergeHarness()

describe('Approve and merge', () => {
  test('with no CI, Ted merges at once, deletes the branch, removes the worktree and releases blocked Tasks', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    expect(signoff.gate).toEqual({ approveLabel: 'Approve and merge', noCi: ['widgets'] })
    const blocked = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
      factory: 'NB',
      start: true,
      blockedBy: [task.id],
    })
    const repo = (await getTask(client, task.id)).repos[0]
    if (!repo) throw new Error('no repo')
    const signedOff = (
      await run('git', ['rev-parse', 'HEAD'], { cwd: repo.worktree })
    ).stdout.trim()

    await approve(client, signoff)
    const done = await waitForStage(client, task, 'done')

    expect(await merges()).toEqual([
      ['pr', 'merge', '7', '--repo', 'acme/widgets', '--squash', '--match-head-commit', signedOff],
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

  test('with CI, Ted waits for the checks, shows Waiting for CI, and merges once they pass', async () => {
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

  test('Ted doesn’t merge until the Task Lead advances at Merge; before that a Comment steers the Task Lead, the Task Lead titles the pull request for the merge commit, and it can send back only to Work or Design or advance once', async () => {
    const client = await start()
    const script = [
      `[ -e '${client.mergingFile}' ] && exit 0`,
      commitStep.run[2],
      `ted brief write --file '${client.briefFile}'`,
      'ted outcome advance',
    ].join('\n')
    const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
    const { task, signoff } = await toSignoff(client, {
      title: JSON.stringify({ steps: [{ everyMessage: each }, ...each] }),
    })
    await approve(client, signoff)
    await waitForStage(client, task, 'merge')
    await waitForPullRequest(client, task.id)
    const reads = async () =>
      (await ghCalls()).filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql').length
    const before = await reads()
    await waitUntil(async () => (await reads()) >= before + 3, 'Ted to read the pull request')
    expect(await merges()).toEqual([])
    const holding = await getTask(client, task.id)
    expect(holding.status?.kind).not.toBe('waiting-for-github')
    expect(
      (await client.call('POST', `/tasks/${task.id}/cancel-merge`, { comment: 'Stop.' })).status,
    ).toBe(409)
    await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'Looks good.' })

    const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
    const lead = api(ctx.daemon?.port ?? 0, tokens.issue(holding.leadRunId ?? ''))
    const outcome = (body: unknown) => lead.call('POST', `/tasks/${task.id}/outcome`, body)
    const back = await outcome({ outcome: 'back', to: 'validate', findings: 'Recheck it.' })
    expect(back.status).toBe(409)
    expect(JSON.stringify(back.body)).toContain('only to Work or Design')
    const titled = (body: unknown) =>
      lead.call('POST', `/tasks/${task.id}/pull-request-title`, body)
    const loose = await titled({ title: 'Keep the sidebar open' })
    expect(loose.status).toBe(400)
    expect(JSON.stringify(loose.body)).toContain('Conventional Commits')
    const subject = `fix(app): keep the sidebar open (${task.displayId})`
    const body = 'The sidebar closed after a restart.\n\nIt now stays open.'
    const set = await titled({ title: 'fix(app): keep the sidebar open', body })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ title: subject })
    const renames = async () =>
      (await ghCalls()).filter((c) => c.args[0] === 'pr' && c.args[1] === 'edit').map((c) => c.args)
    expect(await renames()).toEqual([
      ['pr', 'edit', '7', '--repo', 'acme/widgets', '--title', subject],
    ])
    const same = await titled({ title: 'fix(app): keep the sidebar open', body })
    expect(JSON.stringify(same.body)).toContain('nothing changed')
    expect(await renames()).toHaveLength(1)
    const advanced = await outcome({ outcome: 'advance' })
    expect(advanced.status).toBe(200)
    expect(JSON.stringify(advanced.body)).toContain('merges')
    const again = await outcome({ outcome: 'advance' })
    expect(again.status).toBe(409)
    expect(JSON.stringify(again.body)).toContain('already reported')
    expect((await titled({ title: 'fix: something else' })).status).toBe(409)

    await waitForStage(client, task, 'done')
    const [merge] = await merges()
    expect(merge?.slice(-4)).toEqual(['--subject', subject, '--body', body])
    expect(await lines(client, task)).toContain(
      `The Task Lead titled the pull request “${subject}”`,
    )
  })

  test('a Task waiting at Merge can be reset: Ted closes the pull request and deletes the branch, and a branch GitHub won’t delete stops the reset', async () => {
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
    const repo = waiting.repos[0]
    if (!repo) throw new Error('no repo')
    const route = `repos/${repo.repo.split('/').map(encodeURIComponent).join('/')}/git/refs/heads/${repo.branch.split('/').map(encodeURIComponent).join('/')}`
    const state = JSON.parse(await readFile(ctx.ghState, 'utf8')) as Record<string, unknown>
    await writeFile(
      ctx.ghState,
      JSON.stringify({
        ...state,
        paths: { [route]: { status: 422, message: 'Cannot delete a protected branch' } },
      }),
    )

    const refused = await client.call('POST', `/tasks/${task.id}/reset`)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain(`couldn’t delete the branch ${repo.branch}`)
    const kept = await getTask(client, task.id)
    expect(kept.stage).toBe('merge')
    expect(kept.statuses).toContain('stopped')
    expect(kept.repos[0]?.pullRequest?.state).toBe('closed')
    expect(await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).not.toEqual([])

    const now = JSON.parse(await readFile(ctx.ghState, 'utf8')) as Record<string, unknown>
    delete now.paths
    await writeFile(ctx.ghState, JSON.stringify(now))
    await client.ok('POST', `/tasks/${task.id}/reset`)

    const fresh = await eventWait(
      client.subscribe,
      async () => {
        const current = await getTask(client, task.id)
        return current.stage === 'intake' && current.leadRunId !== undefined ? current : undefined
      },
      'the reset Task to start again from Intake',
    )
    expect(fresh.repos.every((r) => r.pullRequest === undefined)).toBe(true)
    expect(await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).toEqual([])
    expect((await lines(client, task))[0]).toBe('Task was reset')
    const calls = await ghCalls()
    expect(calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'close')).toHaveLength(1)
    expect(calls.some((c) => c.args[0] === 'api' && c.args.includes(route))).toBe(true)
    expect(await merges()).toEqual([])
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
      `Rebased ${done.repos[0]?.name} onto main with no conflicts · running checks again`,
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

  test('a commit made between the sign-off and the approval is never pushed or merged: the Task goes back to Validate', async () => {
    const client = await start()
    const { task, signoff } = await toSignoff(client)
    const before = (await getTask(client, task.id)).repos[0]
    await commitIn(before?.worktree ?? '', 'late.txt')

    await approve(client, signoff)
    const back = await waitUntil(async () => {
      const backs = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      return backs.find((b) => b.from === 'merge')
    }, 'the send-back from Merge')

    expect(back).toMatchObject({ to: 'validate' })
    expect(back.findings).toContain('changed after the human signed it off')
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).repos[0]?.pushed).toBeUndefined()
    expect(await originBranches()).not.toContain(before?.branch ?? 'ted/')
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
