import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FailureCase, FailureContext } from '@ted/protocol'
import { expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'

test('failure history and atomic request/answer linkage replay without changing factual Check results', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-failure-store-'))
  let store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Failure history' })
    const check = store.startChecks({
      taskId: task.id,
      trigger: 'agent',
      stage: 'work',
      checks: [{ name: 'Test', command: 'false', timeout: '1m', state: 'waiting' }],
    })
    store.checkFinished(check.id, 0, { state: 'timed-out', durationMs: 60_000 })
    store.finishChecks(check.id, 'failed')
    const original = store.getCheckRun(check.id)
    const at = new Date().toISOString()
    const context: FailureContext = {
      id: 'context',
      taskId: task.id,
      version: 1,
      fingerprint: 'fingerprint',
      repos: [],
      checks: 'checks',
      capturedAt: at,
    }
    store.failures.capture(context)
    const value: FailureCase = {
      id: 'case',
      taskId: task.id,
      source: { kind: 'factory-check', checkRunId: check.id, position: 0 },
      evidence: 'Timed out',
      recordedBy: 'lead',
      provenance: 'stored-check',
      contextId: context.id,
      ...(original?.checks[0] && { originalCheck: original.checks[0] }),
      createdAt: at,
      assessments: [],
      additions: [],
      decisions: [],
      resolutions: [],
      invalidations: [],
    }
    store.failures.save(value, 'recorded')
    expect(() =>
      store.failures.save({ ...value, evidence: 'Rewritten evidence' }, 'assessed'),
    ).toThrow('immutable')
    expect(() => store.failures.capture({ ...context, fingerprint: 'replacement' })).toThrow(
      'immutable',
    )
    const assessed = {
      ...value,
      assessments: [
        {
          id: 'assessment',
          runId: 'lead',
          assessment: 'unrelated' as const,
          recommendation: 'Accept',
          contextId: context.id,
          at,
        },
      ],
    }
    store.failures.save(assessed, 'assessed')
    const requested = store.postFailureDecision(assessed, 'Decision')
    const id = requested.decisions[0]?.commentId ?? ''
    expect(store.listOpenRequests().map((c) => c.id)).toContain(id)
    const resolved = {
      ...requested,
      resolutions: [
        {
          requestId: id,
          resolution: 'accepted' as const,
          assessmentId: 'assessment',
          contextId: context.id,
          at,
        },
      ],
    }
    store.resolveFailure(resolved, id, { kind: 'answered', choice: 'Accept this failure', at }, [])
    const final = { ...resolved, invalidations: [{ requestId: id, reason: 'Changed code', at }] }
    store.failures.save(final, 'invalidated')
    expect(() => store.failures.save({ ...final, resolutions: [] }, 'assessed')).toThrow(
      'append-only',
    )
    await store.persisted()
    await store.close()
    for (const file of await readdir(path.join(directory, 'ted'))) {
      if (file.startsWith('state')) await rm(path.join(directory, 'ted', file), { force: true })
    }
    store = await openStore({ directory })
    expect(store.failures.context(context.id)).toEqual(context)
    expect(store.failures.get(value.id)).toEqual(final)
    expect(store.getCheckRun(check.id)).toEqual(original)
    expect(store.getComment(id)?.answer).toMatchObject({
      kind: 'answered',
      choice: 'Accept this failure',
    })
    expect(store.listOpenRequests().map((c) => c.id)).not.toContain(id)
    store.deleteTask(task.id)
    expect(store.failures.list(task.id)).toEqual([])
    expect(store.failures.context(context.id)).toBeUndefined()
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
