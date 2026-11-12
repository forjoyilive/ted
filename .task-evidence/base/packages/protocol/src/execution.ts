declare const executionId: unique symbol
type ExecutionId<Kind extends string> = string & { readonly [executionId]: Kind }

export type MachineId = ExecutionId<'machine'>
export type AssignmentId = ExecutionId<'assignment'>
export type ExecutionOperationId = ExecutionId<'operation'>
export type ReservationId = ExecutionId<'reservation'>
export type ExecutionHandleId = ExecutionId<'handle'>

function id<Kind extends string>(kind: Kind, value: string): ExecutionId<Kind> {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`invalid execution ${kind} ID`)
  }
  return value as ExecutionId<Kind>
}

export const executionIds = {
  machine: (value: string): MachineId => id('machine', value),
  assignment: (value: string): AssignmentId => id('assignment', value),
  operation: (value: string): ExecutionOperationId => id('operation', value),
  reservation: (value: string): ReservationId => id('reservation', value),
  handle: (value: string): ExecutionHandleId => id('handle', value),
}

export interface ExecutionRef {
  taskId: string
  machineId: MachineId
  assignmentId: AssignmentId
  generation: number
  reservationId: ReservationId
}

export interface TaskAssignment extends ExecutionRef {
  operationId: ExecutionOperationId
  assignedAt: string
}

export interface AssignTaskExecution {
  taskId: string
  machineId: MachineId
  assignmentId: AssignmentId
  reservationId: ReservationId
  operationId: ExecutionOperationId
  expectedGeneration: number
}

export type ExecutionOwnership = TaskAssignment | { machineId: MachineId; generation: 0 }

export interface ExecutionHandle extends ExecutionRef {
  id: ExecutionHandleId
}

export function executionHandle(value: ExecutionHandle): ExecutionHandle {
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 || !value.taskId) {
    throw new Error('invalid execution handle reference')
  }
  return {
    taskId: value.taskId,
    machineId: executionIds.machine(value.machineId),
    assignmentId: executionIds.assignment(value.assignmentId),
    generation: value.generation,
    reservationId: executionIds.reservation(value.reservationId),
    id: executionIds.handle(value.id),
  }
}
