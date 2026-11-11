import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FailureCase } from '@ted/protocol'
import { expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'
import { taskThreadEvents } from '../src/tasks/thread.ts'

test('a persisted validation judgment keeps its original visit and failures after later changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-validation-snapshot-'))
  let store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Historical validation' })
    const at = '2026-11-09T12:00:00.000Z'
    const progress = {
      taskId: task.id,
      visit: at,
      checks: [
        { name: 'Original Check', command: 'false', timeout: '1m', state: 'failed' as const },
      ],
      executions: [{ runId: 'original-run', start: 0 }],
      next: 1,
      pending: false,
    }
    store.failures.saveProgress(progress)
    let failure: FailureCase = {
      id: 'original-failure',
      taskId: task.id,
      validation: true,
      source: { kind: 'factory-check', checkRunId: 'original-run', position: 0 },
      evidence: 'Original evidence',
      recordedBy: 'lead',
      provenance: 'stored-check',
      createdAt: at,
      assessments: [],
      additions: [],
      decisions: [],
      resolutions: [],
      invalidations: [],
    }
    failure = store.failures.save(failure, 'recorded')
    failure = store.failures.save(
      {
        ...failure,
        assessments: [
          {
            id: 'assessment',
            runId: 'lead',
            assessment: 'unrelated',
            recommendation: 'Original recommendation',
            at,
          },
        ],
      },
      'assessed',
    )
    failure = store.failures.save(
      { ...failure, decisions: [{ commentId: 'decision', assessmentId: 'assessment' }] },
      'requested',
    )
    failure = store.failures.save(
      {
        ...failure,
        resolutions: [
          {
            requestId: 'decision',
            assessmentId: 'assessment',
            resolution: 'accepted',
            reason: 'Original decision',
            at,
          },
        ],
      },
      'resolved',
    )
    store.judgeValidate({
      taskId: task.id,
      outcome: 'passed',
      review: { passed: false },
      visual: { passed: false },
    })
    store.failures.saveProgress({
      ...progress,
      visit: 'later-visit',
      checks: [{ name: 'Later Check', command: 'true', timeout: '1m', state: 'passed' }],
      executions: [{ runId: 'later-run', start: 0 }],
    })
    store.failures.save(
      {
        ...failure,
        invalidations: [
          { requestId: 'decision', reason: 'Later context', at: new Date().toISOString() },
        ],
      },
      'invalidated',
    )
    await store.persisted()
    await store.close()
    store = await openStore({ directory })
    const events = taskThreadEvents(store, task.id, {
      comments: [],
      displayIdOf: () => '',
      waitingFor: [],
    })
    const judged = events.find((event) => event.validate === 'passed')
    expect(judged?.validation?.progress).toEqual(progress)
    expect(judged?.validation?.failures[0]).toMatchObject({
      evidence: 'Original evidence',
      invalidations: [],
      resolutions: [{ resolution: 'accepted', reason: 'Original decision' }],
    })
    expect(judged?.judgments).toEqual([
      { name: 'Review', passed: false },
      { name: 'Visual', passed: false },
    ])
    expect(store.failures.progress(task.id)?.visit).toBe('later-visit')
    expect(store.failures.get(failure.id)?.invalidations).toHaveLength(1)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
