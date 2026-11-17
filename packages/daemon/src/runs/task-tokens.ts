import type { Agents } from '../agents/index.ts'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import { parsedOutput } from './parsed-output.ts'
import type { RunManager } from './run-manager.ts'

export interface TaskTokensOptions {
  store: TedStore
  runs: Pick<RunManager, 'output' | 'observe'>
  agents: Agents
  everyMs?: number
}

export interface TaskTokens {
  close(): void
}

export function followTaskTokens({
  store,
  runs,
  agents,
  everyMs = 5000,
}: TaskTokensOptions): TaskTokens {
  const timers = new Map<string, NodeJS.Timeout>()
  const readAt = new Map<string, number>()
  let closed = false

  const read = (runId: string) => {
    timers.delete(runId)
    if (closed) return
    const run = store.getRun(runId)
    if (!run || run.taskId === undefined || run.state === 'finished') return
    readAt.set(runId, Date.now())
    try {
      store.setLiveTokens(runId, parsedOutput(runs.output, agents, run).tokens())
    } catch (error) {
      console.error(redactSecrets(`couldn’t count Run ${runId}’s tokens: ${String(error)}`))
    }
  }

  const soon = (runId: string) => {
    if (closed || timers.has(runId)) return
    const wait = Math.max(0, (readAt.get(runId) ?? 0) + everyMs - Date.now())
    timers.set(runId, setTimeout(() => read(runId), wait).unref())
  }

  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'run-output' && event.lines === true) soon(event.runId)
  })
  runs.observe({
    finished(run) {
      clearTimeout(timers.get(run.id))
      timers.delete(run.id)
      readAt.delete(run.id)
      setImmediate(() => {
        if (!closed) store.setLiveTokens(run.id, undefined)
      })
    },
  })
  for (const run of store.listRuns()) {
    if (run.state !== 'finished' && run.taskId !== undefined) soon(run.id)
  }

  return {
    close() {
      closed = true
      unsubscribe()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
