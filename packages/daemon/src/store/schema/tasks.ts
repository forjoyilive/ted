import { Events, Schema, State } from '@livestore/livestore'
import { intervalBoundaries } from '../interval-schema.ts'
import { taskBrowserCaptures } from './apps.ts'
import { automationCheckTasks, automationTaskActions } from './automations.ts'
import {
  checkBoundaries,
  checkResults,
  checkRuns,
  loopChecks,
  p1OnlyReviews,
  reviewers,
  reviewScopes,
  sendBackAsks,
  sendBackResets,
  sendBacks,
  severityDeclarations,
  testInvocations,
} from './checks.ts'
import { failureCases, failureContexts, validationProgress } from './failures.ts'
import { baseConflicts, cleanupReports, pullRequests, taskRepos } from './merge.ts'
import { peerMessages } from './peers.ts'
import {
  commentAttachments,
  comments,
  lineComments,
  messageDrafts,
  requestSnoozes,
  runDraftKey,
  taskAttachments,
  taskBriefs,
} from './requests.ts'
import {
  conversationTabs,
  heldRuns,
  runInterrupts,
  runMessages,
  runs,
  subAgentInstructions,
  subAgentRequests,
} from './runs.ts'
import { task, trackerSyncLog } from './task-log.ts'
import { archiveUnblocks, taskBlockers, taskTreeArchives } from './task-tree.ts'
import { taskSources } from './trackers.ts'

function namedOrder(order: string, names: string): string {
  const named = JSON.parse(names) as Record<string, string>
  const stages = JSON.parse(order) as { stage: string; enabled: boolean }[]
  return JSON.stringify(
    stages.map((planned) =>
      Object.hasOwn(named, planned.stage) ? { ...planned, name: named[planned.stage] } : planned,
    ),
  )
}

const stageEnteredFields = {
  id: Schema.String,
  taskId: Schema.String,
  stage: Schema.String,
  stageFileLayer: Schema.NullOr(Schema.String),
  stageFilePath: Schema.NullOr(Schema.String),
  layers: Schema.String,
  at: Schema.String,
}

function unarchivedRows(taskId: string, rank: number | null, at: string) {
  return [
    taskTreeArchives.delete().where({ taskId }),
    taskTreeArchives.delete().where({ rootId: taskId }),
    ...(rank === null
      ? []
      : [taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace')]),
    tasks
      .update({
        archivedAt: null,
        failedAt: null,
        stoppedAt: null,
        stoppedRuns: null,
        stoppedWhy: null,
        waitsForBlockers: false,
        changedAt: at,
      })
      .where({ id: taskId }),
  ]
}

export const tasks = State.SQLite.table({
  name: 'tasks',
  indexes: [
    { name: 'idx_tasks_number', columns: ['number'] },
    { name: 'idx_tasks_factoryId', columns: ['factoryId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    title: State.SQLite.text(),
    description: State.SQLite.text({ default: '' }),
    priority: State.SQLite.text({ default: 'none' }),
    clarifyDepth: State.SQLite.text({ default: 'auto' }),
    clarifyDepthBy: State.SQLite.text({ nullable: true }),
    leadAgent: State.SQLite.text({ nullable: true }),
    leadModel: State.SQLite.text({ nullable: true }),
    leadEffort: State.SQLite.text({ nullable: true }),
    snoozedUntil: State.SQLite.text({ nullable: true }),
    leadEffortMode: State.SQLite.text({ nullable: true }),
    stageEffort: State.SQLite.text({ nullable: true }),
    pendingLeadMessage: State.SQLite.text({ nullable: true }),
    pendingLeadDeliveries: State.SQLite.text({ nullable: true }),
    leadRestartPending: State.SQLite.boolean({ default: false }),
    startRequested: State.SQLite.boolean({ default: false }),
    waitsForBlockers: State.SQLite.boolean({ default: false }),
    blockersRemoved: State.SQLite.boolean({ default: false }),
    stage: State.SQLite.text({ default: 'backlog' }),
    branch: State.SQLite.text({ nullable: true }),
    worktree: State.SQLite.text({ nullable: true }),
    chosenRepos: State.SQLite.text({ nullable: true }),
    activity: State.SQLite.text({ nullable: true }),
    activityEntries: State.SQLite.integer({ nullable: true }),
    rank: State.SQLite.real({ nullable: true }),
    changedAt: State.SQLite.text({ nullable: true }),
    archivedAt: State.SQLite.text({ nullable: true }),
    stoppedAt: State.SQLite.text({ nullable: true }),
    stoppedRuns: State.SQLite.integer({ nullable: true }),
    stoppedWhy: State.SQLite.text({ nullable: true }),
    preparation: State.SQLite.text({ nullable: true }),
    failedAt: State.SQLite.text({ nullable: true }),
    followUpOf: State.SQLite.text({ nullable: true }),
    forcedGates: State.SQLite.text({ nullable: true }),
    gateOverrides: State.SQLite.text({ nullable: true }),
    autopilotChoice: State.SQLite.text({ nullable: true }),
    changesSettings: State.SQLite.boolean({ default: false }),
    splitFrom: State.SQLite.text({ nullable: true }),
    needsPlanningAt: State.SQLite.text({ nullable: true }),
    partlyMergedAt: State.SQLite.text({ nullable: true }),
    setup: State.SQLite.boolean({ default: false }),
    coordinatorOperation: State.SQLite.text({ nullable: true }),
    createdByTask: State.SQLite.text({ nullable: true }),
    createdByRun: State.SQLite.text({ nullable: true }),
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

export const deletedTasks = State.SQLite.table({
  name: 'deletedTasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    at: State.SQLite.text(),
  },
})

export const taskMoves = State.SQLite.table({
  name: 'taskMoves',
  indexes: [
    { name: 'idx_taskMoves_taskId', columns: ['taskId'] },
    { name: 'idx_taskMoves_factoryId', columns: ['factoryId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    at: State.SQLite.text(),
  },
})

export const taskLog = State.SQLite.table({
  name: 'taskLog',
  indexes: [{ name: 'idx_taskLog_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    name: State.SQLite.text(),
    data: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const taskDescriptions = State.SQLite.table({
  name: 'taskDescriptions',
  indexes: [{ name: 'idx_taskDescriptions_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    version: State.SQLite.integer(),
    text: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const stageEntries = State.SQLite.table({
  name: 'stageEntries',
  indexes: [{ name: 'idx_stageEntries_taskId', columns: ['taskId'] }],
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

export const stageFileTexts = State.SQLite.table({
  name: 'stageFileTexts',
  columns: {
    hash: State.SQLite.text({ primaryKey: true }),
    layer: State.SQLite.text(),
    stage: State.SQLite.text(),
    text: State.SQLite.text(),
    tedVersion: State.SQLite.text(),
    seenAt: State.SQLite.text(),
  },
})

export const tasksEvents = {
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
  taskPreparationChanged: Events.synced({
    name: 'v1.TaskPreparationChanged',
    schema: Schema.Struct({
      taskId: Schema.String,
      state: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskStopped: Events.synced({
    name: 'v1.TaskStopped',
    schema: Schema.Struct({
      taskId: Schema.String,
      runs: Schema.Number,
      why: Schema.String,
      at: Schema.String,
    }),
  }),
  taskResumedOvernight: Events.synced({
    name: 'v1.TaskResumedOvernight',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskResumed: Events.synced({
    name: 'v1.TaskResumed',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskStoppedByTed: Events.synced({
    name: 'v1.TaskStoppedByTed',
    schema: Schema.Struct({
      taskId: Schema.String,
      runId: Schema.String,
      cause: Schema.String,
      at: Schema.String,
    }),
  }),
  tedStopAnswered: Events.synced({
    name: 'v1.TedStopAnswered',
    schema: Schema.Struct({ taskId: Schema.String, choice: Schema.String, at: Schema.String }),
  }),
  taskLeadNudged: Events.synced({
    name: 'v1.TaskLeadNudged',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  taskFollowsUp: Events.synced({
    name: 'v1.TaskFollowsUp',
    schema: Schema.Struct({ taskId: Schema.String, originalId: Schema.String, at: Schema.String }),
  }),
  taskAutopilotChanged: Events.synced({
    name: 'v1.TaskAutopilotChanged',
    schema: Schema.Struct({ taskId: Schema.String, choice: Schema.String, at: Schema.String }),
  }),
  taskGatesChanged: Events.synced({
    name: 'v1.TaskGatesChanged',
    schema: Schema.Struct({ taskId: Schema.String, overrides: Schema.String, at: Schema.String }),
  }),
  taskGatesForced: Events.synced({
    name: 'v1.TaskGatesForced',
    schema: Schema.Struct({
      taskId: Schema.String,
      stages: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskChangesSettings: Events.synced({
    name: 'v1.TaskChangesSettings',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  stageFileTextSeen: Events.synced({
    name: 'v1.StageFileTextSeen',
    schema: Schema.Struct({
      hash: Schema.String,
      layer: Schema.String,
      stage: Schema.String,
      text: Schema.String,
      tedVersion: Schema.String,
      at: Schema.String,
    }),
  }),
  taskFollowedUp: Events.synced({
    name: 'v1.TaskFollowedUp',
    schema: Schema.Struct({ taskId: Schema.String, followUpId: Schema.String, at: Schema.String }),
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
  taskStartCause: Events.synced({
    name: 'v1.TaskStartCause',
    schema: Schema.Struct({
      taskId: Schema.String,
      cause: Schema.String,
      blockers: Schema.Array(Schema.String),
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
  taskArchivedV2: Events.synced({
    name: 'v2.TaskArchived',
    schema: Schema.Struct({
      taskId: Schema.String,
      closing: Schema.Array(Schema.String),
      branches: Schema.Number,
      at: Schema.String,
    }),
  }),
  taskArchivedV3: Events.synced({
    name: 'v3.TaskArchived',
    schema: Schema.Struct({
      taskId: Schema.String,
      closing: Schema.Array(Schema.String),
      branches: Schema.Number,
      why: Schema.String,
      at: Schema.String,
    }),
  }),
  taskUnarchived: Events.synced({
    name: 'v1.TaskUnarchived',
    schema: Schema.Struct({
      taskId: Schema.String,
      rank: Schema.NullOr(Schema.Number),
      at: Schema.String,
    }),
  }),
  taskUnarchivedV2: Events.synced({
    name: 'v2.TaskUnarchived',
    schema: Schema.Struct({
      taskId: Schema.String,
      rank: Schema.NullOr(Schema.Number),
      reblocked: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskDeleted: Events.synced({
    name: 'v1.TaskDeleted',
    schema: Schema.Struct({
      taskId: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      runIds: Schema.Array(Schema.String),
      checkRunIds: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskReset: Events.synced({
    name: 'v1.TaskReset',
    schema: Schema.Struct({
      taskId: Schema.String,
      description: Schema.String,
      clarifyDepth: Schema.String,
      clarifyDepthBy: Schema.NullOr(Schema.String),
      runIds: Schema.Array(Schema.String),
      checkRunIds: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskMovedToFactory: Events.synced({
    name: 'v1.TaskMovedToFactory',
    schema: Schema.Struct({
      taskId: Schema.String,
      fromFactoryId: Schema.String,
      fromNumber: Schema.Number,
      fromDisplayId: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      by: Schema.String,
      started: Schema.Boolean,
      checkRunIds: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskEdited: Events.synced({
    name: 'v1.TaskEdited',
    schema: Schema.Struct({
      taskId: Schema.String,
      title: Schema.NullOr(Schema.String),
      description: Schema.NullOr(Schema.String),
      version: Schema.NullOr(Schema.Number),
      previous: Schema.NullOr(Schema.String),
      previousAt: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskStageChanged: Events.synced({
    name: 'v1.TaskStageChanged',
    schema: Schema.Struct({ taskId: Schema.String, stage: Schema.String, at: Schema.String }),
  }),
  clarifyDepthSet: Events.synced({
    name: 'v1.ClarifyDepthSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      depth: Schema.String,
      by: Schema.String,
      runId: Schema.NullOr(Schema.String),
      why: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskStageEntered: Events.synced({
    name: 'v1.TaskStageEntered',
    schema: Schema.Struct(stageEnteredFields),
  }),
  taskStageEnteredV3: Events.synced({
    name: 'v3.TaskStageEntered',
    schema: Schema.Struct({
      ...stageEnteredFields,
      order: Schema.String,
      effort: Schema.NullOr(Schema.String),
    }),
  }),
  taskStageEnteredV4: Events.synced({
    name: 'v4.TaskStageEntered',
    schema: Schema.Struct({
      ...stageEnteredFields,
      order: Schema.String,
      names: Schema.String,
      effort: Schema.NullOr(Schema.String),
    }),
  }),
  taskLeadEffortModeSet: Events.synced({
    name: 'v1.TaskLeadEffortModeSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      mode: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskLeadRestartPendingSet: Events.synced({
    name: 'v1.TaskLeadRestartPendingSet',
    schema: Schema.Struct({ taskId: Schema.String, pending: Schema.Boolean, at: Schema.String }),
  }),
  taskLeadMessageHeld: Events.synced({
    name: 'v1.TaskLeadMessageHeld',
    schema: Schema.Struct({
      taskId: Schema.String,
      text: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskLeadMessagesHeld: Events.synced({
    name: 'v1.TaskLeadMessagesHeld',
    schema: Schema.Struct({ taskId: Schema.String, messages: Schema.String, at: Schema.String }),
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
  taskLeadFailed: Events.synced({
    name: 'v1.TaskLeadFailed',
    schema: Schema.Struct({
      taskId: Schema.String,
      runId: Schema.String,
      reason: Schema.String,
      recovery: Schema.String,
      resumeFailed: Schema.Boolean,
      rank: Schema.NullOr(Schema.Number),
      ask: Schema.NullOr(
        Schema.Struct({ id: Schema.String, title: Schema.String, body: Schema.String }),
      ),
      at: Schema.String,
    }),
  }),
  taskRetried: Events.synced({
    name: 'v1.TaskRetried',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskCreatedByCoordinator: Events.synced({
    name: 'v1.TaskCreatedByCoordinator',
    schema: Schema.Struct({
      taskId: Schema.String,
      factoryId: Schema.String,
      operation: Schema.String,
      at: Schema.String,
    }),
  }),
  taskCreatedByTaskLead: Events.synced({
    name: 'v1.TaskCreatedByTaskLead',
    schema: Schema.Struct({
      taskId: Schema.String,
      creatorId: Schema.String,
      runId: Schema.String,
      child: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  taskLeadCreatedTask: Events.synced({
    name: 'v1.TaskLeadCreatedTask',
    schema: Schema.Struct({
      taskId: Schema.String,
      createdId: Schema.String,
      runId: Schema.String,
      child: Schema.Boolean,
      at: Schema.String,
    }),
  }),
}

export const tasksMaterializers = State.SQLite.materializers(tasksEvents, {
  'v1.TaskCreated': (task) => tasks.insert({ ...task, stage: 'backlog' }),
  'v2.TaskCreated': (task) => tasks.insert({ ...task, stage: 'backlog' }),
  'v1.TaskPreparationChanged': ({ taskId, state, at }) =>
    tasks.update({ preparation: state, changedAt: at }).where({ id: taskId }),
  'v1.TaskStopped': ({ taskId, runs, why, at }) => [
    runMessages
      .update({ deletedAt: at, queued: false })
      .where({ taskId, roundId: { op: '!=', value: null }, queued: true }),
    comments.update({ talkRequested: false, talkMessageId: null }).where({ taskId }),
    taskQueue.delete().where({ taskId }),
    tasks
      .update({
        stoppedAt: at,
        stoppedRuns: runs,
        stoppedWhy: why,
        waitsForBlockers: false,
        changedAt: at,
      })
      .where({ id: taskId }),
  ],
  'v1.TaskResumedOvernight': ({ taskId, rank, at }) => [
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
    tasks
      .update({ stoppedAt: null, stoppedRuns: null, stoppedWhy: null, changedAt: at })
      .where({ id: taskId }),
  ],
  'v1.TaskResumed': ({ taskId, rank, at }) => [
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
    tasks
      .update({ stoppedAt: null, stoppedRuns: null, stoppedWhy: null, changedAt: at })
      .where({ id: taskId }),
  ],
  'v1.TaskStoppedByTed': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TedStopAnswered': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TaskLeadNudged': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TaskCreatedByCoordinator': ({ taskId, operation }) =>
    tasks.update({ coordinatorOperation: operation }).where({ id: taskId }),
  'v1.TaskCreatedByTaskLead': ({ taskId, creatorId, runId }) =>
    tasks.update({ createdByTask: creatorId, createdByRun: runId }).where({ id: taskId }),
  'v1.TaskLeadCreatedTask': ({ taskId, at }) =>
    tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TaskFollowsUp': ({ taskId, originalId }) =>
    tasks.update({ followUpOf: originalId }).where({ id: taskId }),
  'v1.TaskAutopilotChanged': ({ taskId, choice, at }) =>
    tasks.update({ autopilotChoice: choice, changedAt: at }).where({ id: taskId }),
  'v1.TaskGatesChanged': ({ taskId, overrides, at }) =>
    tasks.update({ gateOverrides: overrides, changedAt: at }).where({ id: taskId }),
  'v1.TaskGatesForced': ({ taskId, stages }) =>
    tasks.update({ forcedGates: JSON.stringify(stages) }).where({ id: taskId }),
  'v1.TaskChangesSettings': ({ taskId }) =>
    tasks.update({ changesSettings: true }).where({ id: taskId }),
  'v1.StageFileTextSeen': ({ at, ...seen }) =>
    stageFileTexts.insert({ ...seen, seenAt: at }).onConflict('hash', 'ignore'),
  'v1.TaskFollowedUp': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TaskStarted': ({ taskId, stage, branch, worktree }) =>
    tasks.update({ stage, branch, worktree }).where({ id: taskId }),
  'v1.TaskStageChanged': ({ taskId, stage }) => tasks.update({ stage }).where({ id: taskId }),
  'v1.TaskQueued': ({ taskId, stage, rank, at }) => [
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
    tasks.update({ stage }).where({ id: taskId }),
  ],
  'v1.TaskStartCause': () => [],
  'v1.TaskDequeued': ({ taskId }) => taskQueue.delete().where({ taskId }),
  'v1.TaskMovedToBacklog': ({ taskId }) => [
    taskQueue.delete().where({ taskId }),
    tasks.update({ stage: 'backlog' }).where({ id: taskId }),
  ],
  'v1.TaskRanked': ({ taskId, rank }) => [
    tasks.update({ rank }).where({ id: taskId }),
    taskQueue.update({ rank }).where({ taskId }),
  ],
  'v1.TaskEdited': ({ taskId, title, description, version, previous, previousAt, at }) => [
    tasks
      .update({
        ...(title !== null && { title }),
        ...(description !== null && { description }),
        changedAt: at,
      })
      .where({ id: taskId }),
    ...(description === null || version === null
      ? []
      : [
          ...(previous === null || previousAt === null
            ? []
            : [
                taskDescriptions
                  .insert({
                    id: `${taskId}:${version - 1}`,
                    taskId,
                    version: version - 1,
                    text: previous,
                    at: previousAt,
                  })
                  .onConflict('id', 'ignore'),
              ]),
          taskDescriptions
            .insert({ id: `${taskId}:${version}`, taskId, version, text: description, at })
            .onConflict('id', 'replace'),
        ]),
  ],
  'v1.TaskPriorityChanged': ({ taskId, priority, at }) =>
    tasks.update({ priority, changedAt: at }).where({ id: taskId }),
  'v1.TaskArchived': ({ taskId, at }) => [
    runMessages
      .update({ deletedAt: at, queued: false })
      .where({ taskId, roundId: { op: '!=', value: null }, queued: true }),
    comments.update({ talkRequested: false, talkMessageId: null }).where({ taskId }),
    taskQueue.delete().where({ taskId }),
    messageDrafts.delete().where({ taskId }),
    tasks.update({ archivedAt: at, changedAt: at }).where({ id: taskId }),
  ],
  'v2.TaskArchived': ({ taskId, at }) => [
    runMessages
      .update({ deletedAt: at, queued: false })
      .where({ taskId, roundId: { op: '!=', value: null }, queued: true }),
    comments.update({ talkRequested: false, talkMessageId: null }).where({ taskId }),
    taskQueue.delete().where({ taskId }),
    messageDrafts.delete().where({ taskId }),
    tasks.update({ archivedAt: at, changedAt: at }).where({ id: taskId }),
  ],
  'v3.TaskArchived': ({ taskId, at }) => [
    runMessages
      .update({ deletedAt: at, queued: false })
      .where({ taskId, roundId: { op: '!=', value: null }, queued: true }),
    comments.update({ talkRequested: false, talkMessageId: null }).where({ taskId }),
    taskQueue.delete().where({ taskId }),
    messageDrafts.delete().where({ taskId }),
    tasks.update({ archivedAt: at, changedAt: at }).where({ id: taskId }),
  ],
  'v1.TaskUnarchived': ({ taskId, rank, at }) => unarchivedRows(taskId, rank, at),
  'v2.TaskUnarchived': ({ taskId, rank, at }) => [
    ...unarchivedRows(taskId, rank, at),
    archiveUnblocks.delete().where({ blockerId: taskId }),
  ],
  'v1.TaskDeleted': ({ taskId, factoryId, number, runIds, checkRunIds, at }) => [
    deletedTasks.insert({ id: taskId, factoryId, number, at }).onConflict('id', 'ignore'),
    tasks.delete().where({ id: taskId }),
    taskQueue.delete().where({ taskId }),
    taskBlockers.delete().where({ taskId }),
    taskTreeArchives.delete().where({ taskId }),
    taskTreeArchives.delete().where({ rootId: taskId }),
    archiveUnblocks.delete().where({ taskId }),
    archiveUnblocks.delete().where({ blockerId: taskId }),
    taskAttachments.delete().where({ taskId }),
    taskBrowserCaptures.delete().where({ taskId }),
    commentAttachments.delete().where({ taskId }),
    lineComments.delete().where({ taskId }),
    taskSources.delete().where({ taskId }),
    runs.delete().where({ taskId }),
    subAgentRequests.delete().where({ taskId }),
    subAgentInstructions.delete().where({ taskId }),
    conversationTabs.delete().where({ taskId }),
    comments.delete().where({ taskId }),
    requestSnoozes.delete().where({ ownerId: taskId }),
    taskLog.delete().where({ taskId }),
    taskBriefs.delete().where({ taskId }),
    peerMessages.delete().where({ recipientTaskId: taskId }),
    taskDescriptions.delete().where({ taskId }),
    sendBacks.delete().where({ taskId }),
    reviewScopes.delete().where({ taskId }),
    baseConflicts.delete().where({ taskId }),
    cleanupReports.delete().where({ taskId }),
    p1OnlyReviews.delete().where({ taskId }),
    severityDeclarations.delete().where({ taskId }),
    sendBackResets.delete().where({ taskId }),
    checkRuns.delete().where({ taskId }),
    testInvocations.delete().where({ taskId }),
    failureCases.delete().where({ taskId }),
    validationProgress.delete().where({ taskId }),
    failureContexts.delete().where({ taskId }),
    stageEntries.delete().where({ taskId }),
    taskRepos.delete().where({ taskId }),
    pullRequests.delete().where({ taskId }),
    heldRuns.delete().where({ taskId }),
    messageDrafts.delete().where({ taskId }),
    automationCheckTasks.delete().where({ taskId }),
    automationTaskActions.delete().where({ taskId }),
    ...(runIds.length === 0
      ? []
      : [
          messageDrafts.delete().where({ key: { op: 'IN', value: runIds.map(runDraftKey) } }),
          runs.delete().where({ id: { op: 'IN', value: runIds } }),
          runMessages.delete().where({ runId: { op: 'IN', value: runIds } }),
          runInterrupts.delete().where({ runId: { op: 'IN', value: runIds } }),
        ]),
    ...(checkRunIds.length === 0
      ? []
      : [
          checkResults.delete().where({ checkRunId: { op: 'IN', value: checkRunIds } }),
          checkBoundaries.delete().where({ checkRunId: { op: 'IN', value: checkRunIds } }),
        ]),
  ],
  'v1.TaskReset': ({
    taskId,
    description,
    clarifyDepth,
    clarifyDepthBy,
    runIds,
    checkRunIds,
    at,
  }) => [
    tasks
      .update({
        description,
        clarifyDepth,
        clarifyDepthBy,
        stage: 'backlog',
        branch: null,
        worktree: null,
        activity: null,
        activityEntries: null,
        stageEffort: null,
        pendingLeadMessage: null,
        pendingLeadDeliveries: null,
        leadRestartPending: false,
        startRequested: false,
        waitsForBlockers: false,
        blockersRemoved: false,
        snoozedUntil: null,
        stoppedAt: null,
        stoppedRuns: null,
        stoppedWhy: null,
        preparation: null,
        failedAt: null,
        needsPlanningAt: null,
        changedAt: at,
      })
      .where({ id: taskId }),
    taskQueue.delete().where({ taskId }),
    taskBrowserCaptures.delete().where({ taskId }),
    commentAttachments.delete().where({ taskId }),
    lineComments.delete().where({ taskId }),
    runs.delete().where({ taskId }),
    subAgentRequests.delete().where({ taskId }),
    subAgentInstructions.delete().where({ taskId }),
    reviewers.delete().where({ taskId }),
    loopChecks.delete().where({ taskId }),
    sendBackAsks.delete().where({ taskId }),
    conversationTabs.delete().where({ taskId }),
    comments.delete().where({ taskId }),
    requestSnoozes.delete().where({ ownerId: taskId }),
    messageDrafts.delete().where({ taskId }),
    taskLog.delete().where({ taskId, name: { op: 'NOT IN', value: trackerSyncLog } }),
    taskBriefs.delete().where({ taskId }),
    peerMessages.delete().where({ recipientTaskId: taskId }),
    taskDescriptions.delete().where({ taskId }),
    sendBacks.delete().where({ taskId }),
    reviewScopes.delete().where({ taskId }),
    taskTreeArchives.delete().where({ rootId: taskId }),
    taskTreeArchives.delete().where({ taskId }),
    baseConflicts.delete().where({ taskId }),
    cleanupReports.delete().where({ taskId }),
    p1OnlyReviews.delete().where({ taskId }),
    severityDeclarations.delete().where({ taskId }),
    sendBackResets.delete().where({ taskId }),
    checkRuns.delete().where({ taskId }),
    testInvocations.delete().where({ taskId }),
    failureCases.delete().where({ taskId }),
    validationProgress.delete().where({ taskId }),
    failureContexts.delete().where({ taskId }),
    stageEntries.delete().where({ taskId }),
    taskRepos.delete().where({ taskId }),
    pullRequests.delete().where({ taskId }),
    heldRuns.delete().where({ taskId }),
    intervalBoundaries.delete().where({ subject: `task:${taskId}` }),
    ...(runIds.length === 0
      ? []
      : [
          runs.delete().where({ id: { op: 'IN', value: runIds } }),
          runMessages.delete().where({ runId: { op: 'IN', value: runIds } }),
          runInterrupts.delete().where({ runId: { op: 'IN', value: runIds } }),
          messageDrafts.delete().where({ key: { op: 'IN', value: runIds.map(runDraftKey) } }),
          intervalBoundaries
            .delete()
            .where({ subject: { op: 'IN', value: runIds.map((id) => `run:${id}`) } }),
        ]),
    ...(checkRunIds.length === 0
      ? []
      : [
          checkResults.delete().where({ checkRunId: { op: 'IN', value: checkRunIds } }),
          checkBoundaries.delete().where({ checkRunId: { op: 'IN', value: checkRunIds } }),
        ]),
  ],
  'v1.TaskMovedToFactory': ({
    taskId,
    fromFactoryId,
    fromNumber,
    factoryId,
    number,
    checkRunIds,
    at,
  }) => [
    tasks
      .update({
        factoryId,
        number,
        stage: 'backlog',
        branch: null,
        worktree: null,
        chosenRepos: null,
        changesSettings: false,
        activity: null,
        activityEntries: null,
        stageEffort: null,
        pendingLeadMessage: null,
        pendingLeadDeliveries: null,
        leadRestartPending: false,
        startRequested: false,
        waitsForBlockers: false,
        blockersRemoved: false,
        snoozedUntil: null,
        stoppedAt: null,
        stoppedRuns: null,
        stoppedWhy: null,
        preparation: null,
        failedAt: null,
        needsPlanningAt: null,
        partlyMergedAt: null,
        changedAt: at,
      })
      .where({ id: taskId }),
    taskMoves
      .insert({
        id: `${taskId}:${fromFactoryId}:${fromNumber}`,
        taskId,
        factoryId: fromFactoryId,
        number: fromNumber,
        at,
      })
      .onConflict('id', 'ignore'),
    taskQueue.delete().where({ taskId }),
    taskBrowserCaptures.delete().where({ taskId }),
    lineComments.delete().where({ taskId }),
    subAgentRequests.delete().where({ taskId }),
    reviewers.delete().where({ taskId }),
    loopChecks.delete().where({ taskId }),
    sendBackAsks.delete().where({ taskId }),
    requestSnoozes.delete().where({ ownerId: taskId }),
    messageDrafts.update({ factoryId }).where({ taskId }),
    taskLog.delete().where({ taskId, name: { op: 'IN', value: trackerSyncLog } }),
    peerMessages.delete().where({ recipientTaskId: taskId }),
    peerMessages.delete().where({ senderTaskId: taskId }),
    sendBacks.delete().where({ taskId }),
    reviewScopes.delete().where({ taskId }),
    taskTreeArchives.delete().where({ rootId: taskId }),
    taskTreeArchives.delete().where({ taskId }),
    archiveUnblocks.delete().where({ taskId }),
    archiveUnblocks.delete().where({ blockerId: taskId }),
    baseConflicts.delete().where({ taskId }),
    cleanupReports.delete().where({ taskId }),
    p1OnlyReviews.delete().where({ taskId }),
    severityDeclarations.delete().where({ taskId }),
    sendBackResets.delete().where({ taskId }),
    checkRuns.delete().where({ taskId }),
    testInvocations.delete().where({ taskId }),
    failureCases.delete().where({ taskId }),
    validationProgress.delete().where({ taskId }),
    failureContexts.delete().where({ taskId }),
    stageEntries.delete().where({ taskId }),
    taskRepos.delete().where({ taskId }),
    pullRequests.delete().where({ taskId }),
    heldRuns.delete().where({ taskId }),
    ...(checkRunIds.length === 0
      ? []
      : [
          checkResults.delete().where({ checkRunId: { op: 'IN', value: checkRunIds } }),
          checkBoundaries.delete().where({ checkRunId: { op: 'IN', value: checkRunIds } }),
        ]),
  ],
  'v1.ClarifyDepthSet': ({ taskId, depth, by, at }) =>
    tasks.update({ clarifyDepth: depth, clarifyDepthBy: by, changedAt: at }).where({ id: taskId }),
  'v1.TaskLeadSet': ({ taskId, agent, model, effort }) =>
    tasks.update({ leadAgent: agent, leadModel: model, leadEffort: effort }).where({ id: taskId }),
  'v1.TaskLeadFailed': ({ taskId, runId, recovery, rank, ask, at }) => [
    ...(recovery === 'fresh' && rank !== null
      ? [taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace')]
      : []),
    tasks
      .update({ changedAt: at, ...(recovery === 'failed' && { failedAt: at }) })
      .where({ id: taskId }),
    ...(ask === null
      ? []
      : [
          comments.insert({
            id: ask.id,
            taskId,
            kind: 'question',
            body: ask.body,
            title: ask.title,
            choices: JSON.stringify(['Retry']),
            authorKind: 'ted',
            authorRunId: null,
            failedRunId: runId,
            createdAt: at,
          }),
        ]),
  ],
  'v1.TaskRetried': ({ taskId, rank, at }) => [
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
    tasks
      .update({
        failedAt: null,
        stoppedAt: null,
        stoppedRuns: null,
        stoppedWhy: null,
        changedAt: at,
      })
      .where({ id: taskId }),
  ],
  'v1.TaskStageEntered': (entry) => stageEntries.insert(entry),
  'v2.TaskStageEntered': (entry) => stageEntries.insert(entry),
  'v3.TaskStageEntered': ({ effort, ...entry }) => [
    stageEntries.insert(entry),
    tasks.update({ stageEffort: effort }).where({ id: entry.taskId }),
  ],
  'v4.TaskStageEntered': ({ effort, names, order, ...entry }) => [
    stageEntries.insert({ ...entry, order: namedOrder(order, names) }),
    tasks.update({ stageEffort: effort }).where({ id: entry.taskId }),
  ],
  'v1.TaskLeadEffortModeSet': ({ taskId, mode }) =>
    tasks.update({ leadEffortMode: mode }).where({ id: taskId }),
  'v1.TaskLeadRestartPendingSet': ({ taskId, pending }) =>
    tasks.update({ leadRestartPending: pending }).where({ id: taskId }),
  'v1.TaskLeadMessageHeld': ({ taskId, text }) =>
    tasks.update({ pendingLeadMessage: text }).where({ id: taskId }),
  'v1.TaskLeadMessagesHeld': ({ taskId, messages }) =>
    tasks
      .update({ pendingLeadDeliveries: messages, pendingLeadMessage: null })
      .where({ id: taskId }),
  'v1.TaskActivitySet': ({ taskId, text, stageEntries: count }) =>
    tasks.update({ activity: text, activityEntries: count }).where({ id: taskId }),
  'v1.WorkflowLayerAccepted': ({ layer, files, version, at }) =>
    workflowLayers.insert({ layer, files, version, acceptedAt: at }).onConflict('layer', 'replace'),
})
