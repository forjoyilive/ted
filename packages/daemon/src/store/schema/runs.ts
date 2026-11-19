import { Events, Schema, State } from '@livestore/livestore'
import { testInvocations } from './checks.ts'
import { comments } from './requests.ts'

const runStartedFields = {
  id: Schema.String,
  agent: Schema.String,
  sessionId: Schema.String,
  prompt: Schema.String,
  cwd: Schema.String,
  startedAt: Schema.String,
}

export const runs = State.SQLite.table({
  name: 'runs',
  indexes: [{ name: 'idx_runs_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    agent: State.SQLite.text(),
    sessionId: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    usesDefaultModel: State.SQLite.boolean({ default: false }),
    problem: State.SQLite.text({ nullable: true }),
    problemAt: State.SQLite.text({ nullable: true }),
    permissions: State.SQLite.text({ default: 'auto' }),
    manualPermissions: State.SQLite.boolean({ default: false }),
    prompt: State.SQLite.text(),
    cwd: State.SQLite.text(),
    taskId: State.SQLite.text({ nullable: true }),
    parentRunId: State.SQLite.text({ nullable: true }),
    name: State.SQLite.text({ nullable: true }),
    failure: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    readOffset: State.SQLite.integer(),
    lastOutputAt: State.SQLite.text({ nullable: true }),
    startedAt: State.SQLite.text(),
    revivedAt: State.SQLite.text({ nullable: true }),
    ended: State.SQLite.text({ nullable: true }),
    retrying: State.SQLite.boolean({ default: false }),
    steeringRelease: State.SQLite.text({ nullable: true }),
    promptParts: State.SQLite.text({ nullable: true }),
  },
})

export const promptTexts = State.SQLite.table({
  name: 'promptTexts',
  columns: {
    hash: State.SQLite.text({ primaryKey: true }),
    text: State.SQLite.text(),
    seenAt: State.SQLite.text(),
  },
})

export const subAgentInstructions = State.SQLite.table({
  name: 'subAgentInstructions',
  indexes: [{ name: 'idx_subAgentInstructions_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    text: State.SQLite.text(),
  },
})

export const subAgentRequests = State.SQLite.table({
  name: 'subAgentRequests',
  indexes: [{ name: 'idx_subAgentRequests_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    parentRunId: State.SQLite.text(),
    name: State.SQLite.text(),
    agent: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    prompt: State.SQLite.text(),
    ownWorktree: State.SQLite.boolean({ default: false }),
    at: State.SQLite.text(),
  },
})

export const runMessages = State.SQLite.table({
  name: 'runMessages',
  indexes: [{ name: 'idx_runMessages_runId', columns: ['runId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    runId: State.SQLite.text(),
    taskId: State.SQLite.text({ nullable: true }),
    roundId: State.SQLite.text({ nullable: true }),
    text: State.SQLite.text(),
    at: State.SQLite.text(),
    queued: State.SQLite.boolean({ default: false }),
    fromTed: State.SQLite.boolean({ default: false }),
    deletedAt: State.SQLite.text({ nullable: true }),
  },
})

export const runInterrupts = State.SQLite.table({
  name: 'runInterrupts',
  indexes: [{ name: 'idx_runInterrupts_runId', columns: ['runId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    runId: State.SQLite.text(),
    hold: State.SQLite.boolean({ default: false }),
    at: State.SQLite.text(),
  },
})

export const conversationTabs = State.SQLite.table({
  name: 'conversationTabs',
  indexes: [{ name: 'idx_conversationTabs_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    runId: State.SQLite.text(),
    openedAt: State.SQLite.text(),
  },
})

export const runUsage = State.SQLite.table({
  name: 'runUsage',
  indexes: [{ name: 'idx_runUsage_at', columns: ['at'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    agent: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    input: State.SQLite.integer(),
    output: State.SQLite.integer(),
    cost: State.SQLite.real({ nullable: true }),
    at: State.SQLite.text(),
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
    pickUp: State.SQLite.text({ nullable: true }),
    carriedRunId: State.SQLite.text({ nullable: true }),
    carriedMessageIds: State.SQLite.json({ schema: Schema.Array(Schema.String), nullable: true }),
  },
})

export const runsEvents = {
  runKilledForMemory: Events.synced({
    name: 'v1.RunKilledForMemory',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      lowestMemory: Schema.Number,
      at: Schema.String,
    }),
  }),
  runUsageRecorded: Events.synced({
    name: 'v1.RunUsageRecorded',
    schema: Schema.Struct({
      runId: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      input: Schema.Number,
      output: Schema.Number,
      cost: Schema.NullOr(Schema.Number),
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
  runStateChanged: Events.synced({
    name: 'v1.RunStateChanged',
    schema: Schema.Struct({ runId: Schema.String, state: Schema.String, at: Schema.String }),
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
  taskRunHeldV2: Events.synced({
    name: 'v2.TaskRunHeld',
    schema: Schema.Struct({
      taskId: Schema.String,
      agent: Schema.String,
      sessionId: Schema.NullOr(Schema.String),
      pickUp: Schema.NullOr(Schema.String),
      carried: Schema.NullOr(
        Schema.Struct({ runId: Schema.String, messageIds: Schema.Array(Schema.String) }),
      ),
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
  runRetryingChanged: Events.synced({
    name: 'v1.RunRetryingChanged',
    schema: Schema.Struct({ runId: Schema.String, retrying: Schema.Boolean, at: Schema.String }),
  }),
  runProblemFound: Events.synced({
    name: 'v1.RunProblemFound',
    schema: Schema.Struct({ runId: Schema.String, problem: Schema.String, at: Schema.String }),
  }),
  runPermissionsSet: Events.synced({
    name: 'v1.RunPermissionsSet',
    schema: Schema.Struct({ runId: Schema.String, permissions: Schema.String, at: Schema.String }),
  }),
  runAutoModeUnavailable: Events.synced({
    name: 'v1.RunAutoModeUnavailable',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  permissionRequested: Events.synced({
    name: 'v1.PermissionRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      runId: Schema.String,
      requestId: Schema.String,
      stage: Schema.NullOr(Schema.String),
      title: Schema.String,
      body: Schema.String,
      command: Schema.String,
      details: Schema.NullOr(Schema.String),
      generation: Schema.Number,
      repo: Schema.NullOr(Schema.String),
      input: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  runOutputReadV2: Events.synced({
    name: 'v2.RunOutputRead',
    schema: Schema.Struct({
      runId: Schema.String,
      toOffset: Schema.Number,
      entries: Schema.Array(
        Schema.Struct({ offset: Schema.Number, line: Schema.String, at: Schema.String }),
      ),
    }),
  }),
  runOutputReadV3: Events.synced({
    name: 'v3.RunOutputRead',
    schema: Schema.Struct({
      runId: Schema.String,
      toOffset: Schema.Number,
      lastOutputAt: Schema.NullOr(Schema.String),
    }),
  }),
  runMessageSent: Events.synced({
    name: 'v1.RunMessageSent',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      lead: Schema.Boolean,
      text: Schema.String,
      at: Schema.String,
    }),
  }),
  runMessageQueued: Events.synced({
    name: 'v1.RunMessageQueued',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      text: Schema.String,
      at: Schema.String,
    }),
  }),
  runMessageQueuedV2: Events.synced({
    name: 'v2.RunMessageQueued',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      text: Schema.String,
      at: Schema.String,
      from: Schema.String,
    }),
  }),
  runMessageDelivered: Events.synced({
    name: 'v1.RunMessageDelivered',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      lead: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  runMessageDeleted: Events.synced({
    name: 'v1.RunMessageDeleted',
    schema: Schema.Struct({ id: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  runSteeringReleased: Events.synced({
    name: 'v1.RunSteeringReleased',
    schema: Schema.Struct({ runId: Schema.String, release: Schema.String }),
  }),
  runTurnInterrupted: Events.synced({
    name: 'v1.RunTurnInterrupted',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      hold: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  conversationTabOpened: Events.synced({
    name: 'v1.ConversationTabOpened',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  conversationTabClosed: Events.synced({
    name: 'v1.ConversationTabClosed',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  runStartedV4: Events.synced({
    name: 'v4.RunStarted',
    schema: Schema.Struct({
      ...runStartedFields,
      taskId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      parentRunId: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
  }),
  runStartedV5: Events.synced({
    name: 'v5.RunStarted',
    schema: Schema.Struct({
      id: Schema.String,
      agent: Schema.String,
      sessionId: Schema.String,
      promptParts: Schema.Array(
        Schema.Union([
          Schema.Struct({ text: Schema.String }),
          Schema.Struct({ hash: Schema.String }),
          Schema.Struct({ request: Schema.String }),
        ]),
      ),
      cwd: Schema.String,
      startedAt: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      parentRunId: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
  }),
  promptTextSeen: Events.synced({
    name: 'v1.PromptTextSeen',
    schema: Schema.Struct({ hash: Schema.String, text: Schema.String, at: Schema.String }),
  }),
  subAgentRequestedV2: Events.synced({
    name: 'v2.SubAgentRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      parentRunId: Schema.String,
      name: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      prompt: Schema.String,
      ownWorktree: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  subAgentRequested: Events.synced({
    name: 'v1.SubAgentRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      parentRunId: Schema.String,
      name: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      prompt: Schema.String,
      ownWorktree: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  subAgentRequestDropped: Events.synced({
    name: 'v1.SubAgentRequestDropped',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  runFailed: Events.synced({
    name: 'v1.RunFailed',
    schema: Schema.Struct({ runId: Schema.String, error: Schema.String, at: Schema.String }),
  }),
  runEnded: Events.synced({
    name: 'v1.RunEnded',
    schema: Schema.Struct({ runId: Schema.String, ending: Schema.String, at: Schema.String }),
  }),
  runRevived: Events.synced({
    name: 'v1.RunRevived',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
}

export const runsMaterializers = State.SQLite.materializers(runsEvents, {
  'v1.RunKilledForMemory': () => [],
  'v1.RunUsageRecorded': ({ runId, ...usage }) =>
    runUsage.insert({ id: runId, ...usage }).onConflict('id', 'replace'),
  'v1.RunStarted': (run) => runs.insert({ ...run, taskId: null, state: 'working', readOffset: 0 }),
  'v2.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
  'v3.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
  'v4.RunStarted': (run) => [
    runs.insert({ ...run, state: 'working', readOffset: 0 }),
    subAgentRequests.delete().where({ id: run.id }),
  ],
  'v5.RunStarted': ({ promptParts, ...run }) => [
    runs.insert({
      ...run,
      prompt: '',
      promptParts: JSON.stringify(promptParts),
      state: 'working',
      readOffset: 0,
    }),
    subAgentRequests.delete().where({ id: run.id }),
  ],
  'v1.PromptTextSeen': ({ at, ...seen }) =>
    promptTexts.insert({ ...seen, seenAt: at }).onConflict('hash', 'ignore'),
  'v1.SubAgentRequested': (request) => subAgentRequests.insert(request),
  'v2.SubAgentRequested': (request) => [
    subAgentRequests.insert(request),
    subAgentInstructions.insert({
      id: request.id,
      taskId: request.taskId,
      text: request.prompt.trim(),
    }),
  ],
  'v1.SubAgentRequestDropped': ({ id }) => [
    subAgentRequests.delete().where({ id }),
    subAgentInstructions.delete().where({ id }),
  ],
  'v1.RunFailed': ({ runId, error }) => runs.update({ failure: error }).where({ id: runId }),
  'v1.RunRestarted': ({ runId, model, effort, usesDefaultModel }) =>
    runs
      .update({ model, effort, usesDefaultModel, problem: null, state: 'idle' })
      .where({ id: runId }),
  'v1.RunRetryingChanged': ({ runId, retrying }) => runs.update({ retrying }).where({ id: runId }),
  'v1.RunProblemFound': ({ runId, problem, at }) =>
    runs.update({ problem, problemAt: at, state: 'waiting' }).where({ id: runId }),
  'v1.RunEnded': ({ runId, ending }) => runs.update({ ended: ending }).where({ id: runId }),
  'v1.RunRevived': ({ runId, at }) =>
    runs
      .update({ state: 'working', ended: null, problem: null, revivedAt: at })
      .where({ id: runId }),
  'v1.RunOutputRead': ({ runId, toOffset }) =>
    runs.update({ readOffset: toOffset }).where({ id: runId }),
  'v2.RunOutputRead': ({ runId, toOffset, entries }) => {
    const last = entries.at(-1)
    return runs
      .update({ readOffset: toOffset, ...(last && { lastOutputAt: last.at }) })
      .where({ id: runId })
  },
  'v3.RunOutputRead': ({ runId, toOffset, lastOutputAt }) =>
    runs
      .update({ readOffset: toOffset, ...(lastOutputAt !== null && { lastOutputAt }) })
      .where({ id: runId }),
  'v1.RunMessageSent': ({ id, runId, text, at }) => runMessages.insert({ id, runId, text, at }),
  'v1.RunMessageQueued': ({ id, runId, text, at }) =>
    runMessages.insert({ id, runId, text, at, queued: true }),
  'v2.RunMessageQueued': ({ id, runId, taskId, text, at, from }) =>
    runMessages.insert({ id, runId, taskId, text, at, queued: true, fromTed: from === 'ted' }),
  'v1.RunMessageDelivered': ({ id }) => runMessages.update({ queued: false }).where({ id }),
  'v1.RunMessageDeleted': ({ id, at }) =>
    runMessages.update({ deletedAt: at, queued: false }).where({ id }),
  'v1.RunSteeringReleased': ({ runId, release }) =>
    runs.update({ steeringRelease: release }).where({ id: runId }),
  'v1.RunTurnInterrupted': ({ id, runId, hold, at }) =>
    runInterrupts.insert({ id, runId, hold, at }),
  'v1.ConversationTabOpened': ({ taskId, runId, at }) =>
    conversationTabs
      .insert({ id: `${taskId}:${runId}`, taskId, runId, openedAt: at })
      .onConflict('id', 'ignore'),
  'v1.ConversationTabClosed': ({ taskId, runId }) =>
    conversationTabs.delete().where({ id: `${taskId}:${runId}` }),
  'v1.RunStateChanged': ({ runId, state }) => [
    runs.update({ state }).where({ id: runId }),
    ...(state === 'finished'
      ? [testInvocations.update({ ownerEnded: true }).where({ runId })]
      : []),
  ],
  'v1.RunPermissionsSet': ({ runId, permissions }) =>
    runs.update({ permissions }).where({ id: runId }),
  'v1.RunAutoModeUnavailable': ({ runId }) =>
    runs.update({ manualPermissions: true }).where({ id: runId }),
  'v1.PermissionRequested': ({
    runId,
    requestId,
    generation,
    command,
    details,
    repo,
    input,
    ...comment
  }) =>
    comments.insert({
      ...comment,
      kind: 'permission',
      authorKind: 'run',
      authorRunId: runId,
      permission: JSON.stringify({
        requestId,
        generation,
        command,
        ...(details !== null && { details }),
        ...(repo !== null && { repo }),
        ...(input !== null && { input }),
      }),
    }),
  'v1.RunSessionIdentified': ({ runId, sessionId }) =>
    runs.update({ sessionId }).where({ id: runId }),
  'v1.AgentPaused': ({ agent, reason, at }) =>
    agentPauses.insert({ agent, reason, since: at }).onConflict('agent', 'replace'),
  'v1.AgentResumed': ({ agent }) => agentPauses.delete().where({ agent }),
  'v1.TaskRunHeld': (held) => heldRuns.insert(held).onConflict('taskId', 'replace'),
  'v2.TaskRunHeld': ({ carried, ...held }) =>
    heldRuns
      .insert({
        ...held,
        carriedRunId: carried?.runId ?? null,
        carriedMessageIds: carried?.messageIds ?? null,
      })
      .onConflict('taskId', 'replace'),
  'v1.TaskRunReleased': ({ taskId }) => heldRuns.delete().where({ taskId }),
})
