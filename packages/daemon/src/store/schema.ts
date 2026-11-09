import { Events, makeSchema, Schema, State } from '@livestore/livestore'

export const factories = State.SQLite.table({
  name: 'factories',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    key: State.SQLite.text(),
    name: State.SQLite.text(),
    repo: State.SQLite.text(),
    cloneUrl: State.SQLite.text(),
    defaultBranch: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

export const tasks = State.SQLite.table({
  name: 'tasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    title: State.SQLite.text(),
    stage: State.SQLite.text({ default: 'backlog' }),
    branch: State.SQLite.text({ nullable: true }),
    worktree: State.SQLite.text({ nullable: true }),
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
    taskId: State.SQLite.text({ nullable: true }),
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

export const comments = State.SQLite.table({
  name: 'comments',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    kind: State.SQLite.text(),
    body: State.SQLite.text(),
    authorRunId: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

const runStartedFields = {
  id: Schema.String,
  agent: Schema.String,
  sessionId: Schema.String,
  prompt: Schema.String,
  cwd: Schema.String,
  startedAt: Schema.String,
}

export const events = {
  factoryAdded: Events.synced({
    name: 'v1.FactoryAdded',
    schema: Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      repo: Schema.String,
      cloneUrl: Schema.String,
      defaultBranch: Schema.String,
      createdAt: Schema.String,
    }),
  }),
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
  taskStarted: Events.synced({
    name: 'v1.TaskStarted',
    schema: Schema.Struct({
      taskId: Schema.String,
      stage: Schema.String,
      branch: Schema.String,
      worktree: Schema.String,
      at: Schema.String,
    }),
  }),
  taskStageChanged: Events.synced({
    name: 'v1.TaskStageChanged',
    schema: Schema.Struct({ taskId: Schema.String, stage: Schema.String, at: Schema.String }),
  }),
  commentPosted: Events.synced({
    name: 'v1.CommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      authorRunId: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  runStarted: Events.synced({
    name: 'v1.RunStarted',
    schema: Schema.Struct(runStartedFields),
  }),
  runStartedV2: Events.synced({
    name: 'v2.RunStarted',
    schema: Schema.Struct({ ...runStartedFields, taskId: Schema.NullOr(Schema.String) }),
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
  runSessionIdentified: Events.synced({
    name: 'v1.RunSessionIdentified',
    schema: Schema.Struct({ runId: Schema.String, sessionId: Schema.String }),
  }),
}

const materializers = State.SQLite.materializers(events, {
  'v1.FactoryAdded': (factory) => factories.insert(factory),
  'v1.TaskCreated': (task) => tasks.insert({ ...task, stage: 'backlog' }),
  'v1.TaskStarted': ({ taskId, stage, branch, worktree }) =>
    tasks.update({ stage, branch, worktree }).where({ id: taskId }),
  'v1.TaskStageChanged': ({ taskId, stage }) => tasks.update({ stage }).where({ id: taskId }),
  'v1.CommentPosted': (comment) => comments.insert(comment),
  'v1.RunStarted': (run) => runs.insert({ ...run, taskId: null, state: 'working', readOffset: 0 }),
  'v2.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
  'v1.RunOutputRead': ({ runId, toOffset, entries }) => [
    runs.update({ readOffset: toOffset }).where({ id: runId }),
    ...entries.map(({ offset, line }) =>
      conversationEntries.insert({ id: `${runId}:${offset}`, runId, offset, line }),
    ),
  ],
  'v1.RunStateChanged': ({ runId, state }) => runs.update({ state }).where({ id: runId }),
  'v1.RunSessionIdentified': ({ runId, sessionId }) =>
    runs.update({ sessionId }).where({ id: runId }),
})

const state = State.SQLite.makeState({
  tables: { factories, tasks, runs, conversationEntries, comments },
  materializers,
})

export const schema = makeSchema({ events, state })
