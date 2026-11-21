import { Events, Schema, State } from '@livestore/livestore'
import { chatAgents, chatCommands } from './chats.ts'
import { messageDraftKey, messageDrafts, requestSnoozes } from './requests.ts'
import { runInterrupts, runMessages, runs } from './runs.ts'
import { tasks } from './tasks.ts'

export const plans = State.SQLite.table({
  name: 'plans',
  indexes: [{ name: 'idx_plans_fromTaskId', columns: ['fromTaskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    title: State.SQLite.text(),
    message: State.SQLite.text(),
    agent: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    resume: State.SQLite.text({ nullable: true }),
    outcome: State.SQLite.text({ nullable: true }),
    error: State.SQLite.text({ nullable: true }),
    checkout: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
    startedAt: State.SQLite.text({ nullable: true }),
    finishedAt: State.SQLite.text({ nullable: true }),
    fromPlanId: State.SQLite.text({ nullable: true }),
    fromPlanTitle: State.SQLite.text({ nullable: true }),
    context: State.SQLite.text({ nullable: true }),
    fromTaskId: State.SQLite.text({ nullable: true }),
    fromTaskDisplayId: State.SQLite.text({ nullable: true }),
    fromTaskTitle: State.SQLite.text({ nullable: true }),
    sizeCheckId: State.SQLite.text({ nullable: true }),
    fromTaskGone: State.SQLite.text({ nullable: true }),
    archivedAt: State.SQLite.text({ nullable: true }),
  },
})

export const planRequests = State.SQLite.table({
  name: 'planRequests',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    planId: State.SQLite.text(),
    runId: State.SQLite.text(),
    kind: State.SQLite.text(),
    author: State.SQLite.text(),
    title: State.SQLite.text({ nullable: true }),
    body: State.SQLite.text(),
    choices: State.SQLite.text({ nullable: true }),
    multiple: State.SQLite.integer({ nullable: true }),
    round: State.SQLite.text({ nullable: true }),
    proposal: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const planTasks = State.SQLite.table({
  name: 'planTasks',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    planId: State.SQLite.text(),
    row: State.SQLite.integer(),
    at: State.SQLite.text(),
  },
})

export const plansEvents = {
  planStarted: Events.synced({
    name: 'v1.PlanStarted',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      title: Schema.String,
      message: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planRenamed: Events.synced({
    name: 'v1.PlanRenamed',
    schema: Schema.Struct({ id: Schema.String, title: Schema.String, at: Schema.String }),
  }),
  planDeleted: Events.synced({
    name: 'v1.PlanDeleted',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  planRunBegan: Events.synced({
    name: 'v1.PlanRunBegan',
    schema: Schema.Struct({ id: Schema.String, checkout: Schema.String, at: Schema.String }),
  }),
  planRunResumeQueued: Events.synced({
    name: 'v1.PlanRunResumeQueued',
    schema: Schema.Struct({ id: Schema.String, error: Schema.String, at: Schema.String }),
  }),
  planRunRevived: Events.synced({
    name: 'v1.PlanRunRevived',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  planEnded: Events.synced({
    name: 'v1.PlanEnded',
    schema: Schema.Struct({
      id: Schema.String,
      outcome: Schema.String,
      error: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planRequestPosted: Events.synced({
    name: 'v1.PlanRequestPosted',
    schema: Schema.Struct({
      id: Schema.String,
      planId: Schema.String,
      runId: Schema.String,
      kind: Schema.String,
      author: Schema.String,
      title: Schema.NullOr(Schema.String),
      body: Schema.String,
      round: Schema.NullOr(Schema.String),
      proposal: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planQuestionPosted: Events.synced({
    name: 'v1.PlanQuestionPosted',
    schema: Schema.Struct({
      id: Schema.String,
      planId: Schema.String,
      runId: Schema.String,
      body: Schema.String,
      choices: Schema.Array(Schema.String),
      multiple: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  planRequestAnswered: Events.synced({
    name: 'v1.PlanRequestAnswered',
    schema: Schema.Struct({ id: Schema.String, answer: Schema.String, at: Schema.String }),
  }),
  planContinued: Events.synced({
    name: 'v1.PlanContinued',
    schema: Schema.Struct({
      id: Schema.String,
      fromPlanId: Schema.String,
      fromTitle: Schema.String,
      context: Schema.String,
      at: Schema.String,
    }),
  }),
  planArchived: Events.synced({
    name: 'v1.PlanArchived',
    schema: Schema.Struct({
      id: Schema.String,
      withdraw: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  planUnarchived: Events.synced({
    name: 'v1.PlanUnarchived',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  planRetried: Events.synced({
    name: 'v1.PlanRetried',
    schema: Schema.Struct({
      id: Schema.String,
      fresh: Schema.Boolean,
      checkout: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planStartedFromTask: Events.synced({
    name: 'v1.PlanStartedFromTask',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      displayId: Schema.String,
      taskTitle: Schema.String,
      sizeCheckId: Schema.String,
      at: Schema.String,
    }),
  }),
  planTaskDetached: Events.synced({
    name: 'v1.PlanTaskDetached',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      reason: Schema.String,
      at: Schema.String,
    }),
  }),
  taskPlanEnded: Events.synced({
    name: 'v1.TaskPlanEnded',
    schema: Schema.Struct({
      taskId: Schema.String,
      planId: Schema.String,
      outcome: Schema.String,
      at: Schema.String,
    }),
  }),
  planTaskCreated: Events.synced({
    name: 'v1.PlanTaskCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      planId: Schema.String,
      row: Schema.Number,
      at: Schema.String,
    }),
  }),
}

export const plansMaterializers = State.SQLite.materializers(plansEvents, {
  'v1.PlanStarted': ({ at, ...plan }) => plans.insert({ ...plan, state: 'queued', createdAt: at }),
  'v1.PlanRenamed': ({ id, title }) => plans.update({ title }).where({ id }),
  'v1.PlanDeleted': ({ id }) => [
    chatAgents.delete().where({ chatId: id }),
    chatCommands.delete().where({ chatId: id }),
    messageDrafts.delete().where({ planId: id }),
    plans.delete().where({ id }),
    planRequests.delete().where({ planId: id }),
    requestSnoozes.delete().where({ ownerId: id }),
    runs.delete().where({ id }),
    runMessages.delete().where({ runId: id }),
    runInterrupts.delete().where({ runId: id }),
  ],
  'v1.PlanRunBegan': ({ id, checkout, at }) =>
    plans.update({ state: 'started', checkout, startedAt: at }).where({ id }),
  'v1.PlanRunResumeQueued': ({ id, error }) =>
    plans.update({ resume: 'queued', error }).where({ id }),
  'v1.PlanRunRevived': ({ id }) => plans.update({ resume: 'done' }).where({ id }),
  'v1.PlanEnded': ({ id, outcome, error, at }) =>
    plans
      .update({
        state: 'ended',
        outcome,
        error,
        finishedAt: at,
        ...(outcome === 'finished' && { archivedAt: at }),
      })
      .where({ id }),
  'v1.PlanArchived': ({ id, withdraw, at }) => [
    plans.update({ archivedAt: at }).where({ id }),
    ...withdraw.flatMap((requestId) => [
      planRequests
        .update({ answer: JSON.stringify({ kind: 'withdrawn', at, runStopped: true }) })
        .where({ id: requestId, planId: id }),
      requestSnoozes.delete().where({ requestId }),
      messageDrafts.delete().where({ key: messageDraftKey('plan-request', requestId) }),
    ]),
  ],
  'v1.PlanUnarchived': ({ id }) => plans.update({ archivedAt: null }).where({ id }),
  'v1.PlanRequestPosted': ({ at, ...request }) =>
    planRequests.insert({ ...request, createdAt: at }),
  'v1.PlanQuestionPosted': ({ at, choices, multiple, ...question }) =>
    planRequests.insert({
      ...question,
      kind: 'question',
      author: 'run',
      choices: JSON.stringify(choices),
      multiple: multiple ? 1 : null,
      createdAt: at,
    }),
  'v1.PlanRequestAnswered': ({ id, answer }) => [
    planRequests.update({ answer }).where({ id }),
    requestSnoozes.delete().where({ requestId: id }),
    messageDrafts.delete().where({ key: messageDraftKey('plan-request', id) }),
  ],
  'v1.PlanTaskCreated': (link) => planTasks.insert(link).onConflict('taskId', 'ignore'),
  'v1.PlanContinued': ({ id, fromPlanId, fromTitle, context }) =>
    plans.update({ fromPlanId, fromPlanTitle: fromTitle, context }).where({ id }),
  'v1.PlanRetried': ({ id, fresh, checkout }) =>
    plans
      .update({
        state: fresh ? 'queued' : 'started',
        resume: fresh ? null : 'queued',
        outcome: null,
        error: null,
        finishedAt: null,
        checkout,
      })
      .where({ id }),
  'v1.PlanStartedFromTask': ({ id, taskId, displayId, taskTitle, sizeCheckId }) =>
    plans
      .update({
        fromTaskId: taskId,
        fromTaskDisplayId: displayId,
        fromTaskTitle: taskTitle,
        sizeCheckId,
      })
      .where({ id }),
  'v1.PlanTaskDetached': ({ id, reason }) => plans.update({ fromTaskGone: reason }).where({ id }),
  'v1.TaskPlanEnded': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
})
