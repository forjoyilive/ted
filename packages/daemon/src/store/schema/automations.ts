import { Events, Schema, State } from '@livestore/livestore'
import { runBrowserCaptures } from './apps.ts'
import { messageDrafts, requestSnoozes, runDraftKey } from './requests.ts'
import { runInterrupts, runMessages, runs } from './runs.ts'
import { tasks } from './tasks.ts'

export const automations = State.SQLite.table({
  name: 'automations',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    name: State.SQLite.text(),
    prompt: State.SQLite.text(),
    schedule: State.SQLite.text(),
    timeZone: State.SQLite.text(),
    agent: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    on: State.SQLite.boolean(),
    checkout: State.SQLite.boolean({ default: false }),
    priority: State.SQLite.text({ nullable: true }),
    checkCommand: State.SQLite.text({ nullable: true }),
    checkTimeout: State.SQLite.text({ nullable: true }),
    checkRunBy: State.SQLite.text({ nullable: true }),
    checkAgent: State.SQLite.text({ nullable: true }),
    checkStartTasks: State.SQLite.boolean({ default: false }),
    template: State.SQLite.text({ nullable: true }),
    handledUntil: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

export const automationPromptDrafts = State.SQLite.table({
  name: 'automationPromptDrafts',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    input: State.SQLite.text(),
    state: State.SQLite.text(),
    prompt: State.SQLite.text({ nullable: true }),
    error: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
    updatedAt: State.SQLite.text(),
  },
})

export const automationFirings = State.SQLite.table({
  name: 'automationFirings',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    trigger: State.SQLite.text(),
    slotAt: State.SQLite.text({ nullable: true }),
    retryOf: State.SQLite.text({ nullable: true }),
    retriedAt: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    at: State.SQLite.text(),
    startedAt: State.SQLite.text({ nullable: true }),
    resume: State.SQLite.text({ nullable: true }),
    outcome: State.SQLite.text({ nullable: true }),
    error: State.SQLite.text({ nullable: true }),
    message: State.SQLite.text({ nullable: true }),
    finishedAt: State.SQLite.text({ nullable: true }),
    agentPhase: State.SQLite.text({ nullable: true }),
  },
})

export const automationTasks = State.SQLite.table({
  name: 'automationTasks',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    firingId: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const automationCheckResults = State.SQLite.table({
  name: 'automationCheckResults',
  columns: {
    firingId: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    state: State.SQLite.text(),
    exitCode: State.SQLite.integer({ nullable: true }),
    durationMs: State.SQLite.integer(),
    ranWhileBusy: State.SQLite.boolean(),
    skipped: State.SQLite.text(),
    failing: State.SQLite.text(),
    updatedTaskIds: State.SQLite.text(),
    agentCommit: State.SQLite.text({ nullable: true }),
    agentReport: State.SQLite.text({ nullable: true }),
    fallbackReason: State.SQLite.text({ nullable: true }),
  },
})

export const automationTaskActions = State.SQLite.table({
  name: 'automationTaskActions',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    firingId: State.SQLite.text(),
    taskId: State.SQLite.text(),
    action: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const automationCheckTasks = State.SQLite.table({
  name: 'automationCheckTasks',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    key: State.SQLite.text(),
  },
})

export const automationComments = State.SQLite.table({
  name: 'automationComments',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    firingId: State.SQLite.text(),
    kind: State.SQLite.text(),
    body: State.SQLite.text(),
    choices: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    answeredAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const automationsEvents = {
  automationCreated: Events.synced({
    name: 'v1.AutomationCreated',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      name: Schema.String,
      prompt: Schema.String,
      schedule: Schema.String,
      timeZone: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      on: Schema.Boolean,
      template: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  automationEdited: Events.synced({
    name: 'v1.AutomationEdited',
    schema: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      prompt: Schema.String,
      schedule: Schema.String,
      timeZone: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      rescheduled: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  automationCheckoutSet: Events.synced({
    name: 'v1.AutomationCheckoutSet',
    schema: Schema.Struct({ id: Schema.String, checkout: Schema.Boolean, at: Schema.String }),
  }),
  automationPrioritySet: Events.synced({
    name: 'v1.AutomationPrioritySet',
    schema: Schema.Struct({ id: Schema.String, priority: Schema.String, at: Schema.String }),
  }),
  automationSwitched: Events.synced({
    name: 'v1.AutomationSwitched',
    schema: Schema.Struct({ id: Schema.String, on: Schema.Boolean, at: Schema.String }),
  }),
  automationDeleted: Events.synced({
    name: 'v1.AutomationDeleted',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationFired: Events.synced({
    name: 'v1.AutomationFired',
    schema: Schema.Struct({
      id: Schema.String,
      automationId: Schema.String,
      trigger: Schema.String,
      slotAt: Schema.NullOr(Schema.String),
      retryOf: Schema.NullOr(Schema.String),
      skipped: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  automationFiringDropped: Events.synced({
    name: 'v1.AutomationFiringDropped',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationRunBegan: Events.synced({
    name: 'v1.AutomationRunBegan',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationRunResumeQueued: Events.synced({
    name: 'v1.AutomationRunResumeQueued',
    schema: Schema.Struct({ id: Schema.String, error: Schema.String, at: Schema.String }),
  }),
  automationRunRevived: Events.synced({
    name: 'v1.AutomationRunRevived',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationRunEnded: Events.synced({
    name: 'v1.AutomationRunEnded',
    schema: Schema.Struct({
      id: Schema.String,
      outcome: Schema.String,
      error: Schema.NullOr(Schema.String),
      message: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  setupTaskCreated: Events.synced({
    name: 'v1.SetupTaskCreated',
    schema: Schema.Struct({ taskId: Schema.String, factoryId: Schema.String, at: Schema.String }),
  }),
  automationCheckSet: Events.synced({
    name: 'v1.AutomationCheckSet',
    schema: Schema.Struct({
      automationId: Schema.String,
      command: Schema.String,
      timeout: Schema.String,
      runBy: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  automationCheckFinished: Events.synced({
    name: 'v1.AutomationCheckFinished',
    schema: Schema.Struct({
      firingId: Schema.String,
      automationId: Schema.String,
      state: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      durationMs: Schema.Number,
      ranWhileBusy: Schema.Boolean,
      skipped: Schema.Array(Schema.String),
      failing: Schema.Array(Schema.String),
      updatedTaskIds: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  automationCheckAgentSet: Events.synced({
    name: 'v1.AutomationCheckAgentSet',
    schema: Schema.Struct({
      automationId: Schema.String,
      agentStep: Schema.String,
      startTasks: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  automationCheckAgentQueued: Events.synced({
    name: 'v1.AutomationCheckAgentQueued',
    schema: Schema.Struct({
      firingId: Schema.String,
      commit: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  automationCheckAgentStarted: Events.synced({
    name: 'v1.AutomationCheckAgentStarted',
    schema: Schema.Struct({ firingId: Schema.String, at: Schema.String }),
  }),
  automationCheckAgentReported: Events.synced({
    name: 'v1.AutomationCheckAgentReported',
    schema: Schema.Struct({ firingId: Schema.String, summary: Schema.String, at: Schema.String }),
  }),
  automationCheckFallbackApplied: Events.synced({
    name: 'v1.AutomationCheckFallbackApplied',
    schema: Schema.Struct({
      firingId: Schema.String,
      reason: Schema.String,
      updatedTaskIds: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  automationTaskNoted: Events.synced({
    name: 'v1.AutomationTaskNoted',
    schema: Schema.Struct({
      taskId: Schema.String,
      automationId: Schema.String,
      firingId: Schema.String,
      at: Schema.String,
    }),
  }),
  taskStartedByAutomation: Events.synced({
    name: 'v1.TaskStartedByAutomation',
    schema: Schema.Struct({
      taskId: Schema.String,
      automationId: Schema.String,
      firingId: Schema.String,
      name: Schema.String,
      at: Schema.String,
    }),
  }),
  automationCheckTaskCreated: Events.synced({
    name: 'v1.AutomationCheckTaskCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      automationId: Schema.String,
      key: Schema.String,
      at: Schema.String,
    }),
  }),
  automationTaskCreated: Events.synced({
    name: 'v1.AutomationTaskCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      automationId: Schema.String,
      firingId: Schema.String,
      at: Schema.String,
    }),
  }),
  automationCommentPosted: Events.synced({
    name: 'v1.AutomationCommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      automationId: Schema.String,
      firingId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      choices: Schema.NullOr(Schema.Array(Schema.String)),
      at: Schema.String,
    }),
  }),
  automationCommentAnswered: Events.synced({
    name: 'v1.AutomationCommentAnswered',
    schema: Schema.Struct({ id: Schema.String, text: Schema.String, at: Schema.String }),
  }),
  automationPromptDraftRequested: Events.synced({
    name: 'v1.AutomationPromptDraftRequested',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      input: Schema.String,
      at: Schema.String,
    }),
  }),
  automationPromptDraftChanged: Events.synced({
    name: 'v1.AutomationPromptDraftChanged',
    schema: Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      prompt: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  automationPromptDraftRemoved: Events.synced({
    name: 'v1.AutomationPromptDraftRemoved',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
}

export const automationsMaterializers = State.SQLite.materializers(automationsEvents, {
  'v1.SetupTaskCreated': ({ taskId }) => tasks.update({ setup: true }).where({ id: taskId }),
  'v1.AutomationCreated': ({ at, ...automation }) =>
    automations.insert({ ...automation, handledUntil: at, createdAt: at }),
  'v1.AutomationEdited': ({ id, rescheduled, at, ...fields }) =>
    automations.update({ ...fields, ...(rescheduled && { handledUntil: at }) }).where({ id }),
  'v1.AutomationCheckoutSet': ({ id, checkout }) => automations.update({ checkout }).where({ id }),
  'v1.AutomationPrioritySet': ({ id, priority }) => automations.update({ priority }).where({ id }),
  'v1.AutomationSwitched': ({ id, on, at }) =>
    automations.update({ on, ...(on && { handledUntil: at }) }).where({ id }),
  'v1.AutomationDeleted': ({ id }) => [
    automations.delete().where({ id }),
    automationFirings.delete().where({ automationId: id }),
    automationComments.delete().where({ automationId: id }),
    automationCheckResults.delete().where({ automationId: id }),
    automationCheckTasks.delete().where({ automationId: id }),
    automationTaskActions.delete().where({ automationId: id }),
    runBrowserCaptures.delete().where({ automationId: id }),
    requestSnoozes.delete().where({ ownerId: id }),
  ],
  'v1.AutomationFired': ({ skipped, retryOf, slotAt, ...firing }) => [
    automationFirings.insert({
      ...firing,
      slotAt,
      retryOf,
      state: skipped ? 'skipped' : 'queued',
    }),
    ...(slotAt !== null
      ? [automations.update({ handledUntil: slotAt }).where({ id: firing.automationId })]
      : []),
    ...(retryOf !== null
      ? [automationFirings.update({ retriedAt: firing.at }).where({ id: retryOf })]
      : []),
  ],
  'v1.AutomationFiringDropped': ({ id, at }) =>
    automationFirings.update({ state: 'dropped', finishedAt: at }).where({ id }),
  'v1.AutomationRunBegan': ({ id, at }) =>
    automationFirings.update({ state: 'started', startedAt: at }).where({ id }),
  'v1.AutomationRunResumeQueued': ({ id, error }) =>
    automationFirings.update({ resume: 'queued', error }).where({ id }),
  'v1.AutomationRunRevived': ({ id }) => automationFirings.update({ resume: 'done' }).where({ id }),
  'v1.AutomationRunEnded': ({ id, outcome, error, message, at }) =>
    automationFirings
      .update({ state: 'ended', outcome, error, message, finishedAt: at })
      .where({ id }),
  'v1.AutomationTaskCreated': (link) => automationTasks.insert(link).onConflict('taskId', 'ignore'),
  'v1.AutomationCheckSet': ({ automationId, command, timeout, runBy }) =>
    automations
      .update({ checkCommand: command, checkTimeout: timeout, checkRunBy: runBy })
      .where({ id: automationId }),
  'v1.AutomationCheckFinished': ({ at: _, failing, updatedTaskIds, skipped, ...result }) =>
    automationCheckResults
      .insert({
        ...result,
        failing: JSON.stringify(failing),
        skipped: JSON.stringify(skipped),
        updatedTaskIds: JSON.stringify(updatedTaskIds),
      })
      .onConflict('firingId', 'replace'),
  'v1.AutomationCheckAgentSet': ({ automationId, agentStep, startTasks }) =>
    automations
      .update({ checkAgent: agentStep, checkStartTasks: startTasks })
      .where({ id: automationId }),
  'v1.AutomationCheckAgentQueued': ({ firingId, commit }) => [
    automationFirings.update({ agentPhase: 'queued' }).where({ id: firingId }),
    automationCheckResults.update({ agentCommit: commit }).where({ firingId }),
  ],
  'v1.AutomationCheckAgentStarted': ({ firingId }) =>
    automationFirings.update({ agentPhase: 'started' }).where({ id: firingId }),
  'v1.AutomationCheckAgentReported': ({ firingId, summary }) =>
    automationCheckResults.update({ agentReport: summary }).where({ firingId }),
  'v1.AutomationCheckFallbackApplied': ({ firingId, reason, updatedTaskIds }) =>
    automationCheckResults
      .update({ fallbackReason: reason, updatedTaskIds: JSON.stringify(updatedTaskIds) })
      .where({ firingId }),
  'v1.AutomationTaskNoted': ({ taskId, automationId, firingId, at }) =>
    automationTaskActions
      .insert({
        id: `${firingId}:${taskId}:noted`,
        automationId,
        firingId,
        taskId,
        action: 'noted',
        at,
      })
      .onConflict('id', 'ignore'),
  'v1.TaskStartedByAutomation': ({ taskId, automationId, firingId, at }) =>
    automationTaskActions
      .insert({
        id: `${firingId}:${taskId}:started`,
        automationId,
        firingId,
        taskId,
        action: 'started',
        at,
      })
      .onConflict('id', 'ignore'),
  'v1.AutomationCheckTaskCreated': ({ at: _, ...link }) =>
    automationCheckTasks.insert(link).onConflict('taskId', 'replace'),
  'v1.AutomationCommentPosted': ({ choices, at, ...comment }) =>
    automationComments.insert({
      ...comment,
      choices: choices === null ? null : JSON.stringify(choices),
      createdAt: at,
    }),
  'v1.AutomationCommentAnswered': ({ id, text, at }) => [
    automationComments.update({ answer: text, answeredAt: at }).where({ id }),
    requestSnoozes.delete().where({ requestId: id }),
  ],
  'v1.AutomationPromptDraftRequested': ({ at, ...draft }) =>
    automationPromptDrafts.insert({
      ...draft,
      state: 'queued',
      createdAt: at,
      updatedAt: at,
    }),
  'v1.AutomationPromptDraftChanged': ({ id, at, ...fields }) =>
    automationPromptDrafts.update({ ...fields, updatedAt: at }).where({ id }),
  'v1.AutomationPromptDraftRemoved': ({ id }) => [
    automationPromptDrafts.delete().where({ id }),
    messageDrafts.delete().where({ key: runDraftKey(id) }),
    runs.delete().where({ id }),
    runMessages.delete().where({ runId: id }),
    runInterrupts.delete().where({ runId: id }),
  ],
})
