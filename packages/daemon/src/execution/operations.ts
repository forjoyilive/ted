import { constants } from 'node:fs'
import { access, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type ExecutionCommand,
  type ExecutionInventoryEntry,
  type ExecutionLimits,
  type ExecutionRef,
  type ExecutionRefusal,
  type ExecutionReport,
  type ExecutionResult,
  type ExecutionScope,
  type ExecutionStop,
  type ExecutionSyncRequest,
  type ExecutionSyncResponse,
  executionIds,
  executionLimits,
  parseExecutionResult,
  sameExecutionRef,
  type WorkerOperations,
} from '@ted/protocol'
import { redactSecrets } from '../redact.ts'
import { crashPoint } from './crash.ts'
import { privateDirectory } from './files.ts'
import { type JournaledOperation, JournalFull, openJournal } from './journal.ts'

type Evidence = { finished: ExecutionResult } | 'not-started' | 'unknown'

async function probeLines(root: string): Promise<{ lines: string[]; torn: boolean }> {
  const text = await readFile(path.join(root, 'effects.log'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    },
  )
  const end = text.lastIndexOf('\n') + 1
  return { lines: text.slice(0, end).split('\n').filter(Boolean), torn: end < text.length }
}

const probe = {
  async run(
    root: string,
    command: ExecutionCommand,
    signal: AbortSignal,
  ): Promise<ExecutionResult | 'stopped'> {
    if (command.input.wait) {
      const release = path.join(root, `${command.operationId}.release`)
      for (;;) {
        if (signal.aborted) return 'stopped'
        const released = await access(release).then(
          () => true,
          () => false,
        )
        if (released) break
        await delay(50, undefined, { signal }).catch(() => undefined)
      }
    }
    if (signal.aborted) return 'stopped'
    crashPoint('worker-before-effect')
    const file = await open(
      path.join(root, 'effects.log'),
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.appendFile(`${command.operationId}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    crashPoint('worker-after-effect')
    const { lines } = await probeLines(root)
    return { ok: true, value: lines.filter((line) => line === command.operationId).length }
  },
  async evidence(root: string, command: ExecutionCommand): Promise<Evidence> {
    if (command.input.evidence === false) return 'unknown'
    const { lines, torn } = await probeLines(root)
    const value = lines.filter((line) => line === command.operationId).length
    if (value > 0) return { finished: { ok: true, value } }
    return torn ? 'unknown' : 'not-started'
  },
}

export async function createExecutionOperations(options: {
  home: string
  identity(): { grantId: string; scopes: ExecutionScope[] } | undefined
  freeBytes(): Promise<number>
  limits?: ExecutionLimits
  changed?: () => void
}) {
  const limits = options.limits ?? executionLimits
  const journal = await openJournal(options.home, limits)
  const probeRoot = await privateDirectory(path.join(options.home, 'probe'))
  const running = new Map<string, AbortController>()
  let refusals: ExecutionReport[] = []
  let allowed = false
  let lowDisk = false
  let closed = false
  let work = Promise.resolve()

  for (const operation of journal.operations()) {
    if (operation.state !== 'running' || !operation.command) continue
    const evidence = await probe.evidence(probeRoot, operation.command)
    if (evidence === 'unknown') await journal.record('uncertain', operation.id)
    else if (evidence === 'not-started')
      await journal.record(operation.stopRequested ? 'stopped' : 'reset', operation.id)
    else await journal.finish(operation.id, evidence.finished)
  }

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = work.then(task)
    work = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  function refuse(
    command: { operationId: ExecutionCommand['operationId']; ref: ExecutionRef },
    refusal: ExecutionRefusal,
  ): void {
    refusals = refusals.filter((r) => r.operationId !== command.operationId).slice(-15)
    refusals.push({
      operationId: command.operationId,
      ref: command.ref,
      state: 'refused',
      refusal,
    })
  }
  function stale(ref: ExecutionRef, order: number): boolean {
    if (ref.machineId !== options.identity()?.grantId) return true
    const task = journal.task(ref.taskId)
    if (!task) return false
    if (ref.generation < task.generation) return true
    if (
      ref.generation === task.generation &&
      (ref.assignmentId !== task.assignmentId || ref.reservationId !== task.reservationId)
    )
      return true
    return order <= task.lastOrder
  }
  async function accept(command: ExecutionCommand): Promise<void> {
    if (journal.operation(command.operationId)) return
    const identity = options.identity()
    if (stale(command.ref, command.order)) return refuse(command, 'stale')
    if (
      !identity?.scopes.some(
        (s) => s.factoryId === command.scope.factoryId && s.repo === command.scope.repo,
      )
    )
      return refuse(command, 'scope')
    lowDisk = (await options.freeBytes()) < limits.minFreeBytes
    if (lowDisk) return refuse(command, 'disk')
    try {
      await journal.accept(command)
    } catch (error) {
      if (error instanceof JournalFull) return refuse(command, 'limit')
      throw error
    }
    crashPoint('worker-after-accept')
  }
  async function stop(request: ExecutionStop): Promise<void> {
    const operation = journal.operation(request.operationId)
    if (!operation) {
      if (stale(request.ref, request.order)) return
      await journal.tombstone(request.operationId, request.ref, request.order)
      return
    }
    if (
      request.ref.machineId !== options.identity()?.grantId ||
      !sameExecutionRef(request.ref, operation.ref)
    )
      return
    const starting = running.get(operation.id)
    if (operation.state === 'accepted' && !starting) {
      await journal.record('stopped', operation.id)
      return
    }
    if ((operation.state !== 'running' && !starting) || operation.stopRequested) return
    starting?.abort()
    await journal.record('stop', operation.id)
  }
  async function run(operation: JournaledOperation & { command: ExecutionCommand }): Promise<void> {
    const abort = new AbortController()
    running.set(operation.id, abort)
    try {
      await journal.record('start', operation.id)
      crashPoint('worker-after-start')
      options.changed?.()
      let outcome: ExecutionResult | 'stopped'
      try {
        outcome = abort.signal.aborted
          ? 'stopped'
          : await probe.run(probeRoot, operation.command, abort.signal)
      } catch (error) {
        outcome = {
          ok: false,
          diagnostic: redactSecrets(error instanceof Error ? error.message : 'Operation failed')
            .replace(/[^\x20-\x7e]/g, ' ')
            .slice(0, 2000),
        }
      }
      if (closed) return
      if (outcome === 'stopped') await journal.record('stopped', operation.id)
      else await journal.finish(operation.id, parseExecutionResult(outcome))
      crashPoint('worker-after-finish')
      options.changed?.()
    } finally {
      running.delete(operation.id)
      if (!closed) pump()
    }
  }
  function pump(): void {
    if (!allowed || closed) return
    const grantId = options.identity()?.grantId
    const tasks = new Map<string, JournaledOperation[]>()
    for (const o of journal.operations())
      tasks.set(o.ref.taskId, [...(tasks.get(o.ref.taskId) ?? []), o])
    for (const operations of tasks.values()) {
      if (operations.some((o) => o.state === 'running' || o.state === 'uncertain')) continue
      const next = operations
        .filter((o) => o.state === 'accepted' && o.ref.machineId === grantId)
        .sort((a, b) => a.order - b.order)[0]
      if (next?.command && !running.has(next.id))
        void run({ ...next, command: next.command }).catch((error: unknown) =>
          console.error(
            'execution operation could not be journaled:',
            redactSecrets(error instanceof Error ? error.message : 'unknown error'),
          ),
        )
    }
  }
  function report(o: JournaledOperation): ExecutionReport {
    return {
      operationId: executionIds.operation(o.id),
      ref: o.ref,
      state: o.state,
      ...(o.state === 'finished' && o.result && { result: o.result }),
    }
  }

  return {
    async request(
      inventory: boolean,
    ): Promise<Pick<ExecutionSyncRequest, 'inventory' | 'reports' | 'accepting'>> {
      lowDisk = (await options.freeBytes()) < limits.minFreeBytes
      const all = journal.operations()
      const settled = (o: JournaledOperation) => o.state === 'finished' || o.state === 'stopped'
      const reports: ExecutionReport[] = []
      let bytes = 0
      for (const o of [...all.filter(settled), ...all.filter((o) => !settled(o))]) {
        if (reports.length >= executionLimits.unconfirmed - refusals.length) break
        const next = report(o)
        const size = Buffer.byteLength(JSON.stringify(next))
        if (bytes + size > limits.syncRequestBytes / 2) continue
        bytes += size
        reports.push(next)
      }
      reports.push(...refusals)
      return {
        ...(inventory && {
          inventory: all.map(
            (o): ExecutionInventoryEntry => ({
              operationId: executionIds.operation(o.id),
              ref: o.ref,
              state: o.state,
            }),
          ),
        }),
        reports,
        accepting: lowDisk ? 'disk' : journal.full() ? 'limit' : true,
      }
    },
    handle(response: ExecutionSyncResponse): Promise<void> {
      return serial(async () => {
        refusals = []
        await journal.confirm(response.confirmed)
        for (const request of response.stops) await stop(request)
        for (const command of response.commands) await accept(command)
        pump()
      })
    },
    allow(value: boolean): void {
      allowed = value
      pump()
    },
    counts(): WorkerOperations {
      const all = journal.operations()
      const count = (...states: JournaledOperation['state'][]) =>
        all.filter((o) => states.includes(o.state)).length
      return {
        running: count('running'),
        queued: count('accepted'),
        waiting: count('finished', 'stopped'),
        uncertain: count('uncertain'),
        reconciling: !allowed,
        ...(lowDisk
          ? { refusing: 'disk' as const }
          : journal.full() && { refusing: 'limit' as const }),
      }
    },
    async close(): Promise<void> {
      closed = true
      allowed = false
      for (const abort of running.values()) abort.abort()
      await work
      await journal.close()
    },
  }
}
export type ExecutionOperations = Awaited<ReturnType<typeof createExecutionOperations>>
