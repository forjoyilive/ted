import { DaemonClient, readDaemonInfo, tedPaths } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { openStore } from '../src/store/index.ts'
import { makeTempHome, rawRequest } from './helpers.ts'

test('read-only Dashboard request uses durable Factory history and validates its range', async () => {
  const { home, cleanup } = await makeTempHome()
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  const store = await openStore({ directory: tedPaths(home).store })
  const now = Date.now()
  let factoryId = ''
  let taskId = ''
  try {
    vi.useFakeTimers({ toFake: ['Date'] })
    const factory = store.createFactory({
      key: 'NB',
      name: 'Widgets',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    factoryId = factory.id
    vi.setSystemTime(now - 36_000_000)
    const task = await store.createTask({ factoryId, title: 'Completed across two repos' })
    taskId = task.id
    store.worktreeCreated(task.id, {
      name: 'a',
      repo: 'acme/a',
      branch: 'task',
      worktree: home,
      copied: [],
      skipped: [],
    })
    store.worktreeCreated(task.id, {
      name: 'b',
      repo: 'acme/b',
      branch: 'task',
      worktree: home,
      copied: [],
      skipped: [],
    })
    vi.setSystemTime(now - 18_000_000)
    store.changeStage(task.id, 'intake', { layers: [], order: [] })
    vi.setSystemTime(now - 3_600_000)
    store.changeStage(task.id, 'done', { layers: [], order: [] })
    store.archiveTask(task.id)
    const other = store.createFactory({
      key: 'ZZ',
      name: 'Other',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    const excluded = await store.createTask({ factoryId: other.id, title: 'Other Factory' })
    store.changeStage(excluded.id, 'done', { layers: [], order: [] })
    await store.persisted()
  } finally {
    vi.useRealTimers()
    await store.close()
  }
  try {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('missing daemon info')
    const client = new DaemonClient(info)
    const result = await client.factoryDashboard(factoryId, '7d')
    expect(result.current.taskIds).toEqual([taskId])
    expect(result.current.created.value).toBe(32_400_000)
    expect(result.current.intake.value).toBe(14_400_000)
    expect(result.tasks).toMatchObject([{ id: taskId, archived: true }])
    expect(await client.factoryDashboard(factoryId, 'all')).toMatchObject({
      previous: null,
      comparison: null,
    })
    const request = (path: string, token = info.token) =>
      rawRequest(daemon?.port ?? 0, { path, headers: { authorization: `Bearer ${token}` } })
    expect((await request(`/factories/${factoryId}/dashboard?range=bad`)).status).toBe(400)
    expect((await request('/factories/missing/dashboard?range=7d')).status).toBe(404)
    expect((await request(`/factories/${factoryId}/dashboard?range=7d`, 'wrong')).status).toBe(401)
  } finally {
    await daemon?.stop()
    await cleanup()
  }
})

test('Flow survives reopening without Run logs and preserves actual transitions, archive cutoffs and accepted failures', async () => {
  const { home, cleanup } = await makeTempHome()
  let store = await openStore({ directory: tedPaths(home).store })
  const asOf = Date.parse('2026-11-12T12:00:00.000Z')
  const hour = 3_600_000
  const setAgo = (hours: number) => vi.setSystemTime(asOf - hours * hour)
  const entry = { layers: [], order: [] }
  let factoryId = ''
  let acceptedId = ''
  let heldId = ''
  let archivedId = ''
  let passId = ''
  let backlogId = ''
  try {
    vi.useFakeTimers({ toFake: ['Date'] })
    setAgo(100)
    const factory = store.createFactory({
      key: 'FL',
      name: 'Flow',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    factoryId = factory.id
    const accepted = await store.createTask({ factoryId, title: 'Accepted Check failure' })
    acceptedId = accepted.id
    store.changeStage(accepted.id, 'intake', entry)
    setAgo(90)
    store.changeStage(accepted.id, 'work', entry)
    setAgo(80)
    store.changeStage(accepted.id, 'validate', entry)
    const check = store.startChecks({
      taskId: accepted.id,
      stage: 'validate',
      trigger: 'validate',
      checks: [{ name: 'Build', command: 'build', timeout: '10m', state: 'waiting' }],
    })
    setAgo(79)
    store.checkFinished(check.id, 0, { state: 'failed', exitCode: 1, durationMs: 10 })
    store.finishChecks(check.id, 'failed')
    const failure = {
      id: 'flow-accepted',
      taskId: accepted.id,
      source: { kind: 'factory-check' as const, checkRunId: check.id, position: 0 },
      recordedBy: 'lead',
      provenance: 'stored-check' as const,
      evidence: 'Build failed before acceptance',
      createdAt: new Date().toISOString(),
      validation: true,
      assessments: [],
      additions: [],
      decisions: [],
      resolutions: [],
      invalidations: [],
    }
    store.failures.save(failure, 'recorded')
    setAgo(78)
    store.failures.save(
      {
        ...failure,
        assessments: [
          {
            id: 'assessment',
            runId: 'lead',
            assessment: 'unrelated',
            recommendation: 'Accept the known fixture failure',
            at: new Date().toISOString(),
          },
        ],
      },
      'assessed',
    )
    const assessed = store.failures.get(failure.id)
    if (!assessed) throw new Error('Missing assessed failure')
    store.failures.save(
      {
        ...assessed,
        resolutions: [
          {
            requestId: 'request',
            assessmentId: 'assessment',
            resolution: 'accepted',
            at: new Date().toISOString(),
          },
        ],
      },
      'resolved',
    )
    const failedRun = store.getCheckRun(check.id)
    if (!failedRun) throw new Error('Missing failed Check run')
    store.failures.saveProgress({
      taskId: accepted.id,
      visit: new Date(asOf - 80 * hour).toISOString(),
      checks: failedRun.checks,
      executions: [{ runId: check.id, start: 0 }],
      next: 1,
      pending: false,
    })
    setAgo(70)
    store.judgeValidate({
      taskId: accepted.id,
      outcome: 'passed',
      checkRunId: check.id,
      review: { passed: true },
      visual: { passed: true },
    })
    store.changeStage(accepted.id, 'review', entry)
    setAgo(60)
    store.changeStage(accepted.id, 'done', entry)

    const held = await store.createTask({ factoryId, title: 'Held send-back question' })
    heldId = held.id
    store.changeStage(held.id, 'intake', entry)
    setAgo(50)
    store.changeStage(held.id, 'validate', entry)
    const ask = store.postComment({
      taskId: held.id,
      kind: 'question',
      body: 'Send back?',
      author: { kind: 'ted' },
    })
    store.askAboutSendBack({
      taskId: held.id,
      commentId: ask.id,
      from: 'validate',
      to: 'work',
      findings: 'Held pending a decision',
      loop: false,
    })

    const reworked = await store.createTask({ factoryId, title: 'Uncounted rework' })
    store.changeStage(reworked.id, 'intake', entry)
    setAgo(40)
    store.changeStage(reworked.id, 'validate', entry)
    setAgo(35)
    store.recordSendBack({
      taskId: reworked.id,
      from: 'validate',
      to: 'work',
      findings: 'Conflict',
      counted: false,
      cause: 'base-conflict',
    })
    store.changeStage(reworked.id, 'work', entry)
    setAgo(34)
    store.recordSendBack({
      taskId: reworked.id,
      from: 'work',
      to: 'design',
      findings: 'Revise',
      counted: true,
      cause: 'review',
    })
    store.changeStage(reworked.id, 'design', entry)

    const archived = await store.createTask({ factoryId, title: 'Archived then restored' })
    archivedId = archived.id
    store.changeStage(archived.id, 'intake', entry)
    setAgo(30)
    store.changeStage(archived.id, 'work', entry)
    setAgo(20)
    store.archiveTask(archived.id)
    setAgo(10)
    store.unarchiveTask(archived.id, { queue: false, waitForBlockers: false })

    const pass = await store.createTask({ factoryId, title: 'First-pass success' })
    passId = pass.id
    store.changeStage(pass.id, 'intake', entry)
    setAgo(8)
    store.changeStage(pass.id, 'work', entry)
    const passing = store.startChecks({
      taskId: pass.id,
      stage: 'work',
      trigger: 'hand-off',
      checks: [{ name: 'Build', command: 'build', timeout: '10m', state: 'waiting' }],
    })
    setAgo(7)
    store.checkFinished(passing.id, 0, { state: 'passed', exitCode: 0, durationMs: 10 })
    store.finishChecks(passing.id, 'passed')
    store.changeStage(pass.id, 'validate', entry)
    setAgo(6)
    store.judgeValidate({
      taskId: pass.id,
      outcome: 'passed',
      checkRunId: passing.id,
      reviewer: { agent: 'codex', unavailable: 'claude' },
      review: { passed: true },
      visual: { passed: true },
    })
    store.changeStage(pass.id, 'review', entry)
    setAgo(5)
    store.changeStage(pass.id, 'done', entry)

    const backlog = await store.createTask({ factoryId, title: 'Backlog without entry metadata' })
    backlogId = backlog.id
    store.changeStage(backlog.id, 'intake', entry)
    setAgo(4)
    store.changeStage(backlog.id, 'work', entry)
    setAgo(3)
    store.changeStage(backlog.id, 'backlog')
    setAgo(1)
    store.changeStage(backlog.id, 'work', entry)

    const other = store.createFactory({
      key: 'OT',
      name: 'Other',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    const excluded = await store.createTask({ factoryId: other.id, title: 'Other Factory' })
    store.recordSendBack({
      taskId: excluded.id,
      from: 'validate',
      to: 'work',
      findings: 'Other Factory',
      counted: true,
    })
    await store.persisted()
    vi.useRealTimers()
    await store.close()
    store = await openStore({ directory: tedPaths(home).store })
    const data = store.factoryDashboard(factoryId, '7d', asOf)
    expect(
      data.flow.current.stages
        .find((s) => s.stage === 'work')
        ?.samples.find((s) => s.taskId === backlogId)?.elapsedMs,
    ).toBe(2 * hour)
    expect(data.flow.current.firstPass).toMatchObject({ passed: 1, denominator: 2, percent: 50 })
    expect(data.flow.current.firstPass.samples.find((s) => s.taskId === acceptedId)).toMatchObject({
      outcome: 'failed',
      failureIds: ['flow-accepted'],
    })
    expect(data.flow.current.firstPass.samples.find((s) => s.taskId === passId)?.outcome).toBe(
      'passed',
    )
    const backs = data.flow.current.sendBacks.flatMap((g) => g.transitions)
    expect(backs).toHaveLength(2)
    expect(backs.filter((s) => s.counted)).toHaveLength(1)
    expect(backs.some((s) => s.taskId === heldId)).toBe(false)
    expect(
      data.flow.current.stages
        .find((s) => s.stage === 'work')
        ?.samples.find((s) => s.taskId === archivedId)?.elapsedMs,
    ).toBe(10 * hour)
    expect(data.flow.tasks.find((t) => t.id === archivedId)).toMatchObject({
      archived: false,
      endReason: 'archived',
      endedAt: new Date(asOf - 20 * hour).toISOString(),
    })
    expect(
      data.flow.current.stages
        .find((s) => s.stage === 'validate')
        ?.samples.find((s) => s.taskId === heldId)?.elapsedMs,
    ).toBe(50 * hour)
  } finally {
    vi.useRealTimers()
    await store.close()
    await cleanup()
  }
})
