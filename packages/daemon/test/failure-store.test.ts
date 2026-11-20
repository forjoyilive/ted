import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FailureCase, FailureContext } from '@ted/protocol'
import { expect, expectTypeOf, test } from 'vitest'
import type { ChecksArea } from '../src/store/checks.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { createFailureCases } from '../src/tasks/failure-cases.ts'

expectTypeOf<TedStore>().toExtend<ChecksArea>()

const failureService = (store: TedStore) =>
  createFailureCases({
    store,
    snapshot: async () => {
      throw new Error('No worktree')
    },
    assertLead: () => {},
    drafts: () => [],
    onHold: async () => {},
    onInvalidated: async () => {},
    tell: async () => {},
  })

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
    expect(await failureService(store).obligations({ ...task, stage: 'done' })).toMatchObject({
      satisfied: true,
      cases: [{ disposition: 'accepted', context: 'historical' }],
    })
    const final = { ...resolved, invalidations: [{ requestId: id, reason: 'Changed code', at }] }
    store.invalidateFailure(final, {
      title: 'Failure acceptance invalidated',
      body: 'Changed code',
    })
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
    expect(
      store.listComments(task.id).filter((c) => c.title === 'Failure acceptance invalidated'),
    ).toMatchObject([{ body: 'Changed code', author: { kind: 'ted' } }])
    expect(
      store.listComments(task.id).find((c) => c.title === 'Failure acceptance invalidated')
        ?.delivered,
    ).toBeUndefined()
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

test('legacy evidence requires a bound assessment and new bindings survive replay', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-failure-evidence-'))
  let store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Legacy assessment' })
    const at = new Date().toISOString()
    const original: FailureCase = {
      id: 'legacy',
      taskId: task.id,
      source: { kind: 'finding', runId: 'lead', finding: 'Original' },
      evidence: 'Original evidence',
      recordedBy: 'lead',
      provenance: 'task-lead-reported',
      createdAt: at,
      additions: [],
      assessments: [],
      decisions: [],
      resolutions: [],
      invalidations: [],
    }
    store.failures.save(original, 'recorded')
    const evidence = {
      ...original,
      additions: [{ evidence: 'Added evidence', runId: 'lead', at }],
    }
    store.failures.save(evidence, 'evidence')
    const legacy = {
      ...evidence,
      assessments: [
        {
          id: 'old',
          assessment: 'unrelated' as const,
          recommendation: 'Accept',
          runId: 'lead',
          at,
        },
      ],
    }
    store.failures.save(legacy, 'assessed')
    await store.persisted()
    await store.close()
    store = await openStore({ directory })
    expect(store.failures.get(legacy.id)).toEqual(legacy)
    const service = failureService(store)
    await expect(service.request(task, legacy.id, 'lead')).rejects.toMatchObject({ status: 409 })
    const pending = store.postFailureDecision(legacy, 'Old pending decision')
    const oldRequest = pending.decisions.at(-1)?.commentId ?? ''
    await expect(
      service.resolve(task, legacy.id, {
        requestId: oldRequest,
        resolution: 'fixed',
        reason: 'A reason cannot replace a current assessment',
      }),
    ).rejects.toMatchObject({ status: 409 })
    const fresh = await service.assess(task, legacy.id, 'lead', {
      assessment: 'unrelated',
      recommendation: 'Consider all evidence',
      choice: 'fixed',
    })
    expect(fresh.assessments.at(-1)?.evidenceCount).toBe(1)
    expect(store.getComment(oldRequest)?.answer?.kind).toBe('withdrawn')
    const asked = await service.request(task, legacy.id, 'lead')
    const request = {
      requestId: asked.decisions.at(-1)?.commentId ?? '',
      resolution: 'fixed' as const,
      reason: 'Verified a fix',
    }
    await service.resolve(task, legacy.id, request)
    await expect(service.resolve(task, legacy.id, request)).rejects.toMatchObject({ status: 409 })
    const withoutAdditions = { ...original, id: 'legacy-no-additions' }
    store.failures.save(withoutAdditions, 'recorded')
    store.failures.save({ ...withoutAdditions, assessments: legacy.assessments }, 'assessed')
    const oldAssessment = await service.request(task, withoutAdditions.id, 'lead')
    await service.resolve(task, withoutAdditions.id, {
      requestId: oldAssessment.decisions.at(-1)?.commentId ?? '',
      resolution: 'fixed',
      reason: 'No evidence was added',
    })
    await store.persisted()
    await store.close()
    for (const file of await readdir(path.join(directory, 'ted'))) {
      if (file.startsWith('state')) await rm(path.join(directory, 'ted', file), { force: true })
    }
    store = await openStore({ directory })
    const replayed = store.failures.get(legacy.id)
    expect(replayed?.assessments[0]).toEqual(legacy.assessments[0])
    expect(replayed?.assessments.at(-1)?.evidenceCount).toBe(1)
    expect(replayed?.resolutions.at(-1)?.requestId).toBe(request.requestId)
    expect(store.getComment(request.requestId)?.answer?.kind).toBe('answered')
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('final observation invalidates earlier consent while committing only the matching case', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-failure-final-'))
  const store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Independent final decisions' })
    store.startRun({ id: 'lead', taskId: task.id, agent: 'codex', prompt: '', cwd: directory })
    let fingerprint = 'A'
    let final = false
    let reads = 0
    const service = createFailureCases({
      store,
      snapshot: async () => ({
        id: `${fingerprint}-${reads++}`,
        taskId: task.id,
        version: 2,
        capturedAt: new Date().toISOString(),
        fingerprint: final && reads === 2 ? 'B' : fingerprint,
        repos: [],
        checks: final && reads === 2 ? 'B' : fingerprint,
      }),
      assertLead: () => {},
      drafts: () => [],
      onHold: async () => {},
      onInvalidated: async () => {},
      tell: async () => {},
    })
    const a = await service.capture(task, 'lead')
    fingerprint = 'B'
    const b = await service.capture(task, 'lead')
    fingerprint = 'A'
    const ask = async (contextId: string) => {
      const value = await service.record(task, 'lead', {
        source: { kind: 'finding', runId: 'lead', finding: 'Original Finding' },
        evidence: 'Original evidence',
        contextId,
      })
      await service.assess(task, value.id, 'lead', {
        assessment: 'unrelated',
        recommendation: 'Accept this context',
        choice: 'fixed',
      })
      return service.request(task, value.id, 'lead')
    }
    const first = await ask(a.id)
    await service.resolve(task, first.id, {
      requestId: first.decisions[0]?.commentId ?? '',
      resolution: 'accepted',
    })
    store.recordRunOutput('lead', {
      toOffset: 0,
      state: 'finished',
      ending: { how: 'exited', errorLines: [], at: new Date().toISOString() },
    })
    const second = await ask(b.id)
    final = true
    reads = 0
    const resolved = await service.resolve(task, second.id, {
      requestId: second.decisions[0]?.commentId ?? '',
      resolution: 'accepted',
    })
    expect(resolved.resolutions).toHaveLength(1)
    expect(resolved.invalidations).toEqual([])
    expect(store.failures.get(first.id)?.invalidations).toHaveLength(1)
    expect(store.failures.get(first.id)?.resolutions).toHaveLength(1)
    final = false
    fingerprint = 'B'
    expect(await service.obligations(task)).toMatchObject({
      satisfied: false,
      blockers: [first.id],
      cases: expect.arrayContaining([
        { id: first.id, disposition: 'invalidated', context: 'changed' },
        { id: second.id, disposition: 'accepted', context: 'current' },
      ]),
    })
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('CI invalidation is synchronous and delayed hold effects cannot revoke newer consent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-failure-ci-'))
  const store = await openStore({ directory })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const task = await store.createTask({ title: 'Immediate CI observation' })
    store.startRun({ id: 'lead', taskId: task.id, agent: 'codex', prompt: '', cwd: directory })
    let reads = 0
    let delay = false
    let entered = () => {}
    const holding = new Promise<void>((resolve) => {
      entered = resolve
    })
    const notices: string[][] = []
    const service = createFailureCases({
      store,
      snapshot: async () => ({
        id: `context-${reads++}`,
        taskId: task.id,
        version: 2,
        fingerprint: 'context-A',
        capturedAt: new Date().toISOString(),
        repos: [],
        checks: 'checks',
        ci: 'CI-A',
      }),
      assertLead: () => {},
      drafts: () => [],
      tell: async () => {},
      onHold: async () => {
        if (delay) {
          delay = false
          entered()
          await gate
        }
      },
      onInvalidated: async (_task, ids) => {
        notices.push(ids)
      },
    })
    const context = await service.capture(task, 'lead')
    const value = await service.record(task, 'lead', {
      source: { kind: 'finding', runId: 'lead', finding: 'Original Finding' },
      evidence: 'Original evidence',
      contextId: context.id,
    })
    const accept = async () => {
      await service.assess(task, value.id, 'lead', {
        assessment: 'unrelated',
        recommendation: 'Accept A',
        choice: 'accepted',
      })
      const asked = await service.request(task, value.id, 'lead')
      return service.resolve(task, value.id, {
        requestId: asked.decisions.at(-1)?.commentId ?? '',
        resolution: 'accepted',
      })
    }
    const first = await accept()
    delay = true
    const effects = service.observeCi(task, 'CI-B')
    expect(store.failures.get(value.id)?.invalidations).toMatchObject([
      { requestId: first.resolutions[0]?.requestId },
    ])
    await holding
    await service.observeCi(task, 'CI-A')
    const fresh = await accept()
    release()
    await effects
    expect(store.failures.get(value.id)?.resolutions).toEqual(fresh.resolutions)
    expect(store.failures.get(value.id)?.invalidations).toHaveLength(1)
    expect(notices).toEqual([[value.id]])
    expect(await service.obligations(task)).toMatchObject({
      satisfied: true,
      cases: [{ id: value.id, disposition: 'accepted', context: 'current' }],
    })
  } finally {
    release()
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failure question in Work is replaced with Run the checks again once the code moves, and a Comment wakes the exited Task Lead', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-failure-rerun-'))
  const store = await openStore({ directory })
  try {
    const created = await store.createTask({ title: 'Code moved after the ask' })
    store.startTask({
      taskId: created.id,
      stage: 'work',
      branch: 'code-moved',
      worktree: directory,
      entry: { layers: [], order: [{ stage: 'work', enabled: true }] },
      repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
    })
    store.startRun({ id: 'lead', taskId: created.id, agent: 'codex', prompt: '', cwd: directory })
    const check = store.startChecks({
      taskId: created.id,
      trigger: 'validate',
      stage: 'validate',
      checks: [{ name: 'Tests', command: 'false', timeout: '1m', state: 'waiting' }],
    })
    store.checkFinished(check.id, 0, { state: 'failed', durationMs: 1000, exitCode: 1 })
    store.finishChecks(check.id, 'failed')
    const at = new Date().toISOString()
    const tested = (head: string): FailureContext => ({
      id: `context-${head}`,
      taskId: created.id,
      version: 2,
      fingerprint: head,
      repos: [{ repo: 'acme/widgets', head, base: 'base', tree: `tree-${head}`, mergeBase: 'mb' }],
      checks: 'checks',
      capturedAt: at,
    })
    store.failures.capture(tested('a'))
    const value: FailureCase = {
      id: 'case',
      taskId: created.id,
      source: { kind: 'factory-check', checkRunId: check.id, position: 0 },
      evidence: 'Tests failed',
      recordedBy: 'lead',
      provenance: 'stored-check',
      contextId: 'context-a',
      createdAt: at,
      validation: true,
      assessments: [],
      additions: [],
      decisions: [],
      resolutions: [],
      invalidations: [],
    }
    store.failures.save(value, 'recorded')
    const assessed = {
      ...value,
      assessments: [
        {
          id: 'assessment',
          runId: 'lead',
          assessment: 'unrelated' as const,
          recommendation: 'It fails the same way on main.',
          choice: 'accepted' as const,
          contextId: 'context-a',
          at,
        },
      ],
    }
    store.failures.save(assessed, 'assessed')
    const asked = store.postFailureDecision(assessed, 'Accept?').decisions[0]
    let current: FailureContext | undefined = tested('a')
    const service = createFailureCases({
      store,
      snapshot: async () => {
        if (!current) throw new Error('No worktree')
        return current
      },
      assertLead: () => {},
      drafts: () => [],
      onHold: async () => {},
      onInvalidated: async () => {},
      tell: async () => {},
    })
    const task = () => {
      const found = store.getTask(created.id)
      if (!found) throw new Error('missing Task')
      return found
    }
    expect(await service.refreshStale(task())).toBe(0)
    expect(store.getComment(asked?.commentId ?? '')?.answer).toBeUndefined()

    current = tested('b')
    expect(await service.refreshStale(task())).toBe(1)
    expect(store.getComment(asked?.commentId ?? '')?.answer).toMatchObject({ kind: 'withdrawn' })
    const replaced = store.failures.get('case')?.decisions.at(-1)
    expect(replaced).toMatchObject({ rerun: true, acceptRefused: 'changed' })
    const card = store.getComment(replaced?.commentId ?? '')
    expect(card).toMatchObject({
      purpose: { kind: 'failure' },
      choices: ['Run the checks again on the new code'],
    })
    expect(card?.body).toContain('code changed after the Task Lead asked')
    expect(await service.refreshStale(task())).toBe(0)

    expect(task().wakesOnComment).toBeUndefined()
    store.recordRunOutput('lead', {
      toOffset: 0,
      state: 'finished',
      ending: { how: 'exited', errorLines: [], at: new Date().toISOString() },
    })
    expect(task()).toMatchObject({ wakesOnComment: true })
    expect(task().canResume).toBeUndefined()
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
