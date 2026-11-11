import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
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
    store.testInvocations.report(input.id, {
      sequence: 0,
      kind: 'wait-start',
      at: invocation.registeredAt,
    })
    expect(store.testInvocations.summary(task.id).checksWithoutReports).toEqual([])
    store.checkInterrupted(check.id, 0)
    expect(store.testInvocations.summary(task.id).invocations[0]?.coverage).toBe('incomplete')
    store.finishChecks(check.id, 'interrupted')
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
