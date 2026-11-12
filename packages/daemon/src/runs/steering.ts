import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Run, RunMessage } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { RunInterrupt, TedStore } from '../store/index.ts'
import { runFiles } from './host-files.ts'
import type { RunManager } from './run-manager.ts'

export interface SteeringSource {
  acknowledged?: true
  revocable?: true
  pending(run: Run): { id: string; text: string; at: string }[]
  delivered(run: Run, ids: string[]): void
}

export interface Steering {
  addSource(source: SteeringSource): void
  changed(runId: string): Promise<void>
  refresh(runId: string): Promise<void>
  send(runId: string, text: string, options: { interrupt: boolean }): Promise<RunMessage>
  stopTurn(runId: string): Promise<void>
  sendNow(runId: string, messageId: string): Promise<RunMessage>
  remove(runId: string, messageId: string): RunMessage
  deliverAdmitted(runId: string): Promise<number>
  delivering(runId: string): boolean
  drain(runId: string): Promise<void>
  syncQueuedFlag(runId: string): void
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
  canDeliver: (runId: string, admitted: boolean) => boolean
  deliveryFinished?: (runId: string, error?: unknown) => void
}): Steering {
  const { home, store, runs, isCurrentLead } = options
  const sources = new Set<SteeringSource>()
  const chains = new Map<string, Promise<unknown>>()
  const waiters = new Set<{ runId: string; texts: string[]; done: () => void }>()
  const sendingNow = new Set<string>()
  const delivering = new Set<string>()

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

  const queued = (runId: string) => {
    const roundMessages = new Set(store.roundTalkMessageIds(runId))
    return store.runMessages(runId).filter((m) => m.queued === true && !roundMessages.has(m.id))
  }

  function releaseState(runId: string) {
    const release = store.runSteeringRelease(runId)
    const holdId = store.runInterrupts(runId).findLast((interrupt) => interrupt.hold)?.id
    return release?.holdId === holdId ? release : undefined
  }

  function releaseMessages(run: Run, messageIds: string[], first?: string) {
    const previous = releaseState(run.id)
    const holdId = store.runInterrupts(run.id).findLast((interrupt) => interrupt.hold)?.id
    const pending = new Set([
      ...queued(run.id).map((message) => message.id),
      ...[...sources].flatMap((source) => source.pending(run).map((message) => message.id)),
    ])
    const priority = first ?? previous?.first
    store.releaseRunSteering(run.id, {
      messageIds: [
        ...new Set([
          ...(previous?.messageIds ?? []).filter((id) => pending.has(id)),
          ...messageIds,
        ]),
      ],
      ...(priority !== undefined && pending.has(priority) && { first: priority }),
      ...(holdId !== undefined && { holdId }),
    })
  }

  function releaseAll(run: Run) {
    releaseMessages(run, [
      ...queued(run.id).map((message) => message.id),
      ...[...sources].flatMap((source) => source.pending(run).map((message) => message.id)),
    ])
  }

  function deliverable(runId: string): RunMessage[] {
    if (delivering.has(runId) || !options.canDeliver(runId, false)) return []
    const interrupts = store.runInterrupts(runId)
    const released = new Set(releaseState(runId)?.messageIds)
    return queued(runId).filter(
      (message) =>
        (!isHeld(message, interrupts) || released.has(message.id)) && !sendingNow.has(message.id),
    )
  }

  function pendingSources(runId: string, includeHeld = false) {
    const run = store.getRun(runId)
    if (!run || run.state === 'finished' || !options.canDeliver(runId, false)) return []
    const interrupts = store.runInterrupts(runId)
    const released = new Set(releaseState(runId)?.messageIds)
    return [...sources].flatMap((source) =>
      source
        .pending(run)
        .filter(
          (message) => includeHeld || !isHeld(message, interrupts) || released.has(message.id),
        )
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
    delivery: { admitted?: boolean; includeHeld?: boolean; first?: string } = {},
  ): Promise<number> {
    const { admitted = false, includeHeld = false } = delivery
    const first = delivery.first ?? releaseState(run.id)?.first
    if (!options.canDeliver(run.id, admitted)) return 0
    const current = store.getRun(run.id)
    if (!current || current.state === 'finished') return 0
    const pending = pendingSources(run.id, includeHeld)
    let acknowledged = 0
    for (const source of sources) {
      if (!source.acknowledged) continue
      const messages = pending.filter((message) => message.source === source)
      if (messages.length === 0) continue
      await store.persisted()
      if (
        await runs.dispatch(
          run.id,
          messages,
          true,
          (id) =>
            options.canDeliver(run.id, admitted) &&
            source.pending(run).some((message) => id === undefined || message.id === id),
          { revocable: source.revocable === true },
        )
      ) {
        source.delivered(
          run,
          messages.map((message) => message.id),
        )
        await store.persisted()
        acknowledged += messages.length
      }
    }
    if (!options.canDeliver(run.id, admitted) || store.getRun(run.id)?.state === 'finished')
      return acknowledged
    const still = new Set(queued(run.id).map((m) => m.id))
    const sending = messages.filter((m) => still.has(m.id))
    const extra = pendingSources(run.id, includeHeld).filter(
      (message) => !message.source.acknowledged,
    )
    if (sending.length === 0 && extra.length === 0) {
      syncFlag(run.id)
      return acknowledged
    }
    if (store.coordinators.forRun(run.id)) {
      delivering.add(run.id)
      syncFlag(run.id)
      let failure: unknown
      try {
        await store.persisted()
        if (!options.canDeliver(run.id, admitted)) return 0
        const pending = new Set(queued(run.id).map((message) => message.id))
        const available = sending.filter((message) => pending.has(message.id))
        const dispatch = admitted ? available.slice(0, 1) : available
        if (dispatch.length === 0) return 0
        if (
          !(await runs.dispatch(
            run.id,
            dispatch,
            !admitted,
            (messageId) =>
              options.canDeliver(run.id, admitted) &&
              (messageId === undefined ||
                queued(run.id).some((message) => message.id === messageId)),
          ))
        )
          return 0
        const remaining = new Set(queued(run.id).map((message) => message.id))
        const delivered = dispatch.filter((message) => remaining.has(message.id))
        store.deliverRunMessages(
          run.id,
          delivered.map((message) => message.id),
          false,
        )
        await store.persisted()
        return delivered.length
      } catch (error) {
        failure = error
        throw error
      } finally {
        delivering.delete(run.id)
        syncFlag(run.id)
        options.deliveryFinished?.(run.id, failure)
      }
    }
    store.deliverRunMessages(
      run.id,
      sending.map((m) => m.id),
      isCurrentLead(current),
    )
    const ordered = [...sending, ...extra].sort((a, b) => a.at.localeCompare(b.at))
    const priority = first === undefined ? -1 : ordered.findIndex((m) => m.id === first)
    if (priority > 0) ordered.unshift(...ordered.splice(priority, 1))
    syncFlag(run.id)
    await store.persisted()
    await runs.steer(
      run.id,
      ordered.map((m) => m.text),
    )
    for (const source of sources) {
      const ids = extra.filter((m) => m.source === source).map((m) => m.id)
      if (ids.length > 0) source.delivered(run, ids)
    }
    await store.persisted()
    syncFlag(run.id)
    return ordered.length + acknowledged
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
      await deliver(run, [first, ...deliverable(run.id).filter((m) => m.id !== first.id)], {
        first: first.id,
      })
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
    delivering: (runId) => delivering.has(runId),
    drain: async (runId) => {
      await chains.get(runId)?.catch(() => {})
    },
    syncQueuedFlag: syncFlag,
    deliverAdmitted: (runId) =>
      serially(runId, () => deliver(requireLive(runId), queued(runId), { admitted: true })),
    addSource(source) {
      sources.add(source)
      for (const run of store.listRuns()) {
        if (run.state === 'finished') continue
        syncFlag(run.id)
        if (run.state !== 'working' && hasPending(run.id)) void flush(run).catch(logFailure(run.id))
      }
    },
    async refresh(runId) {
      const run = store.getRun(runId)
      if (!run || run.state === 'finished') return
      syncFlag(runId)
      if (run.state !== 'working') await flush(run)
    },
    async changed(runId) {
      const run = requireLive(runId)
      syncFlag(runId)
      if (run.state !== 'working') {
        await serially(runId, async () => {
          const current = requireLive(runId)
          if (current.state !== 'working')
            await deliver(current, queued(runId), { includeHeld: true })
          else syncFlag(runId)
        })
      }
    },
    async send(runId, text, { interrupt }) {
      const run = requireLive(runId)
      if (run.state === 'working') {
        if (interrupt) store.recordTurnInterrupted(runId, false)
        const message = store.queueRunMessage({ runId, text })
        releaseAll(run)
        if (interrupt) interruptThenDeliver(run, message)
        else syncFlag(runId)
        return message
      }
      return serially(runId, async () => {
        const live = requireLive(runId)
        if (live.state === 'working' || !options.canDeliver(runId, false)) {
          const message = store.queueRunMessage({ runId, text })
          releaseAll(live)
          syncFlag(runId)
          return message
        }
        await deliver(live, queued(runId), { includeHeld: true })
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
      releaseMessages(run, [message.id], message.id)
      if (run.state === 'working') {
        store.recordTurnInterrupted(runId, false)
        interruptThenDeliver(run, message)
      } else {
        await serially(runId, () => deliver(run, [message], { first: message.id }))
      }
      return { id: message.id, runId, text: message.text, at: message.at }
    },
    remove(runId, messageId) {
      if (!store.getRun(runId)) throw new RequestError(404, 'no such Run')
      if (store.coordinators.forRun(runId) && runs.inputDispatched(runId, messageId))
        throw new RequestError(409, 'Delivery has started; this message can no longer be canceled')
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
        const seen = store.coordinators.forRun(runId)
          ? undefined
          : accepted(
              runId,
              [...messages, ...extra].map((m) => m.text),
            )
        const delivered = await deliver(run, messages)
        if (delivered > 0) await seen
        return { delivered }
      })
    },
  }
}

const logFailure = (runId: string) => (error: unknown) =>
  console.error(`couldn’t deliver a queued message to Run ${runId}:`, error)
