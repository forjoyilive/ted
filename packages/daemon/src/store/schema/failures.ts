import { Events, Schema, State } from '@livestore/livestore'

export const failureCases = State.SQLite.table({
  name: 'failureCases',
  indexes: [{ name: 'idx_failureCases_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    data: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const validationProgress = State.SQLite.table({
  name: 'validationProgress',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    data: State.SQLite.text(),
  },
})

export const failureContexts = State.SQLite.table({
  name: 'failureContexts',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    data: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const failuresEvents = {
  validationProgressed: Events.synced({
    name: 'v1.ValidationProgressed',
    schema: Schema.Struct({ taskId: Schema.String, data: Schema.String }),
  }),
  failureVerified: Events.synced({
    name: 'v1.FailureVerified',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureContextCaptured: Events.synced({
    name: 'v1.FailureContextCaptured',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureCaseRecorded: Events.synced({
    name: 'v1.FailureCaseRecorded',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureAssessed: Events.synced({
    name: 'v1.FailureAssessed',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureEvidenceAdded: Events.synced({
    name: 'v1.FailureEvidenceAdded',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureDecisionRequested: Events.synced({
    name: 'v1.FailureDecisionRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureRepairIncorporated: Events.synced({
    name: 'v1.FailureRepairIncorporated',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureResolved: Events.synced({
    name: 'v1.FailureResolved',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureFixChosen: Events.synced({
    name: 'v1.FailureFixChosen',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureAcceptanceInvalidated: Events.synced({
    name: 'v1.FailureAcceptanceInvalidated',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
}

export const failuresMaterializers = State.SQLite.materializers(failuresEvents, {
  'v1.ValidationProgressed': (row) =>
    validationProgress.insert(row).onConflict('taskId', 'replace'),
  'v1.FailureVerified': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureContextCaptured': (row) => failureContexts.insert(row).onConflict('id', 'replace'),
  'v1.FailureCaseRecorded': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureAssessed': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureEvidenceAdded': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureDecisionRequested': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureRepairIncorporated': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureResolved': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureFixChosen': (row) => failureCases.insert(row).onConflict('id', 'replace'),
  'v1.FailureAcceptanceInvalidated': (row) => failureCases.insert(row).onConflict('id', 'replace'),
})
