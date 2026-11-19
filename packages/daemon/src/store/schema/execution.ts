import { Events, Schema, State } from '@livestore/livestore'

export const executionPairing = State.SQLite.table({
  name: 'executionPairing',
  columns: { id: State.SQLite.text({ primaryKey: true }), data: State.SQLite.text() },
})

export const executionMachine = State.SQLite.table({
  name: 'executionMachine',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    machineId: State.SQLite.text(),
  },
})

export const executionAssignments = State.SQLite.table({
  name: 'executionAssignments',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    machineId: State.SQLite.text(),
    assignmentId: State.SQLite.text(),
    generation: State.SQLite.integer(),
    reservationId: State.SQLite.text(),
    operationId: State.SQLite.text(),
    assignedAt: State.SQLite.text(),
  },
})

export const executionOperations = State.SQLite.table({
  name: 'executionOperations',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    machineId: State.SQLite.text(),
    position: State.SQLite.integer(),
    state: State.SQLite.text(),
    stopRequestedAt: State.SQLite.text({ nullable: true }),
    command: State.SQLite.text(),
    report: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const executionEvents = {
  executionControllerConfigured: Events.synced({
    name: 'v1.ExecutionControllerConfigured',
    schema: Schema.Struct({ data: Schema.String }),
  }),
  executionMachineApproved: Events.synced({
    name: 'v1.ExecutionMachineApproved',
    schema: Schema.Struct({ id: Schema.String, data: Schema.String }),
  }),
  executionMachineRevoked: Events.synced({
    name: 'v1.ExecutionMachineRevoked',
    schema: Schema.Struct({ id: Schema.String, data: Schema.String }),
  }),
  localMachineIdentified: Events.synced({
    name: 'v1.LocalMachineIdentified',
    schema: Schema.Struct({ machineId: Schema.String, at: Schema.String }),
  }),
  taskExecutionAssigned: Events.synced({
    name: 'v1.TaskExecutionAssigned',
    schema: Schema.Struct({
      taskId: Schema.String,
      machineId: Schema.String,
      assignmentId: Schema.String,
      generation: Schema.Number,
      reservationId: Schema.String,
      operationId: Schema.String,
      assignedAt: Schema.String,
    }),
  }),
  taskExecutionForgotten: Events.synced({
    name: 'v1.TaskExecutionForgotten',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  executionOperationIssued: Events.synced({
    name: 'v1.ExecutionOperationIssued',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      machineId: Schema.String,
      position: Schema.Number,
      command: Schema.String,
      at: Schema.String,
    }),
  }),
  executionOperationReported: Events.synced({
    name: 'v1.ExecutionOperationReported',
    schema: Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      report: Schema.String,
      at: Schema.String,
    }),
  }),
  executionStopRequested: Events.synced({
    name: 'v1.ExecutionStopRequested',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  executionOperationUnknown: Events.synced({
    name: 'v1.ExecutionOperationUnknown',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      machineId: Schema.String,
      report: Schema.String,
      at: Schema.String,
    }),
  }),
  executionOperationsForgotten: Events.synced({
    name: 'v1.ExecutionOperationsForgotten',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
}

export const executionMaterializers = State.SQLite.materializers(executionEvents, {
  'v1.ExecutionControllerConfigured': ({ data }) =>
    executionPairing.insert({ id: 'controller', data }).onConflict('id', 'replace'),
  'v1.ExecutionMachineApproved': ({ id, data }) =>
    executionPairing.insert({ id, data }).onConflict('id', 'ignore'),
  'v1.ExecutionMachineRevoked': ({ id, data }) => executionPairing.update({ data }).where({ id }),
  'v1.LocalMachineIdentified': ({ machineId }) =>
    executionMachine.insert({ id: 'local', machineId }).onConflict('id', 'ignore'),
  'v1.TaskExecutionAssigned': (assignment) =>
    executionAssignments.insert(assignment).onConflict('taskId', 'ignore'),
  'v1.TaskExecutionForgotten': ({ taskId }) => executionAssignments.delete().where({ taskId }),
  'v1.ExecutionOperationIssued': ({ id, taskId, machineId, position, command, at }) =>
    executionOperations
      .insert({
        id,
        taskId,
        machineId,
        position,
        state: 'issued',
        stopRequestedAt: null,
        command,
        report: null,
        at,
      })
      .onConflict('id', 'ignore'),
  'v1.ExecutionOperationReported': ({ id, state, report }) =>
    executionOperations.update({ state, report }).where({ id }),
  'v1.ExecutionStopRequested': ({ id, at }) =>
    executionOperations.update({ stopRequestedAt: at }).where({ id }),
  'v1.ExecutionOperationUnknown': ({ id, taskId, machineId, report, at }) =>
    executionOperations
      .insert({
        id,
        taskId,
        machineId,
        position: 0,
        state: 'unknown',
        stopRequestedAt: null,
        command: '',
        report,
        at,
      })
      .onConflict('id', 'ignore'),
  'v1.ExecutionOperationsForgotten': ({ taskId }) => executionOperations.delete().where({ taskId }),
})
