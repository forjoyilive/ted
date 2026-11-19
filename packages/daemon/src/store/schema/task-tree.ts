import { Events, Schema, State } from '@livestore/livestore'
import { taskQueue, tasks } from './tasks.ts'

export const taskBlockers = State.SQLite.table({
  name: 'taskBlockers',
  indexes: [
    { name: 'idx_taskBlockers_taskId', columns: ['taskId'] },
    { name: 'idx_taskBlockers_blockerId', columns: ['blockerId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    blockerId: State.SQLite.text(),
    setByRunId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const taskParents = State.SQLite.table({
  name: 'taskParents',
  indexes: [{ name: 'idx_taskParents_parentId', columns: ['parentId'] }],
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    parentId: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const taskTreeArchives = State.SQLite.table({
  name: 'taskTreeArchives',
  indexes: [{ name: 'idx_taskTreeArchives_rootId', columns: ['rootId'] }],
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    rootId: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const archiveUnblocks = State.SQLite.table({
  name: 'archiveUnblocks',
  indexes: [
    { name: 'idx_archiveUnblocks_blockerId', columns: ['blockerId'] },
    { name: 'idx_archiveUnblocks_taskId', columns: ['taskId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    blockerId: State.SQLite.text(),
    taskId: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const taskTreeEvents = {
  taskParentChanged: Events.synced({
    name: 'v1.TaskParentChanged',
    schema: Schema.Struct({
      taskId: Schema.String,
      parentId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskTreeArchived: Events.synced({
    name: 'v1.TaskTreeArchived',
    schema: Schema.Struct({
      rootId: Schema.String,
      taskIds: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  archiveUnblocked: Events.synced({
    name: 'v1.ArchiveUnblocked',
    schema: Schema.Struct({
      blockerId: Schema.String,
      taskIds: Schema.Array(Schema.String),
      at: Schema.String,
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
  taskSnoozed: Events.synced({
    name: 'v1.TaskSnoozed',
    schema: Schema.Struct({ taskId: Schema.String, until: Schema.String, at: Schema.String }),
  }),
  taskSnoozeCleared: Events.synced({
    name: 'v1.TaskSnoozeCleared',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskStartRequestChanged: Events.synced({
    name: 'v1.TaskStartRequestChanged',
    schema: Schema.Struct({
      taskId: Schema.String,
      startRequested: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  taskBlockersRemovedChanged: Events.synced({
    name: 'v1.TaskBlockersRemovedChanged',
    schema: Schema.Struct({
      taskId: Schema.String,
      removed: Schema.Boolean,
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
  taskRequeuedAfterBlockersV2: Events.synced({
    name: 'v2.TaskRequeuedAfterBlockers',
    schema: Schema.Struct({
      taskId: Schema.String,
      rank: Schema.Number,
      why: Schema.String,
      at: Schema.String,
    }),
  }),
  taskSplitFrom: Events.synced({
    name: 'v1.TaskSplitFrom',
    schema: Schema.Struct({ taskId: Schema.String, originalId: Schema.String, at: Schema.String }),
  }),
  taskSplit: Events.synced({
    name: 'v1.TaskSplit',
    schema: Schema.Struct({
      taskId: Schema.String,
      pieceIds: Schema.Array(Schema.String),
      narrowedTo: Schema.String,
      at: Schema.String,
    }),
  }),
  childTasksCreated: Events.synced({
    name: 'v1.ChildTasksCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      childIds: Schema.Array(Schema.String),
      from: Schema.String,
      at: Schema.String,
    }),
  }),
  parentFinishedWithChildren: Events.synced({
    name: 'v1.ParentFinishedWithChildren',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskNeedsPlanning: Events.synced({
    name: 'v1.TaskNeedsPlanning',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  taskStartedAfterPlanning: Events.synced({
    name: 'v1.TaskStartedAfterPlanning',
    schema: Schema.Struct({
      taskId: Schema.String,
      stage: Schema.String,
      rank: Schema.Number,
      at: Schema.String,
    }),
  }),
}

export const taskTreeMaterializers = State.SQLite.materializers(taskTreeEvents, {
  'v1.TaskParentChanged': ({ taskId, parentId, at }) => [
    parentId === null
      ? taskParents.delete().where({ taskId })
      : taskParents.insert({ taskId, parentId, at }).onConflict('taskId', 'replace'),
    tasks.update({ changedAt: at }).where({ id: taskId }),
  ],
  'v1.TaskTreeArchived': ({ rootId, taskIds, at }) => [
    taskTreeArchives.delete().where({ rootId }),
    ...taskIds.map((taskId) =>
      taskTreeArchives.insert({ taskId, rootId, at }).onConflict('taskId', 'replace'),
    ),
  ],
  'v1.ArchiveUnblocked': ({ blockerId, taskIds, at }) =>
    taskIds.map((taskId) =>
      archiveUnblocks
        .insert({ id: `${blockerId}:${taskId}`, blockerId, taskId, at })
        .onConflict('id', 'replace'),
    ),
  'v1.TaskBlockerAdded': ({ taskId, blockerId, at }) => [
    taskBlockers
      .insert({ id: `${taskId}:${blockerId}`, taskId, blockerId, at })
      .onConflict('id', 'ignore'),
    archiveUnblocks.delete().where({ id: `${blockerId}:${taskId}` }),
  ],
  'v2.TaskBlockerAdded': ({ taskId, blockerId, runId, at }) => [
    taskBlockers
      .insert({ id: `${taskId}:${blockerId}`, taskId, blockerId, setByRunId: runId, at })
      .onConflict('id', 'replace'),
    archiveUnblocks.delete().where({ id: `${blockerId}:${taskId}` }),
  ],
  'v1.TaskBlockerRemoved': ({ taskId, blockerId }) => [
    taskBlockers.delete().where({ id: `${taskId}:${blockerId}` }),
    archiveUnblocks.delete().where({ id: `${blockerId}:${taskId}` }),
  ],
  'v1.TaskSnoozed': ({ taskId, until }) =>
    tasks.update({ snoozedUntil: until, startRequested: false }).where({ id: taskId }),
  'v1.TaskSnoozeCleared': ({ taskId }) =>
    tasks.update({ snoozedUntil: null }).where({ id: taskId }),
  'v1.TaskStartRequestChanged': ({ taskId, startRequested }) =>
    tasks.update({ startRequested }).where({ id: taskId }),
  'v1.TaskBlockersRemovedChanged': ({ taskId, removed }) =>
    tasks.update({ blockersRemoved: removed }).where({ id: taskId }),
  'v1.TaskWaitingForBlockers': ({ taskId }) => [
    taskQueue.delete().where({ taskId }),
    tasks.update({ waitsForBlockers: true }).where({ id: taskId }),
  ],
  'v1.TaskRequeuedAfterBlockers': ({ taskId, rank, at }) => [
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
    tasks.update({ waitsForBlockers: false }).where({ id: taskId }),
  ],
  'v2.TaskRequeuedAfterBlockers': ({ taskId, rank, at }) => [
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
    tasks.update({ waitsForBlockers: false }).where({ id: taskId }),
  ],
  'v1.TaskSplitFrom': ({ taskId, originalId }) =>
    tasks.update({ splitFrom: originalId }).where({ id: taskId }),
  'v1.TaskSplit': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.ChildTasksCreated': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.ParentFinishedWithChildren': ({ taskId, at }) =>
    tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TaskNeedsPlanning': ({ taskId, at }) => [
    taskQueue.delete().where({ taskId }),
    tasks
      .update({ stage: 'backlog', needsPlanningAt: at, activity: null, changedAt: at })
      .where({ id: taskId }),
  ],
  'v1.TaskStartedAfterPlanning': ({ taskId, stage, rank, at }) => [
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
    tasks.update({ stage, needsPlanningAt: null, changedAt: at }).where({ id: taskId }),
  ],
})
