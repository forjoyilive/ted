import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type Comment,
  type FailureCase,
  type FailureContext,
  tedPaths,
  type ValidationObligations,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { api, stubClaudePath, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  heldLeadSteps,
  merges,
  readGh,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForPullRequest,
} from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'
import { offeredChoice } from './support/failure-choice.ts'
import { leadFor } from './support/failure-merge.ts'
import { ManualClock } from './support/manual-clock.ts'

useMergeHarness()

test('acceptance, obligations and Gate approval each verify worktree edits made while GitHub is pending', async () => {
  const client = await start({
    mergePollMs: 60_000,
    workflow: ['stages:', '  review: { gate: false }', '  merge: { gate: true }'],
  })
  const { task, signoff } = await toSignoff(client)
  expect(signoff.stage).toBe('merge')
  await writeFile(client.mergingFile, '')
  const github = await readGh()
  for (const boundary of ['acceptance', 'obligations', 'gate']) {
    const current = await getTask(client, task.id)
    const { post } = await leadFor(task.id, current.leadRunId ?? '')
    const context = await post<FailureContext>('/failure-contexts')
    const value = await post<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Known failure' },
      evidence: 'Observed before editing',
      contextId: context.id,
    })
    await post(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      choice: offeredChoice(value),
      recommendation: 'Accept in the tested context',
    })
    const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
    const resolve = () =>
      client.call('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
        requestId: asked.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    if (boundary !== 'acceptance') expect((await resolve()).status).toBe(200)
    const entered = path.join(ctx.scratch, 'github-waiting')
    const release = path.join(ctx.scratch, 'github-release')
    await writeFile(
      ctx.ghState,
      JSON.stringify({
        ...(await readGh()),
        graphqlGate: { entered, release, after: boundary === 'acceptance' ? 1 : 0 },
      }),
    )
    const pending =
      boundary === 'acceptance'
        ? resolve()
        : boundary === 'gate'
          ? client.call('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
          : client.call('GET', `/tasks/${task.id}/validation-obligations`)
    try {
      await waitUntil(() => readFile(entered, 'utf8').catch(() => undefined), 'GitHub waiting')
      await writeFile(path.join(current.repos[0]?.worktree ?? '', 'changed.txt'), 'new code')
    } finally {
      await writeFile(release, '')
    }
    const response = await pending
    expect(response.status).toBe(boundary === 'obligations' ? 200 : 409)
    if (boundary === 'obligations') {
      const observed = response.body as ValidationObligations
      expect(observed.satisfied).toBe(false)
      expect(observed.cases.find((c) => c.id === value.id)).toMatchObject({
        disposition: 'invalidated',
      })
    }
    const obligations = await client.ok<ValidationObligations>(
      'GET',
      `/tasks/${task.id}/validation-obligations`,
    )
    expect(obligations).toMatchObject({
      satisfied: false,
      blockers: [value.id],
    })
    expect(
      obligations.cases.find((c) => c.id === value.id),
      boundary,
    ).toMatchObject({
      disposition: boundary === 'acceptance' ? 'unresolved' : 'invalidated',
    })
    const stored = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
    expect(stored.find((c) => c.id === value.id)?.resolutions, boundary).toHaveLength(
      boundary === 'acceptance' ? 0 : 1,
    )
    const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    expect(comments.find((c) => c.id === signoff.id)?.answer).toBeUndefined()
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await merges()).toEqual([])
    await rm(path.join(current.repos[0]?.worktree ?? '', 'changed.txt'))
    await post(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      choice: offeredChoice(value),
      recommendation: 'Close this completed test scenario',
    })
    const closing = await post<FailureCase>(`/failures/${value.id}/decision`)
    await client.ok('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
      requestId: closing.decisions.at(-1)?.commentId,
      resolution: 'no-longer-applicable',
      reason: 'The test edit was removed before the next scenario.',
    })
    expect(await client.ok('GET', `/tasks/${task.id}/validation-obligations`)).toMatchObject({
      satisfied: true,
      blockers: [],
    })
    await writeFile(ctx.ghState, JSON.stringify(github))
    await rm(entered)
    await rm(release)
  }
}, 90_000)

test('completed acceptance survives background reads, explicit queries and daemon restart', async ({
  onTestFailed,
}) => {
  const timings: { phase: string; startedMs: number; endedMs?: number }[] = []
  const started = performance.now()
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const timing: (typeof timings)[number] = { phase: name, startedMs: performance.now() - started }
    timings.push(timing)
    const result = await work()
    timing.endedMs = performance.now() - started
    return result
  }
  onTestFailed(() => console.error('Completed acceptance phases:', JSON.stringify(timings)))
  const clock = new ManualClock()
  const pollEveryMs = 50
  const client = await phase('daemon and Factory startup', () =>
    start({ mergePollMs: pollEveryMs, daemon: { clock } }),
  )
  const pollFinished = () =>
    eventWait(
      clock.subscribe,
      () => clock.pending.includes(pollEveryMs),
      'completed acceptance: GitHub observation applied and poll rearmed',
    )
  const { task, signoff } = await phase('first Task to Review sign-off', () =>
    toSignoff(client, {}, clock),
  )
  const { current, post } = await phase('read Task and prepare Task Lead requests', async () => {
    await writeFile(client.mergingFile, '')
    const current = await getTask(client, task.id)
    return { current, ...(await leadFor(task.id, current.leadRunId ?? '')) }
  })
  const context = await phase('capture tested context', () =>
    post<FailureContext>('/failure-contexts'),
  )
  const value = await phase('record Finding', () =>
    post<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Known unrelated issue' },
      evidence: 'Observed',
      contextId: context.id,
    }),
  )
  await phase('assess Finding', () =>
    post(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      choice: offeredChoice(value),
      recommendation: 'Accept',
    }),
  )
  const asked = await phase('request failure decision', () =>
    post<FailureCase>(`/failures/${value.id}/decision`),
  )
  await phase('accept failure', () =>
    client.ok('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
      requestId: asked.decisions.at(-1)?.commentId,
      resolution: 'accepted',
    }),
  )
  await phase('approve Review sign-off', () => approve(client, signoff))
  await phase('merge to Done', () =>
    waitUntil(async () => {
      const done = (await getTask(client, task.id)).stage === 'done'
      if (!done && clock.pending.includes(pollEveryMs)) clock.advance(pollEveryMs)
      else if (!done && clock.pending.includes(100)) clock.advance(100)
      return done
    }, 'completed acceptance: Done'),
  )
  await rm(client.mergingFile)
  await setGh({ merged: false })
  await phase('second Task to Merge with an open pull request', async () => {
    const second = await toSignoff(client, { title: heldLeadSteps(client) }, clock)
    await approve(client, second.signoff)
    await waitForPullRequest(client, second.task.id)
  })
  await phase('drain background poll', pollFinished)

  const query = `/tasks/${task.id}/validation-obligations`
  const accepted = {
    satisfied: true,
    cases: [{ id: value.id, disposition: 'accepted', context: 'historical' }],
  }
  const entered = path.join(ctx.scratch, 'completed-read-entered')
  const release = path.join(ctx.scratch, 'completed-read-release')
  await writeFile(
    ctx.ghState,
    JSON.stringify({
      ...(await readGh()),
      graphqlGate: { entered, release },
    }),
  )
  clock.advance(pollEveryMs)
  try {
    await phase('background GitHub read enters gate', () =>
      waitUntil(
        () => readFile(entered, 'utf8').catch(() => undefined),
        'completed acceptance: background GitHub read entered',
      ),
    )
    await phase('explicit obligations during delayed background read', async () => {
      expect(await client.ok('GET', query)).toMatchObject(accepted)
    })
  } finally {
    await writeFile(release, '')
  }
  await phase('background GitHub read completes', pollFinished)
  await phase('explicit obligations after background read', async () => {
    expect(await client.ok('GET', query)).toMatchObject(accepted)
  })
  const history = await phase('read accepted history', () =>
    client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`),
  )
  expect(history[0]?.invalidations).toEqual([])
  expect(history[0]?.resolutions[0]?.resolution).toBe('accepted')
  await phase('stop daemon', async () => {
    await ctx.daemon?.stop()
  })
  await phase('remove state for event-log replay', async () => {
    const directory = path.join(tedPaths(ctx.home).store, 'ted')
    for (const file of await readdir(directory))
      if (file.startsWith('state')) await rm(path.join(directory, file), { force: true })
  })
  ctx.daemon = await phase('restart daemon and replay', () =>
    startDaemon({
      home: ctx.home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      mergePollMs: 100,
    }),
  )
  const restarted = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  await phase('obligations and identical history after replay', async () => {
    expect(await restarted.call('GET', query)).toMatchObject({ status: 200, body: accepted })
    const replayed = await restarted.call('GET', `/tasks/${task.id}/failures`)
    expect(replayed.status).toBe(200)
    expect(replayed.body).toEqual(history)
  })
  console.info('Completed acceptance phases:', JSON.stringify(timings))
}, 90_000)
