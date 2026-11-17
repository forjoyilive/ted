import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type FailureCase, type FailureContext, tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, stubClaudePath, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  ghCalls,
  heldLeadSteps,
  readGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForPullRequest,
} from './merge-harness.ts'

useMergeHarness()

test.each(['changed', 'unavailable'])(
  '%s CI observed during a remote merge invalidates consent before restoration and replays',
  async (observation) => {
    const client = await start({ mergePollMs: 50 })
    const { task, signoff } = await toSignoff(client, { title: heldLeadSteps(client) })
    await approve(client, signoff)
    const current = await waitForPullRequest(client, task.id)
    await waitUntil(
      async () => (await client.getRun(current.leadRunId ?? '')).run.state === 'idle',
      'the Merge Task Lead to go idle',
    )
    const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
    const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
    const root = `/tasks/${task.id}`
    const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
      const result = await lead.call('POST', `${root}${suffix}`, body)
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
      return result.body as T
    }
    const context = await post<FailureContext>('/failure-contexts')
    const cases: FailureCase[] = []
    const ask = async (id: string) => {
      await post(`/failures/${id}/assessments`, {
        assessment: 'unrelated',
        recommendation: 'Accept this tested context',
      })
      return post<FailureCase>(`/failures/${id}/decision`)
    }
    const resolve = (value: FailureCase) =>
      client.call('POST', `${root}/failures/${value.id}/resolve`, {
        requestId: value.decisions.at(-1)?.commentId,
        resolution: 'accepted',
      })
    for (let i = 0; i < 2; i++) {
      const value = await post<FailureCase>('/failures', {
        source: { kind: 'finding', runId: current.leadRunId, finding: `Known failure ${i}` },
        evidence: `Original evidence ${i}`,
        contextId: context.id,
      })
      expect((await resolve(await ask(value.id))).status).toBe(200)
      cases.push(value)
    }
    const mergeEntered = path.join(ctx.scratch, 'merge-entered')
    const mergeRelease = path.join(ctx.scratch, 'merge-release')
    const mergeGate = { entered: mergeEntered, release: mergeRelease }
    const state = await readGh()
    await writeFile(ctx.ghState, JSON.stringify({ ...state, mergeGate }))
    const advanced = await lead.call('POST', `${root}/outcome`, { outcome: 'advance' })
    expect(advanced.status, JSON.stringify(advanced.body)).toBe(200)
    try {
      await waitUntil(
        () => readFile(mergeEntered, 'utf8').catch(() => undefined),
        'remote merge paused',
      )
      const entered = path.join(ctx.scratch, 'poll-entered')
      const release = path.join(ctx.scratch, 'poll-release')
      const altered =
        observation === 'unavailable'
          ? { ...state.merge, rollup: 'missing' }
          : {
              ...state.merge,
              checks: [{ name: 'replacement', id: 'replacement', conclusion: 'SUCCESS' }],
            }
      await writeFile(
        ctx.ghState,
        JSON.stringify({ ...state, merge: altered, mergeGate, graphqlGate: { entered, release } }),
      )
      await waitUntil(
        () => readFile(entered, 'utf8').catch(() => undefined),
        'altered CI read captured',
      )
      const count = async () =>
        (await ghCalls()).filter((call) => call.args.includes('graphql')).length
      const before = await count()
      await writeFile(release, '')
      await waitUntil(async () => (await count()) > before + 1, 'altered CI polls delivered')
      const observed = await client.ok<FailureCase[]>('GET', `${root}/failures`)
      for (const value of cases) {
        expect(observed.find((item) => item.id === value.id)?.invalidations).toHaveLength(1)
        expect(observed.find((item) => item.id === value.id)?.resolutions).toHaveLength(1)
      }
      await writeFile(ctx.ghState, JSON.stringify({ ...state, mergeGate }))
      const restored = await count()
      await waitUntil(async () => (await count()) > restored + 1, 'original CI observed again')
      expect(await client.ok('GET', `${root}/failures`)).toEqual(observed)
    } finally {
      await writeFile(mergeRelease, '')
    }
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.state === 'merged',
      'issued merge recorded',
    )
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await client.ok('GET', `${root}/validation-obligations`)).toMatchObject({
      satisfied: false,
    })
    const first = cases[0]
    if (!first) throw new Error('Missing first case')
    expect((await resolve(await ask(first.id))).status).toBe(200)
    const saved = await client.ok<FailureCase[]>('GET', `${root}/failures`)
    expect(saved.find((value) => value.id === first.id)?.resolutions).toHaveLength(2)
    for (const value of cases) {
      expect(saved.find((item) => item.id === value.id)?.invalidations).toHaveLength(1)
      expect(saved.find((item) => item.id === value.id)?.evidence).toBe(value.evidence)
    }
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
    expect(await replay.call('GET', `${root}/failures`)).toMatchObject({ body: saved })
    const response = await replay.call('GET', `${root}/validation-obligations`)
    expect(response.status).toBe(200)
    const obligations = response.body as {
      satisfied: boolean
      cases: { id: string; disposition: string }[]
    }
    expect(obligations.satisfied).toBe(false)
    expect(obligations.cases.find((value) => value.id === first.id)?.disposition).toBe('accepted')
    expect(obligations.cases.find((value) => value.id === cases[1]?.id)?.disposition).toBe(
      'invalidated',
    )
  },
  60000,
)
