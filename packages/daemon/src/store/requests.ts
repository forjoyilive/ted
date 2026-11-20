import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import {
  type Attachment,
  type Comment,
  type CommentAnswer,
  emptyMessageDraft,
  type LineComment,
  type MessageBox,
  type MessageDraft,
  type NewTaskDraft,
  type SnoozedRequest,
  type StageId,
  type TaskBrief,
  type TaskDraftState,
  type WaitingRequest,
} from '@ted/protocol'
import type { StoreContext } from './context.ts'
import { storedFiles } from './runs.ts'
import {
  commentAttachments,
  comments,
  events,
  lineComments,
  messageDraftKey,
  messageDrafts,
  requestSnoozes,
  runBrowserCaptures,
  runMessages,
  taskAttachments,
  type taskBriefs,
  taskBrowserCaptures,
  taskDrafts,
} from './schema.ts'
import type { NewComment, NewLineComment } from './types.ts'

export interface RequestsArea {
  postComment(input: NewComment): Comment
  heldRequests(): { id: string; runId: string; createdAt: string }[]
  releaseRequests(ids: readonly string[]): void
  listComments(taskId: string): Comment[]
  commentTexts(): {
    id: string
    taskId: string
    title?: string
    body: string
    author: Comment['author']
    createdAt: string
  }[]
  permissionComments(runId: string): Comment[]
  taskFiles(taskId: string): Attachment[]
  taskDraft(factoryId: string): TaskDraftState
  saveTaskDraft(factoryId: string, draft: NewTaskDraft): TaskDraftState
  removeTaskDraft(factoryId: string): void
  messageDraft(box: MessageBox): MessageDraft | null
  saveMessageDraft(
    box: MessageBox,
    owner: { factoryId?: string; taskId?: string; planId?: string },
    draft: MessageDraft,
  ): MessageDraft | null
  messageDraftFiles(taskId: string): Attachment[]
  filesInUse(): Set<string>
  getComment(id: string): Comment | undefined
  answerComment(
    id: string,
    answer: CommentAnswer,
    lineComments?: readonly string[],
    autopilot?: boolean,
    queueAnswer?: boolean,
  ): Comment
  draftLineComment(input: NewLineComment): LineComment
  editLineComment(id: string, body: string): LineComment
  deleteLineComments(taskId: string, ids: readonly string[]): void
  getLineComment(id: string): LineComment | undefined
  lineCommentDrafts(taskId: string): LineComment[]
  taskLineComments(taskId: string): LineComment[]
  commentsDelivered(ids: readonly string[], runId: string): void
  commentsRead(ids: readonly string[]): void
  holdAnswer(id: string): void
  requestRoundTalk(id: string): Comment
  startRoundTalk(id: string, runId: string, text: string): Comment
  roundTalkMessageIds(runId: string): string[]
  pendingRoundTalks(runId: string): { messageId: string; round: Comment }[]
  roundTalkNotified(id: string, runId: string, messageId: string): void
  roundTalkDone(id: string): Comment
  heldAnswers(taskId: string): Comment[]
  answersDelivered(ids: readonly string[], runId: string): void
  supersedeComment(id: string, input: NewComment): Comment
  listOpenRequests(): Comment[]
  listAnsweredRequests(since: string, kinds?: ReadonlySet<CommentAnswer['kind']>): Comment[]
  writeBrief(input: { taskId: string; text: string; runId?: string }): TaskBrief
  listBriefs(taskId: string): TaskBrief[]
  latestBrief(taskId: string): TaskBrief | undefined
  snoozed(): SnoozedRequest[]
  snoozeRequest(
    requestId: string,
    until: string | null,
  ): SnoozedRequest | WaitingRequest | undefined
  returnDueRequests(now: number): string[]
  requestSnoozesPending(): boolean
}

export function requestsArea(ctx: StoreContext): RequestsArea {
  const {
    storeState,
    store,
    commit,
    taskDraft,
    requireFactory,
    attachmentRows,
    toAttachment,
    browserCapturesOf,
    toComment,
    toLineComment,
    lineCommentsSent,
    commentRows,
    shownRequestRows,
    briefRows,
    taskRow,
    runRow,
    taskIdOfRun,
    emit,
    getComment,
    requireComment,
    commentPosted,
    emitComment,
    updatedTask,
    openRequests,
    snoozed,
  } = ctx
  const commitDraft: typeof store.commit = (...args: unknown[]) => {
    storeState.waitingUnchanged = true
    try {
      return (commit as (...a: unknown[]) => unknown)(...args)
    } finally {
      storeState.waitingUnchanged = false
    }
  }

  const messageDraft = (box: MessageBox): MessageDraft | null => {
    const row = store.query(
      queryDb(messageDrafts.where({ key: messageDraftKey(box.kind, box.id) })),
    )[0]
    return row ? (JSON.parse(row.draft) as MessageDraft) : null
  }

  const attachmentsOf = (taskId: string): Attachment[] => attachmentRows(taskId).map(toAttachment)

  const lineCommentDrafts = (taskId: string) =>
    store
      .query(
        queryDb(
          lineComments
            .where({ taskId, commentId: null, deleted: false })
            .orderBy('createdAt', 'asc'),
        ),
      )
      .map(toLineComment)

  const toBrief = ({ runId, stage, id: _, ...row }: typeof taskBriefs.Type): TaskBrief => ({
    ...row,
    stage: stage as StageId,
    ...(runId !== null && { runId }),
  })

  const lineCommentRow = (id: string) => {
    const row = store.query(queryDb(lineComments.where({ id, deleted: false }))).at(0)
    return row && toLineComment(row)
  }
  const requireLineComment = (id: string) => {
    const found = lineCommentRow(id)
    if (!found) throw new Error(`no line comment ${id}`)
    return found
  }

  return {
    taskFiles: (taskId) => [
      ...attachmentsOf(taskId),
      ...browserCapturesOf(taskId),
      ...store
        .query(queryDb(commentAttachments.where({ taskId })))
        .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType })),
    ],
    taskDraft,
    saveTaskDraft(factoryId, draft) {
      requireFactory(factoryId)
      const state = taskDraft(factoryId)
      if (
        state.clearedRevision !== draft.revision &&
        !state.clearedRevisions?.includes(draft.revision)
      ) {
        commitDraft(
          events.taskDraftSavedV2({
            factoryId,
            draft: JSON.stringify(draft),
            clearedRevision: state.clearedRevision ?? null,
            at: new Date().toISOString(),
          }),
        )
      }
      return taskDraft(factoryId)
    },
    removeTaskDraft(factoryId) {
      commit(events.taskDraftRemoved({ factoryId, at: new Date().toISOString() }))
    },
    messageDraft,
    saveMessageDraft(box, owner, draft) {
      const key = messageDraftKey(box.kind, box.id)
      const at = new Date().toISOString()
      const kept = messageDraft(box)
      if (emptyMessageDraft(draft)) {
        if (kept) commitDraft(events.messageDraftCleared({ key, at }))
        return null
      }
      const text = JSON.stringify(draft)
      if (kept === null || JSON.stringify(kept) !== text) {
        commitDraft(
          events.messageDraftSaved({
            key,
            factoryId: owner.factoryId ?? null,
            taskId: owner.taskId ?? null,
            planId: owner.planId ?? null,
            draft: text,
            at,
          }),
        )
      }
      return messageDraft(box)
    },
    messageDraftFiles: (taskId) =>
      store
        .query(queryDb(messageDrafts.where({ taskId })))
        .flatMap((row) => (JSON.parse(row.draft) as MessageDraft).attachments),
    filesInUse: () =>
      new Set([
        ...store
          .query(queryDb(messageDrafts))
          .flatMap((row) => (JSON.parse(row.draft) as MessageDraft).attachments.map((a) => a.hash)),
        ...store
          .query(queryDb(taskDrafts))
          .flatMap((row) =>
            row.draft ? (JSON.parse(row.draft) as NewTaskDraft).attachments.map((a) => a.hash) : [],
          ),
        ...store.query(queryDb(taskAttachments)).map((a) => a.hash),
        ...store.query(queryDb(taskBrowserCaptures)).map((a) => a.hash),
        ...store.query(queryDb(runBrowserCaptures)).map((a) => a.hash),
        ...store.query(queryDb(commentAttachments)).map((a) => a.hash),
        ...store
          .query(queryDb(runMessages.select('files').where({ files: { op: '!=', value: null } })))
          .flatMap((files) => storedFiles(files).map((a) => a.hash)),
      ]),
    postComment(input) {
      const at = new Date().toISOString()
      const { id, event, attached } = commentPosted(input, at)
      commit(event, ...attached, ...lineCommentsSent(input.lineComments, id, at))
      const comment = requireComment(id)
      if (!comment.held) emit({ type: 'comment-posted', comment })
      if (comment.kind !== 'note') updatedTask(input.taskId)
      for (const taskId of new Set(comment.lineComments?.map((c) => c.taskId))) {
        emit({ type: 'line-comments-changed', taskId })
      }
      return comment
    },
    supersedeComment(oldId, input) {
      const at = new Date().toISOString()
      const { id, event, attached } = commentPosted(input, at)
      const answer: CommentAnswer = { kind: 'superseded', at, by: id }
      commit(
        event,
        ...attached,
        events.commentAnswered({ id: oldId, answer: JSON.stringify(answer), at }),
      )
      const comment = requireComment(id)
      if (!comment.held) emit({ type: 'comment-posted', comment })
      emitComment(oldId)
      updatedTask(input.taskId)
      return comment
    },
    heldRequests: () =>
      store
        .query(queryDb(comments.where({ heldFor: { op: '!=', value: null } })))
        .map(({ id, heldFor, createdAt }) => ({ id, runId: heldFor ?? '', createdAt })),
    releaseRequests(ids) {
      const held = ids.flatMap((id) => {
        const row = store.query(queryDb(comments.where({ id }))).at(0)
        return row?.heldFor ? [row] : []
      })
      if (held.length === 0) return
      const at = new Date().toISOString()
      commit(...held.map((row) => events.requestReleased({ commentId: row.id, at })))
      for (const row of held) {
        const comment = requireComment(row.id)
        emit({ type: 'comment-posted', comment })
        updatedTask(row.taskId)
      }
    },
    listComments: (taskId) => commentRows(taskId).map(toComment),
    commentTexts: () =>
      commentRows().map(({ id, taskId, title, body, authorKind, authorRunId, createdAt }) => ({
        id,
        taskId,
        ...(title !== null && { title }),
        body,
        author:
          authorKind === 'run' && authorRunId !== null
            ? { kind: 'run' as const, runId: authorRunId }
            : { kind: authorKind === 'ted' ? ('ted' as const) : ('human' as const) },
        createdAt,
      })),
    permissionComments(runId) {
      const taskId = runRow(runId)?.taskId
      if (taskId === undefined || taskId === null) return []
      return store
        .query(
          queryDb(
            comments
              .where({ authorRunId: runId, authorKind: 'run', kind: 'permission', taskId })
              .orderBy('createdAt', 'asc'),
          ),
        )
        .map(toComment)
    },
    getComment,
    answerComment(id, answer, sending, autopilot = false, queueAnswer = false) {
      commit(
        events.commentAnswered({ id, answer: JSON.stringify(answer), at: answer.at }),
        ...(autopilot
          ? [
              events.commentAnsweredByAutopilot({
                taskId: requireComment(id).taskId,
                commentId: id,
                at: answer.at,
              }),
            ]
          : []),
        ...(queueAnswer ? [events.commentAnswerQueued({ id, at: answer.at })] : []),
        ...lineCommentsSent(sending, id, answer.at),
      )
      const comment = emitComment(id)
      updatedTask(comment.taskId)
      if (sending !== undefined && sending.length > 0) {
        emit({ type: 'line-comments-changed', taskId: comment.taskId })
      }
      return comment
    },
    draftLineComment({ quoted, ...input }) {
      const id = randomUUID()
      commit(
        events.lineCommentDrafted({
          id,
          ...input,
          quoted: JSON.stringify(quoted),
          at: new Date().toISOString(),
        }),
      )
      emit({ type: 'line-comments-changed', taskId: input.taskId })
      return requireLineComment(id)
    },
    editLineComment(id, body) {
      commit(events.lineCommentEdited({ id, body, at: new Date().toISOString() }))
      const edited = requireLineComment(id)
      emit({ type: 'line-comments-changed', taskId: edited.taskId })
      return edited
    },
    deleteLineComments(taskId, ids) {
      if (ids.length === 0) return
      commit(events.lineCommentsDeleted({ ids: [...ids], at: new Date().toISOString() }))
      emit({ type: 'line-comments-changed', taskId })
    },
    getLineComment: (id) => lineCommentRow(id),
    lineCommentDrafts,
    taskLineComments: (taskId) =>
      store
        .query(queryDb(lineComments.where({ taskId, deleted: false }).orderBy('createdAt', 'asc')))
        .map(toLineComment),
    commentsDelivered(ids, runId) {
      if (ids.length === 0) return
      commit(events.commentsDelivered({ ids, runId, at: new Date().toISOString() }))
      for (const id of ids) emitComment(id)
    },
    commentsRead(ids) {
      if (ids.length === 0) return
      commit(events.commentsRead({ ids, at: new Date().toISOString() }))
      for (const id of ids) emitComment(id)
    },
    requestRoundTalk(id) {
      commit(events.roundTalkRequested({ id, at: new Date().toISOString() }))
      return emitComment(id)
    },
    startRoundTalk(id, runId, text) {
      const at = new Date().toISOString()
      const messageId = randomUUID()
      const taskId = taskIdOfRun(runId) ?? null
      commit(
        events.runMessageQueuedV2({ id: messageId, runId, taskId, text, at, from: 'ted' }),
        events.roundTalkStartedV2({
          id,
          runId,
          messageId,
          at,
        }),
      )
      emit({ type: 'run-output', runId })
      return emitComment(id)
    },
    roundTalkMessageIds(runId) {
      return store
        .query(
          queryDb(runMessages.where({ runId, roundId: { op: '!=', value: null }, queued: true })),
        )
        .map((message) => message.id)
    },
    pendingRoundTalks(runId) {
      return store
        .query(queryDb(comments.where({ talkRunId: runId, talkRequested: true, answer: null })))
        .flatMap((row) =>
          row.talkMessageId === null
            ? []
            : [{ messageId: row.talkMessageId, round: toComment(row) }],
        )
    },
    roundTalkNotified(id, runId, messageId) {
      const at = new Date().toISOString()
      const taskId = taskIdOfRun(runId) ?? null
      commit(
        events.runMessageDelivered({ id: messageId, runId, taskId, lead: false, at }),
        events.roundTalkNotified({ id, runId, messageId, at }),
      )
      emit({ type: 'run-output', runId })
      emitComment(id)
    },
    roundTalkDone(id) {
      commit(events.roundTalkDone({ id, at: new Date().toISOString() }))
      return emitComment(id)
    },
    holdAnswer(id) {
      commit(events.commentAnswerHeld({ id, at: new Date().toISOString() }))
    },
    heldAnswers: (taskId) =>
      store
        .query(queryDb(comments.where({ taskId, answerHeld: true }).orderBy('createdAt', 'asc')))
        .map(toComment),
    answersDelivered(ids, runId) {
      if (ids.length === 0) return
      commit(events.commentAnswersSent({ ids, runId, at: new Date().toISOString() }))
      for (const id of ids) updatedTask(emitComment(id).taskId)
    },
    listOpenRequests: () => shownRequestRows().map(toComment),
    listAnsweredRequests: (since, kinds) =>
      commentRows()
        .filter((row) => {
          if (row.kind === 'note' || row.answer === null) return false
          const answer = JSON.parse(row.answer) as CommentAnswer
          return answer.at >= since && (kinds === undefined || kinds.has(answer.kind))
        })
        .map(toComment),
    writeBrief({ taskId, text, runId }) {
      const row = taskRow(taskId)
      if (!row) throw new Error(`no Task ${taskId}`)
      const version = (briefRows(taskId).at(-1)?.version ?? 0) + 1
      const id = randomUUID()
      commit(
        events.taskBriefWritten({
          id,
          taskId,
          version,
          text,
          stage: row.stage,
          runId: runId ?? null,
          at: new Date().toISOString(),
        }),
      )
      const brief = briefRows(taskId).at(-1)
      if (!brief) throw new Error(`no brief for ${taskId}`)
      updatedTask(taskId)
      return toBrief(brief)
    },
    listBriefs: (taskId) => briefRows(taskId).map(toBrief),
    latestBrief(taskId) {
      const row = briefRows(taskId).at(-1)
      return row && toBrief(row)
    },
    snoozed,
    snoozeRequest(requestId, until) {
      const request = openRequests().find((r) => r.id === requestId)
      if (!request) return undefined
      const at = new Date().toISOString()
      const ownerId =
        request.source === 'task'
          ? request.taskId
          : request.source === 'plan'
            ? request.planId
            : request.source === 'coordinator'
              ? request.chatId
              : request.automationId
      commit(
        until === null
          ? events.requestSnoozeCleared({ requestId, at })
          : events.requestSnoozed({
              requestId,
              ownerId,
              factoryId: request.factoryId,
              until,
              at,
            }),
      )
      if (request.source === 'task') updatedTask(request.taskId)
      return until === null ? request : { ...request, snoozedUntil: until }
    },
    returnDueRequests(now) {
      const due = store
        .query(queryDb(requestSnoozes.select()))
        .filter((row) => Date.parse(row.until) <= now)
      if (due.length === 0) return []
      const at = new Date().toISOString()
      commit(...due.map((row) => events.requestSnoozeCleared({ requestId: row.requestId, at })))
      for (const ownerId of new Set(due.map((row) => row.ownerId))) {
        if (taskRow(ownerId)) updatedTask(ownerId)
      }
      return due.map((row) => row.requestId)
    },
    requestSnoozesPending: () => store.query(queryDb(requestSnoozes.select())).length > 0,
  }
}
