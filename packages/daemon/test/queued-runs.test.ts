import type { AgentKind, DaemonEvent, Run } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import type { RunObserver } from '../src/runs/run-manager.ts'
import type { QueueSource } from '../src/tasks/queue.ts'
import {
  afterProcessEnded,
  processEndedText,
  queuedRunStatus,
  queuedRuns,
  runLimits,
} from '../src/tasks/queued-runs.ts'

const run = (id: string, fields: Partial<Run> = {}) =>
  ({ id, agent: 'claude', state: 'working', ...fields }) as Run

function fakes() {
  const runs = new Map<string, Run>()
  const pauses: Partial<Record<AgentKind, string>> = {}
  const listeners = new Set<(event: DaemonEvent) => void>()
  const observers: RunObserver[] = []
  const ready: ((agent: AgentKind) => void)[] = []
  return {
    runs,
    pauses,
    store: {
      agentPauses: () => ({ ...pauses }),
      getRun: (id: string) => runs.get(id),
      subscribe(listener: (event: DaemonEvent) => void) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    runManager: { observe: (observer: RunObserver) => void observers.push(observer) },
    health: { onReady: (listener: (agent: AgentKind) => void) => void ready.push(listener) },
    usage(id: string) {
      for (const o of observers) o.usage?.(runs.get(id) as Run, { limited: true })
    },
    authFailed(id: string) {
      for (const o of observers) o.authFailed?.(runs.get(id) as Run)
    },
    ready(agent: AgentKind) {
      for (const listener of ready) listener(agent)
    },
    emit(event: DaemonEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

describe('queuedRuns', () => {
  test('begin twice starts one launch, and the item holds a slot until it ends', async () => {
    let source: QueueSource | undefined
    let pumps = 0
    const queue = {
      addQueueSource(s: QueueSource) {
        source = s
        return () => void pumps++
      },
    }
    let finish = () => {}
    const launched: string[] = []
    queuedRuns(queue, {
      kind: 'planning',
      what: 'Planning Run',
      waiting: () => [{ id: 'p1', rank: 1, factoryId: 'f' }],
      runnable: () => true,
      launch(id) {
        launched.push(id)
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      candidates: () => ['p1'],
      holds: () => false,
      slot: (id) => ({ runId: id, planId: id, name: 'Plan', factoryId: 'f' }),
    })
    if (!source) throw new Error('no queue source')
    expect(source.queued()).toEqual([{ id: 'p1', rank: 1, factoryId: 'f', kind: 'planning' }])
    source.begin('p1')
    source.begin('p1')
    expect(launched).toEqual(['p1'])
    expect(source.queued()).toEqual([])
    expect(source.starting?.()).toEqual(['p1'])
    expect(source.holders()).toEqual([
      { kind: 'planning', runId: 'p1', planId: 'p1', name: 'Plan', factoryId: 'f', runs: 1 },
    ])
    expect(source.describe('p1', 2)).toMatchObject({ kind: 'planning', place: 2, runId: 'p1' })
    finish()
    await expect.poll(() => pumps).toBe(1)
    expect(source.holders()).toEqual([])
  })
})

describe('runLimits', () => {
  test('a usage limit or failed sign-in pauses the Run until its Provider is ready', () => {
    const f = fakes()
    let readied = 0
    const limits = runLimits({
      store: f.store,
      runs: f.runManager,
      health: f.health,
      owns: (id) => id !== 'other',
      isClosed: () => false,
      ready: () => void readied++,
    })
    f.runs.set('r1', run('r1'))
    f.runs.set('r2', run('r2', { agent: 'codex' }))
    f.runs.set('other', run('other'))
    f.usage('r1')
    f.authFailed('r2')
    f.usage('other')
    expect([limits.has('r1'), limits.has('r2'), limits.has('other')]).toEqual([true, true, false])
    expect(limits.paused(run('r1'))).toBe(true)

    f.pauses.codex = 'usage limit'
    f.ready('claude')
    expect(limits.has('r1')).toBe(false)
    expect(limits.has('r2')).toBe(true)
    expect(readied).toBe(1)
    expect(limits.paused(run('r2', { agent: 'codex' }))).toBe(true)

    delete f.pauses.codex
    f.ready('claude')
    expect(limits.has('r2')).toBe(false)
  })

  test('a Run that works again is cleared, and nothing is marked after close', () => {
    const f = fakes()
    let closed = false
    const limits = runLimits({
      store: f.store,
      runs: f.runManager,
      health: f.health,
      owns: () => true,
      isClosed: () => closed,
      ready: () => {},
    })
    f.runs.set('r1', run('r1'))
    f.usage('r1')
    f.emit({ type: 'run-updated', run: run('r1') } as DaemonEvent)
    expect(limits.has('r1')).toBe(false)
    closed = true
    f.usage('r1')
    f.authFailed('r1')
    expect(limits.has('r1')).toBe(false)
  })
})

describe('afterProcessEnded', () => {
  test('resumes once when the Run has a session, then fails', () => {
    const withSession = { sessionId: 's1' }
    expect(
      afterProcessEnded({
        stopped: false,
        run: withSession,
        resumedBefore: false,
        lastLines: ['', 'boom', ''],
      }),
    ).toEqual({ resume: 'boom' })
    expect(
      afterProcessEnded({ stopped: false, run: withSession, resumedBefore: true, lastLines: [] }),
    ).toEqual({ fail: processEndedText })
    expect(
      afterProcessEnded({ stopped: false, run: {}, resumedBefore: false, lastLines: [] }),
    ).toEqual({ fail: processEndedText })
  })

  test('a stopped Run is not resumed', () => {
    expect(
      afterProcessEnded({
        stopped: true,
        run: { sessionId: 's1' },
        resumedBefore: false,
        lastLines: [],
      }),
    ).toEqual({ stopped: true })
  })
})

describe('queuedRunStatus', () => {
  test('gives the shared statuses and leaves the rest to the owner', () => {
    const f = fakes()
    const limits = runLimits({
      store: f.store,
      runs: f.runManager,
      health: f.health,
      owns: () => true,
      isClosed: () => false,
      ready: () => {},
    })
    expect(queuedRunStatus(undefined, { waiting: false, limits })).toBe('queued')
    expect(queuedRunStatus(run('r', { state: 'finished' }), { waiting: true, limits })).toBe(
      'ended',
    )
    expect(queuedRunStatus(run('r'), { waiting: true, limits })).toBe('waiting')
    expect(queuedRunStatus(run('r', { state: 'waiting' }), { waiting: false, limits })).toBe(
      'waiting',
    )
    f.pauses.claude = 'usage limit'
    expect(queuedRunStatus(run('r'), { waiting: false, limits })).toBe('paused')
    delete f.pauses.claude
    expect(queuedRunStatus(run('r'), { waiting: false, limits })).toBeUndefined()
  })
})
