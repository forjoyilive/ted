import { Events, Schema, State } from '@livestore/livestore'
import { taskQueue } from './tasks.ts'

const gitHubNotice = Schema.Struct({
  key: Schema.String,
  sig: Schema.String,
  kind: Schema.String,
  where: Schema.String,
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
    sentryShortId: State.SQLite.text({ nullable: true }),
    asana: State.SQLite.text({ nullable: true }),
    github: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const trackersEvents = {
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
  taskSourceSentrySet: Events.synced({
    name: 'v1.TaskSourceSentrySet',
    schema: Schema.Struct({ taskId: Schema.String, shortId: Schema.String, at: Schema.String }),
  }),
  taskSourceAsanaSet: Events.synced({
    name: 'v1.TaskSourceAsanaSet',
    schema: Schema.Struct({ taskId: Schema.String, asana: Schema.String, at: Schema.String }),
  }),
  taskSourceGitHubSet: Events.synced({
    name: 'v1.TaskSourceGitHubSet',
    schema: Schema.Struct({ taskId: Schema.String, github: Schema.String, at: Schema.String }),
  }),
  linearIssueSeen: Events.synced({
    name: 'v1.LinearIssueSeen',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      stateType: Schema.String,
      state: Schema.String,
      team: Schema.String,
      at: Schema.String,
    }),
  }),
  linearIssueMoved: Events.synced({
    name: 'v1.LinearIssueMoved',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      step: Schema.String,
      state: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  linearSyncAllowed: Events.synced({
    name: 'v1.LinearSyncAllowed',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      by: Schema.String,
      at: Schema.String,
    }),
  }),
  linearTeamSyncAllowed: Events.synced({
    name: 'v1.LinearTeamSyncAllowed',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      team: Schema.String,
      at: Schema.String,
    }),
  }),
  linearPullRequestsLinked: Events.synced({
    name: 'v1.LinearPullRequestsLinked',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      urls: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  trackerItemSeen: Events.synced({
    name: 'v1.TrackerItemSeen',
    schema: Schema.Struct({
      taskId: Schema.String,
      tracker: Schema.String,
      item: Schema.String,
      closed: Schema.Boolean,
      state: Schema.String,
      group: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  trackerItemGroupsSeen: Events.synced({
    name: 'v1.TrackerItemGroupsSeen',
    schema: Schema.Struct({
      taskId: Schema.String,
      tracker: Schema.String,
      item: Schema.String,
      groups: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  trackerItemMoved: Events.synced({
    name: 'v1.TrackerItemMoved',
    schema: Schema.Struct({
      taskId: Schema.String,
      tracker: Schema.String,
      item: Schema.String,
      step: Schema.String,
      state: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  trackerSyncAllowed: Events.synced({
    name: 'v1.TrackerSyncAllowed',
    schema: Schema.Struct({
      taskId: Schema.String,
      tracker: Schema.String,
      item: Schema.String,
      by: Schema.String,
      account: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  trackerSyncDeclined: Events.synced({
    name: 'v1.TrackerSyncDeclined',
    schema: Schema.Struct({
      taskId: Schema.String,
      tracker: Schema.String,
      item: Schema.String,
      at: Schema.String,
    }),
  }),
  trackerGroupSyncAllowed: Events.synced({
    name: 'v1.TrackerGroupSyncAllowed',
    schema: Schema.Struct({
      taskId: Schema.String,
      tracker: Schema.String,
      item: Schema.String,
      group: Schema.String,
      account: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  trackerPullRequestsLinked: Events.synced({
    name: 'v1.TrackerPullRequestsLinked',
    schema: Schema.Struct({
      taskId: Schema.String,
      tracker: Schema.String,
      item: Schema.String,
      urls: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  gitHubActivitySent: Events.synced({
    name: 'v1.GitHubActivitySent',
    schema: Schema.Struct({
      taskId: Schema.String,
      runId: Schema.String,
      notices: Schema.Array(gitHubNotice),
      at: Schema.String,
    }),
  }),
  gitHubActivityHeld: Events.synced({
    name: 'v1.GitHubActivityHeld',
    schema: Schema.Struct({
      taskId: Schema.String,
      notices: Schema.Array(gitHubNotice),
      at: Schema.String,
    }),
  }),
  gitHubActivityQueued: Events.synced({
    name: 'v1.GitHubActivityQueued',
    schema: Schema.Struct({
      taskId: Schema.String,
      rank: Schema.Number,
      notices: Schema.Array(gitHubNotice),
      at: Schema.String,
    }),
  }),
}

export const trackersMaterializers = State.SQLite.materializers(trackersEvents, {
  'v1.GitHubActivitySent': () => [],
  'v1.LinearIssueSeen': () => [],
  'v1.LinearSyncAllowed': () => [],
  'v1.LinearTeamSyncAllowed': () => [],
  'v1.LinearIssueMoved': () => [],
  'v1.LinearPullRequestsLinked': () => [],
  'v1.TrackerItemSeen': () => [],
  'v1.TrackerItemGroupsSeen': () => [],
  'v1.TrackerItemMoved': () => [],
  'v1.TrackerSyncAllowed': () => [],
  'v1.TrackerSyncDeclined': () => [],
  'v1.TrackerGroupSyncAllowed': () => [],
  'v1.TrackerPullRequestsLinked': () => [],
  'v1.GitHubActivityHeld': () => [],
  'v1.GitHubActivityQueued': ({ taskId, rank, at }) =>
    taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
  'v1.TaskSourceSet': (source) => taskSources.insert(source).onConflict('taskId', 'replace'),
  'v1.TaskSourceSentrySet': ({ taskId, shortId }) =>
    taskSources.update({ sentryShortId: shortId }).where({ taskId }),
  'v1.TaskSourceAsanaSet': ({ taskId, asana }) => taskSources.update({ asana }).where({ taskId }),
  'v1.TaskSourceGitHubSet': ({ taskId, github }) =>
    taskSources.update({ github }).where({ taskId }),
})
