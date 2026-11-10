import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Run, RunMessage } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { RunInterrupt, TedStore } from '../store/index.ts'
import { runFiles } from './host-files.ts'
import type { RunManager } from './run-manager.ts'

export interface SteeringSource {
  pending(run: Run): { id: string; text: string; at: string }[]
  delivered(run: Run, ids: string[]): void
}

export interface Steering {
  addSource(source: SteeringSource): void
  changed(runId: string): Promise<void>
  send(runId: string, text: string, options: { interrupt: boolean }): Promise<RunMessage>
  stopTurn(runId: string): Promise<void>
  sendNow(runId: string, messageId: string): Promise<RunMessage>
  remove(runId: string, messageId: string): RunMessage
  boundary(runId: string): Promise<{ delivered: number }>
}

const turnEndMs = 10_000
const acceptMs = 10_000
const pollMs = 50

export function isHeld(
  message: Pick<RunMessage, 'at'>,
  interrupts: readonly RunInterrupt[],
): boolean {
  return interrupts.some((interrupt) => interrupt.hold && interrupt.at >= message.at)
}

export function createSteering(options: {
  home: string
  store: TedStore
  runs: RunManager
  isCurrentLead: (run: Run) => boolean
}): Steering {
  const { home, store, runs, isCurrentLead } = options
  const sources = new Set<SteeringSource>()
  const chains = new Map<string, Promise<unknown>>()
  const waiters = new Set<{ runId: string; texts: string[]; done: () => void }>()
  const sendingNow = new Set<string>()

  const flagFile = (runId: string) => runFiles(path.join(home, 'runs', runId)).queued

  function serially<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(runId) ?? Promise.resolve()).catch(() => {}).then(work)
    chains.set(runId, next)
    void next
      .catch(() => {})
      .finally(() => {
        if (chains.get(runId) === next) chains.delete(runId)
      })
    return next
  }

  const queued = (runId: string) => store.runMessages(runId).filter((m) => m.queued === true)

  function deliverable(runId: string): RunMessage[] {
    const interrupts = store.runInterrupts(runId)
    return queued(runId).filter(
      (message) => !isHeld(message, interrupts) && !sendingNow.has(message.id),
    )
  }

  function pendingSources(runId: string, includeHeld = false) {
    const run = store.getRun(runId)
    if (!run || run.state === 'finished') return []
    const interrupts = store.runInterrupts(runId)
    return [...sources].flatMap((source) =>
      source
        .pending(run)
        .filter((message) => includeHeld || !isHeld(message, interrupts))
        .map((message) => ({ ...message, source })),
    )
  }

  const hasPending = (runId: string) =>
    deliverable(runId).length > 0 || pendingSources(runId).length > 0

  function syncFlag(runId: string): void {
    try {
      if (hasPending(runId)) writeFileSync(flagFile(runId), '', { mode: 0o600 })
      else rmSync(flagFile(runId), { force: true })
    } catch (error) {
      console.error(`couldn’t mark Run ${runId}’s queued messages:`, error)
    }
  }

  function requireLive(runId: string): Run {
    const run = store.getRun(runId)
    if (!run) throw new RequestError(404, 'no such Run')
    if (run.state === 'finished') {
      throw new RequestError(409, 'This Run has finished, so it can’t take messages')
    }
    return run
  }

  function accepted(runId: string, texts: string[]): Promise<void> {
    const waiting = texts.map((text) => text.trim())
    return new Promise<void>((resolve) => {
      const waiter = { runId, texts: waiting, done: () => {} }
      const timer = setTimeout(() => waiter.done(), acceptMs)
      waiter.done = () => {
        clearTimeout(timer)
        waiters.delete(waiter)
        resolve()
      }
      waiters.add(waiter)
    })
  }

  async function deliver(
    run: Run,
    messages: readonly RunMessage[],
    includeHeld = false,
    first?: string,
  ): Promise<void> {
    const current = store.getRun(run.id)
    if (!current || current.state === 'finished') return
    const still = new Set(queued(run.id).map((m) => m.id))
    const sending = messages.filter((m) => still.has(m.id))
    const extra = pendingSources(run.id, includeHeld)
    if (sending.length === 0 && extra.length === 0) return
    store.deliverRunMessages(
      run.id,
      sending.map((m) => m.id),
      isCurrentLead(current),
    )
    const ordered = [...sending, ...extra].sort((a, b) => a.at.localeCompare(b.at))
    const priority = first === undefined ? -1 : ordered.findIndex((m) => m.id === first)
    if (priority > 0) ordered.unshift(...ordered.splice(priority, 1))
    await runs.steer(
      run.id,
      ordered.map((m) => m.text),
    )
    for (const source of sources) {
      const ids = extra.filter((m) => m.source === source).map((m) => m.id)
      if (ids.length > 0) source.delivered(run, ids)
    }
    syncFlag(run.id)
  }

  async function turnEnded(runId: string): Promise<void> {
    for (let waited = 0; waited < turnEndMs; waited += pollMs) {
      const state = store.getRun(runId)?.state
      if (state !== 'working') return
      await sleep(pollMs)
    }
  }

  function interruptThenDeliver(run: Run, first: RunMessage): void {
    sendingNow.add(first.id)
    syncFlag(run.id)
    void serially(run.id, async () => {
      try {
        await runs.interrupt(run.id)
        await turnEnded(run.id)
      } finally {
        sendingNow.delete(first.id)
      }
      await deliver(
        run,
        [first, ...deliverable(run.id).filter((m) => m.id !== first.id)],
        false,
        first.id,
      )
    }).catch(logFailure(run.id))
  }

  const flush = (run: Run) => serially(run.id, () => deliver(run, deliverable(run.id)))

  runs.observe({
    accepted(run, texts) {
      for (const waiter of waiters) {
        if (waiter.runId !== run.id) continue
        for (const text of texts) {
          const at = waiter.texts.indexOf(text.trim())
          if (at !== -1) waiter.texts.splice(at, 1)
        }
        if (waiter.texts.length === 0) waiter.done()
      }
    },
    boundary(run) {
      if (hasPending(run.id)) void flush(run).catch(logFailure(run.id))
    },
    settled(run) {
      if (hasPending(run.id)) void flush(run).catch(logFailure(run.id))
    },
    finished(run) {
      rmSync(flagFile(run.id), { force: true })
    },
  })

  for (const run of store.listRuns()) {
    if (run.state === 'finished' || queued(run.id).length === 0) continue
    syncFlag(run.id)
    if (run.state !== 'working') void flush(run).catch(logFailure(run.id))
  }

  return {
    addSource(source) {
      sources.add(source)
      for (const run of store.listRuns()) {
        if (run.state === 'finished') continue
        syncFlag(run.id)
        if (run.state !== 'working' && hasPending(run.id)) void flush(run).catch(logFailure(run.id))
      }
    },
    async changed(runId) {
      const run = requireLive(runId)
      syncFlag(runId)
      if (run.state !== 'working') {
        await serially(runId, async () => {
          const current = requireLive(runId)
          if (current.state !== 'working') await deliver(current, queued(runId), true)
          else syncFlag(runId)
        })
      }
    },
    async send(runId, text, { interrupt }) {
      const run = requireLive(runId)
      if (run.state === 'working') {
        if (interrupt) store.recordTurnInterrupted(runId, false)
        const message = store.queueRunMessage({ runId, text })
        if (interrupt) interruptThenDeliver(run, message)
        else syncFlag(runId)
        return message
      }
      return serially(runId, async () => {
        const live = requireLive(runId)
        if (live.state === 'working') {
          const message = store.queueRunMessage({ runId, text })
          syncFlag(runId)
          return message
        }
        await deliver(live, queued(runId), true)
        await runs.send(runId, text)
        return store.recordRunMessage({ runId, text, lead: isCurrentLead(live) })
      })
    },
    async stopTurn(runId) {
      const run = requireLive(runId)
      if (run.state !== 'working') {
        throw new RequestError(409, 'The Run isn’t working, so there’s no turn to stop')
      }
      store.recordTurnInterrupted(runId, true)
      syncFlag(runId)
      await runs.interrupt(runId)
    },
    async sendNow(runId, messageId) {
      const run = requireLive(runId)
      const message = queued(runId).find((m) => m.id === messageId)
      if (!message) throw new RequestError(409, 'The agent has already read this message')
      if (run.state === 'working') {
        store.recordTurnInterrupted(runId, false)
        interruptThenDeliver(run, message)
      } else {
        await serially(runId, () => deliver(run, [message], false, message.id))
      }
      return { id: message.id, runId, text: message.text, at: message.at }
    },
    remove(runId, messageId) {
      if (!store.getRun(runId)) throw new RequestError(404, 'no such Run')
      const removed = store.deleteRunMessage(runId, messageId)
      if (!removed) throw new RequestError(409, 'The agent has already read this message')
      syncFlag(runId)
      return removed
    },
    async boundary(runId) {
      if (!hasPending(runId)) {
        syncFlag(runId)
        return { delivered: 0 }
      }
      return serially(runId, async () => {
        const run = store.getRun(runId)
        if (!run || run.state === 'finished') return { delivered: 0 }
        const messages = deliverable(runId)
        const extra = pendingSources(runId)
        if (messages.length === 0 && extra.length === 0) {
          syncFlag(runId)
          return { delivered: 0 }
        }
        const seen = accepted(
          runId,
          [...messages, ...extra].map((m) => m.text),
        )
        await deliver(run, messages)
        await seen
        return { delivered: messages.length + extra.length }
      })
    },
  }
}

const logFailure = (runId: string) => (error: unknown) =>
  console.error(`couldn’t deliver a queued message to Run ${runId}:`, error)
