import { Events, Schema, State } from '@livestore/livestore'
import { runMessages } from './runs.ts'

export const messageDraftKey = (kind: string, id: string): string => `${kind}:${id}`

export const runDraftKey = (id: string): string => messageDraftKey('run', id)

export const taskDrafts = State.SQLite.table({
  name: 'taskDrafts',
  columns: {
    factoryId: State.SQLite.text({ primaryKey: true }),
    draft: State.SQLite.text({ nullable: true }),
    clearedRevision: State.SQLite.text({ nullable: true }),
  },
})

export const taskDraftConsumptions = State.SQLite.table({
  name: 'taskDraftConsumptions',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    revision: State.SQLite.text(),
  },
})

export const messageDrafts = State.SQLite.table({
  name: 'messageDrafts',
  columns: {
    key: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text({ nullable: true }),
    taskId: State.SQLite.text({ nullable: true }),
    planId: State.SQLite.text({ nullable: true }),
    draft: State.SQLite.text(),
  },
})

export const taskAttachments = State.SQLite.table({
  name: 'taskAttachments',
  indexes: [{ name: 'idx_taskAttachments_taskId', columns: ['taskId'] }],
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

export const commentAttachments = State.SQLite.table({
  name: 'commentAttachments',
  indexes: [
    { name: 'idx_commentAttachments_commentId', columns: ['commentId'] },
    { name: 'idx_commentAttachments_taskId', columns: ['taskId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    commentId: State.SQLite.text(),
    taskId: State.SQLite.text(),
    hash: State.SQLite.text(),
    name: State.SQLite.text(),
    size: State.SQLite.integer(),
    mediaType: State.SQLite.text(),
    position: State.SQLite.integer(),
  },
})

export const comments = State.SQLite.table({
  name: 'comments',
  indexes: [
    { name: 'idx_comments_taskId', columns: ['taskId'] },
    { name: 'idx_comments_authorRunId', columns: ['authorRunId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    kind: State.SQLite.text(),
    body: State.SQLite.text(),
    autopilotAnswered: State.SQLite.boolean({ default: false }),
    authorKind: State.SQLite.text({ default: 'run' }),
    authorRunId: State.SQLite.text({ nullable: true }),
    stage: State.SQLite.text({ nullable: true }),
    title: State.SQLite.text({ nullable: true }),
    choices: State.SQLite.text({ nullable: true }),
    round: State.SQLite.text({ nullable: true }),
    proposal: State.SQLite.text({ nullable: true }),
    sizeCheck: State.SQLite.text({ nullable: true }),
    gate: State.SQLite.text({ nullable: true }),
    permission: State.SQLite.text({ nullable: true }),
    simulator: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    deliveredRunId: State.SQLite.text({ nullable: true }),
    deliveredAt: State.SQLite.text({ nullable: true }),
    readAt: State.SQLite.text({ nullable: true }),
    answerHeld: State.SQLite.boolean({ default: false }),
    answerQueuedAt: State.SQLite.text({ nullable: true }),
    answerSentRunId: State.SQLite.text({ nullable: true }),
    answerSentAt: State.SQLite.text({ nullable: true }),
    failedRunId: State.SQLite.text({ nullable: true }),
    talkNotifiedAt: State.SQLite.text({ nullable: true }),
    talkMessageId: State.SQLite.text({ nullable: true }),
    talkRequested: State.SQLite.boolean({ default: false }),
    talkRunId: State.SQLite.text({ nullable: true }),
    talkStartedAt: State.SQLite.text({ nullable: true }),
    talkDoneAt: State.SQLite.text({ nullable: true }),
    design: State.SQLite.text({ nullable: true }),
    tutorial: State.SQLite.boolean({ default: false }),
    linearTeam: State.SQLite.text({ nullable: true }),
    asanaMissing: State.SQLite.text({ nullable: true }),
    asanaUnfinished: State.SQLite.text({ nullable: true }),
    archive: State.SQLite.text({ nullable: true }),
    move: State.SQLite.text({ nullable: true }),
    cleanupFailure: State.SQLite.text({ nullable: true }),
    memoryKill: State.SQLite.text({ nullable: true }),
    multiple: State.SQLite.boolean({ default: false }),
    purpose: State.SQLite.text({ nullable: true }),
    heldFor: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const lineComments = State.SQLite.table({
  name: 'lineComments',
  indexes: [
    { name: 'idx_lineComments_taskId', columns: ['taskId'] },
    { name: 'idx_lineComments_commentId', columns: ['commentId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    repo: State.SQLite.text(),
    path: State.SQLite.text(),
    side: State.SQLite.text(),
    start: State.SQLite.integer(),
    end: State.SQLite.integer(),
    commit: State.SQLite.text(),
    quoted: State.SQLite.text(),
    body: State.SQLite.text(),
    createdAt: State.SQLite.text(),
    editedAt: State.SQLite.text({ nullable: true }),
    commentId: State.SQLite.text({ nullable: true }),
    sentAt: State.SQLite.text({ nullable: true }),
    deleted: State.SQLite.boolean({ default: false }),
  },
})

export const taskBriefs = State.SQLite.table({
  name: 'taskBriefs',
  indexes: [{ name: 'idx_taskBriefs_taskId', columns: ['taskId'] }],
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

export const requestSnoozes = State.SQLite.table({
  name: 'requestSnoozes',
  indexes: [{ name: 'idx_requestSnoozes_ownerId', columns: ['ownerId'] }],
  columns: {
    requestId: State.SQLite.text({ primaryKey: true }),
    ownerId: State.SQLite.text(),
    factoryId: State.SQLite.text(),
    until: State.SQLite.text(),
  },
})

export const requestsEvents = {
  requestSnoozed: Events.synced({
    name: 'v1.RequestSnoozed',
    schema: Schema.Struct({
      requestId: Schema.String,
      ownerId: Schema.String,
      factoryId: Schema.String,
      until: Schema.String,
      at: Schema.String,
    }),
  }),
  requestSnoozeCleared: Events.synced({
    name: 'v1.RequestSnoozeCleared',
    schema: Schema.Struct({ requestId: Schema.String, at: Schema.String }),
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
  commentAttachmentAdded: Events.synced({
    name: 'v1.CommentAttachmentAdded',
    schema: Schema.Struct({
      commentId: Schema.String,
      taskId: Schema.String,
      hash: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      mediaType: Schema.String,
      position: Schema.Number,
    }),
  }),
  commentDesignAttached: Events.synced({
    name: 'v1.CommentDesignAttached',
    schema: Schema.Struct({ commentId: Schema.String, design: Schema.String }),
  }),
  commentAnsweredByAutopilot: Events.synced({
    name: 'v1.CommentAnsweredByAutopilot',
    schema: Schema.Struct({ taskId: Schema.String, commentId: Schema.String, at: Schema.String }),
  }),
  requestHeld: Events.synced({
    name: 'v1.RequestHeld',
    schema: Schema.Struct({ commentId: Schema.String, runId: Schema.String }),
  }),
  requestReleased: Events.synced({
    name: 'v1.RequestReleased',
    schema: Schema.Struct({ commentId: Schema.String, at: Schema.String }),
  }),
  commentPurposeRecorded: Events.synced({
    name: 'v1.CommentPurposeRecorded',
    schema: Schema.Struct({ commentId: Schema.String, purpose: Schema.String }),
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
  commentPostedV3: Events.synced({
    name: 'v3.CommentPosted',
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
      round: Schema.NullOr(Schema.String),
      gate: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  commentPostedV4: Events.synced({
    name: 'v4.CommentPosted',
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
      round: Schema.NullOr(Schema.String),
      proposal: Schema.NullOr(Schema.String),
      sizeCheck: Schema.NullOr(Schema.String),
      gate: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  commentAnswered: Events.synced({
    name: 'v1.CommentAnswered',
    schema: Schema.Struct({ id: Schema.String, answer: Schema.String, at: Schema.String }),
  }),
  roundTalkRequested: Events.synced({
    name: 'v1.RoundTalkRequested',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  roundTalkStarted: Events.synced({
    name: 'v1.RoundTalkStarted',
    schema: Schema.Struct({ id: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  roundTalkStartedV2: Events.synced({
    name: 'v2.RoundTalkStarted',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      messageId: Schema.String,
      at: Schema.String,
    }),
  }),
  roundTalkNotified: Events.synced({
    name: 'v1.RoundTalkNotified',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      messageId: Schema.String,
      at: Schema.String,
    }),
  }),
  roundTalkDone: Events.synced({
    name: 'v1.RoundTalkDone',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
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
  taskDraftSaved: Events.synced({
    name: 'v1.TaskDraftSaved',
    schema: Schema.Struct({ factoryId: Schema.String, draft: Schema.String, at: Schema.String }),
  }),
  taskDraftCleared: Events.synced({
    name: 'v1.TaskDraftCleared',
    schema: Schema.Struct({ factoryId: Schema.String, revision: Schema.String, at: Schema.String }),
  }),
  taskDraftSavedV2: Events.synced({
    name: 'v2.TaskDraftSaved',
    schema: Schema.Struct({
      factoryId: Schema.String,
      draft: Schema.String,
      clearedRevision: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskDraftConsumed: Events.synced({
    name: 'v1.TaskDraftConsumed',
    schema: Schema.Struct({
      factoryId: Schema.String,
      revision: Schema.String,
      draft: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskDraftRemoved: Events.synced({
    name: 'v1.TaskDraftRemoved',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
  }),
  messageDraftSaved: Events.synced({
    name: 'v1.MessageDraftSaved',
    schema: Schema.Struct({
      key: Schema.String,
      factoryId: Schema.NullOr(Schema.String),
      taskId: Schema.NullOr(Schema.String),
      planId: Schema.NullOr(Schema.String),
      draft: Schema.String,
      at: Schema.String,
    }),
  }),
  messageDraftCleared: Events.synced({
    name: 'v1.MessageDraftCleared',
    schema: Schema.Struct({ key: Schema.String, at: Schema.String }),
  }),
  commentsDelivered: Events.synced({
    name: 'v1.CommentsDelivered',
    schema: Schema.Struct({
      ids: Schema.Array(Schema.String),
      runId: Schema.String,
      at: Schema.String,
    }),
  }),
  commentsRead: Events.synced({
    name: 'v1.CommentsRead',
    schema: Schema.Struct({ ids: Schema.Array(Schema.String), at: Schema.String }),
  }),
  lineCommentDrafted: Events.synced({
    name: 'v1.LineCommentDrafted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      repo: Schema.String,
      path: Schema.String,
      side: Schema.String,
      start: Schema.Number,
      end: Schema.Number,
      commit: Schema.String,
      quoted: Schema.String,
      body: Schema.String,
      at: Schema.String,
    }),
  }),
  lineCommentEdited: Events.synced({
    name: 'v1.LineCommentEdited',
    schema: Schema.Struct({ id: Schema.String, body: Schema.String, at: Schema.String }),
  }),
  lineCommentsDeleted: Events.synced({
    name: 'v1.LineCommentsDeleted',
    schema: Schema.Struct({ ids: Schema.Array(Schema.String), at: Schema.String }),
  }),
  lineCommentsSent: Events.synced({
    name: 'v1.LineCommentsSent',
    schema: Schema.Struct({
      ids: Schema.Array(Schema.String),
      commentId: Schema.String,
      at: Schema.String,
    }),
  }),
  commentAnswerHeld: Events.synced({
    name: 'v1.CommentAnswerHeld',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  commentAnswerQueued: Events.synced({
    name: 'v1.CommentAnswerQueued',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  commentAnswersSent: Events.synced({
    name: 'v1.CommentAnswersSent',
    schema: Schema.Struct({
      ids: Schema.Array(Schema.String),
      runId: Schema.String,
      at: Schema.String,
    }),
  }),
  commentAnswersDelivered: Events.synced({
    name: 'v1.CommentAnswersDelivered',
    schema: Schema.Struct({
      ids: Schema.Array(Schema.String),
      runId: Schema.String,
      at: Schema.String,
    }),
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
  commentMarkedTutorial: Events.synced({
    name: 'v1.CommentMarkedTutorial',
    schema: Schema.Struct({ commentId: Schema.String }),
  }),
  commentLinearTeamAsked: Events.synced({
    name: 'v1.CommentLinearTeamAsked',
    schema: Schema.Struct({ commentId: Schema.String, key: Schema.String, name: Schema.String }),
  }),
  commentAsanaMissingAsked: Events.synced({
    name: 'v1.CommentAsanaMissingAsked',
    schema: Schema.Struct({ commentId: Schema.String, missing: Schema.String }),
  }),
  commentAsanaUnfinishedAsked: Events.synced({
    name: 'v1.CommentAsanaUnfinishedAsked',
    schema: Schema.Struct({ commentId: Schema.String, unfinished: Schema.String }),
  }),
  commentCleanupFailureAsked: Events.synced({
    name: 'v1.CommentCleanupFailureAsked',
    schema: Schema.Struct({ commentId: Schema.String, failure: Schema.String }),
  }),
  commentMemoryKillAsked: Events.synced({
    name: 'v1.CommentMemoryKillAsked',
    schema: Schema.Struct({ commentId: Schema.String, memoryKill: Schema.String }),
  }),
  commentArchiveAsked: Events.synced({
    name: 'v1.CommentArchiveAsked',
    schema: Schema.Struct({ commentId: Schema.String, archive: Schema.String }),
  }),
  commentMoveAsked: Events.synced({
    name: 'v1.CommentMoveAsked',
    schema: Schema.Struct({ commentId: Schema.String, move: Schema.String }),
  }),
  commentMultipleChoiceAsked: Events.synced({
    name: 'v1.CommentMultipleChoiceAsked',
    schema: Schema.Struct({ commentId: Schema.String }),
  }),
}

export const requestsMaterializers = State.SQLite.materializers(requestsEvents, {
  'v1.RequestSnoozed': ({ requestId, ownerId, factoryId, until }) =>
    requestSnoozes
      .insert({ requestId, ownerId, factoryId, until })
      .onConflict('requestId', 'replace'),
  'v1.RequestSnoozeCleared': ({ requestId }) => requestSnoozes.delete().where({ requestId }),
  'v1.TaskAttachmentAdded': ({ taskId, hash, name, ...rest }) =>
    taskAttachments
      .insert({ id: `${taskId}:${hash}:${name}`, taskId, hash, name, ...rest })
      .onConflict('id', 'ignore'),
  'v1.CommentAttachmentAdded': ({ commentId, hash, name, ...rest }) =>
    commentAttachments
      .insert({ id: `${commentId}:${hash}:${name}`, commentId, hash, name, ...rest })
      .onConflict('id', 'ignore'),
  'v1.CommentMarkedTutorial': ({ commentId }) =>
    comments.update({ tutorial: true }).where({ id: commentId }),
  'v1.CommentLinearTeamAsked': ({ commentId, key, name }) =>
    comments.update({ linearTeam: JSON.stringify({ key, name }) }).where({ id: commentId }),
  'v1.CommentAsanaMissingAsked': ({ commentId, missing }) =>
    comments.update({ asanaMissing: missing }).where({ id: commentId }),
  'v1.CommentAsanaUnfinishedAsked': ({ commentId, unfinished }) =>
    comments.update({ asanaUnfinished: unfinished }).where({ id: commentId }),
  'v1.CommentArchiveAsked': ({ commentId, archive }) =>
    comments.update({ archive }).where({ id: commentId }),
  'v1.CommentMoveAsked': ({ commentId, move }) =>
    comments.update({ move }).where({ id: commentId }),
  'v1.CommentMultipleChoiceAsked': ({ commentId }) =>
    comments.update({ multiple: true }).where({ id: commentId }),
  'v1.CommentCleanupFailureAsked': ({ commentId, failure }) =>
    comments.update({ cleanupFailure: failure }).where({ id: commentId }),
  'v1.CommentMemoryKillAsked': ({ commentId, memoryKill }) =>
    comments.update({ memoryKill }).where({ id: commentId }),
  'v1.RequestHeld': ({ commentId, runId }) =>
    comments.update({ heldFor: runId }).where({ id: commentId }),
  'v1.RequestReleased': ({ commentId, at }) =>
    comments.update({ heldFor: null, createdAt: at }).where({ id: commentId }),
  'v1.CommentDesignAttached': ({ commentId, design }) =>
    comments.update({ design }).where({ id: commentId }),
  'v1.CommentAnsweredByAutopilot': ({ commentId }) =>
    comments.update({ autopilotAnswered: true }).where({ id: commentId }),
  'v1.CommentPurposeRecorded': ({ commentId, purpose }) =>
    comments.update({ purpose }).where({ id: commentId }),
  'v1.CommentPosted': (comment) => comments.insert({ ...comment, authorKind: 'run' }),
  'v2.CommentPosted': ({ choices, ...comment }) =>
    comments.insert({
      ...comment,
      choices: choices === null ? null : JSON.stringify(choices),
    }),
  'v3.CommentPosted': ({ choices, ...comment }) =>
    comments.insert({
      ...comment,
      choices: choices === null ? null : JSON.stringify(choices),
    }),
  'v4.CommentPosted': ({ choices, ...comment }) =>
    comments.insert({
      ...comment,
      choices: choices === null ? null : JSON.stringify(choices),
    }),
  'v1.CommentAnswered': ({ id, answer, at }) => [
    runMessages.update({ deletedAt: at, queued: false }).where({ roundId: id, queued: true }),
    comments.update({ answer, talkRequested: false, talkMessageId: null }).where({ id }),
    requestSnoozes.delete().where({ requestId: id }),
    messageDrafts.delete().where({ key: messageDraftKey('request', id) }),
  ],
  'v1.RoundTalkRequested': ({ id, at }) => [
    runMessages.update({ deletedAt: at, queued: false }).where({ roundId: id, queued: true }),
    comments.update({ talkRequested: true, talkMessageId: null }).where({ id }),
  ],
  'v1.RoundTalkStarted': ({ id, runId, at }) =>
    comments
      .update({
        talkRunId: runId,
        talkStartedAt: at,
        talkDoneAt: null,
        talkNotifiedAt: at,
        talkRequested: false,
      })
      .where({ id }),
  'v2.RoundTalkStarted': ({ id, runId, messageId, at }) => [
    runMessages.update({ deletedAt: at, queued: false }).where({ roundId: id, queued: true }),
    runMessages.update({ roundId: id }).where({ id: messageId }),
    comments
      .update({
        talkRunId: runId,
        talkStartedAt: at,
        talkDoneAt: null,
        talkRequested: true,
        talkMessageId: messageId,
        talkNotifiedAt: null,
      })
      .where({ id }),
  ],
  'v1.RoundTalkNotified': ({ id, runId, messageId, at }) =>
    comments
      .update({ talkRequested: false, talkNotifiedAt: at })
      .where({ id, talkRunId: runId, talkMessageId: messageId }),
  'v1.RoundTalkDone': ({ id, at }) => comments.update({ talkDoneAt: at }).where({ id }),
  'v1.TaskBriefWritten': ({ at, ...brief }) => taskBriefs.insert({ ...brief, createdAt: at }),
  'v1.TedCommentPosted': (comment) =>
    comments.insert({ ...comment, authorKind: 'ted', authorRunId: null }),
  'v1.TaskDraftSaved': ({ factoryId, draft }) =>
    taskDrafts.insert({ factoryId, draft }).onConflict('factoryId', 'replace'),
  'v1.TaskDraftCleared': ({ factoryId, revision }) => [
    taskDrafts
      .insert({ factoryId, draft: null, clearedRevision: revision })
      .onConflict('factoryId', 'replace'),
    taskDraftConsumptions
      .insert({ id: `${factoryId}:${revision}`, factoryId, revision })
      .onConflict('id', 'ignore'),
  ],
  'v2.TaskDraftSaved': ({ factoryId, draft, clearedRevision }) =>
    taskDrafts.insert({ factoryId, draft, clearedRevision }).onConflict('factoryId', 'replace'),
  'v1.TaskDraftConsumed': ({ factoryId, revision, draft }) => [
    taskDrafts
      .insert({ factoryId, draft, clearedRevision: revision })
      .onConflict('factoryId', 'replace'),
    taskDraftConsumptions
      .insert({ id: `${factoryId}:${revision}`, factoryId, revision })
      .onConflict('id', 'ignore'),
  ],
  'v1.MessageDraftSaved': ({ at: _at, ...row }) =>
    messageDrafts.insert(row).onConflict('key', 'replace'),
  'v1.MessageDraftCleared': ({ key }) => messageDrafts.delete().where({ key }),
  'v1.TaskDraftRemoved': ({ factoryId }) => [
    taskDrafts.delete().where({ factoryId }),
    taskDraftConsumptions.delete().where({ factoryId }),
  ],
  'v1.CommentsDelivered': ({ ids, runId, at }) =>
    ids.map((id) => comments.update({ deliveredRunId: runId, deliveredAt: at }).where({ id })),
  'v1.CommentsRead': ({ ids, at }) =>
    ids.map((id) => comments.update({ readAt: at }).where({ id })),
  'v1.LineCommentDrafted': ({ at, ...draft }) =>
    lineComments.insert({ ...draft, createdAt: at }).onConflict('id', 'ignore'),
  'v1.LineCommentEdited': ({ id, body, at }) =>
    lineComments.update({ body, editedAt: at }).where({ id, commentId: null }),
  'v1.LineCommentsDeleted': ({ ids }) =>
    ids.map((id) => lineComments.update({ deleted: true }).where({ id, commentId: null })),
  'v1.LineCommentsSent': ({ ids, commentId, at }) =>
    ids.map((id) => lineComments.update({ commentId, sentAt: at }).where({ id, commentId: null })),
  'v1.CommentAnswerQueued': ({ id, at }) =>
    comments.update({ answerHeld: true, answerQueuedAt: at }).where({ id }),
  'v1.CommentAnswersSent': ({ ids, runId, at }) =>
    ids.map((id) =>
      comments
        .update({ answerHeld: false, answerSentRunId: runId, answerSentAt: at })
        .where({ id }),
    ),
  'v1.CommentAnswerHeld': ({ id }) => comments.update({ answerHeld: true }).where({ id }),
  'v1.CommentAnswersDelivered': ({ ids }) =>
    ids.map((id) => comments.update({ answerHeld: false }).where({ id })),
})
