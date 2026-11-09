import { Events, makeSchema, Schema, State } from '@livestore/livestore'
import { counted } from './progress.ts'

export const factories = State.SQLite.table({
  name: 'factories',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    key: State.SQLite.text(),
    name: State.SQLite.text(),
    repo: State.SQLite.text(),
    cloneUrl: State.SQLite.text(),
    defaultBranch: State.SQLite.text(),
    showTutorial: State.SQLite.boolean({ default: false }),
    clonedAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const factoryRepos = State.SQLite.table({
  name: 'factoryRepos',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    position: State.SQLite.integer(),
    repo: State.SQLite.text(),
    name: State.SQLite.text(),
    cloneUrl: State.SQLite.text(),
  },
})

export const tasks = State.SQLite.table({
  name: 'tasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    title: State.SQLite.text(),
    description: State.SQLite.text({ default: '' }),
    priority: State.SQLite.text({ default: 'none' }),
    clarifyDepth: State.SQLite.text({ default: 'auto' }),
    leadAgent: State.SQLite.text({ nullable: true }),
    leadModel: State.SQLite.text({ nullable: true }),
    leadEffort: State.SQLite.text({ nullable: true }),
    startRequested: State.SQLite.boolean({ default: false }),
    waitsForBlockers: State.SQLite.boolean({ default: false }),
    stage: State.SQLite.text({ default: 'backlog' }),
    branch: State.SQLite.text({ nullable: true }),
    worktree: State.SQLite.text({ nullable: true }),
    activity: State.SQLite.text({ nullable: true }),
    activityEntries: State.SQLite.integer({ nullable: true }),
    rank: State.SQLite.real({ nullable: true }),
    changedAt: State.SQLite.text({ nullable: true }),
    archivedAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const taskQueue = State.SQLite.table({
  name: 'taskQueue',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    rank: State.SQLite.real(),
    queuedAt: State.SQLite.text(),
  },
})

export const taskBlockers = State.SQLite.table({
  name: 'taskBlockers',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    blockerId: State.SQLite.text(),
    setByRunId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const taskAttachments = State.SQLite.table({
  name: 'taskAttachments',
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

export const taskSources = State.SQLite.table({
  name: 'taskSources',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    url: State.SQLite.text(),
    linearIdentifier: State.SQLite.text({ nullable: true }),
    linearTitle: State.SQLite.text({ nullable: true }),
    linearBranchName: State.SQLite.text({ nullable: true }),
    linearDescription: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const runs = State.SQLite.table({
  name: 'runs',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    agent: State.SQLite.text(),
    sessionId: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    usesDefaultModel: State.SQLite.boolean({ default: false }),
    problem: State.SQLite.text({ nullable: true }),
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
    authorKind: State.SQLite.text({ default: 'run' }),
    authorRunId: State.SQLite.text({ nullable: true }),
    stage: State.SQLite.text({ nullable: true }),
    title: State.SQLite.text({ nullable: true }),
    choices: State.SQLite.text({ nullable: true }),
    gate: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const taskBriefs = State.SQLite.table({
  name: 'taskBriefs',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    version: State.SQLite.integer(),
    text: State.SQLite.text(),
    stage: State.SQLite.text(),
    runId: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const sendBacks = State.SQLite.table({
  name: 'sendBacks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    fromStage: State.SQLite.text(),
    toStage: State.SQLite.text(),
    findings: State.SQLite.text(),
    counted: State.SQLite.boolean(),
    round: State.SQLite.integer({ nullable: true }),
    limit: State.SQLite.integer({ nullable: true }),
    checkRunId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const checkRuns = State.SQLite.table({
  name: 'checkRuns',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    trigger: State.SQLite.text(),
    stage: State.SQLite.text(),
    startedAt: State.SQLite.text(),
    finishedAt: State.SQLite.text({ nullable: true }),
    outcome: State.SQLite.text({ nullable: true }),
  },
})

export const checkResults = State.SQLite.table({
  name: 'checkResults',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    checkRunId: State.SQLite.text(),
    position: State.SQLite.integer(),
    name: State.SQLite.text(),
    repo: State.SQLite.text({ nullable: true }),
    command: State.SQLite.text(),
    timeout: State.SQLite.text(),
    builtIn: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    exitCode: State.SQLite.integer({ nullable: true }),
    durationMs: State.SQLite.integer({ nullable: true }),
  },
})

export const sendBackResets = State.SQLite.table({
  name: 'sendBackResets',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    stage: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const machineSettings = State.SQLite.table({
  name: 'machineSettings',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    appearance: State.SQLite.text(),
  },
})

export const machineSettingValues = State.SQLite.table({
  name: 'machineSettingValues',
  columns: {
    name: State.SQLite.text({ primaryKey: true }),
    value: State.SQLite.text(),
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
    order: State.SQLite.text({ nullable: true }),
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

export const banners = State.SQLite.table({
  name: 'banners',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    problem: State.SQLite.text(),
    severity: State.SQLite.text(),
    factoryId: State.SQLite.text({ nullable: true }),
    text: State.SQLite.text(),
    action: State.SQLite.text({ nullable: true }),
    raisedAt: State.SQLite.text(),
    dismissedUntil: State.SQLite.text({ nullable: true }),
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

export const agentPauses = State.SQLite.table({
  name: 'agentPauses',
  columns: {
    agent: State.SQLite.text({ primaryKey: true }),
    reason: State.SQLite.text(),
    since: State.SQLite.text(),
  },
})

export const heldRuns = State.SQLite.table({
  name: 'heldRuns',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    agent: State.SQLite.text(),
    sessionId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

const stageEnteredFields = {
  id: Schema.String,
  taskId: Schema.String,
  stage: Schema.String,
  stageFileLayer: Schema.NullOr(Schema.String),
  stageFilePath: Schema.NullOr(Schema.String),
  layers: Schema.String,
  at: Schema.String,
}

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
  factoryAddedV2: Events.synced({
    name: 'v2.FactoryAdded',
    schema: Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      repos: Schema.Array(
        Schema.Struct({ repo: Schema.String, name: Schema.String, cloneUrl: Schema.String }),
      ),
      defaultBranch: Schema.String,
      showTutorial: Schema.Boolean,
      createdAt: Schema.String,
    }),
  }),
  factoryCloned: Events.synced({
    name: 'v1.FactoryCloned',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
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
  taskCreatedV2: Events.synced({
    name: 'v2.TaskCreated',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      title: Schema.String,
      description: Schema.String,
      priority: Schema.String,
      clarifyDepth: Schema.String,
      leadAgent: Schema.NullOr(Schema.String),
      leadModel: Schema.NullOr(Schema.String),
      leadEffort: Schema.NullOr(Schema.String),
      startRequested: Schema.Boolean,
      createdAt: Schema.String,
    }),
  }),
  taskBlockerAdded: Events.synced({
    name: 'v1.TaskBlockerAdded',
    schema: Schema.Struct({ taskId: Schema.String, blockerId: Schema.String, at: Schema.String }),
  }),
  taskBlockerAddedV2: Events.synced({
    name: 'v2.TaskBlockerAdded',
    schema: Schema.Struct({
      taskId: Schema.String,
      blockerId: Schema.String,
      runId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskBlockerRemoved: Events.synced({
    name: 'v1.TaskBlockerRemoved',
    schema: Schema.Struct({
      taskId: Schema.String,
      blockerId: Schema.String,
      runId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskStartRequestChanged: Events.synced({
    name: 'v1.TaskStartRequestChanged',
    schema: Schema.Struct({
      taskId: Schema.String,
      startRequested: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  taskWaitingForBlockers: Events.synced({
    name: 'v1.TaskWaitingForBlockers',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskRequeuedAfterBlockers: Events.synced({
    name: 'v1.TaskRequeuedAfterBlockers',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskAttachmentAdded: Events.synced({
    name: 'v1.TaskAttachmentAdded',
    schema: Schema.Struct({
      taskId: Schema.String,
      hash: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      mediaType: Schema.String,
      at: Schema.String,
    }),
  }),
  taskSourceSet: Events.synced({
    name: 'v1.TaskSourceSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      url: Schema.String,
      linearIdentifier: Schema.NullOr(Schema.String),
      linearTitle: Schema.NullOr(Schema.String),
      linearBranchName: Schema.NullOr(Schema.String),
      linearDescription: Schema.NullOr(Schema.String),
      at: Schema.String,
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
  taskQueued: Events.synced({
    name: 'v1.TaskQueued',
    schema: Schema.Struct({
      taskId: Schema.String,
      stage: Schema.String,
      rank: Schema.Number,
      at: Schema.String,
    }),
  }),
  taskDequeued: Events.synced({
    name: 'v1.TaskDequeued',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskMovedToBacklog: Events.synced({
    name: 'v1.TaskMovedToBacklog',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskRanked: Events.synced({
    name: 'v1.TaskRanked',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskPriorityChanged: Events.synced({
    name: 'v1.TaskPriorityChanged',
    schema: Schema.Struct({ taskId: Schema.String, priority: Schema.String, at: Schema.String }),
  }),
  taskArchived: Events.synced({
    name: 'v1.TaskArchived',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
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
  commentPostedV2: Events.synced({
    name: 'v2.CommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      authorKind: Schema.String,
      authorRunId: Schema.NullOr(Schema.String),
      stage: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
      choices: Schema.NullOr(Schema.Array(Schema.String)),
      gate: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  commentAnswered: Events.synced({
    name: 'v1.CommentAnswered',
    schema: Schema.Struct({ id: Schema.String, answer: Schema.String, at: Schema.String }),
  }),
  taskBriefWritten: Events.synced({
    name: 'v1.TaskBriefWritten',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      version: Schema.Number,
      text: Schema.String,
      stage: Schema.String,
      runId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskSentBack: Events.synced({
    name: 'v1.TaskSentBack',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      counted: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  taskSentBackV2: Events.synced({
    name: 'v2.TaskSentBack',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      counted: Schema.Boolean,
      round: Schema.NullOr(Schema.Number),
      limit: Schema.NullOr(Schema.Number),
      checkRunId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  checksStarted: Events.synced({
    name: 'v1.ChecksStarted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      checks: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          repo: Schema.NullOr(Schema.String),
          command: Schema.String,
          timeout: Schema.String,
          builtIn: Schema.NullOr(Schema.String),
          state: Schema.String,
        }),
      ),
      at: Schema.String,
    }),
  }),
  checkStarted: Events.synced({
    name: 'v1.CheckStarted',
    schema: Schema.Struct({
      checkRunId: Schema.String,
      position: Schema.Number,
      at: Schema.String,
    }),
  }),
  checkFinished: Events.synced({
    name: 'v1.CheckFinished',
    schema: Schema.Struct({
      checkRunId: Schema.String,
      position: Schema.Number,
      state: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      durationMs: Schema.Number,
      at: Schema.String,
    }),
  }),
  checksFinished: Events.synced({
    name: 'v1.ChecksFinished',
    schema: Schema.Struct({ checkRunId: Schema.String, outcome: Schema.String, at: Schema.String }),
  }),
  sendBackCountReset: Events.synced({
    name: 'v1.SendBackCountReset',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      stage: Schema.String,
      at: Schema.String,
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
    schema: Schema.Struct(stageEnteredFields),
  }),
  taskStageEnteredV2: Events.synced({
    name: 'v2.TaskStageEntered',
    schema: Schema.Struct({ ...stageEnteredFields, order: Schema.String }),
  }),
  taskActivitySet: Events.synced({
    name: 'v1.TaskActivitySet',
    schema: Schema.Struct({
      taskId: Schema.String,
      text: Schema.String,
      runId: Schema.NullOr(Schema.String),
      stageEntries: Schema.Number,
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
  machineSettingsChanged: Events.synced({
    name: 'v1.MachineSettingsChanged',
    schema: Schema.Struct({ changes: Schema.String, at: Schema.String }),
  }),
  bannerRaised: Events.synced({
    name: 'v1.BannerRaised',
    schema: Schema.Struct({
      id: Schema.String,
      problem: Schema.String,
      severity: Schema.String,
      factoryId: Schema.NullOr(Schema.String),
      text: Schema.String,
      action: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  bannerDismissed: Events.synced({
    name: 'v1.BannerDismissed',
    schema: Schema.Struct({ id: Schema.String, until: Schema.String, at: Schema.String }),
  }),
  bannerCleared: Events.synced({
    name: 'v1.BannerCleared',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  agentPaused: Events.synced({
    name: 'v1.AgentPaused',
    schema: Schema.Struct({ agent: Schema.String, reason: Schema.String, at: Schema.String }),
  }),
  agentResumed: Events.synced({
    name: 'v1.AgentResumed',
    schema: Schema.Struct({ agent: Schema.String, at: Schema.String }),
  }),
  taskRunHeld: Events.synced({
    name: 'v1.TaskRunHeld',
    schema: Schema.Struct({
      taskId: Schema.String,
      agent: Schema.String,
      sessionId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskRunReleased: Events.synced({
    name: 'v1.TaskRunReleased',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  runSessionIdentified: Events.synced({
    name: 'v1.RunSessionIdentified',
    schema: Schema.Struct({ runId: Schema.String, sessionId: Schema.String }),
  }),
  taskLeadSet: Events.synced({
    name: 'v1.TaskLeadSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  runStartedV3: Events.synced({
    name: 'v3.RunStarted',
    schema: Schema.Struct({
      ...runStartedFields,
      taskId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
    }),
  }),
  runRestarted: Events.synced({
    name: 'v1.RunRestarted',
    schema: Schema.Struct({
      runId: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      usesDefaultModel: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  runProblemFound: Events.synced({
    name: 'v1.RunProblemFound',
    schema: Schema.Struct({ runId: Schema.String, problem: Schema.String, at: Schema.String }),
  }),
  tedCommentPosted: Events.synced({
    name: 'v1.TedCommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      createdAt: Schema.String,
    }),
  }),
}

const materializers = counted(
  State.SQLite.materializers(events, {
    'v1.FactoryAdded': (factory) => [
      factories.insert({ ...factory, clonedAt: factory.createdAt }),
      factoryRepos.insert({
        id: `${factory.id}:0`,
        factoryId: factory.id,
        position: 0,
        repo: factory.repo,
        name: factory.repo.split('/').at(-1) ?? factory.repo,
        cloneUrl: factory.cloneUrl,
      }),
    ],
    'v2.FactoryAdded': ({ repos, ...factory }) => [
      factories.insert({
        ...factory,
        repo: repos[0]?.repo ?? '',
        cloneUrl: repos[0]?.cloneUrl ?? '',
        clonedAt: null,
      }),
      ...repos.map((repo, position) =>
        factoryRepos.insert({
          ...repo,
          id: `${factory.id}:${position}`,
          factoryId: factory.id,
          position,
        }),
      ),
    ],
    'v1.FactoryCloned': ({ factoryId, at }) =>
      factories.update({ clonedAt: at }).where({ id: factoryId }),
    'v1.TaskCreated': (task) => tasks.insert({ ...task, stage: 'backlog' }),
    'v2.TaskCreated': (task) => tasks.insert({ ...task, stage: 'backlog' }),
    'v1.TaskBlockerAdded': ({ taskId, blockerId, at }) =>
      taskBlockers
        .insert({ id: `${taskId}:${blockerId}`, taskId, blockerId, at })
        .onConflict('id', 'ignore'),
    'v2.TaskBlockerAdded': ({ taskId, blockerId, runId, at }) =>
      taskBlockers
        .insert({ id: `${taskId}:${blockerId}`, taskId, blockerId, setByRunId: runId, at })
        .onConflict('id', 'replace'),
    'v1.TaskBlockerRemoved': ({ taskId, blockerId }) =>
      taskBlockers.delete().where({ id: `${taskId}:${blockerId}` }),
    'v1.TaskStartRequestChanged': ({ taskId, startRequested }) =>
      tasks.update({ startRequested }).where({ id: taskId }),
    'v1.TaskWaitingForBlockers': ({ taskId }) => [
      taskQueue.delete().where({ taskId }),
      tasks.update({ waitsForBlockers: true }).where({ id: taskId }),
    ],
    'v1.TaskRequeuedAfterBlockers': ({ taskId, rank, at }) => [
      taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
      tasks.update({ waitsForBlockers: false }).where({ id: taskId }),
    ],
    'v1.TaskAttachmentAdded': ({ taskId, hash, name, ...rest }) =>
      taskAttachments
        .insert({ id: `${taskId}:${hash}:${name}`, taskId, hash, name, ...rest })
        .onConflict('id', 'ignore'),
    'v1.TaskSourceSet': (source) => taskSources.insert(source).onConflict('taskId', 'replace'),
    'v1.TaskStarted': ({ taskId, stage, branch, worktree }) =>
      tasks.update({ stage, branch, worktree }).where({ id: taskId }),
    'v1.TaskStageChanged': ({ taskId, stage }) => tasks.update({ stage }).where({ id: taskId }),
    'v1.TaskQueued': ({ taskId, stage, rank, at }) => [
      taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
      tasks.update({ stage }).where({ id: taskId }),
    ],
    'v1.TaskDequeued': ({ taskId }) => taskQueue.delete().where({ taskId }),
    'v1.TaskMovedToBacklog': ({ taskId }) => [
      taskQueue.delete().where({ taskId }),
      tasks.update({ stage: 'backlog' }).where({ id: taskId }),
    ],
    'v1.TaskRanked': ({ taskId, rank }) => [
      tasks.update({ rank }).where({ id: taskId }),
      taskQueue.update({ rank }).where({ taskId }),
    ],
    'v1.TaskPriorityChanged': ({ taskId, priority, at }) =>
      tasks.update({ priority, changedAt: at }).where({ id: taskId }),
    'v1.TaskArchived': ({ taskId, at }) => [
      taskQueue.delete().where({ taskId }),
      tasks.update({ archivedAt: at, changedAt: at }).where({ id: taskId }),
    ],
    'v1.CommentPosted': (comment) => comments.insert({ ...comment, authorKind: 'run' }),
    'v2.CommentPosted': ({ choices, ...comment }) =>
      comments.insert({ ...comment, choices: choices === null ? null : JSON.stringify(choices) }),
    'v1.CommentAnswered': ({ id, answer }) => comments.update({ answer }).where({ id }),
    'v1.TaskBriefWritten': ({ at, ...brief }) => taskBriefs.insert({ ...brief, createdAt: at }),
    'v1.TaskSentBack': ({ from, to, ...row }) =>
      sendBacks.insert({ ...row, fromStage: from, toStage: to }),
    'v2.TaskSentBack': ({ from, to, ...row }) =>
      sendBacks.insert({ ...row, fromStage: from, toStage: to }),
    'v1.ChecksStarted': ({ checks, at, ...run }) => [
      checkRuns.insert({ ...run, startedAt: at }),
      ...checks.map((check, position) =>
        checkResults.insert({
          ...check,
          id: `${run.id}:${position}`,
          checkRunId: run.id,
          position,
        }),
      ),
    ],
    'v1.CheckStarted': ({ checkRunId, position }) =>
      checkResults.update({ state: 'running' }).where({ id: `${checkRunId}:${position}` }),
    'v1.CheckFinished': ({ checkRunId, position, state, exitCode, durationMs }) =>
      checkResults
        .update({ state, exitCode, durationMs })
        .where({ id: `${checkRunId}:${position}` }),
    'v1.ChecksFinished': ({ checkRunId, outcome, at }) => [
      checkRuns.update({ outcome, finishedAt: at }).where({ id: checkRunId }),
      checkResults.update({ state: 'not-run' }).where({ checkRunId, state: 'waiting' }),
      checkResults.update({ state: 'not-run' }).where({ checkRunId, state: 'running' }),
    ],
    'v1.SendBackCountReset': (reset) => sendBackResets.insert(reset),
    'v1.RunStarted': (run) =>
      runs.insert({ ...run, taskId: null, state: 'working', readOffset: 0 }),
    'v2.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
    'v3.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
    'v1.RunRestarted': ({ runId, model, effort, usesDefaultModel }) =>
      runs
        .update({ model, effort, usesDefaultModel, problem: null, state: 'idle' })
        .where({ id: runId }),
    'v1.RunProblemFound': ({ runId, problem }) =>
      runs.update({ problem, state: 'waiting' }).where({ id: runId }),
    'v1.TaskLeadSet': ({ taskId, agent, model, effort }) =>
      tasks
        .update({ leadAgent: agent, leadModel: model, leadEffort: effort })
        .where({ id: taskId }),
    'v1.TedCommentPosted': (comment) =>
      comments.insert({ ...comment, authorKind: 'ted', authorRunId: null }),
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
    'v2.TaskStageEntered': (entry) => stageEntries.insert(entry),
    'v1.TaskActivitySet': ({ taskId, text, stageEntries: count }) =>
      tasks.update({ activity: text, activityEntries: count }).where({ id: taskId }),
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
      workflowLayers
        .insert({ layer, files, version, acceptedAt: at })
        .onConflict('layer', 'replace'),
    'v1.AppearanceChanged': ({ appearance }) =>
      machineSettings.insert({ id: 'machine', appearance }).onConflict('id', 'replace'),
    'v1.MachineSettingsChanged': ({ changes }) =>
      Object.entries(JSON.parse(changes) as Record<string, unknown>).map(([name, value]) =>
        machineSettingValues
          .insert({ name, value: JSON.stringify(value) })
          .onConflict('name', 'replace'),
      ),
    'v1.BannerRaised': ({ at, ...banner }) => [
      banners.insert({ ...banner, raisedAt: at, dismissedUntil: null }).onConflict('id', 'ignore'),
      banners
        .update({ severity: banner.severity, text: banner.text, action: banner.action })
        .where({ id: banner.id }),
    ],
    'v1.BannerDismissed': ({ id, until }) =>
      banners.update({ dismissedUntil: until }).where({ id }),
    'v1.BannerCleared': ({ id }) => banners.delete().where({ id }),
    'v1.AgentPaused': ({ agent, reason, at }) =>
      agentPauses.insert({ agent, reason, since: at }).onConflict('agent', 'replace'),
    'v1.AgentResumed': ({ agent }) => agentPauses.delete().where({ agent }),
    'v1.TaskRunHeld': (held) => heldRuns.insert(held).onConflict('taskId', 'replace'),
    'v1.TaskRunReleased': ({ taskId }) => heldRuns.delete().where({ taskId }),
  }),
)

const state = State.SQLite.makeState({
  tables: {
    factories,
    factoryRepos,
    tasks,
    taskQueue,
    taskBlockers,
    taskAttachments,
    taskSources,
    runs,
    conversationEntries,
    comments,
    taskBriefs,
    sendBacks,
    sendBackResets,
    checkRuns,
    checkResults,
    stageEntries,
    workflowLayers,
    taskRepos,
    localFolders,
    machineSettings,
    machineSettingValues,
    banners,
    agentPauses,
    heldRuns,
  },
  materializers,
})

export const schema = makeSchema({ events, state })
