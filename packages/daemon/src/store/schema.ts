import { Events, makeSchema, Schema, State } from '@livestore/livestore'

export const tasks = State.SQLite.table({
  name: 'tasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    title: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

export const runs = State.SQLite.table({
  name: 'runs',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    agent: State.SQLite.text(),
    sessionId: State.SQLite.text(),
    prompt: State.SQLite.text(),
    cwd: State.SQLite.text(),
    state: State.SQLite.text(),
    readOffset: State.SQLite.integer(),
    startedAt: State.SQLite.text(),
  },
})

export const conversationEntries = State.SQLite.table({
  name: 'conversationEntries',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    runId: State.SQLite.text(),
    offset: State.SQLite.integer(),
    line: State.SQLite.text(),
  },
})

export const events = {
  taskCreated: Events.synced({
    name: 'v1.TaskCreated',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      title: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  runStarted: Events.synced({
    name: 'v1.RunStarted',
    schema: Schema.Struct({
      id: Schema.String,
      agent: Schema.String,
      sessionId: Schema.String,
      prompt: Schema.String,
      cwd: Schema.String,
      startedAt: Schema.String,
    }),
  }),
  runOutputRead: Events.synced({
    name: 'v1.RunOutputRead',
    schema: Schema.Struct({
      runId: Schema.String,
      toOffset: Schema.Number,
      entries: Schema.Array(Schema.Struct({ offset: Schema.Number, line: Schema.String })),
    }),
  }),
  runStateChanged: Events.synced({
    name: 'v1.RunStateChanged',
    schema: Schema.Struct({ runId: Schema.String, state: Schema.String, at: Schema.String }),
  }),
}

const materializers = State.SQLite.materializers(events, {
  'v1.TaskCreated': (task) => tasks.insert(task),
  'v1.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
  'v1.RunOutputRead': ({ runId, toOffset, entries }) => [
    runs.update({ readOffset: toOffset }).where({ id: runId }),
    ...entries.map(({ offset, line }) =>
      conversationEntries.insert({ id: `${runId}:${offset}`, runId, offset, line }),
    ),
  ],
  'v1.RunStateChanged': ({ runId, state }) => runs.update({ state }).where({ id: runId }),
})

const state = State.SQLite.makeState({
  tables: { tasks, runs, conversationEntries },
  materializers,
})

export const schema = makeSchema({ events, state })
