import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Run } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgents } from '../src/agents/index.ts'
import { createRunOutput } from '../src/runs/run-output.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { createLeadLifecycle, type LeadLifecycleOptions } from '../src/tasks/lead-lifecycle.ts'
import { resolveWorkflow } from '../src/workflow/resolve.ts'
import { ManualClock } from './support/manual-clock.ts'

let home: string
let store: TedStore
let taskId: string
const initial = Date.parse('2026-11-11T12:00:00.000Z')
let clock: ManualClock
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-lead-'))
  store = await openStore({ directory: home })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(initial)
  clock = new ManualClock(initial)
  taskId = (await store.createTask({ title: 'Recover this Task', lead: { agent: 'codex' } })).id
  store.startTask({
    taskId,
    stage: 'work',
    branch: 'ted/recover',
    worktree: home,
    entry: { layers: [], order: [] },
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
})
afterEach(async () => {
  vi.useRealTimers()
  await store.close()
  await rm(home, { recursive: true, force: true })
})

test('a failed Lead with a session waits for the queue to revive the same Run', async () => {
  store.startRun({
    id: 'lead',
    agent: 'codex',
    sessionId: 'session',
    prompt: 'Work',
    cwd: home,
    taskId,
  })
  store.recordRunOutput('lead', {
    toOffset: 1,
    state: 'finished',
    ending: { how: 'exited', code: 1, at: new Date().toISOString(), errorLines: [] },
  })
  const { lifecycle } = harness()
  await lifecycle.failed('lead')
  expect(store.latestLeadFailure(taskId)).toMatchObject({ runId: 'lead', recovery: 'resume' })
  expect(lifecycle.reviveCandidates()).toEqual([
    { taskId, factoryId: store.getTask(taskId)?.factoryId, agent: 'codex' },
  ])
  expect(store.getRun('lead')?.state).toBe('finished')
  lifecycle.close()
})

function harness(overrides: Partial<LeadLifecycleOptions> = {}) {
  const revived: string[] = []
  const starts: string[] = []
  const sent: { id: string; text: string }[] = []
  const stopped: string[] = []
  const work: Promise<void>[] = []
  const resolution = { workflow: resolveWorkflow([]), layers: [] }
  const options: LeadLifecycleOptions = {
    store,
    clock,
    agents: createAgents({}),
    stallAfterMs: 1000,
    runs: {
      output: createRunOutput({ home, store }),
      async start(input) {
        const id = `fresh-${starts.length}`
        starts.push(id)
        return store.startRun({ ...input, id })
      },
      async revive(id, input) {
        revived.push(id)
        return store.reviveRun(id, input.flags)
      },
      async restart(id, flags) {
        return store.restartRun(id, flags)
      },
      async send(id, text) {
        sent.push({ id, text })
      },
      async dispatch(id, messages, _steer, canDispatch) {
        if (!canDispatch()) return false
        sent.push(...messages.map(({ text }) => ({ id, text })))
        return true
      },
      acceptedInputs: () => [],
      lastHeard: () => undefined,
      stop: async (id) => {
        stopped.push(id)
      },
    },
    health: {
      ready: async () => true,
      check: async (kinds = []) =>
        kinds.map((agent) => ({
          agent,
          state: 'ready',
          minimumVersion: '0',
          pausedRuns: 0,
          checkedAt: new Date().toISOString(),
        })),
      limited: () => {},
    },
    local: async () => {},
    workflow: async () => resolution,
    entries: () => [
      { name: 'widgets', repo: 'acme/widgets', cloneUrl: '', primary: true, env: {}, copy: [] },
    ],
    defaultLead: () => ({ agent: 'codex' }),
    context: async (_task, current, _resolution, report, intent) => ({
      prompt: [current.description, intent.pickUp, report].filter(Boolean).join('\n'),
      cwd: home,
      waiting: { comments: [], answers: [] },
      overnight: false,
    }),
    appEnv: async () => ({}),
    protectComments: () => {},
    launched: () => {},
    deliver: async () => {},
    editedSince: () => [],
    freshRunNote: () => store.latestBrief(taskId)?.text ?? 'Pick up this Task',
    failedSetupReports: async () => [],
    setUp: async (task, steps) => {
      for (const { repo, setup } of steps) {
        store.worktreeSetupStarted(task.id, repo.name, setup)
        store.worktreeSetupFinished(task.id, repo.name, { outcome: 'passed' })
      }
      return []
    },
    setUpAdded: async () => ({}),
    hold: () => () => {},
    stopRequested: () => false,
    wake: () => {},
    background: (_what, operation) => {
      work.push(operation())
    },
    hasAnswerText: (comment) => comment.answer !== undefined,
    refreshSteering: async () => {},
    ...overrides,
  }
  const lifecycle = createLeadLifecycle(options)
  return { lifecycle, revived, starts, sent, stopped, work, resolution, runs: options.runs }
}

function startLead(id = 'lead', sessionId: string | false = 'session'): Run {
  return store.startRun({
    id,
    agent: 'codex',
    ...(sessionId !== false && { sessionId }),
    prompt: 'Work',
    cwd: home,
    taskId,
  })
}
function finishLead(id = 'lead', resumeFailed = false): Run {
  store.recordRunOutput(id, {
    toOffset: store.runReadOffset(id) + 1,
    state: 'finished',
    ending: {
      how: 'exited',
      code: 1,
      at: new Date().toISOString(),
      errorLines: [],
      ...(resumeFailed && { resumeFailed }),
    },
  })
  const run = store.getRun(id)
  if (!run) throw new Error('missing Run')
  return run
}
function advance(ms: number): void {
  vi.setSystemTime(clock.now() + ms)
  clock.advance(ms)
}

test('the selected revival keeps the Run and applies pending messages and flags', async () => {
  startLead()
  finishLead()
  store.holdLeadMessage(taskId, 'Use the approved approach')
  store.setTaskLead(taskId, { agent: 'codex', model: 'new-model', effort: 'high' })
  const { lifecycle, revived, runs } = harness()
  const revive = vi.spyOn(runs, 'revive')
  await lifecycle.failed('lead')
  advance(1)
  await lifecycle.beginRevive(taskId)
  expect(revived).toEqual(['lead'])
  expect(store.getRun('lead')).toMatchObject({
    state: 'working',
    model: 'new-model',
    effort: 'high',
  })
  expect(revive.mock.calls[0]?.[1]).toMatchObject({
    env: { TED_TASK: store.getTask(taskId)?.displayId },
  })
  expect(revive.mock.calls[0]?.[1].prompt).toContain('Use the approved approach')
  expect(lifecycle.reviveCandidates()).toEqual([])
  lifecycle.close()
})

test('duplicate and concurrent reports record one failure, and a second crash asks the user', async () => {
  startLead()
  finishLead()
  const { lifecycle } = harness()
  await Promise.all([lifecycle.failed('lead'), lifecycle.failed('lead')])
  await lifecycle.failed('lead')
  expect(store.failureHistory(taskId, clock.now()).sinceFirst).toHaveLength(1)
  advance(1)
  await lifecycle.beginRevive(taskId)
  advance(1)
  finishLead()
  await lifecycle.failed('lead')
  expect(store.getTask(taskId)?.status?.kind).toBe('failed')
  expect(store.listComments(taskId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: 'The Task Lead stopped twice in 30 minutes',
        choices: ['Retry'],
      }),
    ]),
  )
  expect(lifecycle.reviveCandidates()).toEqual([])
  lifecycle.close()
})

test('a Run without a session queues a fresh Lead with the Task brief', async () => {
  startLead('lead', false)
  finishLead()
  store.writeBrief({ taskId, text: '## Goal\nKeep my committed work' })
  const { lifecycle, starts, runs } = harness()
  const start = vi.spyOn(runs, 'start')
  await lifecycle.failed('lead')
  expect(store.latestLeadFailure(taskId)).toMatchObject({ recovery: 'fresh' })
  expect(store.queue().map((q) => q.id)).toContain(taskId)
  expect(starts).toEqual([])
  await lifecycle.prepare(taskId, { kind: 'existing' })
  expect(start.mock.calls[0]?.[0].prompt).toContain('Keep my committed work')
  expect(store.getTask(taskId)?.leadRunId).toBe('fresh-0')
  lifecycle.close()
})

test('a resume that never started falls back to a fresh Run without counting another crash', async () => {
  startLead()
  finishLead()
  const { lifecycle, runs } = harness()
  await lifecycle.failed('lead')
  vi.spyOn(runs, 'revive').mockRejectedValueOnce(new Error('resume unavailable'))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await lifecycle.beginRevive(taskId)
  expect(store.latestLeadFailure(taskId)).toMatchObject({ recovery: 'fresh', resumeFailed: true })
  expect(store.failureHistory(taskId, clock.now()).recent).toHaveLength(1)
  expect(store.queue().map((q) => q.id)).toContain(taskId)
  error.mockRestore()
  lifecycle.close()
})

test('a failed resumed process falls back to fresh even with an earlier crash', async () => {
  startLead()
  finishLead()
  const { lifecycle } = harness()
  await lifecycle.failed('lead')
  advance(1)
  await lifecycle.beginRevive(taskId)
  advance(1)
  finishLead('lead', true)
  await lifecycle.failed('lead')
  expect(store.latestLeadFailure(taskId)).toMatchObject({ recovery: 'fresh', resumeFailed: true })
  expect(store.getTask(taskId)?.status?.kind).not.toBe('failed')
  lifecycle.close()
})

test.each(['stale', 'archived', 'stopped', 'queued', 'held', 'stopping', 'sub-agent'] as const)(
  '%s Run endings do not trigger recovery',
  async (kind) => {
    startLead()
    if (kind === 'sub-agent')
      store.startRun({
        id: 'child',
        agent: 'codex',
        taskId,
        parentRunId: 'lead',
        prompt: 'Help',
        cwd: home,
      })
    finishLead(kind === 'sub-agent' ? 'child' : 'lead')
    if (kind === 'stale') startLead('new-lead')
    if (kind === 'archived') store.archiveTask(taskId)
    if (kind === 'stopped') store.stopTask(taskId, { runs: 1, why: 'human' })
    if (kind === 'queued') store.resumeTask(taskId, { waitForBlockers: false })
    if (kind === 'held') store.holdTaskRun({ taskId, agent: 'codex', sessionId: 'session' })
    const { lifecycle } = harness({ stopRequested: () => kind === 'stopping' })
    await lifecycle.failed(kind === 'sub-agent' ? 'child' : 'lead')
    expect(store.latestLeadFailure(taskId)).toBeUndefined()
    expect(lifecycle.reviveCandidates()).toEqual([])
    lifecycle.close()
  },
)

test('startup reconstructs a pending revival from the store and drops it when the Task stops', async () => {
  startLead()
  finishLead()
  const first = harness()
  await first.lifecycle.failed('lead')
  first.lifecycle.close()
  await store.close()
  store = await openStore({ directory: home })
  const { lifecycle } = harness()
  lifecycle.recoverStartup()
  expect(lifecycle.reviveCandidates().map((candidate) => candidate.taskId)).toEqual([taskId])
  store.stopTask(taskId, { runs: 1, why: 'human' })
  expect(lifecycle.reviveCandidates()).toEqual([])
  lifecycle.close()
  expect(clock.pending).toEqual([])
})

test('startup discovers an unrecorded crash', async () => {
  startLead()
  finishLead()
  const { lifecycle, work } = harness()
  lifecycle.recoverStartup()
  await Promise.all(work)
  expect(store.latestLeadFailure(taskId)?.recovery).toBe('resume')
  lifecycle.close()
})

test('health readiness during an interrupted turn waits for settlement before continuing', async () => {
  const run = startLead()
  const { lifecycle, sent } = harness()
  lifecycle.authFailed(run)
  lifecycle.ready('codex')
  expect(sent).toEqual([])
  store.recordRunOutput(run.id, { toOffset: 1, state: 'idle' })
  const idle = store.getRun(run.id)
  if (!idle) throw new Error('missing Run')
  lifecycle.settled(idle)
  expect(sent.map(({ id }) => id)).toEqual(['lead'])
  lifecycle.ready('codex')
  expect(sent).toHaveLength(1)
  lifecycle.close()
})

test('offline interruptions can be probed once without resuming other agent kinds', async () => {
  startLead()
  const { lifecycle, sent } = harness()
  lifecycle.offline('codex')
  expect(lifecycle.probe('claude')).toBe(false)
  expect(lifecycle.probe('codex')).toBe(true)
  expect(lifecycle.probe('codex')).toBe(false)
  expect(sent.map(({ id }) => id)).toEqual(['lead'])
  lifecycle.close()
})

test('silence excludes health pauses and stops a Lead once after the fresh interval', async () => {
  startLead()
  const { lifecycle, stopped } = harness()
  lifecycle.recoverStartup()
  advance(750)
  expect(stopped).toEqual([])
  store.pauseAgent('codex', 'offline')
  advance(2000)
  expect(stopped).toEqual([])
  store.pauseAgent('codex', undefined)
  advance(750)
  expect(stopped).toEqual([])
  advance(250)
  expect(stopped).toEqual(['lead'])
  advance(2000)
  expect(stopped).toEqual(['lead'])
  lifecycle.close()
})

test('idle-point changes wait for restart before delivering held messages', async () => {
  startLead()
  store.setTaskLead(taskId, { agent: 'codex', model: 'new-model', effort: 'high' })
  store.holdLeadMessage(taskId, 'Start Design')
  const { lifecycle, runs, sent } = harness()
  let finish: (() => void) | undefined
  const restarted = new Promise<void>((resolve) => {
    finish = resolve
  })
  const restart = vi.spyOn(runs, 'restart').mockImplementation(async (id, flags) => {
    expect(store.getTask(taskId)?.leadRestartPending).toBe(true)
    await restarted
    return store.restartRun(id, flags)
  })
  const dispatch = runs.dispatch
  vi.spyOn(runs, 'dispatch').mockImplementation(async (...args) => {
    expect(store.getTask(taskId)?.leadRestartPending).toBe(false)
    return dispatch(...args)
  })
  await lifecycle.applyLead(taskId)
  expect(restart).not.toHaveBeenCalled()
  store.recordRunOutput('lead', { toOffset: 1, state: 'idle' })
  const applying = lifecycle.applyLead(taskId)
  await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
  expect(sent).toEqual([])
  if (!finish) throw new Error('restart did not start')
  finish()
  await applying
  expect(store.getRun('lead')).toMatchObject({ model: 'new-model', effort: 'high' })
  expect(restart).toHaveBeenCalledTimes(1)
  expect(sent.map(({ text }) => text)).toEqual(['Start Design'])
  expect(store.getTask(taskId)).toMatchObject({
    pendingLeadMessages: [],
    leadRestartPending: false,
  })
  lifecycle.close()
})

test('normal stops are not crash recovery during startup', async () => {
  startLead()
  store.recordRunOutput('lead', {
    toOffset: 1,
    state: 'finished',
    ending: { how: 'stopped', at: new Date().toISOString(), errorLines: [] },
  })
  const { lifecycle, work } = harness()
  lifecycle.recoverStartup()
  await Promise.all(work)
  expect(store.latestLeadFailure(taskId)).toBeUndefined()
  lifecycle.close()
})

test('existing worktrees rerun their recorded setup and environment before launch', async () => {
  const task = store.getTask(taskId)
  const repo = task?.repos[0]
  if (!task || !repo) throw new Error('missing worktree')
  store.worktreeSetupStarted(taskId, repo.name, {
    command: 'original-setup',
    timeoutMs: 1234,
    env: { SOURCE: 'recorded' },
  })
  const { lifecycle, runs } = harness()
  const start = vi.spyOn(runs, 'start')
  await lifecycle.prepare(taskId, { kind: 'existing' })
  expect(store.getTask(taskId)?.repos[0]?.setup).toMatchObject({
    command: 'original-setup',
    state: 'passed',
  })
  expect(start.mock.calls[0]?.[0].env).toMatchObject({ SOURCE: 'recorded' })
  lifecycle.close()
})

test.each(['created', 'restored'] as const)(
  '%s worktrees use the selected repo setup, then launch one Lead',
  async (kind) => {
    const { lifecycle, resolution, runs, starts } = harness()
    const start = vi.spyOn(runs, 'start')
    await lifecycle.prepare(taskId, {
      kind,
      resolution,
      entries: [
        {
          name: 'renamed',
          repo: 'ACME/widgets',
          cloneUrl: '',
          primary: true,
          env: { SOURCE: 'selected' },
          copy: [],
          setup: { run: 'selected-setup', timeoutMs: 1000 },
        },
      ],
    })
    expect(store.getTask(taskId)?.repos[0]?.setup).toMatchObject({
      command: 'selected-setup',
      state: 'passed',
    })
    expect(start.mock.calls[0]?.[0].env).toMatchObject({ SOURCE: 'selected' })
    expect(starts).toHaveLength(1)
    lifecycle.close()
  },
)

test('an added repo reports setup to the existing Lead without launching another', async () => {
  startLead()
  const repo = store.getTask(taskId)?.repos[0]
  if (!repo) throw new Error('missing repo')
  const { lifecycle, sent, starts } = harness()
  await lifecycle.prepare(taskId, {
    kind: 'added',
    step: { repo, setup: { command: 'added-setup', timeoutMs: 1000, env: {} } },
    tellLead: true,
  })
  expect(starts).toEqual([])
  expect(sent).toMatchObject([{ id: 'lead', text: expect.stringContaining('added-setup') }])
  lifecycle.close()
})

test('held sessions keep the original setup environment and resume session', async () => {
  startLead()
  finishLead()
  store.holdTaskRun({ taskId, agent: 'codex', sessionId: 'held-session' })
  const repo = store.getTask(taskId)?.repos[0]
  if (!repo) throw new Error('missing repo')
  store.worktreeSetupStarted(taskId, repo.name, {
    command: 'original-setup',
    timeoutMs: 1000,
    env: { SOURCE: 'recorded' },
  })
  const { lifecycle, runs } = harness()
  const start = vi.spyOn(runs, 'start')
  await lifecycle.resume(taskId)
  expect(start.mock.calls[0]?.[0]).toMatchObject({
    resume: 'held-session',
    env: { SOURCE: 'recorded' },
  })
  expect(store.heldRuns()).toEqual([])
  lifecycle.close()
})

test('an unhealthy launch keeps its session held without starting work', async () => {
  const { lifecycle, starts } = harness({
    health: { ready: async () => false, check: async () => [], limited: () => {} },
  })
  await lifecycle.prepare(taskId, { kind: 'existing' })
  expect(starts).toEqual([])
  expect(store.heldRuns()).toMatchObject([{ taskId, agent: 'codex' }])
  lifecycle.close()
})

test('preparation waits for setup completion before starting its Lead', async () => {
  let finish: ((reports: string[] | undefined) => void) | undefined
  const setup = new Promise<string[] | undefined>((resolve) => {
    finish = resolve
  })
  let requested = false
  const { lifecycle, resolution, starts } = harness({
    setUp: async () => {
      requested = true
      return setup
    },
  })
  const preparing = lifecycle.prepare(taskId, {
    kind: 'created',
    resolution,
    entries: [
      {
        name: 'widgets',
        repo: 'acme/widgets',
        cloneUrl: '',
        primary: true,
        env: {},
        copy: [],
        setup: { run: 'prepare-dependencies', timeoutMs: 1000 },
      },
    ],
  })
  await Promise.resolve()
  expect(starts).toEqual([])
  expect(requested).toBe(true)
  if (!finish) throw new Error('setup did not start')
  finish([])
  await preparing
  expect(starts).toHaveLength(1)
  lifecycle.close()
})

test('interrupted setup releases its slot without launching a Lead', async () => {
  let held = 0
  const { lifecycle, resolution, starts } = harness({
    setUp: async () => undefined,
    hold: () => {
      held++
      return () => {
        held--
      }
    },
  })
  await lifecycle.prepare(taskId, {
    kind: 'created',
    resolution,
    entries: [
      {
        name: 'widgets',
        repo: 'acme/widgets',
        cloneUrl: '',
        primary: true,
        env: {},
        copy: [],
        setup: { run: 'prepare-dependencies', timeoutMs: 1000 },
      },
    ],
  })
  expect(starts).toEqual([])
  expect(held).toBe(0)
  lifecycle.close()
})
