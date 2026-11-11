import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { testActivityLeaseMs, testReporterSubject } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { openStore } from '../src/store/index.ts'

test('bounded invocation history enforces ownership, transitions and timestamps and survives replay without logs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-test-reports-'))
  let store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Test reports' })
    const other = await store.createTask({ title: 'Other Task' })
    const run = store.startRun({
      id: randomUUID(),
      taskId: task.id,
      agent: 'codex',
      prompt: 'work',
      cwd: directory,
    })
    const owner = { taskId: task.id, runId: run.id }
    const input = {
      id: randomUUID(),
      supported: true,
      label: 'https://user:password@example.com tests',
    }
    const value = store.testInvocations.register(owner, input)
    expect(value.label).not.toContain('password')
    expect(store.testInvocations.register(owner, input)).toEqual(value)
    expect(() => store.testInvocations.register({ ...owner, taskId: other.id }, input)).toThrow(
      'owned',
    )
    expect(() => store.testInvocations.register(owner, { ...input, supported: false })).toThrow(
      'registered differently',
    )
    expect(() =>
      store.testInvocations.register(
        { ...owner, taskId: other.id },
        { id: randomUUID(), supported: true },
      ),
    ).toThrow('not live')
    const report = (
      sequence: number,
      kind: 'wait-start' | 'wait-end' | 'finished' | 'canceled' | 'interrupted',
      at = value.registeredAt,
    ) => store.testInvocations.report(value.id, { sequence, kind, at })
    expect(() => report(1, 'wait-start')).toThrow('out of order')
    expect(() => report(0, 'wait-end')).toThrow('transition')
    expect(() => report(0, 'wait-start', value.registeredAt - 1)).toThrow('timestamp')
    expect(() => report(0, 'wait-start', Date.now() + 10_000)).toThrow('timestamp')
    report(0, 'wait-start')
    report(0, 'wait-start')
    expect(() => report(0, 'wait-start', value.registeredAt + 1)).toThrow('duplicate')
    expect(() => report(1, 'wait-start')).toThrow('transition')
    expect(() => report(1, 'finished')).toThrow('transition')
    report(1, 'wait-end', value.registeredAt + 10)
    report(2, 'wait-start', value.registeredAt + 10)
    report(3, 'interrupted', value.registeredAt + 20)
    expect(() => report(4, 'finished', value.registeredAt + 20)).toThrow('closed')
    expect(store.testInvocations.summary(task.id).invocations[0]).toMatchObject({
      confirmedWaitMs: 20,
      outcome: 'interrupted',
      coverage: 'reported',
    })

    const missing = store.testInvocations.register(owner, { id: randomUUID(), supported: true })
    const open = store.testInvocations.register(owner, { id: randomUUID(), supported: true })
    store.testInvocations.report(open.id, {
      sequence: 0,
      kind: 'wait-start',
      at: open.registeredAt,
    })
    const unsupported = store.testInvocations.register(owner, {
      id: randomUUID(),
      supported: false,
    })
    expect(() =>
      store.testInvocations.report(unsupported.id, {
        sequence: 0,
        kind: 'finished',
        at: unsupported.registeredAt,
      }),
    ).toThrow('does not support')
    expect(
      store.testInvocations.summary(task.id).invocations.find((i) => i.id === missing.id)?.coverage,
    ).toBe('unreported')
    const bounded = store.testInvocations.register(owner, { id: randomUUID(), supported: true })
    for (let sequence = 0; sequence < 63; sequence++)
      store.testInvocations.report(bounded.id, {
        sequence,
        kind: sequence % 2 === 0 ? 'wait-start' : 'wait-end',
        at: bounded.registeredAt,
      })
    expect(() =>
      store.testInvocations.report(bounded.id, {
        sequence: 63,
        kind: 'wait-end',
        at: bounded.registeredAt,
      }),
    ).toThrow('last report')
    store.testInvocations.report(bounded.id, {
      sequence: 63,
      kind: 'canceled',
      at: bounded.registeredAt,
    })
    while (store.testInvocations.summary(task.id).invocations.length < 256)
      store.testInvocations.register(owner, { id: randomUUID(), supported: false })
    expect(store.testInvocations.summary(task.id).limitReached).toBe(true)
    expect(() =>
      store.testInvocations.register(owner, { id: randomUUID(), supported: true }),
    ).toThrow('limit')

    store.recordRunOutput(run.id, { toOffset: 1, state: 'finished' })
    store.reviveRun(run.id)
    expect(() =>
      store.testInvocations.report(open.id, {
        sequence: 1,
        kind: 'interrupted',
        at: open.registeredAt,
      }),
    ).toThrow('ended')
    const summary = store.testInvocations.summary(task.id)
    expect(summary.invocations.find((i) => i.id === open.id)).toMatchObject({
      coverage: 'incomplete',
      confirmedWaitMs: 0,
      openWaitStartedAt: open.registeredAt,
      ownerEnded: true,
    })
    expect(summary.invocations.find((i) => i.id === missing.id)?.coverage).toBe('incomplete')
    await store.persisted()
    await store.close()
    for (const name of await readdir(path.join(directory, 'ted')))
      if (name.startsWith('state')) await rm(path.join(directory, 'ted', name), { force: true })
    store = await openStore({ directory })
    expect(store.testInvocations.summary(task.id)).toEqual(summary)
    expect(store.testInvocations.summary(other.id).invocations).toEqual([])
    const oldSubject = testReporterSubject(value)
    store.deleteTask(task.id)
    expect(store.testInvocations.get(value.id)).toBeUndefined()
    const replacementRun = store.startRun({
      id: randomUUID(),
      taskId: other.id,
      agent: 'codex',
      prompt: 'replacement',
      cwd: directory,
    })
    const reused = store.testInvocations.register(
      { taskId: other.id, runId: replacementRun.id },
      input,
    )
    const newSubject = testReporterSubject(reused)
    expect(newSubject).not.toBe(oldSubject)
    await store.persisted()
    await store.close()
    for (const name of await readdir(path.join(directory, 'ted')))
      if (name.startsWith('state')) await rm(path.join(directory, 'ted', name), { force: true })
    store = await openStore({ directory })
    const replayed = store.testInvocations.get(value.id)
    expect(replayed).toMatchObject({ taskId: other.id, runId: replacementRun.id })
    if (!replayed) throw new Error('missing replacement invocation')
    expect(testReporterSubject(replayed)).toBe(newSubject)
    expect(testReporterSubject(replayed)).not.toBe(oldSubject)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Check association is verified and interruption ends coverage without inventing a wait boundary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-check-reports-'))
  const store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Check reports' })
    store.changeStage(task.id, 'work')
    store.setChecksWaiting(new Map([[task.id, 2]]))
    expect(store.getTask(task.id)?.markers).toMatchObject([
      {
        kind: 'test-activity',
        source: 'checks',
        phase: 'waiting',
        detail: expect.stringContaining('2nd'),
      },
    ])
    store.setChecksWaiting(new Map())
    const other = await store.createTask({ title: 'Other' })
    const check = store.startChecks({
      taskId: task.id,
      trigger: 'agent',
      stage: 'work',
      checks: [{ name: 'Tests', command: 'true', timeout: '1m', state: 'waiting' }],
    })
    const input = { id: randomUUID(), supported: true, checkRunId: check.id, position: 0 }
    expect(() => store.testInvocations.register({ taskId: task.id }, input)).toThrow('not live')
    store.checkStarted(check.id, 0)
    expect(() => store.testInvocations.register({ taskId: other.id }, input)).toThrow('not live')
    expect(() => store.testInvocations.register({ taskId: task.id, runId: 'run' }, input)).toThrow(
      'Runs cannot',
    )
    expect(() =>
      store.testInvocations.register({ taskId: task.id }, { ...input, position: 1 }),
    ).toThrow('not live')
    expect(store.testInvocations.summary(task.id).checksWithoutReports).toEqual([
      { checkRunId: check.id, position: 0, coverage: 'unreported' },
    ])
    const invocation = store.testInvocations.register({ taskId: task.id }, input)
    expect(store.getTask(task.id)?.markers).toMatchObject([
      { kind: 'test-activity', source: 'checks', phase: 'running' },
    ])
    store.testInvocations.report(input.id, {
      sequence: 0,
      kind: 'wait-start',
      at: invocation.registeredAt,
    })
    store.testInvocations.report(input.id, { sequence: 1, kind: 'waiting', at: Date.now() })
    expect(store.getTask(task.id)?.markers).toMatchObject([
      { kind: 'test-activity', source: 'checks', phase: 'waiting' },
    ])
    expect(store.getTask(task.id)?.activity).toContain('shared test slot')
    expect(store.testInvocations.active(task.id)).toEqual({
      running: 0,
      waiting: 0,
      checksWaiting: true,
    })
    expect(store.testInvocations.summary(task.id).checksWithoutReports).toEqual([])
    store.checkInterrupted(check.id, 0)
    expect(store.testInvocations.summary(task.id).invocations[0]?.coverage).toBe('incomplete')
    store.finishChecks(check.id, 'interrupted')
    expect(store.getTask(task.id)?.markers).toEqual([])
    const completed = store.startChecks({
      taskId: task.id,
      trigger: 'agent',
      stage: 'work',
      checks: [{ name: 'Completed', command: 'true', timeout: '1m', state: 'waiting' }],
    })
    store.checkStarted(completed.id, 0)
    const unfinishedReport = store.testInvocations.register(
      { taskId: task.id },
      { id: randomUUID(), supported: true, checkRunId: completed.id, position: 0 },
    )
    store.checkFinished(completed.id, 0, { state: 'passed', durationMs: 1 })
    expect(
      store.testInvocations.summary(task.id).invocations.find((i) => i.id === unfinishedReport.id)
        ?.coverage,
    ).toBe('incomplete')
    const unreported = store.startChecks({
      taskId: task.id,
      trigger: 'agent',
      stage: 'work',
      checks: [{ name: 'Interrupted', command: 'true', timeout: '1m', state: 'waiting' }],
    })
    store.checkStarted(unreported.id, 0)
    store.finishChecks(unreported.id, 'interrupted')
    expect(store.testInvocations.summary(task.id).checksWithoutReports).toEqual([
      { checkRunId: unreported.id, position: 0, coverage: 'unreported' },
    ])

    expect(store.testInvocations.summary(task.id).invocations[0]).toMatchObject({
      coverage: 'incomplete',
      confirmedWaitMs: 0,
      openWaitStartedAt: invocation.registeredAt,
    })
    expect(store.testInvocations.summary(task.id).invocations[0]?.reports).toHaveLength(1)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('live test indicators aggregate Runs, expire without changing history and clear on lifecycle changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-live-tests-'))
  let store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Live tests' })
    store.changeStage(task.id, 'work')
    const lead = store.startRun({
      id: randomUUID(),
      taskId: task.id,
      agent: 'codex',
      prompt: 'work',
      cwd: directory,
    })
    const child = store.startRun({
      id: randomUUID(),
      taskId: task.id,
      parentRunId: lead.id,
      agent: 'claude',
      prompt: 'review',
      cwd: directory,
    })
    const one = store.testInvocations.register(
      { taskId: task.id, runId: lead.id },
      { id: randomUUID(), supported: true },
    )
    const two = store.testInvocations.register(
      { taskId: task.id, runId: child.id },
      { id: randomUUID(), supported: true },
    )
    const pulse = (id: string, kind: 'running' | 'waiting' | 'inactive', sequence = 0) =>
      store.testInvocations.report(id, { sequence, kind, at: Date.now() })
    expect(store.getTask(task.id)?.markers).toEqual([])
    const snapshots: unknown[] = []
    store.subscribe((event) => {
      if (event.type === 'task-updated' && event.task.id === task.id)
        snapshots.push(event.task.markers)
    })
    pulse(one.id, 'running')
    expect(store.getTask(task.id)?.markers).toMatchObject([
      { label: 'Running tests', phase: 'running', detail: '1 supported test command running' },
    ])
    expect(snapshots.at(-1)).toEqual(store.getTask(task.id)?.markers)
    const beforePulse = store.testInvocations.summary(task.id)
    pulse(one.id, 'running')
    expect(store.testInvocations.summary(task.id)).toEqual(beforePulse)
    expect(() => pulse(one.id, 'waiting')).toThrow('wait state')
    expect(() => pulse(one.id, 'running', 1)).toThrow('out of order')
    expect(() =>
      store.testInvocations.report(one.id, {
        sequence: 0,
        kind: 'running',
        at: Date.now() - 6_000,
      }),
    ).toThrow('stale')
    expect(() =>
      store.testInvocations.report(
        one.id,
        JSON.parse(
          JSON.stringify({ sequence: 0, kind: 'running', at: Date.now(), text: 'untrusted' }),
        ),
      ),
    ).toThrow('unknown')
    store.testInvocations.report(two.id, { sequence: 0, kind: 'wait-start', at: two.registeredAt })
    pulse(two.id, 'waiting', 1)
    expect(store.getTask(task.id)?.markers).toMatchObject([
      { label: 'Running tests' },
      { label: 'Waiting for tests' },
    ])
    expect(store.getTask(task.id)?.activity).toBe('1 test command running · 1 waiting')
    pulse(two.id, 'inactive', 1)
    expect(
      store.testInvocations.summary(task.id).invocations.find((v) => v.id === two.id),
    ).toMatchObject({ openWaitStartedAt: two.registeredAt })
    expect(store.getTask(task.id)?.markers).toHaveLength(1)
    store.testInvocations.report(one.id, { sequence: 0, kind: 'finished', at: Date.now() })
    expect(store.getTask(task.id)?.markers).toEqual([])
    expect(() => pulse(one.id, 'running', 1)).toThrow('closed')
    store.testInvocations.report(two.id, { sequence: 1, kind: 'wait-end', at: Date.now() })
    pulse(two.id, 'running', 2)
    store.recordRunOutput(child.id, { toOffset: 1, state: 'finished' })
    store.reviveRun(child.id)
    expect(store.getTask(task.id)?.markers).toEqual([])
    expect(() => pulse(two.id, 'running', 2)).toThrow('ended')

    const fresh = store.testInvocations.register(
      { taskId: task.id, runId: lead.id },
      { id: randomUUID(), supported: true },
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      pulse(fresh.id, 'running')
      const history = store.testInvocations.summary(task.id)
      await vi.advanceTimersByTimeAsync(testActivityLeaseMs - 1)
      expect(store.getTask(task.id)?.markers).toHaveLength(1)
      pulse(fresh.id, 'running')
      await vi.advanceTimersByTimeAsync(1)
      expect(store.getTask(task.id)?.markers).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(testActivityLeaseMs)
      expect(store.getTask(task.id)?.markers).toEqual([])
      expect(snapshots.at(-1)).toEqual([])
      expect(store.testInvocations.summary(task.id)).toEqual(history)
    } finally {
      vi.useRealTimers()
    }

    pulse(fresh.id, 'running')
    expect(store.archiveTask(task.id).markers).toEqual([])
    store.unarchiveTask(task.id, { queue: false, waitForBlockers: false })
    store.changeStage(task.id, 'done')
    expect(store.getTask(task.id)?.markers).toEqual([])
    store.changeStage(task.id, 'work')
    expect(store.stopTask(task.id, { runs: 1, why: 'human' }).markers).toEqual([])
    await store.persisted()
    await store.close()
    store = await openStore({ directory })
    expect(store.testInvocations.active(task.id)).toEqual({
      running: 0,
      waiting: 0,
      checksWaiting: false,
    })
  } finally {
    vi.useRealTimers()
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
