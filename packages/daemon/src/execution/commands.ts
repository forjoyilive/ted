import { isDeepStrictEqual } from 'node:util'
import {
  type ExecutionCommand,
  type ExecutionGrant,
  type ExecutionInventoryEntry,
  type ExecutionOperationId,
  type ExecutionRefusal,
  type ExecutionReport,
  type ExecutionScope,
  type ExecutionStop,
  type ExecutionSyncRequest,
  type ExecutionSyncResponse,
  executionIds,
  executionLimits,
  type MachineOperations,
  type ProbeInput,
  parseExecutionCommand,
  sameExecutionRef,
  terminalExecutionStates,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { StoredOperation, StoredOperationState } from '../store/execution-operations.ts'
import type { TedStore } from '../store/index.ts'
import { crashPoint } from './crash.ts'
import { machineOperationsText } from './status-text.ts'

export interface IssueExecution {
  operationId: string
  taskId: string
  scope: ExecutionScope
  input: ProbeInput
}

const rank: Record<StoredOperationState, number> = {
  issued: 0,
  accepted: 1,
  running: 2,
  uncertain: 3,
  unknown: 3,
  finished: 4,
  stopped: 4,
  refused: 4,
}
const terminal = (state: StoredOperationState) =>
  (terminalExecutionStates as readonly string[]).includes(state)
const held = (state: StoredOperationState) => state === 'uncertain' || state === 'unknown'

export function createExecutionCommands(options: {
  store: Pick<TedStore, 'execution' | 'operations' | 'pairing' | 'persisted'>
  pollMs?: number
  log?: (line: string) => void
}) {
  const { store } = options
  const log = options.log ?? ((line: string) => console.warn(line))
  const sessions = new Map<
    string,
    { id: string; reconciled: boolean; stopsSent: Set<string>; orphans: ExecutionStop[] }
  >()
  const accepting = new Map<string, true | ExecutionRefusal>()
  const unsaved = new Set<string>()
  const waiting = new Map<string, Set<() => void>>()
  const chains = new Map<string, Promise<unknown>>()

  function wake(machineId: string): void {
    for (const resume of waiting.get(machineId) ?? []) resume()
  }
  function pause(machineId: string, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const waiters = waiting.get(machineId) ?? new Set<() => void>()
      waiting.set(machineId, waiters)
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, options.pollMs ?? 2000)
      waiters.add(done)
      signal?.addEventListener('abort', done)
    })
  }
  function grantFor(machineId: string): ExecutionGrant | undefined {
    return store.pairing.grants().find((g) => g.id === machineId && !g.revokedAt)
  }
  function redacted(report: ExecutionReport): ExecutionReport {
    if (!report.result?.diagnostic) return report
    return {
      ...report,
      result: {
        ...report.result,
        diagnostic: redactSecrets(report.result.diagnostic).slice(
          0,
          executionLimits.diagnosticBytes,
        ),
      },
    }
  }

  function noteUnknown(
    machineId: string,
    entry: Pick<ExecutionReport, 'operationId' | 'ref' | 'state'>,
  ): boolean {
    const assigned = store.execution.assignment(entry.ref.taskId)?.machineId === machineId
    const known = store.operations.forMachine(machineId).filter((r) => r.state === 'unknown')
    if (!assigned || known.length >= executionLimits.unconfirmed) {
      log(`execution operation ${entry.operationId} is not this Mac’s to report; ignored`)
      return false
    }
    store.operations.unknown(machineId, entry)
    return true
  }

  function reconcile(machineId: string, inventory: ExecutionInventoryEntry[]): ExecutionStop[] {
    const orphans: ExecutionStop[] = []
    const reported = new Set<string>()
    for (const entry of inventory) {
      reported.add(entry.operationId)
      const row = store.operations.get(entry.operationId)
      if (row) continue
      if (store.operations.taskExists(entry.ref.taskId)) noteUnknown(machineId, entry)
      else if (entry.state === 'accepted' || entry.state === 'running')
        orphans.push({ operationId: entry.operationId, ref: entry.ref, order: 1 })
    }
    for (const row of store.operations.forMachine(machineId)) {
      if ((row.state !== 'accepted' && row.state !== 'running') || reported.has(row.id)) continue
      if (!row.command) continue
      log(`execution operation ${row.id} is missing on its execution Mac; held as uncertain`)
      store.operations.report({
        operationId: row.command.operationId,
        ref: row.command.ref,
        state: 'uncertain',
      })
    }
    return orphans
  }

  async function apply(
    machineId: string,
    reports: ExecutionReport[],
  ): Promise<ExecutionOperationId[]> {
    const confirmed: ExecutionOperationId[] = []
    const pending: ExecutionOperationId[] = []
    let changed = false
    for (const given of reports) {
      const report = redacted(given)
      if (report.refusal === 'limit' || report.refusal === 'disk') continue
      const row = store.operations.get(report.operationId)
      if (!row) {
        if (store.operations.taskExists(report.ref.taskId)) {
          changed = noteUnknown(machineId, report) || changed
        } else if (report.state !== 'accepted' && report.state !== 'running') {
          log(`execution operation ${report.operationId} reported for a deleted Task; cleared`)
          pending.push(report.operationId)
        }
        continue
      }
      if (row.state === 'unknown' || row.state === 'uncertain' || !row.command) continue
      if (row.machineId !== machineId || !sameExecutionRef(row.command.ref, report.ref)) {
        log(`execution operation ${row.id} reported with another assignment; not applied`)
        continue
      }
      if (terminal(row.state)) {
        if (terminal(report.state) && !isDeepStrictEqual(row.report, report))
          log(`execution operation ${row.id} reported a second, different outcome; first kept`)
        confirmed.push(report.operationId)
        continue
      }
      if (rank[report.state] <= rank[row.state]) continue
      store.operations.report(report)
      changed = true
      if (terminal(report.state)) pending.push(report.operationId)
    }
    if (changed) {
      await store.persisted()
      crashPoint('controller-after-report')
    }
    return [...confirmed, ...pending]
  }

  function outgoing(
    machineId: string,
    session: { stopsSent: Set<string>; orphans: ExecutionStop[] },
    canAccept: boolean,
  ): Pick<ExecutionSyncResponse, 'commands' | 'stops'> {
    const commands: ExecutionCommand[] = []
    const stops: ExecutionStop[] = session.orphans.splice(0)
    let bytes = 0
    const tasks = new Set<string>()
    for (const row of store.operations.forMachine(machineId)) {
      if (
        row.stopRequestedAt &&
        row.command &&
        !terminal(row.state) &&
        !held(row.state) &&
        !session.stopsSent.has(row.id)
      ) {
        session.stopsSent.add(row.id)
        stops.push({
          operationId: row.command.operationId,
          ref: row.command.ref,
          order: row.command.order,
        })
      }
      if (tasks.has(row.taskId)) continue
      tasks.add(row.taskId)
      const all = store.operations.forTask(row.taskId)
      if (all.some((r) => held(r.state))) continue
      const next = all.find((r) => r.machineId === machineId && r.state === 'issued')
      if (!canAccept || !next?.command || next.stopRequestedAt || unsaved.has(next.id)) continue
      const size = Buffer.byteLength(JSON.stringify(next.command))
      if (bytes + size > executionLimits.syncResponseBytes / 2) continue
      bytes += size
      commands.push(next.command)
    }
    return { commands, stops }
  }

  async function sync(
    grant: ExecutionGrant,
    request: ExecutionSyncRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionSyncResponse> {
    const machineId = grant.id
    let session = sessions.get(machineId)
    if (!session || session.id !== request.session) {
      session = { id: request.session, reconciled: false, stopsSent: new Set(), orphans: [] }
      sessions.set(machineId, session)
    }
    accepting.set(machineId, request.accepting)
    const first = !session.reconciled
    if (first) {
      if (!request.inventory)
        return { needInventory: true, reconciled: false, confirmed: [], commands: [], stops: [] }
      session.orphans = reconcile(machineId, request.inventory)
      await store.persisted()
      session.reconciled = true
    }
    const confirmed = await apply(machineId, request.reports)
    if (first)
      return {
        needInventory: false,
        reconciled: true,
        confirmed,
        commands: [],
        stops: outgoing(machineId, session, false).stops,
      }
    let out = outgoing(machineId, session, request.accepting === true)
    if (confirmed.length + out.commands.length + out.stops.length === 0) {
      await pause(machineId, signal)
      if (sessions.get(machineId) === session)
        out = outgoing(machineId, session, request.accepting === true)
    }
    return { needInventory: false, reconciled: true, confirmed, ...out }
  }

  return {
    async issue(input: IssueExecution): Promise<ExecutionCommand> {
      const operationId = executionIds.operation(input.operationId)
      const assignment = store.execution.assignment(input.taskId)
      if (!assignment) throw new RequestError(409, 'The Task has no execution assignment')
      const grant = grantFor(assignment.machineId)
      if (!grant) throw new RequestError(409, 'The Task is not assigned to a paired execution Mac')
      const scope = { factoryId: input.scope.factoryId, repo: input.scope.repo.toLowerCase() }
      if (!grant.scopes.some((s) => s.factoryId === scope.factoryId && s.repo === scope.repo))
        throw new RequestError(403, 'That repo is not approved for this execution Mac')
      const rows = store.operations.forTask(input.taskId)
      const { operationId: _, assignedAt: __, ...ref } = assignment
      const existing = store.operations.get(operationId)
      if (existing) {
        const same =
          existing.command &&
          sameExecutionRef(existing.command.ref, ref) &&
          isDeepStrictEqual(existing.command.scope, scope) &&
          isDeepStrictEqual(existing.command.input, input.input)
        if (!same || !existing.command)
          throw new RequestError(409, 'That operation ID is already used for other work')
        return existing.command
      }
      if (rows.some((r) => held(r.state)))
        throw new RequestError(409, 'The Task has an unresolved operation; new starts are held')
      const command = parseExecutionCommand({
        operationId,
        ref,
        scope,
        order: Math.max(0, ...rows.map((r) => r.position)) + 1,
        kind: 'probe',
        input: input.input,
      })
      unsaved.add(operationId)
      try {
        store.operations.issue(command)
        await store.persisted()
      } finally {
        unsaved.delete(operationId)
      }
      crashPoint('controller-after-issue')
      wake(assignment.machineId)
      return command
    },
    async stop(id: string): Promise<void> {
      const row = store.operations.get(id)
      if (!row) throw new RequestError(404, 'No such execution operation')
      if (terminal(row.state) || row.stopRequestedAt) return
      store.operations.requestStop(id)
      await store.persisted()
      wake(row.machineId)
    },
    sync(grant: ExecutionGrant, request: ExecutionSyncRequest, signal?: AbortSignal) {
      const previous = chains.get(grant.id) ?? Promise.resolve()
      const next = previous.then(
        () => sync(grant, request, signal),
        () => sync(grant, request, signal),
      )
      chains.set(
        grant.id,
        next.catch(() => undefined),
      )
      return next
    },
    operation: (id: string): StoredOperation | undefined => store.operations.get(id),
    summary(machineId: string, connected: boolean): MachineOperations | undefined {
      const rows = store.operations.forMachine(machineId)
      const refusing = accepting.get(machineId)
      const counts = {
        running: rows.filter((r) => r.state === 'running').length,
        unconfirmed: rows.filter((r) => !terminal(r.state) && !held(r.state)).length,
        stopsUnconfirmed: rows.filter(
          (r) => r.stopRequestedAt && !terminal(r.state) && !held(r.state),
        ).length,
        uncertain: rows.filter((r) => r.state === 'uncertain').length,
        unknown: rows.filter((r) => r.state === 'unknown').length,
        reconciling: connected && sessions.get(machineId)?.reconciled !== true,
        ...(connected && refusing !== undefined && refusing !== true && { refusing }),
      }
      const text = machineOperationsText(counts, connected)
      return text ? { ...counts, text } : undefined
    },
  }
}
export type ExecutionCommands = ReturnType<typeof createExecutionCommands>
