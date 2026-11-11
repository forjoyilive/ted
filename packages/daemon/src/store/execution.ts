import { randomUUID } from 'node:crypto'
import { queryDb, type Store } from '@livestore/livestore'
import {
  type AssignTaskExecution,
  type ExecutionOwnership,
  type ExecutionRef,
  executionIds,
  type MachineId,
  type TaskAssignment,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { events, executionAssignments, executionMachine, type schema } from './schema.ts'

export interface ExecutionStore {
  readonly localMachineId: MachineId
  assignment(taskId: string): TaskAssignment | undefined
  ownership(taskId: string): ExecutionOwnership
  assign(input: AssignTaskExecution): TaskAssignment
  require(ref: ExecutionRef): TaskAssignment
}

export function createExecutionStore({
  store,
  commit,
  task,
}: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  task(id: string): { started: boolean } | undefined
}): ExecutionStore {
  const known = store.query(queryDb(executionMachine.where({ id: 'local' })))[0]
  const localMachineId = executionIds.machine(known?.machineId ?? randomUUID())
  if (!known) {
    commit(
      events.localMachineIdentified({ machineId: localMachineId, at: new Date().toISOString() }),
    )
  }

  const exists = (taskId: string) => {
    const found = task(taskId)
    if (!found) throw new RequestError(404, 'no Task for execution assignment')
    return found
  }
  const assignment = (taskId: string): TaskAssignment | undefined => {
    const row = store.query(queryDb(executionAssignments.where({ taskId })))[0]
    return (
      row && {
        taskId: row.taskId,
        machineId: executionIds.machine(row.machineId),
        assignmentId: executionIds.assignment(row.assignmentId),
        reservationId: executionIds.reservation(row.reservationId),
        operationId: executionIds.operation(row.operationId),
        generation: row.generation,
        assignedAt: row.assignedAt,
      }
    )
  }
  const conflict = (): never => {
    throw new RequestError(409, 'execution assignment conflicts with current ownership')
  }

  return {
    localMachineId,
    assignment,
    ownership(taskId) {
      exists(taskId)
      return assignment(taskId) ?? { machineId: localMachineId, generation: 0 }
    },
    assign(input) {
      const found = exists(input.taskId)
      executionIds.machine(input.machineId)
      executionIds.assignment(input.assignmentId)
      executionIds.reservation(input.reservationId)
      executionIds.operation(input.operationId)
      if (input.expectedGeneration !== 0) conflict()
      const previous = assignment(input.taskId)
      if (previous) {
        if (
          previous.machineId === input.machineId &&
          previous.assignmentId === input.assignmentId &&
          previous.operationId === input.operationId &&
          previous.reservationId === input.reservationId
        )
          return previous
        conflict()
      }
      if (found.started && input.machineId !== localMachineId) conflict()
      const reused = store
        .query(queryDb(executionAssignments))
        .some(
          (row) =>
            row.assignmentId === input.assignmentId ||
            row.reservationId === input.reservationId ||
            row.operationId === input.operationId,
        )
      if (reused) conflict()
      const saved: TaskAssignment = {
        taskId: input.taskId,
        machineId: input.machineId,
        assignmentId: input.assignmentId,
        reservationId: input.reservationId,
        operationId: input.operationId,
        generation: 1,
        assignedAt: new Date().toISOString(),
      }
      commit(events.taskExecutionAssigned(saved))
      return saved
    },
    require(ref) {
      exists(ref.taskId)
      const saved = assignment(ref.taskId)
      if (
        !saved ||
        ref.generation !== saved.generation ||
        ref.machineId !== saved.machineId ||
        ref.assignmentId !== saved.assignmentId ||
        ref.reservationId !== saved.reservationId
      )
        return conflict()
      return saved
    },
  }
}
