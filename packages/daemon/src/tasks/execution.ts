import { randomUUID } from 'node:crypto'
import { type AssignTaskExecution, type ExecutionRef, executionIds } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { TedStore } from '../store/index.ts'

export function createTaskExecution(store: Pick<TedStore, 'execution' | 'persisted'>) {
  return {
    assign(input: AssignTaskExecution) {
      return store.execution.assign(input)
    },
    require(ref: ExecutionRef) {
      return store.execution.require(ref)
    },
    async local(taskId: string) {
      const execution = store.execution
      const saved =
        execution.assignment(taskId) ??
        execution.assign({
          taskId,
          machineId: execution.localMachineId,
          assignmentId: executionIds.assignment(randomUUID()),
          reservationId: executionIds.reservation(randomUUID()),
          operationId: executionIds.operation(randomUUID()),
          expectedGeneration: 0,
        })
      if (saved.machineId !== execution.localMachineId) {
        throw new RequestError(409, 'Task execution belongs to another machine')
      }
      await store.persisted()
      return execution.require(saved)
    },
  }
}
