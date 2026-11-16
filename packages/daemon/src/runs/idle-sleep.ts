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
  now?: () => number
  checkEveryMs?: number
}

const sleepable: readonly AgentKind[] = ['claude', 'codex']

export interface SleepFacts {
  run: Run
  task: Pick<StoredTask, 'leadRunId' | 'archived' | 'stopped' | 'stage'> & {
    pendingLeadMessages: readonly unknown[]
  }
  lastOutputAt: string | undefined
  liveSubAgents: number
  queuedMessages: number
  midWork: boolean
  afterMs: number
  now: number
}

export function idleSince(run: Run, lastOutputAt: string | undefined): number {
  return Math.max(
    ...[lastOutputAt, run.revivedAt, run.startedAt].flatMap((at) =>
      at === undefined ? [] : [Date.parse(at)],
    ),
  )
}

export function maySleep(facts: SleepFacts): boolean {
  const { run, task } = facts
  return (
    run.state === 'idle' &&
    !run.asleep &&
    run.problem === undefined &&
    run.sessionId !== undefined &&
    run.parentRunId === undefined &&
    sleepable.includes(run.agent) &&
    task.leadRunId === run.id &&
    !task.archived &&
    !task.stopped &&
    task.stage !== 'backlog' &&
    task.stage !== 'done' &&
    task.pendingLeadMessages.length === 0 &&
    facts.liveSubAgents === 0 &&
    facts.queuedMessages === 0 &&
    !facts.midWork &&
    facts.now - idleSince(run, facts.lastOutputAt) >= facts.afterMs
  )
}

export function sleepIdleRuns(options: IdleSleepOptions): IdleSleep {
  const { store, runs } = options
  const now = options.now ?? Date.now
  let closed = false

  function check(): void {
    const minutes = store.settings().sleepIdleRunsAfterMinutes
    if (closed || minutes === null || store.newWorkHold() !== undefined) return
    const afterMs = minutes * 60_000
    const live = store.liveRuns()
    const at = now()
    for (const run of live) {
      if (run.state !== 'idle' || run.asleep || run.taskId === undefined) continue
      const task = store.getTask(run.taskId)
      if (!task) continue
      const rests = maySleep({
        run,
        task,
        lastOutputAt: store.lastOutputAt(run.id),
        liveSubAgents: live.filter((other) => other.parentRunId === run.id).length,
        queuedMessages: store.runMessages(run.id).filter((message) => message.queued === true)
          .length,
        midWork: options.midWork(task.id),
        afterMs,
        now: at,
      })
      if (!rests) continue
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
