import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import {
  type AgentStageId,
  type AutopilotChoice,
  type ClarifyDepth,
  type ClarifyDepthChooser,
  type CommentAnswer,
  type CommentKind,
  type DescriptionVersion,
  type LayerKind,
  type LayerUse,
  type Priority,
  parseLinearUrl,
  type QueuedAfter,
  type StageEntry,
  type StageId,
  type Task,
  type TaskGateOverrides,
  type TaskIntervalHistory,
  type TaskLead,
  type TaskRepo,
  type TedStoppedTask,
} from '@ted/protocol'
import { isCleanup, mergesHere } from '@ted/protocol/stage'
import { placeholderFactory, type StoreContext, sequence } from './context.ts'
import { intervalBoundaries, isSubAgentRequested } from './interval-schema.ts'
import {
  comments,
  events,
  stageEntries,
  stageFileTexts,
  taskBlockers,
  taskMoves,
  tasks,
  workflowLayers,
} from './schema.ts'
import type { TaskHistory } from './task-history.ts'
import { blockerTransitions, taskIntervalHistory } from './task-intervals.ts'
import type {
  AcceptedLayer,
  LeadFailure,
  LeadMessage,
  LoggedEvent,
  MoveTaskInput,
  NewStageEntry,
  NewTask,
  NewWorktree,
  PlannedStage,
  QueuedTask,
  SeenStageFile,
  StartCause,
  StopReason,
  StoredTask,
  TreeRef,
} from './types.ts'

const tedStopEntries = new Set([
  'v1.TaskStoppedByTed',
  'v1.TedStopAnswered',
  'v1.TaskStopped',
  'v1.TaskResumed',
  'v1.TaskResumedOvernight',
  'v1.TaskRetried',
])

export interface TasksArea extends TaskHistory {
  createTask(input: NewTask): Promise<Task>
  listTasks(): Task[]
  getTask(ref: string): StoredTask | undefined
  startTask(input: {
    taskId: string
    stage: StageId
    branch: string
    worktree: string
    entry: NewStageEntry
    repo: NewWorktree
  }): Task
  queueTask(
    taskId: string,
    stage: StageId,
    options?: { prepare?: boolean; keepRank?: boolean; cause?: StartCause | undefined },
  ): Task
  moveToBacklog(taskId: string): Task
  rankTask(taskId: string, rank: number, priority: Priority): Task
  setPriority(taskId: string, priority: Priority): Task
  editTask(taskId: string, edit: { title?: string; description?: string }): Task
  descriptionVersions(taskId: string): DescriptionVersion[]
  archiveTask(taskId: string, record?: { closing: string[]; branches: number; why?: string }): Task
  unarchiveTask(
    taskId: string,
    input: { queue: boolean; waitForBlockers: boolean; reblocked?: readonly string[] },
  ): Task
  deleteTask(taskId: string): void
  resetTask(taskId: string): Task
  moveTask(input: MoveTaskInput): { id: string; from: string; to: string }[]
  nextTaskNumber(factoryId: string): number
  queue(): QueuedTask[]
  dequeue(taskId: string): Task
  taskStoppedByHuman(taskId: string): boolean
  stopTask(taskId: string, input: { runs: number; why: StopReason }): Task
  resumeTask(
    taskId: string,
    options: { waitForBlockers: boolean; overnight?: boolean; talkCommentId?: string },
  ): Task
  taskStoppedByTed(
    taskId: string,
    runId: string,
    cause: 'quit' | 'ended-outside',
    at?: string,
  ): void
  tedStopPending(taskId: string): boolean
  answerTedStop(taskId: string, choice: 'restart' | 'leave'): void
  tedStops(): TedStoppedTask[]
  leadNudged(taskId: string, runId: string): void
  leadFailed(failure: LeadFailure): Task
  retryTask(taskId: string, options: { waitForBlockers: boolean }): Task
  changeStage(
    taskId: string,
    stage: StageId,
    entry?: NewStageEntry,
    options?: { prepare?: boolean },
  ): Task
  listStageEntries(taskId: string): StageEntry[]
  recordedStages(taskId: string): PlannedStage[] | undefined
  acceptWorkflowLayer(layer: string, accepted: Omit<AcceptedLayer, 'acceptedAt'>): void
  lastValidWorkflowLayer(layer: string): AcceptedLayer | undefined
  rememberStageFileText(seen: SeenStageFile): void
  seenStageFileText(hash: string): SeenStageFile | undefined
  setTaskLead(taskId: string, lead: TaskLead): Task
  setLeadRestartPending(taskId: string, pending: boolean): void
  tasksWithQueuedContinuations(): string[]
  holdLeadMessage(taskId: string, text: string, waitForSlot?: boolean, after?: QueuedAfter): void
  deliveredLeadMessages(taskId: string, ids: readonly string[]): void
  setTaskAutopilot(taskId: string, choice: AutopilotChoice): Task
  setTaskGates(taskId: string, overrides: TaskGateOverrides): Task
  setClarifyDepth(
    taskId: string,
    input: { depth: ClarifyDepth; by: ClarifyDepthChooser; runId?: string; why?: string },
  ): Task
  setActivity(taskId: string, text: string, runId?: string): Task
  taskIntervalHistory(taskId: string, asOf?: string): TaskIntervalHistory
  taskLog(taskId: string): LoggedEvent[]
  tasksIn(ids: ReadonlySet<string>): Task[]
  preparedTasks(): string[]
  backlogTasks(): { id: string; snoozed: boolean }[]
  unarchivedTaskRepos(): { id: string; stage: StageId; repos: TaskRepo[] }[]
  taskOutlines(): {
    id: string
    factoryId: string
    stage: StageId
    archived: boolean
    setup: boolean
  }[]
  taskVersion(): number
  taskBuilds(): number
  setTaskStopping(taskId: string, on: boolean): void
}

export function tasksArea(ctx: StoreContext): TasksArea {
  const {
    storeState,
    store,
    checkingTasks,
    movingAfterChecks,
    heldMerges,
    stoppingTasks,
    commit,
    allTasks,
    taskDraft,
    listFactories,
    emitGuides,
    guideEnding,
    setUpDone,
    factoryKey,
    taskRuns,
    queue,
    reposOf,
    readTaskLog,
    history,
    parentRow,
    childRows,
    startRequestUsed,
    blockersRemovedUsed,
    startCause,
    entryRows,
    taskReads,
    readEveryTaskFrom,
    toTask,
    toPublicTask,
    openRequestRows,
    descriptionRows,
    stageEntered,
    checkRunRows,
    taskRow,
    usedNumbers,
    requireTaskRow,
    taskEdited,
    nextRank,
    emit,
    requireComment,
    treeTaskEvents,
    commentPosted,
    emitComment,
    updatedTask,
    updatedQueue,
    logRows,
    observationSessionId,
    repairApproved,
  } = ctx
  const toStageEntry = (row: typeof stageEntries.Type): StageEntry => ({
    taskId: row.taskId,
    stage: row.stage as StageId,
    ...(row.stageFileLayer !== null &&
      row.stageFilePath !== null && {
        stageFile: { layer: row.stageFileLayer as LayerKind, path: row.stageFilePath },
      }),
    layers: JSON.parse(row.layers) as LayerUse[],
    at: row.at,
  })

  const taskRowByDisplayId = (ref: string) => {
    const dash = ref.lastIndexOf('-')
    const digits = ref.slice(dash + 1)
    if (dash < 0 || !/^(0|[1-9]\d*)$/.test(digits)) return undefined
    const key = ref.slice(0, dash)
    const number = Number(digits)
    const row = store
      .query(queryDb(tasks.where({ number })))
      .find((row) => factoryKey(row.factoryId) === key)
    if (row) return row
    const moved = store
      .query(queryDb(taskMoves.where({ number })))
      .find((row) => factoryKey(row.factoryId) === key)
    return moved ? taskRow(moved.taskId) : undefined
  }
  const nextNumber = (factoryId: string) => {
    const awaitingSetup =
      listFactories().find((f) => f.id === factoryId)?.clonedAt === undefined &&
      factoryId !== placeholderFactory.id
    return Math.max(awaitingSetup ? 1 : 0, ...usedNumbers(factoryId)) + 1
  }

  const listTasks = () => {
    const reads = taskReads(true)
    return store.query(allTasks).map((row) => toTask(row, false, reads))
  }

  const updatedDependents = (blockerId: string) => {
    const parent = parentRow(blockerId)?.parentId
    if (parent && taskRow(parent)) updatedTask(parent)
    for (const { taskId } of store.query(queryDb(taskBlockers.where({ blockerId })))) {
      if (taskRow(taskId)) updatedTask(taskId)
    }
  }

  const pendingTedStop = (taskId: string, leadRunId: string | undefined): string | undefined => {
    const last = logRows(taskId)
      .filter((entry) => tedStopEntries.has(entry.name))
      .toSorted((a, b) => sequence(a.id) - sequence(b.id))
      .at(-1)
    if (last?.name !== 'v1.TaskStoppedByTed' || leadRunId === undefined) return undefined
    return (JSON.parse(last.data) as { runId?: string }).runId === leadRunId ? last.at : undefined
  }

  return {
    async createTask({
      draftRevision,
      repairApproval,
      title,
      linearConsent = false,
      factoryId = placeholderFactory.id,
      description = '',
      priority = 'none',
      clarifyDepth = 'auto',
      lead,
      startRequested = false,
      blockedBy = [],
      parentId,
      attachments = [],
      source,
      followUpOf,
      forcedGates = [],
      changesSettings = false,
      splitFrom,
      automation,
      checkFailure,
      plan,
      setup = false,
      coordinatorOperation,
      taskLead,
      children = [],
      notes = [],
    }) {
      const used = usedNumbers(factoryId)
      const awaitingSetup =
        !setup &&
        listFactories().find((f) => f.id === factoryId)?.clonedAt === undefined &&
        factoryId !== placeholderFactory.id
      const currentDraft = draftRevision ? taskDraft(factoryId).draft : null
      const number = setup && !used.includes(1) ? 1 : Math.max(awaitingSetup ? 1 : 0, ...used) + 1
      const id = randomUUID()
      const at = new Date().toISOString()
      const rootRank = nextRank()
      const childIds = new Map(children.map((child) => [child.key, randomUUID()]))
      const childId = (ref: TreeRef | undefined) => {
        if (ref === undefined) return id
        const found = 'key' in ref ? childIds.get(ref.key) : ref.taskId
        if (found === undefined) throw new Error('a child Task points at a missing parent')
        return found
      }
      let childNumber = Math.max(number, ...used) + 1
      let childRank = rootRank + 1
      const childEvents = children.flatMap((child) =>
        treeTaskEvents(child, {
          id: childId({ key: child.key }),
          factoryId,
          number: childNumber++,
          rank: childRank++,
          parentId: childId(child.parent),
          at,
        }),
      )
      const notePosts = notes.map(({ task, body }) =>
        commentPosted({ taskId: childId(task), kind: 'note', author: { kind: 'ted' }, body }, at),
      )
      const repair = repairApproval
        ? repairApproved(repairApproval, {
            id,
            displayId: `${listFactories().find((f) => f.id === factoryId)?.key ?? 'TASK'}-${number}`,
            title,
          })
        : undefined
      const byUser =
        !setup &&
        coordinatorOperation === undefined &&
        taskLead === undefined &&
        followUpOf === undefined &&
        splitFrom === undefined &&
        automation === undefined &&
        plan === undefined
      const ending = byUser ? guideEnding(factoryId, 'task-created') : []
      const guideEnd = ending.length > 0 && setUpDone(factoryId) ? ending : []
      commit(
        ...guideEnd,
        ...(draftRevision && factoryId !== placeholderFactory.id
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
        events.taskCreatedV2({
          id,
          factoryId,
          number,
          title,
          description,
          priority,
          clarifyDepth,
          leadAgent: lead?.agent ?? null,
          leadModel: lead?.model ?? null,
          leadEffort: lead?.effort ?? null,
          startRequested,
          createdAt: at,
        }),
        ...(lead?.effortMode === 'stage'
          ? [events.taskLeadEffortModeSet({ taskId: id, mode: 'stage', at })]
          : []),
        ...(repair?.events ?? []),
        ...(repairApproval?.startStage
          ? [
              events.taskQueued({
                taskId: id,
                stage: repairApproval.startStage,
                rank: nextRank(),
                at,
              }),
            ]
          : []),
        events.taskRanked({ taskId: id, rank: rootRank, at }),
        ...blockedBy.map((blockerId) =>
          events.taskBlockerAddedV2({ taskId: id, blockerId, runId: null, at }),
        ),
        ...(parentId ? [events.taskParentChanged({ taskId: id, parentId, at })] : []),
        ...attachments.map((attachment) =>
          events.taskAttachmentAdded({ taskId: id, ...attachment, at }),
        ),
        ...(source
          ? [
              events.taskSourceSet({
                taskId: id,
                url: source.url,
                linearIdentifier: source.linear?.identifier ?? null,
                linearTitle: source.linear?.title ?? null,
                linearBranchName: source.linear?.branchName ?? null,
                linearDescription: source.linear?.description ?? null,
                at,
              }),
              ...(source.sentry
                ? [events.taskSourceSentrySet({ taskId: id, shortId: source.sentry.shortId, at })]
                : []),
              ...(source.github
                ? [
                    events.taskSourceGitHubSet({
                      taskId: id,
                      github: JSON.stringify(source.github),
                      at,
                    }),
                  ]
                : []),
              ...(linearConsent && parseLinearUrl(source.url)
                ? [
                    events.linearSyncAllowed({
                      taskId: id,
                      identifier: parseLinearUrl(source.url)?.identifier ?? '',
                      by: 'created',
                      at,
                    }),
                  ]
                : []),
            ]
          : []),
        ...(forcedGates.length > 0
          ? [events.taskGatesForced({ taskId: id, stages: forcedGates, at })]
          : []),
        ...(changesSettings ? [events.taskChangesSettings({ taskId: id, at })] : []),
        ...(followUpOf !== undefined
          ? [
              events.taskFollowsUp({ taskId: id, originalId: followUpOf, at }),
              events.taskFollowedUp({ taskId: followUpOf, followUpId: id, at }),
            ]
          : []),
        ...(splitFrom !== undefined
          ? [events.taskSplitFrom({ taskId: id, originalId: splitFrom, at })]
          : []),
        ...(automation ? [events.automationTaskCreated({ ...automation, taskId: id, at })] : []),
        ...(automation && checkFailure !== undefined
          ? [
              events.automationCheckTaskCreated({
                taskId: id,
                automationId: automation.automationId,
                key: checkFailure,
                at,
              }),
            ]
          : []),
        ...(plan ? [events.planTaskCreated({ ...plan, taskId: id, at })] : []),
        ...(setup ? [events.setupTaskCreated({ taskId: id, factoryId, at })] : []),
        ...(coordinatorOperation !== undefined
          ? [
              events.taskCreatedByCoordinator({
                taskId: id,
                factoryId,
                operation: coordinatorOperation,
                at,
              }),
            ]
          : []),
        ...(taskLead
          ? [
              events.taskCreatedByTaskLead({ taskId: id, ...taskLead, at }),
              events.taskLeadCreatedTask({
                taskId: taskLead.creatorId,
                createdId: id,
                runId: taskLead.runId,
                child: taskLead.child,
                at,
              }),
            ]
          : []),
        ...childEvents,
        ...notePosts.flatMap(({ event, attached }) => [event, ...attached]),
      )
      const row = taskRow(id)
      if (!row) throw new Error(`no Task ${id}`)
      const task = toPublicTask(toTask(row, true))
      emit({ type: 'task-created', task })
      for (const child of children) {
        const childRow = taskRow(childId({ key: child.key }))
        if (childRow) emit({ type: 'task-created', task: toPublicTask(toTask(childRow, true)) })
      }
      for (const { id: commentId } of notePosts)
        emit({ type: 'comment-posted', comment: requireComment(commentId) })
      if (repairApproval) {
        emitComment(repairApproval.request.requestId)
        updatedTask(repairApproval.failure.taskId)
        updatedQueue(repairApproval.failure.taskId)
      }
      if (automation) emit({ type: 'automation-updated', automationId: automation.automationId })
      if (followUpOf !== undefined && taskRow(followUpOf)) updatedTask(followUpOf)
      if (parentId !== undefined && taskRow(parentId)) updatedTask(parentId)
      if (taskLead && taskLead.creatorId !== parentId && taskRow(taskLead.creatorId))
        updatedTask(taskLead.creatorId)
      if (guideEnd.length > 0) emitGuides()
      return task
    },
    listTasks: () => listTasks().map(toPublicTask),
    getTask(ref) {
      const row = taskRow(ref)
      const found = row ?? taskRowByDisplayId(ref)
      return found && toTask(found)
    },
    startTask({ taskId, stage, branch, worktree, entry, repo }) {
      const at = new Date().toISOString()
      const queued = queue().some((q) => q.id === taskId)
      commit(
        ...(queued ? [events.taskDequeued({ taskId, at })] : []),
        events.taskStarted({ taskId, stage, branch, worktree, at }),
        events.taskWorktreeCreated({ taskId, ...repo, branch, worktree, at }),
        stageEntered(taskId, stage, entry, at),
      )
      const task = updatedTask(taskId)
      if (queued) updatedQueue(taskId)
      return task
    },
    queueTask(taskId, stage, options) {
      const kept = options?.keepRank ? taskRow(taskId)?.rank : null
      const rank = kept ?? nextRank()
      const at = new Date().toISOString()
      commit(
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        ...(taskRow(taskId)?.stoppedAt !== null ? [events.taskResumed({ taskId, rank, at })] : []),
        ...startRequestUsed(taskId, at),
        ...blockersRemovedUsed(taskId, at),
        ...(kept == null ? [events.taskRanked({ taskId, rank, at })] : []),
        events.taskQueued({ taskId, stage, rank, at }),
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
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    moveToBacklog(taskId) {
      const at = new Date().toISOString()
      commit(
        events.taskMovedToBacklog({ taskId, at }),
        ...(taskRow(taskId)?.preparation !== null
          ? [events.taskPreparationChanged({ taskId, state: null, at })]
          : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    rankTask(taskId, rank, priority) {
      const at = new Date().toISOString()
      const changed = taskRow(taskId)?.priority !== priority
      commit(
        events.taskRanked({ taskId, rank, at }),
        ...(changed ? [events.taskPriorityChanged({ taskId, priority, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    editTask(taskId, edit) {
      const event = taskEdited(taskId, edit, new Date().toISOString())
      if (!event) return toPublicTask(toTask(requireTaskRow(taskId)))
      commit(event)
      return updatedTask(taskId)
    },
    descriptionVersions(taskId) {
      const rows = descriptionRows(taskId)
      if (rows.length > 0) return rows.map(({ version, text, at }) => ({ version, text, at }))
      const row = taskRow(taskId)
      return row ? [{ version: 1, text: row.description, at: row.createdAt }] : []
    },
    setPriority(taskId, priority) {
      commit(events.taskPriorityChanged({ taskId, priority, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    archiveTask(taskId, { closing, branches, why } = { closing: [], branches: 0 }) {
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId)
      const answer: CommentAnswer = { kind: 'withdrawn', at, archived: true }
      const archived = taskRow(taskId)
      const guideEnd = archived?.setup ? guideEnding(archived.factoryId, 'setup-archived') : []
      commit(
        ...guideEnd,
        ...(taskRow(taskId)?.snoozedUntil ? [events.taskSnoozeCleared({ taskId, at })] : []),
        ...blockersRemovedUsed(taskId, at),
        why === undefined
          ? events.taskArchivedV2({ taskId, closing, branches, at })
          : events.taskArchivedV3({ taskId, closing, branches, why, at }),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      updatedDependents(taskId)
      if (guideEnd.length > 0) emitGuides()
      return task
    },
    unarchiveTask(taskId, { queue: queued, waitForBlockers, reblocked = [] }) {
      const at = new Date().toISOString()
      const rank = queued ? Math.max(0, ...queue().map((q) => q.rank)) + 1 : null
      commit(
        events.taskUnarchivedV2({ taskId, rank, reblocked: [...reblocked], at }),
        ...(taskRow(taskId)?.preparation === 'ready'
          ? [events.taskStopped({ taskId, runs: 0, why: 'prepared', at })]
          : []),
        ...(queued && waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      updatedDependents(taskId)
      return task
    },
    deleteTask(taskId) {
      const oldParent = parentRow(taskId)?.parentId
      const oldChildren = childRows(taskId).map((row) => row.taskId)
      const row = taskRow(taskId)
      if (!row) return
      checkingTasks.delete(taskId)
      movingAfterChecks.delete(taskId)
      heldMerges.delete(taskId)
      const at = new Date().toISOString()
      const guideEnd = row.setup ? guideEnding(row.factoryId, 'setup-deleted') : []
      commit(
        ...guideEnd,
        ...[
          ...childRows(taskId).map((row) => row.taskId),
          ...(parentRow(taskId) ? [taskId] : []),
        ].map((id) => events.taskParentChanged({ taskId: id, parentId: null, at })),
        events.taskExecutionForgotten({ taskId, at }),
        events.executionOperationsForgotten({ taskId, at }),
        events.taskDeleted({
          taskId,
          factoryId: row.factoryId,
          number: row.number,
          runIds: taskRuns(taskId).map((r) => r.id),
          checkRunIds: checkRunRows(taskId).map((r) => r.id),
          at,
        }),
      )
      if (oldParent && taskRow(oldParent)) updatedTask(oldParent)
      for (const id of oldChildren) if (taskRow(id)) updatedTask(id)
      emit({ type: 'task-deleted', taskId })
      updatedQueue()
      updatedDependents(taskId)
      if (guideEnd.length > 0) emitGuides()
    },
    resetTask(taskId) {
      const row = requireTaskRow(taskId)
      checkingTasks.delete(taskId)
      movingAfterChecks.delete(taskId)
      heldMerges.delete(taskId)
      const runIds = taskRuns(taskId).map((r) => r.id)
      const human = history.humanClarifyDepth(taskId)
      const byLead = row.clarifyDepthBy === 'task-lead'
      commit(
        events.taskReset({
          taskId,
          description: descriptionRows(taskId).at(0)?.text ?? row.description,
          clarifyDepth: byLead ? (human ?? 'auto') : row.clarifyDepth,
          clarifyDepthBy: byLead ? (human === undefined ? null : 'human') : row.clarifyDepthBy,
          runIds,
          checkRunIds: checkRunRows(taskId).map((r) => r.id),
          at: new Date().toISOString(),
        }),
      )
      emit({ type: 'task-reset', taskId })
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      updatedDependents(taskId)
      return task
    },
    nextTaskNumber: (factoryId) => nextNumber(factoryId),
    moveTask({ moves, unlink, leaveParent, notes, by }) {
      const at = new Date().toISOString()
      const next = new Map<string, number>()
      const numberIn = (factoryId: string) => {
        const number = next.get(factoryId) ?? nextNumber(factoryId)
        next.set(factoryId, number + 1)
        return number
      }
      const planned = moves.map(({ taskId, factoryId, started }) => {
        const row = requireTaskRow(taskId)
        checkingTasks.delete(taskId)
        movingAfterChecks.delete(taskId)
        heldMerges.delete(taskId)
        return {
          row,
          started,
          factoryId,
          number: numberIn(factoryId),
          from: `${factoryKey(row.factoryId)}-${row.number}`,
        }
      })
      const withdrawn = planned.flatMap(({ row, factoryId }) =>
        openRequestRows(row.id).map((request) => ({ request, factoryId })),
      )
      const oldParent = leaveParent === undefined ? undefined : parentRow(leaveParent)?.parentId
      const posts = notes.map(({ taskId, body }) =>
        commentPosted({ taskId, kind: 'note', author: { kind: 'ted' }, body }, at),
      )
      commit(
        ...unlink.map(({ taskId, blockerId }) =>
          events.taskBlockerRemoved({ taskId, blockerId, runId: null, at }),
        ),
        ...(leaveParent !== undefined && oldParent !== undefined
          ? [events.taskParentChanged({ taskId: leaveParent, parentId: null, at })]
          : []),
        ...withdrawn.map(({ request, factoryId }) => {
          const answer: CommentAnswer = { kind: 'withdrawn', at, movedToFactory: factoryId }
          return events.commentAnswered({ id: request.id, answer: JSON.stringify(answer), at })
        }),
        ...planned.flatMap(({ row, started, factoryId, number, from }) => [
          ...(row.snoozedUntil ? [events.taskSnoozeCleared({ taskId: row.id, at })] : []),
          events.taskMovedToFactory({
            taskId: row.id,
            fromFactoryId: row.factoryId,
            fromNumber: row.number,
            fromDisplayId: from,
            factoryId,
            number,
            by,
            started,
            checkRunIds: checkRunRows(row.id).map((r) => r.id),
            at,
          }),
        ]),
        ...posts.flatMap(({ event, attached }) => [event, ...attached]),
      )
      for (const { request } of withdrawn) emitComment(request.id)
      for (const { id } of posts) emitComment(id)
      for (const { row } of planned) updatedTask(row.id)
      if (oldParent !== undefined && taskRow(oldParent)) updatedTask(oldParent)
      for (const { taskId, blockerId } of unlink) {
        if (taskRow(taskId)) updatedTask(taskId)
        if (taskRow(blockerId)) updatedTask(blockerId)
      }
      updatedQueue()
      for (const { row } of planned) updatedDependents(row.id)
      return planned.map(({ row, factoryId, number, from }) => ({
        id: row.id,
        from,
        to: `${factoryKey(factoryId)}-${number}`,
      }))
    },
    queue,
    dequeue(taskId) {
      commit(events.taskDequeued({ taskId, at: new Date().toISOString() }))
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    taskStoppedByHuman(taskId) {
      const row = requireTaskRow(taskId)
      return row.stoppedAt !== null && (row.stoppedWhy === 'human' || row.stoppedWhy === null)
    },
    stopTask(taskId, { runs, why }) {
      const pendingTalks = store.query(queryDb(comments.where({ taskId, talkRequested: true })))
      const at = new Date().toISOString()
      commit(
        events.taskStopped({ taskId, runs, why, at }),
        ...((why === 'human' || why === 'blockers-removed') &&
        taskRow(taskId)?.preparation === 'ready'
          ? [events.taskPreparationChanged({ taskId, state: null, at })]
          : []),
      )
      for (const { id } of pendingTalks) emitComment(id)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    resumeTask(taskId, { waitForBlockers, overnight, talkCommentId }) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      const at = new Date().toISOString()
      commit(
        ...(talkCommentId ? [events.roundTalkRequested({ id: talkCommentId, at })] : []),
        (overnight ? events.taskResumedOvernight : events.taskResumed)({ taskId, rank, at }),
        ...(taskRow(taskId)?.preparation === 'ready'
          ? [events.taskPreparationChanged({ taskId, state: null, at })]
          : []),
        ...(waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      if (talkCommentId) emitComment(talkCommentId)
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    taskStoppedByTed(taskId, runId, cause, at = new Date().toISOString()) {
      commit(events.taskStoppedByTed({ taskId, runId, cause, at }))
      emit({ type: 'ted-stops-changed' })
    },
    tedStopPending(taskId) {
      const lead = taskRuns(taskId).find((run) => run.parentRunId === null)
      return pendingTedStop(taskId, lead?.id) !== undefined
    },
    answerTedStop(taskId, choice) {
      commit(events.tedStopAnswered({ taskId, choice, at: new Date().toISOString() }))
      emit({ type: 'ted-stops-changed' })
    },
    tedStops() {
      return listTasks().flatMap((task) => {
        if (!task.canResume) return []
        const stoppedAt = pendingTedStop(task.id, task.leadRunId)
        if (stoppedAt === undefined) return []
        return [
          {
            id: task.id,
            displayId: task.displayId,
            title: task.title,
            stage: task.stage,
            factoryId: task.factoryId,
            stoppedAt,
          },
        ]
      })
    },
    leadNudged(taskId, runId) {
      commit(events.taskLeadNudged({ taskId, runId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    leadFailed({ taskId, runId, reason, recovery, resumeFailed, ask, mergeAnyway }) {
      const at = new Date().toISOString()
      const id = ask && randomUUID()
      commit(
        events.taskLeadFailed({
          taskId,
          runId,
          reason,
          recovery,
          resumeFailed,
          rank: recovery === 'fresh' ? Math.max(0, ...queue().map((q) => q.rank)) + 1 : null,
          ask: ask && id ? { id, ...ask } : null,
          at,
        }),
        ...(id
          ? [
              events.commentPurposeRecorded({
                commentId: id,
                purpose: JSON.stringify({ kind: 'failed-run' }),
              }),
              ...(mergeAnyway
                ? [
                    events.failedRunMergeAnywayOffered({
                      commentId: id,
                      choices: JSON.stringify(['Retry', 'Merge anyway']),
                    }),
                  ]
                : []),
            ]
          : []),
      )
      if (id) emit({ type: 'comment-posted', comment: requireComment(id) })
      const task = updatedTask(taskId)
      if (recovery === 'fresh') updatedQueue(taskId)
      return task
    },
    retryTask(taskId, { waitForBlockers }) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      const at = new Date().toISOString()
      commit(
        events.taskRetried({ taskId, rank, at }),
        ...(waitForBlockers ? [events.taskWaitingForBlockers({ taskId, at })] : []),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    changeStage(taskId, stage, entry, options) {
      heldMerges.delete(taskId)
      const at = new Date().toISOString()
      const withdrawn = openRequestRows(taskId).filter(
        (row) =>
          ((row.gate !== null || row.kind === 'round') && row.stage !== stage) ||
          (stage === 'done' && row.archive !== null),
      )
      const answer: CommentAnswer = { kind: 'withdrawn', at, movedTo: stage }
      commit(
        events.taskStageChanged({ taskId, stage, at }),
        ...(options?.prepare
          ? [
              events.taskPreparationChanged({ taskId, state: 'ready', at }),
              events.taskStopped({
                taskId,
                runs: taskRuns(taskId).filter((r) => r.state !== 'finished').length,
                why: 'prepared',
                at,
              }),
            ]
          : []),
        ...(entry ? [stageEntered(taskId, stage, entry, at)] : []),
        ...(mergesHere(stage) ? [events.mergeAwaitsLead({ taskId, at })] : []),
        ...withdrawn.map(({ id }) =>
          events.commentAnswered({ id, answer: JSON.stringify(answer), at }),
        ),
      )
      for (const { id } of withdrawn) emitComment(id)
      const task = updatedTask(taskId)
      if (options?.prepare) updatedQueue(taskId)
      if (stage === 'done' || isCleanup(stage)) updatedDependents(taskId)
      return task
    },
    listStageEntries: (taskId) =>
      store.query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc'))).map(toStageEntry),
    recordedStages(taskId) {
      const saved = store
        .query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc')))
        .findLast((e) => e.order !== null)?.order
      return saved ? (JSON.parse(saved) as PlannedStage[]) : undefined
    },
    acceptWorkflowLayer(layer, { files, version }) {
      commit(
        events.workflowLayerAccepted({
          layer,
          files: JSON.stringify(files),
          version,
          at: new Date().toISOString(),
        }),
      )
    },
    rememberStageFileText(seen) {
      if (store.query(queryDb(stageFileTexts.where({ hash: seen.hash }))).length > 0) return
      commit(events.stageFileTextSeen({ ...seen, at: new Date().toISOString() }))
    },
    seenStageFileText(hash) {
      const row = store.query(queryDb(stageFileTexts.where({ hash }))).at(0)
      return (
        row && {
          hash: row.hash,
          layer: row.layer as LayerKind,
          stage: row.stage as AgentStageId,
          text: row.text,
          tedVersion: row.tedVersion,
        }
      )
    },
    lastValidWorkflowLayer(layer) {
      const row = store.query(queryDb(workflowLayers.where({ layer }))).at(0)
      return (
        row && {
          files: JSON.parse(row.files) as AcceptedLayer['files'],
          version: row.version,
          acceptedAt: row.acceptedAt,
        }
      )
    },
    setTaskLead(taskId, { agent, model, effort, effortMode }) {
      commit(
        events.taskLeadEffortModeSet({
          taskId,
          mode: effortMode ?? null,
          at: new Date().toISOString(),
        }),
        events.taskLeadSet({
          taskId,
          agent,
          model: model ?? null,
          effort: effort ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setLeadRestartPending(taskId, pending) {
      commit(events.taskLeadRestartPendingSet({ taskId, pending, at: new Date().toISOString() }))
    },
    tasksWithQueuedContinuations: () => [
      ...new Set([
        ...store
          .query(queryDb(tasks.where({ pendingLeadDeliveries: { op: '!=', value: null } })))
          .filter((row) =>
            (JSON.parse(row.pendingLeadDeliveries ?? '[]') as LeadMessage[]).some(
              (message) => message.waitForSlot,
            ),
          )
          .map((row) => row.id),
        ...store
          .query(queryDb(comments.where({ answerHeld: true })))
          .filter((comment) => comment.answerQueuedAt !== null)
          .map((comment) => comment.taskId),
        ...store
          .query(queryDb(comments.where({ talkRequested: true, answer: null })))
          .map((comment) => comment.taskId),
      ]),
    ],
    holdLeadMessage(taskId, text, waitForSlot = false, after) {
      const pending = toTask(requireTaskRow(taskId)).pendingLeadMessages
      const at = new Date().toISOString()
      commit(
        events.taskLeadMessagesHeld({
          taskId,
          messages: JSON.stringify([
            ...pending,
            {
              id: randomUUID(),
              text,
              ...(waitForSlot && { waitForSlot: true }),
              ...(waitForSlot && after !== undefined && { after, heldAt: at }),
            },
          ]),
          at,
        }),
      )
    },
    deliveredLeadMessages(taskId, ids) {
      const pending = toTask(requireTaskRow(taskId)).pendingLeadMessages
      const remaining = pending.filter((message) => !ids.includes(message.id))
      if (remaining.length === pending.length) return
      commit(
        events.taskLeadMessagesHeld({
          taskId,
          messages: JSON.stringify(remaining),
          at: new Date().toISOString(),
        }),
      )
    },
    setTaskAutopilot(taskId, choice) {
      commit(events.taskAutopilotChanged({ taskId, choice, at: new Date().toISOString() }))
      return updatedTask(taskId)
    },
    setTaskGates(taskId, overrides) {
      commit(
        events.taskGatesChanged({
          taskId,
          overrides: JSON.stringify(overrides),
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setClarifyDepth(taskId, { depth, by, runId, why }) {
      commit(
        events.clarifyDepthSet({
          taskId,
          depth,
          by,
          runId: runId ?? null,
          why: why ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    setActivity(taskId, text, runId) {
      commit(
        events.taskActivitySet({
          taskId,
          text,
          runId: runId ?? null,
          stageEntries: entryRows(taskId).length,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    ...history,
    taskIntervalHistory(taskId, asOf = new Date().toISOString()) {
      const row = requireTaskRow(taskId)
      const taskBoundaries = store.query(
        queryDb(intervalBoundaries.where({ subject: `task:${taskId}` })),
      )
      const queuedRunIds = taskBoundaries
        .filter((b) => isSubAgentRequested(b.name))
        .map((b) => String(JSON.parse(b.data).queuedRunId))
      return taskIntervalHistory({
        taskId,
        createdAt: row.createdAt,
        asOf,
        log: readTaskLog(taskId),
        observations: store.query(
          queryDb(intervalBoundaries.where({ subject: 'observation' }).orderBy('sequence', 'asc')),
        ),
        boundaries: [
          ...taskBoundaries,
          ...queuedRunIds.flatMap((id) =>
            store.query(queryDb(intervalBoundaries.where({ subject: `sub-agent:${id}` }))),
          ),
          ...taskRuns(taskId).flatMap((r) =>
            store.query(
              queryDb(
                intervalBoundaries.where({ subject: `run:${r.id}` }).orderBy('sequence', 'asc'),
              ),
            ),
          ),
        ],
        blockerCompletions: readTaskLog(taskId).flatMap((event) => {
          if (!event.name.endsWith('TaskBlockerAdded') || typeof event.data.blockerId !== 'string')
            return []
          const id = event.data.blockerId
          return blockerTransitions(id, [
            ...readTaskLog(id),
            ...store
              .query(queryDb(intervalBoundaries.where({ subject: `task:${id}` })))
              .filter((b) => b.name !== 'v1.TaskWaitObserved')
              .map((b) => ({
                id: b.id,
                name: b.name,
                at: b.at,
                data: JSON.parse(b.data) as Record<string, unknown>,
              })),
          ])
        }),
        agents: store.query(queryDb(intervalBoundaries.where({ subject: 'agent' }))),
        runAgents: new Map(taskRuns(taskId).map((r) => [r.id, r.agent])),
        sessionId: observationSessionId,
        comments: store
          .query(queryDb(comments.select('id', 'kind', 'createdAt', 'answer').where({ taskId })))
          .filter((row) => row.kind !== 'note')
          .map((row) => ({
            id: row.id,
            kind: row.kind as CommentKind,
            createdAt: row.createdAt,
            ...(row.answer !== null && { answer: JSON.parse(row.answer) as CommentAnswer }),
          })),
      })
    },
    taskLog: readTaskLog,
    tasksIn: (ids) => {
      const reads = ids.size > readEveryTaskFrom ? taskReads(true) : undefined
      return store
        .query(allTasks)
        .filter((row) => ids.has(row.id))
        .map((row) => toPublicTask(toTask(row, false, reads)))
    },
    preparedTasks: () =>
      store
        .query(allTasks)
        .filter((row) => row.preparation === 'ready' && row.archivedAt === null)
        .map((row) => row.id),
    backlogTasks: () =>
      store
        .query(allTasks)
        .filter((row) => row.stage === 'backlog' && row.archivedAt === null)
        .map((row) => ({ id: row.id, snoozed: Boolean(row.snoozedUntil) })),
    unarchivedTaskRepos: () =>
      store
        .query(allTasks)
        .filter((row) => row.archivedAt === null)
        .map((row) => ({ id: row.id, stage: row.stage as StageId, repos: reposOf(row.id) })),
    taskOutlines: () =>
      store.query(allTasks).map((row) => ({
        id: row.id,
        factoryId: row.factoryId,
        stage: row.stage as StageId,
        archived: row.archivedAt !== null,
        setup: row.setup,
      })),
    taskVersion: () => storeState.stateCommits,
    taskBuilds: () => storeState.taskBuilds,
    setTaskStopping(taskId, on) {
      if (stoppingTasks.has(taskId) === on) return
      storeState.stateCommits += 1
      if (on) {
        if (!taskRow(taskId)) return
        stoppingTasks.add(taskId)
      } else stoppingTasks.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
    },
  }
}
