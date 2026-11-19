import { Events, Schema, State } from '@livestore/livestore'
import { comments } from './requests.ts'

export const taskBrowserCaptures = State.SQLite.table({
  name: 'taskBrowserCaptures',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    hash: State.SQLite.text(),
    name: State.SQLite.text(),
    size: State.SQLite.integer(),
    mediaType: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const runBrowserCaptures = State.SQLite.table({
  name: 'runBrowserCaptures',
  indexes: [{ name: 'idx_runBrowserCaptures_runId', columns: ['runId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    runId: State.SQLite.text(),
    automationId: State.SQLite.text(),
    hash: State.SQLite.text(),
    name: State.SQLite.text(),
    size: State.SQLite.integer(),
    mediaType: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const appsEvents = {
  appStarted: Events.synced({
    name: 'v1.AppStarted',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      port: Schema.NullOr(Schema.Number),
      url: Schema.NullOr(Schema.String),
      by: Schema.String,
      runId: Schema.NullOr(Schema.String),
      restart: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  appStopped: Events.synced({
    name: 'v1.AppStopped',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      at: Schema.String,
    }),
  }),
  appExited: Events.synced({
    name: 'v1.AppExited',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      code: Schema.NullOr(Schema.Number),
      signal: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  simulatorRequested: Events.synced({
    name: 'v1.SimulatorRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      runId: Schema.String,
      stage: Schema.NullOr(Schema.String),
      title: Schema.String,
      body: Schema.String,
      simulator: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  simulatorShutDown: Events.synced({
    name: 'v1.SimulatorShutDown',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      forTask: Schema.NullOr(Schema.String),
      idle: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  emulatorShutDown: Events.synced({
    name: 'v1.EmulatorShutDown',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      forTask: Schema.NullOr(Schema.String),
      idle: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  appStartFailed: Events.synced({
    name: 'v1.AppStartFailed',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      problem: Schema.String,
      at: Schema.String,
    }),
  }),
  taskBrowserCaptureAdded: Events.synced({
    name: 'v1.TaskBrowserCaptureAdded',
    schema: Schema.Struct({
      taskId: Schema.String,
      hash: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      mediaType: Schema.String,
      at: Schema.String,
    }),
  }),
  runBrowserCaptureAdded: Events.synced({
    name: 'v1.RunBrowserCaptureAdded',
    schema: Schema.Struct({
      runId: Schema.String,
      automationId: Schema.String,
      hash: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      mediaType: Schema.String,
      at: Schema.String,
    }),
  }),
}

export const appsMaterializers = State.SQLite.materializers(appsEvents, {
  'v1.AppStarted': () => [],
  'v1.AppStopped': () => [],
  'v1.AppExited': () => [],
  'v1.AppStartFailed': () => [],
  'v1.SimulatorShutDown': () => [],
  'v1.EmulatorShutDown': () => [],
  'v1.SimulatorRequested': ({ runId, simulator, ...comment }) =>
    comments.insert({
      ...comment,
      kind: 'permission',
      authorKind: 'run',
      authorRunId: runId,
      simulator,
    }),
  'v1.TaskBrowserCaptureAdded': ({ taskId, hash, name, ...rest }) =>
    taskBrowserCaptures
      .insert({ id: `${taskId}:${hash}:${name}`, taskId, hash, name, ...rest })
      .onConflict('id', 'ignore'),
  'v1.RunBrowserCaptureAdded': ({ runId, hash, name, ...rest }) =>
    runBrowserCaptures
      .insert({ id: `${runId}:${hash}:${name}`, runId, hash, name, ...rest })
      .onConflict('id', 'ignore'),
})
