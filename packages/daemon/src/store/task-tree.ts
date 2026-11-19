import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import type { CommentAnswer, StageId, Task } from '@ted/protocol'
import type { StoreContext } from './context.ts'
import {
  archiveUnblocks,
  comments,
  events,
  taskBlockers,
  taskLog,
  taskParents,
  tasks,
  taskTreeArchives,
} from './schema.ts'
import type {
  AfterBlocking,
  BlockerLink,
  BlockersCleared,
  NewStageEntry,
  NewTaskTree,
  StartCause,
  TreeRef,
} from './types.ts'

export interface TaskTreeArea {
  createTaskTree(input: NewTaskTree): { created: Map<string, Task>; linked: Task[] }
  leadCreatedTasks(creatorId: string): readonly { taskId: string; runId: string }[]
  needsPlanning(taskId: string, runId: string): Task
  startAfterPlanning(
    taskId: string,
    stage: StageId,
    entry: NewStageEntry,
    options?: { prepare?: boolean; cause?: StartCause | undefined },
  ): Task
  taskSplit(
    taskId: string,
    input: { pieceIds: string[]; narrowedTo: string; description: string },
  ): void
  childTasksCreated(
    taskId: string,
    childIds: readonly string[],
    from: 'split' | 'plan' | 'plan-task' | 'chat',
  ): void
  madeParent(taskId: string): boolean
  parentFinishedWithChildren(taskId: string): void
  taskPlanEnded(
    taskId: string,
    planId: string,
    outcome: 'approved' | 'stopped' | 'failed' | 'deleted' | 'archived',
  ): void
  blockedBy(blockerId: string): string[]
  openBlockedTasks(): string[]
  parentOf(taskId: string): string | undefined
  childrenOf(taskId: string): string[]
  setTaskParent(taskId: string, parentId: string | null): Task
  recordTreeArchive(rootId: string, taskIds: readonly string[]): void
  recordArchiveUnblocks(blockerId: string, taskIds: readonly string[]): void
  archiveUnblocked(blockerId: string): string[]
  archivedWith(rootId: string): string[]
  blockers(taskId: string): BlockerLink[]
  addBlocker(
    taskId: string,
    blockerId: string,
    options?: { runId?: string; then?: AfterBlocking },
  ): Task
  removeBlocker(taskId: string, blockerId: string, runId?: string): Task
  setTaskSnooze(taskId: string, until: string | null): Task
  setStartRequested(taskId: string, startRequested: boolean): Task
  waitForBlockers(taskId: string): Task
  blockersRemoved(taskId: string): boolean
  setBlockersRemoved(taskId: string, removed: boolean): void
  requeueAfterBlockers(taskId: string, why: BlockersCleared): Task
}

export function taskTreeArea(ctx: StoreContext): TaskTreeArea {
  const {
    store,
    commit,
    taskDraft,
    listFactories,
    emitGuides,
    guideEnding,
    setUpDone,
    queue,
    parentRow,
    childRows,
    blockerLinks,
    startRequestUsed,
    blockersRemovedUsed,
    startCause,
    toTask,
    toPublicTask,
    openRequestRows,
    stageEntered,
    taskRow,
    usedNumbers,
    taskEdited,
    nextRank,
    emit,
    requireComment,
    treeTaskEvents,
    commentPosted,
    emitComment,
    updatedTask,
    updatedQueue,
  } = ctx
  return {
    createTaskTree({
      factoryId,
      tasks: planned,
      links,
      comments: posted,
      closings = [],
      draftRevision,
    }) {
      const currentDraft = draftRevision ? taskDraft(factoryId).draft : null
      const used = usedNumbers(factoryId)
      const awaitingSetup = listFactories().find((f) => f.id === factoryId)?.clonedAt === undefined
      let number = Math.max(awaitingSetup ? 1 : 0, ...used) + 1
      let rank = nextRank()
      const at = new Date().toISOString()
      const ids = new Map(planned.map((t) => [t.key, randomUUID()]))
      const idOf = (ref: TreeRef) => {
        const id = 'key' in ref ? ids.get(ref.key) : ref.taskId
        if (id === undefined) throw new Error('a Task in the tree points at a missing parent')
        return id
      }
      const created = planned.flatMap((task) =>
        treeTaskEvents(task, {
          id: idOf({ key: task.key }),
          factoryId,
          number: number++,
          rank: rank++,
          ...(task.parent && { parentId: idOf(task.parent) }),
          at,
        }),
      )
      const linked = links.map((link) =>
        events.taskParentChanged({ taskId: link.taskId, parentId: idOf(link.parent), at }),
      )
      const comments = posted.map(({ task, ...comment }) =>
        commentPosted({ ...comment, taskId: idOf(task) }, at),
      )
      const byUser = planned.length > 0 && planned.every((task) => task.automation === undefined)
      const ending = byUser ? guideEnding(factoryId, 'task-created') : []
      const guideEnd = ending.length > 0 && setUpDone(factoryId) ? ending : []
      commit(
        ...guideEnd,
        ...(draftRevision
          ? [
              events.taskDraftConsumed({
                factoryId,
                revision: draftRevision,
                draft:
                  currentDraft && currentDraft.revision !== draftRevision
                    ? JSON.stringify(currentDraft)
                    : null,
                at,
              }),
            ]
          : []),
        ...created,
        ...linked,
        ...comments.flatMap(({ event, attached }) => [event, ...attached]),
        ...closings.map((closing) =>
          events.commentAnswered({
            id: closing.commentId,
            answer: JSON.stringify(closing.answer),
            at: closing.answer.at,
          }),
        ),
      )
      const made = new Map<string, Task>()
      for (const task of planned) {
        const row = taskRow(idOf({ key: task.key }))
        if (!row) throw new Error(`no Task ${task.key}`)
        const public_ = toPublicTask(toTask(row, true))
        made.set(task.key, public_)
        emit({ type: 'task-created', task: public_ })
      }
      const touched = new Set([
        ...links.flatMap((link) => [link.taskId, idOf(link.parent)]),
        ...planned.flatMap((task) =>
          task.parent && 'taskId' in task.parent ? [task.parent.taskId] : [],
        ),
        ...posted.flatMap(({ task }) => ('taskId' in task ? [task.taskId] : [])),
      ])
      const linkedTasks = links.map((link) => updatedTask(link.taskId))
      for (const id of touched) if (!links.some((l) => l.taskId === id)) updatedTask(id)
      for (const { id } of comments) emit({ type: 'comment-posted', comment: requireComment(id) })
      for (const closing of closings) updatedTask(emitComment(closing.commentId).taskId)
      if (guideEnd.length > 0) emitGuides()
      return { created: made, linked: linkedTasks }
    },
    leadCreatedTasks(creatorId) {
      return store
        .query(queryDb(tasks.select('id', 'createdByRun').where({ createdByTask: creatorId })))
        .map((row) => ({ taskId: row.id, runId: row.createdByRun ?? '' }))
    },
    needsPlanning(taskId, runId) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, movedTo: 'backlog' }
      commit(
        events.taskNeedsPlanning({ taskId, runId, at }),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    startAfterPlanning(taskId, stage, entry, options) {
      const at = new Date().toISOString()
      const rank = nextRank()
      commit(
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        ...startRequestUsed(taskId, at),
        ...blockersRemovedUsed(taskId, at),
        events.taskRanked({ taskId, rank, at }),
        events.taskStartedAfterPlanning({ taskId, stage, rank, at }),
        ...startCause(taskId, options?.cause, at),
        ...(options?.prepare || taskRow(taskId)?.preparation !== null
          ? [
              events.taskPreparationChanged({
                taskId,
                state: options?.prepare ? 'preparing' : null,
                at,
              }),
            ]
          : []),
        stageEntered(taskId, stage, entry, at),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    taskSplit(taskId, { pieceIds, narrowedTo, description }) {
      const at = new Date().toISOString()
      const edited = taskEdited(taskId, { title: narrowedTo, description }, at)
      commit(...(edited ? [edited] : []), events.taskSplit({ taskId, pieceIds, narrowedTo, at }))
      updatedTask(taskId)
    },
    childTasksCreated(taskId, childIds, from) {
      const at = new Date().toISOString()
      commit(events.childTasksCreated({ taskId, childIds: [...childIds], from, at }))
      updatedTask(taskId)
    },
    madeParent: (taskId) =>
      store.query(queryDb(taskLog.where({ taskId, name: 'v1.ChildTasksCreated' }))).length > 0,
    parentFinishedWithChildren(taskId) {
      commit(events.parentFinishedWithChildren({ taskId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    taskPlanEnded(taskId, planId, outcome) {
      if (!taskRow(taskId)) return
      commit(events.taskPlanEnded({ taskId, planId, outcome, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    blockedBy: (blockerId) =>
      store.query(queryDb(taskBlockers.where({ blockerId }))).map((row) => row.taskId),
    openBlockedTasks: () =>
      [
        ...new Set([
          ...store.query(queryDb(taskBlockers.orderBy('at', 'asc'))).map((row) => row.taskId),
          ...store.query(queryDb(taskParents.orderBy('taskId', 'asc'))).map((row) => row.parentId),
          ...store.query(queryDb(tasks.where({ blockersRemoved: true }))).map((row) => row.id),
          ...store
            .query(queryDb(comments.where({ answer: null })))
            .filter((row) => row.asanaMissing !== null)
            .map((row) => row.taskId),
        ]),
      ]
        .flatMap((id) => taskRow(id) ?? [])
        .filter((row) => row.stage !== 'done' && row.archivedAt === null)
        .sort((a, b) => a.number - b.number)
        .map((row) => row.id),
    parentOf: (taskId) => parentRow(taskId)?.parentId,
    childrenOf: (taskId) => childRows(taskId).map((row) => row.taskId),
    setTaskParent(taskId, parentId) {
      const old = parentRow(taskId)?.parentId
      commit(events.taskParentChanged({ taskId, parentId, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      for (const id of new Set([old, parentId])) if (id && taskRow(id)) updatedTask(id)
      return task
    },
    recordTreeArchive(rootId, taskIds) {
      commit(
        events.taskTreeArchived({ rootId, taskIds: [...taskIds], at: new Date().toISOString() }),
      )
    },
    recordArchiveUnblocks(blockerId, taskIds) {
      if (taskIds.length === 0) return
      commit(
        events.archiveUnblocked({ blockerId, taskIds: [...taskIds], at: new Date().toISOString() }),
      )
    },
    archiveUnblocked: (blockerId) =>
      store
        .query(queryDb(archiveUnblocks.where({ blockerId }).orderBy('taskId', 'asc')))
        .map((row) => row.taskId),
    archivedWith: (rootId) =>
      store
        .query(queryDb(taskTreeArchives.where({ rootId }).orderBy('taskId', 'asc')))
        .map((row) => row.taskId),
    blockers: blockerLinks,
    addBlocker(taskId, blockerId, { runId, then } = {}) {
      const at = new Date().toISOString()
      commit(
        events.taskBlockerAddedV2({ taskId, blockerId, runId: runId ?? null, at }),
        ...(then === 'backlog'
          ? [
              events.taskMovedToBacklog({ taskId, at }),
              events.taskStartRequestChanged({ taskId, startRequested: true, at }),
            ]
          : []),
        ...(then === 'wait' ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      if (then !== undefined) updatedQueue(taskId)
      return task
    },
    removeBlocker(taskId, blockerId, runId) {
      commit(
        events.taskBlockerRemoved({
          taskId,
          blockerId,
          runId: runId ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setTaskSnooze(taskId, until) {
      const at = new Date().toISOString()
      commit(
        until === null
          ? events.taskSnoozeCleared({ taskId, at })
          : events.taskSnoozed({ taskId, until, at }),
      )
      return updatedTask(taskId)
    },
    setStartRequested(taskId, startRequested) {
      const row = taskRow(taskId)
      const at = new Date().toISOString()
      commit(
        ...(startRequested && row?.stage === 'backlog' && row.stoppedAt !== null
          ? [
              events.taskResumed({ taskId, rank: row.rank ?? row.number, at }),
              events.taskDequeued({ taskId, at }),
            ]
          : []),
        ...(startRequested && taskRow(taskId)?.snoozedUntil
          ? [events.taskSnoozeCleared({ taskId, at: new Date().toISOString() })]
          : []),
        events.taskStartRequestChanged({ taskId, startRequested, at: new Date().toISOString() }),
      )
      return updatedTask(taskId)
    },
    waitForBlockers(taskId) {
      commit(events.taskWaitingForBlockers({ taskId, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    blockersRemoved(taskId) {
      return taskRow(taskId)?.blockersRemoved ?? false
    },
    setBlockersRemoved(taskId, removed) {
      const row = taskRow(taskId)
      if (!row || row.blockersRemoved === removed) return
      commit(events.taskBlockersRemovedChanged({ taskId, removed, at: new Date().toISOString() }))
    },
    requeueAfterBlockers(taskId, why) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      const at = new Date().toISOString()
      commit(
        events.taskRequeuedAfterBlockersV2({ taskId, rank, why, at }),
        ...blockersRemovedUsed(taskId, at),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
  }
}
