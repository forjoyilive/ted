import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type FailureCase, type FailureContext, tedPaths } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import * as git from '../src/git.ts'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, stubClaudePath, waitUntil } from './helpers.ts'
import {
  ctx,
  getTask,
  ghCalls,
  readGh,
  start,
  toSignoff,
  useMergeHarness,
} from './merge-harness.ts'

useMergeHarness()

const scenarios = [
  ['acceptance', 'changed'],
  ['acceptance', 'unavailable'],
  ['acceptance', 'identical'],
  ['capture', 'changed'],
  ['capture', 'unavailable'],
  ['obligations', 'changed'],
  ['obligations', 'unavailable'],
  ['gate', 'changed'],
  ['gate', 'unavailable'],
] as const

test.each(scenarios)(
  '%s rejects superseded local verification: %s',
  async (boundary, observation) => {
    const client = await start({ mergePollMs: 50 })
    const { task, signoff } = await toSignoff(client)
    await writeFile(client.mergingFile, '')
    const current = await getTask(client, task.id)
    const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
    const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
    const root = `/tasks/${task.id}`
    const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
      const result = await lead.call('POST', `${root}${suffix}`, body)
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
      return result.body as T
    }
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
      expect((await resolve()).status).toBe(200)
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
      const state = await readGh()
      const count = async () =>
        (await ghCalls()).filter((call) => call.args.includes('graphql')).length
      const poll = async (merge: typeof state.merge) => {
        await writeFile(ctx.ghState, JSON.stringify({ ...state, merge }))
        const before = await count()
        await waitUntil(
          async () => (await count()) > before + 1,
          'CI observation delivered during local read',
        )
      }
      await poll(
        observation === 'unavailable'
          ? { ...state.merge, rollup: 'missing' }
          : observation === 'identical'
            ? state.merge
            : {
                ...state.merge,
                checks: [{ name: 'replacement', id: 'replacement', conclusion: 'SUCCESS' }],
              },
      )
      await poll(state.merge)
      release()
      const response = await request
      if (boundary === 'obligations')
        expect(response.body).toMatchObject({ satisfied: false, blockers: [value.id] })
      else
        expect(response.status, JSON.stringify(response.body)).toBe(
          observation === 'identical' ? 200 : 409,
        )
    } finally {
      release()
      spy.mockRestore()
    }
    const history = await client.ok<FailureCase[]>('GET', `${root}/failures`)
    const saved = history.find((c) => c.id === value.id)
    expect(saved?.resolutions).toHaveLength(
      boundary === 'obligations' || boundary === 'gate' || observation === 'identical' ? 1 : 0,
    )
    expect(saved?.invalidations).toHaveLength(
      boundary === 'obligations' || boundary === 'gate' ? 1 : 0,
    )
    if (boundary === 'acceptance' && observation !== 'identical')
      expect((await resolve()).status).toBe(200)
    if (boundary === 'capture')
      expect((await post<FailureContext>('/failure-contexts')).fingerprint).toBe(
        context.fingerprint,
      )
    const beforeReplay = await client.ok<FailureCase[]>('GET', `${root}/failures`)
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
    expect(await replay.call('GET', `${root}/failures`)).toMatchObject({
      status: 200,
      body: beforeReplay,
    })
  },
  60000,
)
