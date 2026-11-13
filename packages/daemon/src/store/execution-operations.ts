import { queryDb, type Store } from '@livestore/livestore'
import type { ExecutionCommand, ExecutionOperationState, ExecutionReport } from '@ted/protocol'
import { events, executionOperations, type schema } from './schema.ts'

export type StoredOperationState = 'issued' | 'unknown' | ExecutionOperationState

export interface StoredOperation {
  id: string
  taskId: string
  machineId: string
  position: number
  state: StoredOperationState
  stopRequestedAt?: string
  command?: ExecutionCommand
  report?: ExecutionReport
  at: string
}

export function createOperationStore(
  store: Store<typeof schema>,
  commit: Store<typeof schema>['commit'],
  taskExists: (taskId: string) => boolean,
) {
  const rows = (where: { id: string } | { taskId: string } | { machineId: string }) =>
    store.query(queryDb(executionOperations.where(where)))
  const read = (row: ReturnType<typeof rows>[number] | undefined) =>
    row &&
    ({
      id: row.id,
      taskId: row.taskId,
      machineId: row.machineId,
      position: row.position,
      state: row.state as StoredOperationState,
      at: row.at,
      ...(row.stopRequestedAt && { stopRequestedAt: row.stopRequestedAt }),
      ...(row.command && { command: JSON.parse(row.command) as ExecutionCommand }),
      ...(row.report && { report: JSON.parse(row.report) as ExecutionReport }),
    } satisfies StoredOperation)
  const all = (where: { taskId: string } | { machineId: string }): StoredOperation[] =>
    rows(where)
      .flatMap((row) => read(row) ?? [])
      .sort((a, b) => a.position - b.position)
  return {
    taskExists,
    get: (id: string): StoredOperation | undefined => read(rows({ id })[0]),
    forTask: (taskId: string) => all({ taskId }),
    forMachine: (machineId: string) => all({ machineId }),
    issue(command: ExecutionCommand) {
      commit(
        events.executionOperationIssued({
          id: command.operationId,
          taskId: command.ref.taskId,
          machineId: command.ref.machineId,
          position: command.order,
          command: JSON.stringify(command),
          at: new Date().toISOString(),
        }),
      )
    },
    report(report: ExecutionReport) {
      commit(
        events.executionOperationReported({
          id: report.operationId,
          state: report.state,
          report: JSON.stringify(report),
          at: new Date().toISOString(),
        }),
      )
    },
    requestStop(id: string) {
      commit(events.executionStopRequested({ id, at: new Date().toISOString() }))
    },
    unknown(machineId: string, report: Pick<ExecutionReport, 'operationId' | 'ref' | 'state'>) {
      commit(
        events.executionOperationUnknown({
          id: report.operationId,
          taskId: report.ref.taskId,
          machineId,
          report: JSON.stringify(report),
          at: new Date().toISOString(),
        }),
      )
    },
  }
}
export type OperationStore = ReturnType<typeof createOperationStore>
