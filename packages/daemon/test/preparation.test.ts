import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Comment, type Factory, type Task, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let scratch: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-preparation-'))
})
afterEach(async () => {
  await daemon?.stop()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})
async function start() {
  daemon = await startDaemon({ home, version: 'test', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  return {
    ...client,
    async ok<T>(method: string, route: string, body?: unknown): Promise<T> {
      const result = await client.call(method, route, body)
      if (result.status >= 300) throw Error(`${route}: ${JSON.stringify(result)}`)
      return result.body as T
    },
  }
}

test('Design approval durably holds before Work; Resume and Overnight release only preparation holds', async () => {
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, clarify, design, work, merge]\n',
  })
  let client = await start()
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const get = async (id: string) =>
    (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  const make = () =>
    client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
    })
  const prepare = async (overnightOnApproval = false) => {
    const task = await make()
    await client.ok('POST', `/tasks/${task.id}/start`, { prepare: true })
    const current = await waitUntil(async () => {
      const t = await get(task.id)
      return t?.leadRunId && t.runs[0]?.state === 'idle' ? t : undefined
    }, 'idle preparation Lead')
    const runId = current.leadRunId ?? ''
    const run = api(
      daemon?.port ?? 0,
      (await loadRunTokens(tedPaths(home).runTokenKey)).issue(runId),
    )
    expect(
      (
        await run.call('POST', `/tasks/${task.id}/brief`, {
          text: '## Goal\nPrepare\n## Decisions so far\nNone\n## Current state\nDesigned\n## Open questions\nNone\n## Next step\nWork',
        })
      ).status,
    ).toBe(201)
    for (const stage of ['clarify', 'design']) {
      expect(
        (await run.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
      ).toBe(200)
      expect((await get(task.id))?.stage).toBe(stage)
    }
    expect(
      (
        await run.call('POST', `/tasks/${task.id}/brief`, {
          text: '## Goal\nPrepare\n## Decisions so far\nNone\n## Current state\nDesigned\n## Open questions\nNone\n## Next step\nWork',
        })
      ).status,
    ).toBe(201)
    const designOutcome = await run.call('POST', `/tasks/${task.id}/outcome`, {
      outcome: 'advance',
    })
    expect(designOutcome.status, JSON.stringify(designOutcome.body)).toBe(200)
    const comments = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    const gate = comments.find((c) => c.stage === 'design' && c.gate && !c.answer)
    expect(gate).toBeDefined()
    expect((await get(task.id))?.stage).toBe('design')
    if (overnightOnApproval) await client.ok('PATCH', '/settings', { overnightMode: true })
    await client.ok('POST', `/comments/${gate?.id}/answer`, { action: 'approve' })
    if (overnightOnApproval) {
      const resumed = await waitUntil(async () => {
        const t = await get(task.id)
        return t?.leadRunId && t.leadRunId !== runId && t.preparation === undefined ? t : undefined
      }, 'already-on Overnight pickup after Design')
      expect(resumed.stage).toBe('work')
      return resumed
    }
    const held = await waitUntil(async () => {
      const t = await get(task.id)
      return t?.preparation === 'ready' && t.runs.length === 0 ? t : undefined
    }, 'ready before Work')
    expect(held).toMatchObject({ stage: 'work', status: { kind: 'stopped', prepared: true } })
    const messages = (await client.getRun(runId)).conversation.map((e) => e.line).join('\n')
    expect(messages).not.toContain('TED moved this Task to Work')
    return held
  }
  const a = await prepare()
  const b = await prepare()
  const c = await prepare()
  await client.ok('POST', `/tasks/${a.id}/resume`, {})
  await waitUntil(async () => (await get(a.id))?.leadRunId !== a.leadRunId, 'fresh Work Lead')
  expect((await get(a.id))?.preparation).toBeUndefined()
  await client.ok('POST', `/tasks/${a.id}/stop`)
  await client.ok('POST', `/tasks/${b.id}/stop`)
  await daemon?.stop()
  client = await start()
  expect((await get(c.id))?.preparation).toBe('ready')
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const occupant = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'release-slot') }] }),
  })
  await client.ok('POST', `/tasks/${occupant.id}/start`)
  await waitUntil(
    async () => (await get(occupant.id))?.runs.some((r) => r.state === 'working'),
    'occupied Run slot',
  )
  await client.ok('PATCH', '/settings', { overnightMode: true })
  await client.ok('PATCH', '/settings', { overnightMode: false })
  expect((await get(c.id))?.preparation).toBe('ready')
  await client.ok('POST', `/tasks/${occupant.id}/stop`)
  expect(await get(c.id)).toMatchObject({
    preparation: 'ready',
    leadRunId: c.leadRunId,
    runs: [],
  })
  await client.ok('PATCH', '/settings', { overnightMode: true })
  await waitUntil(async () => (await get(c.id))?.leadRunId !== c.leadRunId, 'Overnight Work Lead')
  expect((await get(c.id))?.preparation).toBeUndefined()
  expect((await get(a.id))?.statuses).toContain('stopped')
  expect((await get(b.id))?.statuses).toContain('stopped')
  expect((await get(b.id))?.leadRunId).toBe(b.leadRunId)
  await client.ok('PATCH', '/settings', { overnightMode: false })
  await prepare(true)
  const next = await make()
  const file = api(daemon?.port ?? 0, await tokenFor(home))
  expect((await file.call('POST', `/tasks/${next.id}/start`, { prepare: true })).status).toBe(403)
  expect((await client.call('POST', `/tasks/${next.id}/start`, { prepare: 'yes' })).status).toBe(
    400,
  )
})

test('omitting Clarify and Design still holds before Work and later Design is refused', async () => {
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  const client = await start()
  await client.ok('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  const started = await client.ok<Task>('POST', `/tasks/${task.id}/start`, { prepare: true })
  const run = api(
    daemon?.port ?? 0,
    (await loadRunTokens(tedPaths(home).runTokenKey)).issue(started.leadRunId ?? ''),
  )
  expect((await run.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status).toBe(
    200,
  )
  await waitUntil(
    async () =>
      (await client.ok<Task[]>('GET', '/tasks')).find(
        (t) => t.id === task.id && t.preparation === 'ready' && t.runs.length === 0,
      ),
    'ready without Clarify or Design',
  )
  await client.ok('POST', `/tasks/${task.id}/resume`, {})
  await waitUntil(
    async () => (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.leadRunId,
    'resumed Work-first Task',
  )
  const other = await makeOriginRepo(path.join(scratch, 'other'))
  await commitToOrigin(path.join(scratch, 'other'), {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, design, merge]\n',
  })
  const renamed = path.join(scratch, 'other', 'acme', 'gadgets.git')
  await rename(other, renamed)
  await client.ok('POST', '/dev/factories', { repo: renamed, key: 'OT' })
  const invalid = await client.ok<Task>('POST', '/tasks', {
    factory: 'OT',
    title: 'Design follows Work',
  })
  expect((await client.call('POST', `/tasks/${invalid.id}/start`, { prepare: true })).status).toBe(
    409,
  )
})
