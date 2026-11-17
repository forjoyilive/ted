import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Task, type TaskGates, tedPaths } from '@ted/protocol'
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-task-gates-'))
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, clarify, design, work, review, merge]\n',
  })
  daemon = await startDaemon({ home, version: 'test', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const factory = await client.call('POST', '/dev/factories', { repo: origin, key: 'NB' })
  expect(factory.status).toBe(201)
  const task = (
    await client.call('POST', '/tasks', {
      factory: 'NB',
      title: 'Choose Gates',
    })
  ).body as Task
  const route = `/tasks/${task.id}/gates`
  const get = async () => (await client.call('GET', route)).body as TaskGates
  return { client, task, route, get }
}

test('overrides are Task-local, reset to inheritance, survive restart and detect stale edits', async () => {
  const { client, route, get } = await start()
  const initial = await get()
  expect(initial.rows.find((r) => r.stage === 'design')).toMatchObject({
    inherited: true,
    effective: true,
  })
  expect(initial.rows.some((r) => r.stage === 'validate')).toBe(false)
  const saved = await client.call('PUT', route, {
    overrides: { design: false, work: true },
    revision: initial.revision,
  })
  expect(saved.status).toBe(200)
  expect((saved.body as TaskGates).rows.find((r) => r.stage === 'design')).toMatchObject({
    inherited: true,
    effective: false,
    override: false,
  })
  expect(
    (await client.call('PUT', route, { overrides: {}, revision: initial.revision })).status,
  ).toBe(409)
  const another = (await client.call('POST', '/tasks', { factory: 'NB', title: 'Other Task' }))
    .body as Task
  expect(
    ((await client.call('GET', `/tasks/${another.id}/gates`)).body as TaskGates).overrides,
  ).toEqual({})
  await daemon?.stop()
  daemon = await startDaemon({ home, version: 'test', claudeBin: stubClaudePath })
  const restarted = api(daemon.port, { appKey: daemon.appToken })
  const persisted = (await restarted.call('GET', route)).body as TaskGates
  expect(persisted.overrides).toEqual({ design: false, work: true })
  const reset = await restarted.call('PUT', route, { overrides: {}, revision: persisted.revision })
  expect(reset.status).toBe(200)
  expect((reset.body as TaskGates).rows.find((r) => r.stage === 'design')?.effective).toBe(true)
})

test('only the app can write, and invalid or unavailable Stages are refused', async () => {
  const { client, route, get } = await start()
  const initial = await get()
  if (!daemon) throw new Error('daemon not running')
  const file = api(daemon.port, await tokenFor(home))
  expect(
    (await file.call('PUT', route, { overrides: { design: false }, revision: initial.revision }))
      .status,
  ).toBe(403)
  for (const overrides of [{ design: 'false' }, { 'Not a Stage': true }, { backlog: true }, []]) {
    expect(
      (await client.call('PUT', route, { overrides, revision: initial.revision })).status,
    ).toBe(400)
  }
  for (const overrides of [{ validate: true }, { bogus: true }]) {
    expect(
      (await client.call('PUT', route, { overrides, revision: initial.revision })).status,
    ).toBe(409)
  }
})

test('Grilling respects editable sign-off overrides; archived Tasks remain locked', async () => {
  const { client, task, route, get } = await start()
  await client.call('PUT', `/tasks/${task.id}/clarify-depth`, { depth: 'few' })
  const optional = await get()
  await client.call('PUT', route, { overrides: { clarify: false }, revision: optional.revision })
  expect(
    (await client.call('PUT', `/tasks/${task.id}/clarify-depth`, { depth: 'grilling' })).status,
  ).toBe(200)
  const grilling = await get()
  expect(grilling.rows.find((r) => r.stage === 'clarify')).toMatchObject({
    effective: false,
    override: false,
    required: false,
  })
  expect(grilling.rows.find((r) => r.stage === 'clarify')?.locked).toBeUndefined()
  expect(
    (await client.call('PUT', route, { overrides: { clarify: true }, revision: grilling.revision }))
      .status,
  ).toBe(200)
  const on = await get()
  expect(on.rows.find((r) => r.stage === 'clarify')).toMatchObject({
    effective: true,
    override: true,
    required: false,
  })
  expect((await client.call('PUT', route, { overrides: {}, revision: on.revision })).status).toBe(
    200,
  )
  expect((await get()).rows.find((r) => r.stage === 'clarify')).toMatchObject({
    effective: false,
    required: false,
  })
  expect((await client.call('POST', `/tasks/${task.id}/archive`)).status).toBe(200)
  const archived = await get()
  expect(archived.rows.every((r) => r.locked === 'This Task has finished')).toBe(true)
  expect(
    (await client.call('PUT', route, { overrides: { design: false }, revision: archived.revision }))
      .status,
  ).toBe(409)
})

test('editing a Gate and advancing its Stage serialize without bypassing a saved Gate', async () => {
  const { client, task, route, get } = await start()
  await client.call('PUT', `/tasks/${task.id}`, {
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  expect((await client.call('POST', `/tasks/${task.id}/start`)).status).toBe(200)
  const current = await waitUntil(async () => {
    const tasks = (await client.call('GET', '/tasks')).body as Task[]
    return tasks.find((entry) => entry.id === task.id && entry.leadRunId)
  }, 'the Task Lead')
  if (!daemon || !current.leadRunId) throw new Error('Task Lead missing')
  const run = api(
    daemon.port,
    (await loadRunTokens(tedPaths(home).runTokenKey)).issue(current.leadRunId),
  )
  expect(
    (
      await run.call('POST', `/tasks/${task.id}/brief`, {
        text: '## Goal\n\nGate race\n\n## Decisions so far\n\nNone\n\n## Current state\n\nBuilt\n\n## Open questions\n\nNone\n\n## Next step\n\nContinue',
      })
    ).status,
  ).toBe(201)
  const before = await get()
  const [save, advance] = await Promise.all([
    client.call('PUT', route, { overrides: { intake: true }, revision: before.revision }),
    run.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' }),
  ])
  expect([200, 409]).toContain(save.status)
  expect([200, 409]).toContain(advance.status)
  if (save.status === 200) {
    if (advance.status === 409)
      expect(
        (await run.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
      ).toBe(200)
    const tasks = (await client.call('GET', '/tasks')).body as Task[]
    expect(tasks.find((entry) => entry.id === task.id)?.stage).toBe('intake')
    const inbox = (await client.call('GET', '/inbox')).body as { request: { stage?: string } }[]
    expect(inbox.some((entry) => entry.request.stage === 'intake')).toBe(true)
  } else {
    expect(advance.status).toBe(200)
    expect((await get()).overrides).toEqual({})
  }
})
