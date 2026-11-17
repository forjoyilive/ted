import type { AgentKind, Run } from '@ted/protocol'
import type { StoredTask, TedStore } from '../store/index.ts'
import type { RunManager } from './run-manager.ts'

export interface IdleSleep {
  check(): void
  close(): void
}

export interface IdleSleepOptions {
  store: TedStore
  runs: Pick<RunManager, 'sleep'>
  midWork(taskId: string): boolean
  chatRests(run: Run): boolean
  now?: () => number
  checkEveryMs?: number
}

const sleepable: readonly AgentKind[] = ['claude', 'codex']

const busyAfterMs = 2 * 60_000

export function sleepAfterMs(minutes: number, busy: boolean): number {
  return busy ? Math.min(minutes * 60_000, busyAfterMs) : minutes * 60_000
}

export type SleepKind = 'lead' | 'sub-agent' | 'chat'

export type SleepTask = Pick<StoredTask, 'leadRunId' | 'archived' | 'stopped' | 'stage'> & {
  pendingLeadMessages: readonly object[]
}

export type Sleeper =
  | { kind: 'lead'; task: SleepTask; workingSubAgents: number; midWork: boolean }
  | { kind: 'sub-agent'; task: SleepTask | undefined; parentLive: boolean }
  | { kind: 'chat'; rests: boolean }

export interface SleepFacts {
  run: Run
  sleeper: Sleeper | undefined
  lastOutputAt: string | undefined
  queuedMessages: number
  afterMs: number
  now: number
}

export function sleepKind(
  run: Run,
  store: {
    coordinators: Pick<TedStore['coordinators'], 'forRun'>
    plans: Pick<TedStore['plans'], 'get'>
  },
): SleepKind | undefined {
  if (run.taskId !== undefined) return run.parentRunId === undefined ? 'lead' : 'sub-agent'
  if (run.parentRunId !== undefined) return undefined
  if (store.coordinators.forRun(run.id)?.runId === run.id) return 'chat'
  if (store.plans.get(run.id) !== undefined) return 'chat'
  return undefined
}

export function idleSince(run: Run, lastOutputAt: string | undefined): number {
  return Math.max(
    ...[lastOutputAt, run.revivedAt, run.startedAt].flatMap((at) =>
      at === undefined ? [] : [Date.parse(at)],
    ),
  )
}

const taskOpen = (task: SleepTask) =>
  !task.archived && !task.stopped && task.stage !== 'backlog' && task.stage !== 'done'

function rests(run: Run, sleeper: Sleeper): boolean {
  switch (sleeper.kind) {
    case 'lead':
      return (
        run.parentRunId === undefined &&
        sleeper.task.leadRunId === run.id &&
        taskOpen(sleeper.task) &&
        sleeper.task.pendingLeadMessages.length === 0 &&
        sleeper.workingSubAgents === 0 &&
        !sleeper.midWork
      )
    case 'sub-agent':
      return (
        run.parentRunId !== undefined &&
        sleeper.parentLive &&
        sleeper.task !== undefined &&
        taskOpen(sleeper.task)
      )
    case 'chat':
      return run.taskId === undefined && run.parentRunId === undefined && sleeper.rests
  }
}

export function maySleep(facts: SleepFacts): boolean {
  const { run, sleeper } = facts
  return (
    sleeper !== undefined &&
    run.state === 'idle' &&
    !run.asleep &&
    run.problem === undefined &&
    run.sessionId !== undefined &&
    sleepable.includes(run.agent) &&
    facts.queuedMessages === 0 &&
    facts.now - idleSince(run, facts.lastOutputAt) >= facts.afterMs &&
    rests(run, sleeper)
  )
}

export function sleepIdleRuns(options: IdleSleepOptions): IdleSleep {
  const { store, runs } = options
  const now = options.now ?? Date.now
  let closed = false

  function sleeperOf(run: Run, live: readonly Run[]): Sleeper | undefined {
    const kind = sleepKind(run, store)
    const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
    if (kind === 'lead') {
      if (!task) return undefined
      return {
        kind,
        task,
        workingSubAgents: live.filter(
          (other) => other.parentRunId === run.id && other.state !== 'idle',
        ).length,
        midWork: options.midWork(task.id),
      }
    }
    if (kind === 'sub-agent') {
      const parent = run.parentRunId === undefined ? undefined : store.getRun(run.parentRunId)
      return { kind, task, parentLive: parent !== undefined && parent.state !== 'finished' }
    }
    if (kind === 'chat') return { kind, rests: options.chatRests(run) }
    return undefined
  }

  function check(): void {
    const minutes = store.settings().sleepIdleRunsAfterMinutes
    if (closed || minutes === null || store.newWorkHold() !== undefined) return
    const afterMs = sleepAfterMs(minutes, store.busyHold() !== undefined)
    const live = store.liveRuns()
    const at = now()
    for (const run of live) {
      if (run.state !== 'idle' || run.asleep) continue
      const sleeper = sleeperOf(run, live)
      if (!sleeper) continue
      const resting = maySleep({
        run,
        sleeper,
        lastOutputAt: store.lastOutputAt(run.id),
        queuedMessages: store.runMessages(run.id).filter((message) => message.queued === true)
          .length,
        afterMs,
        now: at,
      })
      if (!resting) continue
      runs
        .sleep(run.id, at - afterMs)
        .catch((error: Error) => console.error(`couldn’t put Run ${run.id} to sleep:`, error))
    }
  }

  const timer = setInterval(check, options.checkEveryMs ?? 60_000)
  timer.unref()
  return {
    check,
    close() {
      closed = true
      clearInterval(timer)
    },
  }
}
