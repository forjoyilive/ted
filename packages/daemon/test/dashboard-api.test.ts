import { DaemonClient, readDaemonInfo, tedPaths } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { openStore } from '../src/store/index.ts'
import { makeTempHome, rawRequest } from './helpers.ts'

test('read-only Dashboard request combines or narrows Factories and validates its query', async () => {
  const { home, cleanup } = await makeTempHome()
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  const store = await openStore({ directory: tedPaths(home).store })
  const now = new Date().setHours(0, 0, 0, 0)
  let factoryId = ''
  let taskId = ''
  let otherId = ''
  let otherTaskId = ''
  let otherDisplayId = ''
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
    otherId = other.id
    const excluded = await store.createTask({ factoryId: other.id, title: 'Other Factory' })
    otherTaskId = excluded.id
    otherDisplayId = `ZZ-${excluded.number}`
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
    const result = await client.dashboard('7d', [factoryId])
    expect(result.factoryIds).toEqual([factoryId])
    expect(result.current.taskIds).toEqual([taskId])
    expect(result.current.created.value).toBe(32_400_000)
    expect(result.current.intake.value).toBe(14_400_000)
    expect(result.tasks).toMatchObject([{ id: taskId, factoryId, archived: true }])
    expect(result.current.byFactory).toMatchObject([{ factoryId, taskIds: [taskId] }])
    expect(await client.dashboard('all', [factoryId])).toMatchObject({
      previous: null,
      comparison: null,
    })
    const sidebarOrder = (await client.listFactories()).map((factory) => factory.id)
    expect(sidebarOrder).toHaveLength(2)
    const all = await client.dashboard('7d')
    expect(all.factoryIds).toEqual(sidebarOrder)
    expect(all.current.taskIds).toEqual(expect.arrayContaining([taskId, otherTaskId]))
    expect(all.tasks.find((task) => task.id === otherTaskId)).toMatchObject({
      factoryId: otherId,
      displayId: otherDisplayId,
    })
    expect(all.current.byFactory.map((row) => row.factoryId)).toEqual(sidebarOrder)
    expect(all.current.byFactory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ factoryId, taskIds: [taskId] }),
        expect.objectContaining({ factoryId: otherId, taskIds: [otherTaskId] }),
      ]),
    )
    expect(await client.dashboard('7d', [...sidebarOrder].reverse())).toMatchObject({
      factoryIds: sidebarOrder,
    })
    const request = (path: string, token = info.token) =>
      rawRequest(daemon?.port ?? 0, { path, headers: { authorization: `Bearer ${token}` } })
    expect((await request(`/dashboard?range=bad`)).status).toBe(400)
    expect((await request(`/dashboard?range=7d&factory=${factoryId}&factory=missing`)).status).toBe(
      404,
    )
    expect((await request('/dashboard?range=7d', 'wrong')).status).toBe(401)
  } finally {
    await daemon?.stop()
    await cleanup()
  }
})

test('Flow survives reopening without Run logs and preserves actual transitions, archive cutoffs and accepted failures', async () => {
  const { home, cleanup } = await makeTempHome()
  let store = await openStore({ directory: tedPaths(home).store })
  const asOf = new Date(2026, 5, 12).getTime()
  const hour = 3_600_000
  const setAgo = (hours: number) => vi.setSystemTime(asOf - hours * hour)
  const entry = { layers: [], order: [] }
  let factoryId = ''
  let acceptedId = ''
  let heldId = ''
  let archivedId = ''
  let passId = ''
  let backlogId = ''
  let planningId = ''
  let restartedId = ''
  try {
    vi.useFakeTimers({ toFake: ['Date'] })
    setAgo(180)
    const factory = store.createFactory({
      key: 'FL',
      name: 'Flow',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    factoryId = factory.id
    setAgo(170)
    const queued = await store.createTask({ factoryId, title: 'Waiting for the first Run' })
    store.queueTask(queued.id, 'intake')
    setAgo(6)
    const admitted = await store.createTask({ factoryId, title: 'Admitted after a Run-slot wait' })
    store.queueTask(admitted.id, 'intake')
    setAgo(4)
    store.startTask({
      taskId: admitted.id,
      stage: 'intake',
      branch: 'task',
      worktree: home,
      entry,
      repo: { name: 'one', repo: 'acme/one', copied: [], skipped: [] },
    })
    setAgo(2)
    store.changeStage(admitted.id, 'done', entry)
    setAgo(100)
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

    setAgo(6)
    const planning = await store.createTask({ factoryId, title: 'Waiting for outside planning' })
    planningId = planning.id
    const restarted = await store.createTask({ factoryId, title: 'Restarted after planning' })
    restartedId = restarted.id
    for (const task of [planning, restarted]) store.changeStage(task.id, 'intake', entry)
    setAgo(5)
    for (const task of [planning, restarted]) store.changeStage(task.id, 'clarify', entry)
    setAgo(3)
    for (const task of [planning, restarted]) store.needsPlanning(task.id, 'lead')
    setAgo(1)
    store.startAfterPlanning(restarted.id, 'clarify', entry)

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
    vi.setSystemTime(asOf)
    await store.persisted()
    await store.close()
    store = await openStore({ directory: tedPaths(home).store })
    const data = store.dashboard([factoryId], '7d', asOf)
    expect(data.flow.current.taskIds).toEqual(expect.arrayContaining([queued.id, admitted.id]))
    const currentQueue = required(data.flow.current.reasons.find((r) => r.reason === 'run-slot'))
    const previousQueue = required(data.flow.previous?.reasons.find((r) => r.reason === 'run-slot'))
    expect(currentQueue.samples.find((s) => s.taskId === queued.id)).toMatchObject({
      elapsedMs: 168 * hour,
      coverage: 'full',
      intervals: [
        { from: new Date(asOf - 168 * hour).toISOString(), to: new Date(asOf).toISOString() },
      ],
    })
    expect(currentQueue.samples.find((s) => s.taskId === admitted.id)).toMatchObject({
      elapsedMs: 2 * hour,
      intervals: [
        {
          from: new Date(asOf - 6 * hour).toISOString(),
          to: new Date(asOf - 4 * hour).toISOString(),
        },
      ],
    })
    expect(previousQueue.samples.find((s) => s.taskId === queued.id)?.elapsedMs).toBe(2 * hour)
    for (const id of [queued.id, admitted.id]) {
      const recorded = store
        .taskIntervalHistory(id, new Date(asOf).toISOString())
        .intervals.filter((i) => i.reason === 'run-slot')
        .reduce((sum, i) => sum + Date.parse(i.end) - Date.parse(i.start), 0)
      expect(
        (currentQueue.samples.find((s) => s.taskId === id)?.elapsedMs ?? 0) +
          (previousQueue.samples.find((s) => s.taskId === id)?.elapsedMs ?? 0),
      ).toBe(recorded)
    }
    expect(
      data.flow.current.stages
        .find((s) => s.stage === 'intake')
        ?.samples.find((s) => s.taskId === admitted.id),
    ).toMatchObject({
      elapsedMs: 4 * hour,
      intervals: [
        {
          from: new Date(asOf - 6 * hour).toISOString(),
          to: new Date(asOf - 2 * hour).toISOString(),
        },
      ],
    })
    expect(data.tasks.find((t) => t.id === admitted.id)?.intakeMs).toBe(2 * hour)
    const clarify = data.flow.current.stages.find((s) => s.stage === 'clarify')
    expect(clarify?.samples.find((s) => s.taskId === planningId)).toMatchObject({
      elapsedMs: 2 * hour,
      intervals: [
        {
          from: new Date(asOf - 5 * hour).toISOString(),
          to: new Date(asOf - 3 * hour).toISOString(),
        },
      ],
    })
    expect(clarify?.samples.find((s) => s.taskId === restartedId)).toMatchObject({
      elapsedMs: 3 * hour,
      intervals: [
        {
          from: new Date(asOf - 5 * hour).toISOString(),
          to: new Date(asOf - 3 * hour).toISOString(),
        },
        { from: new Date(asOf - hour).toISOString(), to: new Date(asOf).toISOString() },
      ],
    })
    expect(data.flow.current.stages.some((s) => s.stage === 'backlog')).toBe(false)
    expect(
      data.flow.current.incomplete.filter((s) => [planningId, restartedId].includes(s.taskId)),
    ).toEqual([])
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

test('batched Factory timing reconciles public interval/Check/report evidence and preserves it after reopening', async () => {
  const { randomUUID } = await import('node:crypto')
  const { home, cleanup } = await makeTempHome()
  const base = new Date().setHours(1, 0, 0, 0)
  const at = (h: number) => new Date(base + h * 3_600_000).toISOString()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
  let store = await openStore({ directory: tedPaths(home).store })
  try {
    const factory = store.createFactory({
      key: 'TM',
      name: 'Timing',
      repos: [],
      defaultBranch: 'main',
      showTutorial: false,
    })
    const task = await store.createTask({ factoryId: factory.id, title: 'Timing evidence' })
    store.changeStage(task.id, 'intake', { layers: [], order: [] })
    store.changeStage(task.id, 'work', { layers: [], order: [] })
    vi.setSystemTime(base + 3_600_000)
    const run = store.startRun({
      id: randomUUID(),
      taskId: task.id,
      agent: 'codex',
      prompt: '',
      cwd: home,
    })
    vi.setSystemTime(base + 2 * 3_600_000)
    const one = store.postComment({
      taskId: task.id,
      kind: 'question',
      body: 'One?',
      author: { kind: 'ted' },
    })
    const check = store.startChecks({
      taskId: task.id,
      stage: 'work',
      trigger: 'agent',
      checks: [
        {
          name: 'Tests',
          command: 'pnpm vitest run selected.test.ts',
          timeout: '10m',
          state: 'waiting',
        },
      ],
    })
    store.checkSlotBoundary(check.id, 'entered', at(2))
    vi.setSystemTime(base + 3 * 3_600_000)
    const two = store.postComment({
      taskId: task.id,
      kind: 'question',
      body: 'Two?',
      author: { kind: 'ted' },
    })
    store.checkSlotBoundary(check.id, 'acquired', at(3))
    store.checkStarted(check.id, 0)
    const checked = store.testInvocations.register(
      { taskId: task.id },
      { id: randomUUID(), supported: true, checkRunId: check.id, position: 0 },
    )
    const direct = store.testInvocations.register(
      { taskId: task.id, runId: run.id },
      { id: randomUUID(), supported: true },
    )
    vi.setSystemTime(base + 4 * 3_600_000)
    store.answerComment(one.id, { kind: 'answered', text: 'Yes', at: at(4) })
    store.testInvocations.report(checked.id, { sequence: 0, kind: 'wait-start', at: Date.now() })
    vi.setSystemTime(base + 5 * 3_600_000)
    store.answerComment(two.id, { kind: 'answered', text: 'Yes', at: at(5) })
    store.testInvocations.report(direct.id, { sequence: 0, kind: 'wait-start', at: Date.now() })
    vi.setSystemTime(base + 6 * 3_600_000)
    for (const invocation of [checked, direct]) {
      store.testInvocations.report(invocation.id, { sequence: 1, kind: 'wait-end', at: Date.now() })
      store.testInvocations.report(invocation.id, { sequence: 2, kind: 'finished', at: Date.now() })
    }
    const unfinished = store.testInvocations.register(
      { taskId: task.id, runId: run.id },
      { id: randomUUID(), supported: true },
    )
    store.testInvocations.report(unfinished.id, { sequence: 0, kind: 'wait-start', at: Date.now() })
    vi.setSystemTime(base + 7 * 3_600_000)
    store.checkFinished(check.id, 0, { state: 'passed', durationMs: 4 * 3_600_000, exitCode: 0 })
    store.finishChecks(check.id, 'passed')
    store.recordRunOutput(run.id, { toOffset: 1, state: 'finished' })
    vi.setSystemTime(base + 8 * 3_600_000)
    store.postComment({
      taskId: task.id,
      kind: 'question',
      body: 'Still open?',
      author: { kind: 'ted' },
    })
    vi.setSystemTime(base + 10 * 3_600_000)
    const data = store.dashboard([factory.id], 'today', Date.now())
    const get = (reason: string) =>
      required(data.flow.current.reasons.find((r) => r.reason === reason))
    expect(get('run-working').totalMs).toBe(6 * 3_600_000)
    expect(get('user-request').totalMs).toBe(5 * 3_600_000)
    expect(get('check-slot').totalMs).toBe(3_600_000)
    expect(get('running-check').totalMs).toBe(4 * 3_600_000)
    expect(get('test-lock').totalMs).toBe(2 * 3_600_000)
    expect(get('test-lock').samples[0]?.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: checked.id, checkRunId: check.id, position: 0 }),
        expect.objectContaining({ id: direct.id, runId: run.id }),
        expect.objectContaining({
          id: unfinished.id,
          coverage: 'incomplete',
          openWaitStartedAt: at(6),
        }),
      ]),
    )
    const publicIntervals = store.taskIntervalHistory(task.id, at(10))
    for (const reason of [
      'run-working',
      'user-request',
      'run-slot',
      'github',
      'agent-paused',
      'blocker',
      'stopped',
    ]) {
      const total = publicIntervals.intervals
        .filter((i) => i.reason === reason)
        .reduce((n, i) => n + Date.parse(i.end) - Date.parse(i.start), 0)
      expect(get(reason).totalMs).toBe(total)
    }
    await store.persisted()
    await store.close()
    vi.setSystemTime(base + 12 * 3_600_000)
    store = await openStore({ directory: tedPaths(home).store })
    const reopened = store.dashboard([factory.id], 'today', base + 10 * 3_600_000)
    expect(reopened.flow.current.reasons.map((r) => [r.reason, r.totalMs])).toEqual(
      data.flow.current.reasons.map((r) => [r.reason, r.totalMs]),
    )
    expect(
      reopened.flow.current.reasons.find((r) => r.reason === 'test-lock')?.samples[0]?.invocations,
    ).toEqual(get('test-lock').samples[0]?.invocations)
    const gap = required(
      store
        .dashboard([factory.id], 'today', Date.now())
        .flow.current.reasons.find((r) => r.reason === 'run-working'),
    )
    expect(gap.samples[0]?.coverage).toBe('partial')
    expect(gap.samples[0]?.coverageIntervals).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'unknown', source: 'daemon-gap' })]),
    )
    const evidenceTaskIds: string[] = []
    for (let i = 0; i < 999; i++) {
      const retained = await store.createTask({ factoryId: factory.id, title: `Retained ${i}` })
      store.changeStage(retained.id, 'intake', { layers: [], order: [] })
      if (i % 100 === 0) {
        evidenceTaskIds.push(retained.id)
        const owner = store.startRun({
          id: randomUUID(),
          taskId: retained.id,
          agent: 'codex',
          prompt: '',
          cwd: home,
        })
        store.postComment({
          taskId: retained.id,
          kind: 'question',
          body: 'Recorded request',
          author: { kind: 'ted' },
        })
        store.testInvocations.register(
          { taskId: retained.id, runId: owner.id },
          { id: randomUUID(), supported: false },
        )
      }
    }
    vi.setSystemTime(base + 13 * 3_600_000)
    const started = performance.now()
    const retained = store.dashboard([factory.id], 'today', Date.now())
    const elapsed = performance.now() - started
    expect(retained.flow.current.taskIds).toHaveLength(1000)
    expect(retained.flow.current.reasons.every((r) => r.samples.length === 1000)).toBe(true)
    expect(
      retained.flow.current.reasons
        .find((r) => r.reason === 'test-lock')
        ?.samples.filter((s) => s.invocations.some((i) => i.coverage === 'unsupported'))
        .map((s) => s.taskId),
    ).toEqual(expect.arrayContaining(evidenceTaskIds))
    console.info(
      `Flow public-store fixture: 1000 Tasks, ${elapsed.toFixed(1)}ms read/calculation, ${JSON.stringify(retained).length} response bytes`,
    )
  } finally {
    await store.close()
    vi.useRealTimers()
    await cleanup()
  }
})

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Required fixture evidence is missing')
  return value
}
