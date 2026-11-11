import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { openStore, type TedStore } from '../src/store/index.ts'

let dir: string
let store: TedStore
let taskId: string
const check = { name: 'Types', command: 'tsc', timeout: '1m', state: 'waiting' as const }
const initial = Date.parse('2026-11-11T12:00:00Z')
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-check-timing-'))
  store = await openStore({ directory: dir })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(initial)
  taskId = (await store.createTask({ title: 'Checks' })).id
})
afterEach(async () => {
  vi.useRealTimers()
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('queue and command intervals stay separate after reopening and retain Check coverage', async () => {
  const run = store.startChecks({ taskId, trigger: 'merge', stage: 'merge', checks: [check] })
  store.checkSlotBoundary(run.id, 'entered', new Date().toISOString())
  vi.setSystemTime(initial + 2000)
  store.checkSlotBoundary(run.id, 'acquired', new Date().toISOString())
  store.checkStarted(run.id, 0)
  vi.setSystemTime(initial + 5000)
  store.checkFinished(run.id, 0, { state: 'passed', durationMs: 3000, exitCode: 0 })
  store.finishChecks(run.id, 'passed')
  const expected = {
    checkRunId: run.id,
    taskId,
    trigger: 'merge',
    stage: 'merge',
    queue: {
      status: 'complete',
      startedAt: '2026-11-11T12:00:00.000Z',
      endedAt: '2026-11-11T12:00:02.000Z',
      durationMs: 2000,
    },
    execution: [
      {
        position: 0,
        status: 'complete',
        startedAt: '2026-11-11T12:00:02.000Z',
        endedAt: '2026-11-11T12:00:05.000Z',
        durationMs: 3000,
      },
    ],
  }
  expect(store.checkTiming(run.id)).toMatchObject(expected)
  await store.persisted()
  await store.close()
  for (const name of await readdir(path.join(dir, 'ted'))) {
    if (name.startsWith('state')) await rm(path.join(dir, 'ted', name), { force: true })
  }
  store = await openStore({ directory: dir })
  expect(store.checkTiming(run.id)).toMatchObject(expected)
  expect(store.listCheckTimings(taskId)).toMatchObject([expected])
  expect(store.getCheckRun(run.id)?.checks).toMatchObject([{ name: 'Types', durationMs: 3000 }])
})

test('canceled waits have no execution and recovered waits never count downtime', async () => {
  const canceled = store.startChecks({ taskId, trigger: 'agent', stage: 'work', checks: [check] })
  store.checkSlotBoundary(canceled.id, 'entered', new Date().toISOString())
  vi.setSystemTime(initial + 1000)
  store.checkSlotBoundary(canceled.id, 'canceled', new Date().toISOString())
  store.finishChecks(canceled.id, 'interrupted')
  const lost = store.startChecks({
    taskId,
    trigger: 'validate',
    stage: 'validate',
    checks: [check],
  })
  store.checkSlotBoundary(lost.id, 'entered', new Date().toISOString())
  await store.persisted()
  await store.close()
  store = await openStore({ directory: dir })
  vi.setSystemTime(initial + 60_000)
  store.checkSlotBoundary(lost.id, 'recovered', new Date().toISOString())
  store.finishChecks(lost.id, 'interrupted')
  expect(store.checkTiming(canceled.id)).toMatchObject({
    queue: { status: 'canceled', durationMs: 1000 },
    execution: [{ position: 0, status: 'unavailable' }],
  })
  expect(store.checkTiming(lost.id)?.queue).toEqual({
    status: 'interrupted',
    startedAt: '2026-11-11T12:00:01.000Z',
    detectedAt: '2026-11-11T12:01:00.000Z',
  })
  expect(store.checkTiming(lost.id)?.execution).toEqual([{ position: 0, status: 'unavailable' }])
})

test('older queue measurements remain unavailable and factual command durations are unchanged', () => {
  const legacy = store.startChecks({ taskId, trigger: 'agent', stage: 'work', checks: [check] })
  store.checkStarted(legacy.id, 0)
  vi.setSystemTime(initial + 2000)
  store.checkFinished(legacy.id, 0, { state: 'failed', durationMs: 1750, exitCode: 1 })
  store.finishChecks(legacy.id, 'failed')
  expect(store.checkTiming(legacy.id)).toMatchObject({
    queue: { status: 'unavailable' },
    execution: [{ status: 'complete', durationMs: 1750 }],
  })
  expect(store.checkTiming('missing')).toBeUndefined()
  expect(store.listCheckTimings('another-task')).toEqual([])
})

test('observed command interruption records an end without changing historical Check results', () => {
  const run = store.startChecks({ taskId, trigger: 'validate', stage: 'validate', checks: [check] })
  store.checkSlotBoundary(run.id, 'entered', new Date().toISOString())
  store.checkSlotBoundary(run.id, 'acquired', new Date().toISOString())
  store.checkStarted(run.id, 0)
  vi.setSystemTime(initial + 1000)
  store.checkInterrupted(run.id, 0)
  store.finishChecks(run.id, 'interrupted')
  expect(store.checkTiming(run.id)?.execution).toEqual([
    {
      position: 0,
      status: 'interrupted',
      startedAt: '2026-11-11T12:00:00.000Z',
      endedAt: '2026-11-11T12:00:01.000Z',
      durationMs: 1000,
    },
  ])
  expect(store.getCheckRun(run.id)?.checks).toMatchObject([{ state: 'not-run' }])
  expect(store.getCheckRun(run.id)?.checks[0]?.durationMs).toBeUndefined()
})

test('repeated recovery after another stop keeps the first unknown boundary', async () => {
  const run = store.startChecks({ taskId, trigger: 'validate', stage: 'validate', checks: [check] })
  store.checkSlotBoundary(run.id, 'entered', new Date().toISOString())
  vi.setSystemTime(initial + 1000)
  store.checkSlotBoundary(run.id, 'recovered', new Date().toISOString())
  await store.persisted()
  await store.close()
  store = await openStore({ directory: dir })
  vi.setSystemTime(initial + 60_000)
  store.checkSlotBoundary(run.id, 'recovered', new Date().toISOString())
  store.finishChecks(run.id, 'interrupted')
  expect(store.checkTiming(run.id)?.queue).toEqual({
    status: 'interrupted',
    startedAt: '2026-11-11T12:00:00.000Z',
    detectedAt: '2026-11-11T12:00:01.000Z',
  })
})
