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

export const machineSettings = State.SQLite.table({
  name: 'machineSettings',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    appearance: State.SQLite.text(),
  },
})

export const stageEntries = State.SQLite.table({
  name: 'stageEntries',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    stage: State.SQLite.text(),
    stageFileLayer: State.SQLite.text({ nullable: true }),
    stageFilePath: State.SQLite.text({ nullable: true }),
    layers: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const workflowLayers = State.SQLite.table({
  name: 'workflowLayers',
  columns: {
    layer: State.SQLite.text({ primaryKey: true }),
    files: State.SQLite.text(),
    version: State.SQLite.text(),
    acceptedAt: State.SQLite.text(),
  },
})

export const taskRepos = State.SQLite.table({
  name: 'taskRepos',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    name: State.SQLite.text(),
    repo: State.SQLite.text(),
    branch: State.SQLite.text(),
    worktree: State.SQLite.text(),
    copied: State.SQLite.text(),
    skipped: State.SQLite.text(),
    setupCommand: State.SQLite.text({ nullable: true }),
    setupTimeoutMs: State.SQLite.integer({ nullable: true }),
    setupEnv: State.SQLite.text({ nullable: true }),
    setupState: State.SQLite.text({ nullable: true }),
    setupExitCode: State.SQLite.integer({ nullable: true }),
    teardownCommand: State.SQLite.text({ nullable: true }),
    teardownOutcome: State.SQLite.text({ nullable: true }),
    removedAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const localFolders = State.SQLite.table({
  name: 'localFolders',
  columns: {
    repo: State.SQLite.text({ primaryKey: true }),
    path: State.SQLite.text(),
    setAt: State.SQLite.text(),
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
  taskStageEntered: Events.synced({
    name: 'v1.TaskStageEntered',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      stage: Schema.String,
      stageFileLayer: Schema.NullOr(Schema.String),
      stageFilePath: Schema.NullOr(Schema.String),
      layers: Schema.String,
      at: Schema.String,
    }),
  }),
  workflowLayerAccepted: Events.synced({
    name: 'v1.WorkflowLayerAccepted',
    schema: Schema.Struct({
      layer: Schema.String,
      files: Schema.String,
      version: Schema.String,
      at: Schema.String,
    }),
  }),
  taskWorktreeCreated: Events.synced({
    name: 'v1.TaskWorktreeCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      repo: Schema.String,
      branch: Schema.String,
      worktree: Schema.String,
      copied: Schema.Array(Schema.String),
      skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
      at: Schema.String,
    }),
  }),
  taskWorktreeSetupStarted: Events.synced({
    name: 'v1.TaskWorktreeSetupStarted',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      command: Schema.String,
      timeoutMs: Schema.Number,
      env: Schema.String,
      at: Schema.String,
    }),
  }),
  taskWorktreeSetupFinished: Events.synced({
    name: 'v1.TaskWorktreeSetupFinished',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      outcome: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      at: Schema.String,
    }),
  }),
  taskWorktreeRemoved: Events.synced({
    name: 'v1.TaskWorktreeRemoved',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      teardownCommand: Schema.NullOr(Schema.String),
      teardownOutcome: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  localFolderSet: Events.synced({
    name: 'v1.LocalFolderSet',
    schema: Schema.Struct({ repo: Schema.String, path: Schema.String, at: Schema.String }),
  }),
  runStateChanged: Events.synced({
    name: 'v1.RunStateChanged',
    schema: Schema.Struct({ runId: Schema.String, state: Schema.String, at: Schema.String }),
  }),
  appearanceChanged: Events.synced({
    name: 'v1.AppearanceChanged',
    schema: Schema.Struct({ appearance: Schema.String, at: Schema.String }),
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
  'v1.TaskStageEntered': (entry) => stageEntries.insert(entry),
  'v1.TaskWorktreeCreated': ({ taskId, name, copied, skipped, at, ...row }) =>
    taskRepos
      .insert({
        ...row,
        id: `${taskId}:${name}`,
        taskId,
        name,
        copied: JSON.stringify(copied),
        skipped: JSON.stringify(skipped),
        createdAt: at,
      })
      .onConflict('id', 'replace'),
  'v1.TaskWorktreeSetupStarted': ({ taskId, name, command, timeoutMs, env }) =>
    taskRepos
      .update({
        setupCommand: command,
        setupTimeoutMs: timeoutMs,
        setupEnv: env,
        setupState: 'running',
        setupExitCode: null,
      })
      .where({ id: `${taskId}:${name}` }),
  'v1.TaskWorktreeSetupFinished': ({ taskId, name, outcome, exitCode }) =>
    taskRepos
      .update({ setupState: outcome, setupExitCode: exitCode })
      .where({ id: `${taskId}:${name}` }),
  'v1.TaskWorktreeRemoved': ({ taskId, name, teardownCommand, teardownOutcome, at }) => [
    taskRepos
      .update({ teardownCommand, teardownOutcome, removedAt: at })
      .where({ id: `${taskId}:${name}` }),
    tasks.update({ worktree: null }).where({ id: taskId }),
  ],
  'v1.LocalFolderSet': ({ repo, path, at }) =>
    localFolders.insert({ repo, path, setAt: at }).onConflict('repo', 'replace'),
  'v1.WorkflowLayerAccepted': ({ layer, files, version, at }) =>
    workflowLayers.insert({ layer, files, version, acceptedAt: at }).onConflict('layer', 'replace'),
  'v1.AppearanceChanged': ({ appearance }) =>
    machineSettings.insert({ id: 'machine', appearance }).onConflict('id', 'replace'),
})

const state = State.SQLite.makeState({
  tables: {
    factories,
    tasks,
    runs,
    conversationEntries,
    comments,
    stageEntries,
    workflowLayers,
    taskRepos,
    localFolders,
    machineSettings,
  },
  materializers,
})

export const schema = makeSchema({ events, state })
