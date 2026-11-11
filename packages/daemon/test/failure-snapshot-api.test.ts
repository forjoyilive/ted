import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type FailureCase, type FailureContext, tedPaths } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import * as git from '../src/git.ts'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, stubClaudePath, waitUntil } from './helpers.ts'
import { ctx, getTask, readGh, start, toSignoff, useMergeHarness } from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'

useMergeHarness()

const scenarios = [
  ['acceptance', 'changed'],
  ['acceptance', 'unavailable'],
  ['capture', 'changed'],
  ['capture', 'unavailable'],
  ['obligations', 'changed'],
  ['obligations', 'unavailable'],
  ['gate', 'changed'],
  ['gate', 'unavailable'],
  ['acceptance', 'identical'],
] as const

test('acceptance, capture, obligations and the Gate each reject local verification superseded by a changed or unavailable CI observation, acceptance passes an identical one, and every case replays from the event log', async () => {
  const clock = new ManualClock()
  const pollEveryMs = 50
  const client = await start({ mergePollMs: pollEveryMs, daemon: { clock } })
  const pollFinished = () =>
    eventWait(
      clock.subscribe,
      () => clock.pending.includes(pollEveryMs),
      'CI observation applied and GitHub poll rearmed',
    )
  const { task, signoff } = await toSignoff(client, {}, clock)
  await writeFile(client.mergingFile, '')
  const current = await getTask(client, task.id)
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
  const root = `/tasks/${task.id}`
  const replacement = [{ name: 'replacement', id: 'replacement', conclusion: 'SUCCESS' }]

  for (const [boundary, observation] of scenarios) {
    const scenario = `${boundary}/${observation}`
    const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
      const result = await lead.call('POST', `${root}${suffix}`, body)
      expect(result.status, `${scenario}: ${JSON.stringify(result.body)}`).toBeLessThan(300)
      return result.body as T
    }
    const state = await readGh()
    const poll = async (merge: typeof state.merge) => {
      await pollFinished()
      await writeFile(ctx.ghState, JSON.stringify({ ...state, merge }))
      clock.advance(pollEveryMs)
      await pollFinished()
    }
    const stored = async () =>
      (await client.ok<FailureCase[]>('GET', `${root}/failures`)).find((c) => c.id === value.id)
    expect(
      (await client.ok<{ blockers: string[] }>('GET', `${root}/validation-obligations`)).blockers,
      `${scenario}: no earlier case holds the Task`,
    ).toEqual([])
    const context = await post<FailureContext>('/failure-contexts')
    const value = await post<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Original Finding' },
      evidence: 'Original evidence',
      contextId: context.id,
    })
    await post(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      recommendation: 'Accept A',
    })
    const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
    const resolve = () =>
      client.call('POST', `${root}/failures/${value.id}/resolve`, {
        requestId: asked.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    if (boundary === 'obligations' || boundary === 'gate')
      expect((await resolve()).status, `${scenario}: acceptance before the race`).toBe(200)
    // Drain background verification before counting this request’s local reads.
    await pollFinished()
    await client.ok('GET', `${root}/validation-obligations`)
    await pollFinished()
    const original = git.workingChanges
    let enter = () => {},
      release = () => {},
      reads = 0
    const entered = new Promise<void>((r) => {
      enter = r
    })
    const gate = new Promise<void>((r) => {
      release = r
    })
    const spy = vi.spyOn(git, 'workingChanges').mockImplementation(async (...args) => {
      const changes = await original(...args)
      if (++reads === (boundary === 'acceptance' ? 2 : 1)) {
        enter()
        await gate
      }
      return changes
    })
    const request =
      boundary === 'acceptance'
        ? resolve()
        : boundary === 'capture'
          ? lead.call('POST', `${root}/failure-contexts`, {})
          : boundary === 'gate'
            ? client.call('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
            : client.call('GET', `${root}/validation-obligations`)
    try {
      await entered
      await poll(
        observation === 'unavailable'
          ? { ...state.merge, rollup: 'missing' }
          : observation === 'identical'
            ? state.merge
            : { ...state.merge, checks: replacement },
      )
      await poll(state.merge)
      release()
      const response = await request
      if (boundary === 'obligations')
        expect(response.body, scenario).toMatchObject({ satisfied: false, blockers: [value.id] })
      else
        expect(response.status, `${scenario}: ${JSON.stringify(response.body)}`).toBe(
          observation === 'identical' ? 200 : 409,
        )
    } finally {
      release()
      spy.mockRestore()
    }
    const saved = await stored()
    expect(saved?.resolutions, `${scenario}: resolutions`).toHaveLength(
      boundary === 'obligations' || boundary === 'gate' || observation === 'identical' ? 1 : 0,
    )
    expect(saved?.invalidations, `${scenario}: invalidations`).toHaveLength(
      boundary === 'obligations' || boundary === 'gate' ? 1 : 0,
    )
    if (boundary === 'acceptance' && observation !== 'identical')
      expect((await resolve()).status, `${scenario}: acceptance after CI is restored`).toBe(200)
    if (boundary === 'capture')
      expect(
        (await post<FailureContext>('/failure-contexts')).fingerprint,
        `${scenario}: capture after CI is restored`,
      ).toBe(context.fingerprint)

    if (scenario === scenarios.at(-1)?.join('/')) continue
    if (boundary === 'acceptance') {
      await poll({ ...state.merge, checks: replacement })
      await waitUntil(
        async () => (await stored())?.invalidations.length === 1,
        `${scenario}: acceptance invalidated so the case can be closed`,
      )
      await poll(state.merge)
    }
    await post(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      recommendation: 'Close before the next scenario',
    })
    const closing = await post<FailureCase>(`/failures/${value.id}/decision`)
    expect(
      (
        await client.call('POST', `${root}/failures/${value.id}/resolve`, {
          requestId: closing.decisions.at(-1)?.commentId,
          resolution: 'fixed',
          reason: 'Closed before the next scenario',
        })
      ).status,
      `${scenario}: case closed before the next scenario`,
    ).toBe(200)
  }

  const beforeReplay = await client.ok<FailureCase[]>('GET', `${root}/failures`)
  expect(beforeReplay, 'one case per scenario').toHaveLength(scenarios.length)
  await client.ok('POST', `${root}/stop`)
  await ctx.daemon?.stop()
  const directory = path.join(tedPaths(ctx.home).store, 'ted')
  for (const file of await readdir(directory))
    if (file.startsWith('state')) await rm(path.join(directory, file), { force: true })
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    mergePollMs: 60000,
  })
  const replay = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  expect(await replay.call('GET', `${root}/failures`), 'replay').toMatchObject({
    status: 200,
    body: beforeReplay,
  })
}, 180000)
