import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb, StoreInternalsSymbol } from '@livestore/livestore'
import {
  type Activity,
  type AgentKind,
  type AgentStageId,
  type Appearance,
  type ArchiveAsk,
  type AsanaMissing,
  type AsanaSync,
  type AsanaUnfinished,
  type Attachment,
  type AutopilotChoice,
  agentStageIds,
  asanaSyncOf,
  automationCardHeadline,
  autopilotEnabled,
  type BacklogStarts,
  type BusyHold,
  busyHold,
  type CheckResult,
  type CheckRun,
  type CheckRunOutcome,
  type CheckRunTrigger,
  type CheckState,
  type CiSignal,
  type ClarifyDepth,
  type ClarifyDepthChooser,
  type CleanupFailureAsk,
  type Comment,
  type CommentAnswer,
  type CommentKind,
  type ConversationTab,
  type CopySkip,
  type CreatedBy,
  chatRequestKinds,
  type DaemonEvent,
  type DesignReview,
  type DiffRow,
  defaultMachineSettings,
  defaultWorkingRuns,
  deviceSlotLimits,
  type Effort,
  type FactoryGuide,
  type FactoryIcon,
  type FailureCase,
  factoryNotifications,
  failureChoices,
  firstFactoryNotifications,
  type GitHubWait,
  type GuideEnding,
  type LinearTeam,
  type LineComment,
  type LineSide,
  type MachineSettings,
  type MemoryKillAsk,
  type MergeMethod,
  type NewTaskDraft,
  namedRepairChoice,
  noBacklogStarts,
  type Priority,
  type Proposal,
  parseAsanaTaskUrl,
  parseLinearUrl,
  parseSetBacklogStartsRequest,
  type RequestPurpose,
  type Round,
  type Run,
  type RunEnding,
  type RunProblem,
  type RunState,
  type SimulatorAsk,
  type SizeCheck,
  type SnoozedRequest,
  type StageId,
  type Task,
  type TaskAsanaSource,
  type TaskBackToWork,
  type TaskDraftState,
  type TaskEnding,
  type TaskGateOverrides,
  type TaskGitHubSource,
  type TaskPullRequest,
  type TaskRepo,
  type TaskSource,
  type TrackStage,
  type WaitingRequest,
  type WorktreeCommandOutcome,
} from '@ted/protocol'
import { isInteger, isOneOf, type Untyped } from '@ted/protocol/parse'
import { planTitle as titleFromMessage } from '@ted/protocol/plan'
import {
  compareStages,
  hasClarifyRounds,
  isCleanup,
  mergesHere,
  validates,
} from '@ted/protocol/stage'
import { type MoveAsk, readMoveAsk } from '@ted/protocol/task-move'
import { Effect } from 'effect'
import { totalMemory } from '../busy.ts'
import { isDiskFullError } from '../disk.ts'
import { redactSecrets } from '../redact.ts'
import { queueOrder } from '../tasks/queue.ts'
import {
  commentBox,
  commentDelivery,
  statusWithoutBlocker,
  type TaskFacts,
  taskActivity,
  taskCanResume,
  taskIsMerged,
  taskMarkers,
  taskPauses,
  taskStatus,
  taskStatuses,
  taskWaitReasons,
  taskWakesOnComment,
} from '../tasks/status.ts'
import { createChatStore } from './chats.ts'
import { checkRunTiming } from './check-timing.ts'
import {
  confirmationHeadline,
  createCoordinatorStore,
  type StoredCoordinator,
} from './coordinators.ts'
import { createFailureStore } from './failures.ts'
import { eventCount, eventlogFile, storeId } from './files.ts'
import { intervalBoundaries } from './interval-schema.ts'
import { countMaterialized } from './progress.ts'
import { legacyPurpose, structuralPurpose } from './request-purpose.ts'
import {
  agentPauses,
  automationComments,
  automations,
  automationTasks,
  chatRequests as chatRequestRows,
  checkBoundaries,
  checkResults,
  checkRuns,
  commentAttachments,
  comments,
  conversationTabs,
  coordinatorChats as coordinatorRows,
  deletedTasks,
  events,
  factories,
  factoryOrder,
  factoryRepos,
  heldRuns,
  lineComments,
  machineSettings,
  machineSettingValues,
  peerMessages,
  planRequests,
  plans,
  planTasks,
  pullRequests,
  requestSnoozes,
  runs,
  runUsage,
  schema,
  sendBackAsks,
  sendBackResets,
  sendBacks,
  stageEntries,
  subAgentRequests,
  taskAttachments,
  taskBlockers,
  taskBriefs,
  taskBrowserCaptures,
  taskDescriptions,
  taskDraftConsumptions,
  taskDrafts,
  taskLog,
  taskMoves,
  taskParents,
  taskQueue,
  taskRepos,
  taskSources,
  tasks,
} from './schema.ts'
import { markEventsSynced } from './sync-head.ts'
import { createTaskHistory } from './task-history.ts'
import { taskTokens } from './task-tokens.ts'
import { createTestInvocationStore } from './test-invocations.ts'
import type {
  BlockerLink,
  CheckWork,
  FoundConflict,
  LeadMessage,
  LinearSyncRecord,
  LoggedEvent,
  NewComment,
  NewStageEntry,
  NewTreeTask,
  OpenProgress,
  PlannedStage,
  QueueActivity,
  QueuedTask,
  RepairApproval,
  RunRow,
  StartCause,
  StoredFactory,
  StoredPermission,
  StoredTask,
  TrackerSyncRecord,
} from './types.ts'

function movedAsk(text: string | null): { move?: MoveAsk } {
  const move = text === null ? undefined : readMoveAsk(text)
  return move ? { move } : {}
}

export const placeholderFactory = { id: 'dev', key: 'DEV' }

export const linearSteps = ['started', 'review', 'done'] as const

function pick(values: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.includes(name)))
}

const persistTimeoutMs = 10_000

const runFields = [
  'id',
  'agent',
  'sessionId',
  'model',
  'effort',
  'usesDefaultModel',
  'problem',
  'problemAt',
  'permissions',
  'manualPermissions',
  'cwd',
  'taskId',
  'parentRunId',
  'name',
  'failure',
  'state',
  'readOffset',
  'lastOutputAt',
  'startedAt',
  'revivedAt',
  'ended',
  'retrying',
  'steeringRelease',
] as const

export const runRows = runs.select(...runFields)

const briefTimes = taskBriefs.select('taskId', 'version', 'createdAt')

let tasksBuiltHere = 0

export function tasksBuiltInProcess(): number {
  return tasksBuiltHere
}

export function sequence(id: string): number {
  const [global = 0, client = 0] = id.split('.').map(Number)
  return global * 1_000_000 + client
}

function describeOpenError(error: unknown): string {
  let event: string | undefined
  let message = ''
  for (let at: unknown = error; at !== undefined && at !== null; ) {
    const current = at as { message?: unknown; note?: unknown; cause?: unknown }
    const note = typeof current.note === 'string' ? current.note : ''
    event ??= /event definition "([^"]+)"/.exec(note)?.[1]
    if (typeof current.message === 'string' && current.message.trim() !== '') {
      message = current.message
    }
    at = current.cause
  }
  const text = message.replace(/\s+/g, ' ').trim() || 'unknown error'
  return event ? `${event}: ${text}` : text
}

function track(stage: StageId, entries: readonly (typeof stageEntries.Type)[]): TrackStage[] {
  const saved = entries.findLast((e) => e.order !== null)?.order
  const plan: PlannedStage[] = saved
    ? (JSON.parse(saved) as PlannedStage[])
    : agentStageIds.filter((id) => !isCleanup(id)).map((id) => ({ stage: id, enabled: true }))
  const order: StageId[] = plan.map((p) => p.stage)
  const entered = new Set(entries.map((e) => e.stage))
  const inOrder = order.includes(stage)
  const rank = (id: StageId) =>
    inOrder ? order.indexOf(id) : compareStages(id, stage, order) < 0 ? -1 : 1
  const state = (id: StageId, enabled: boolean): TrackStage['state'] => {
    if (id === stage) return 'current'
    if (!enabled) return 'skipped'
    if (stage === 'backlog') return 'future'
    if (stage === 'done' || rank(id) < rank(stage)) return entered.has(id) ? 'past' : 'skipped'
    return 'future'
  }
  return plan.map(({ stage: id, enabled, name }) => ({
    stage: id,
    ...(name !== undefined && { name }),
    state: state(id, enabled),
  }))
}

export function storedPermission(json: string): StoredPermission {
  return JSON.parse(json) as StoredPermission
}

function publicPermission(json: string): NonNullable<Comment['permission']> {
  const { command, details, repo } = storedPermission(json)
  return {
    command,
    ...(details !== undefined && { details }),
    ...(repo !== undefined && { repo }),
  }
}

function headlineOf(title: string | null, body: string): string {
  if (title !== null && title.trim() !== '') return title.trim()
  return (
    body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

function androidAsk(simulator: string): boolean {
  try {
    return (JSON.parse(simulator) as SimulatorAsk).platform === 'android'
  } catch {
    return false
  }
}

function deviceLimitFromOldLimits(values: {
  maxBootedSimulators?: Untyped
  maxRunningEmulators?: Untyped
}): Partial<MachineSettings> {
  const { maxBootedSimulators: simulators, maxRunningEmulators: emulators } = values
  if (simulators === undefined && emulators === undefined) return {}
  const total = (isInteger(simulators) ? simulators : 3) + (isInteger(emulators) ? emulators : 2)
  return { maxRunningDevices: Math.min(total, deviceSlotLimits.max) }
}

interface LiveState {
  newWorkHeld: string | undefined
  piSandboxReason: string | undefined
  heldBusy: BusyHold | undefined
  checksWaiting: ReadonlyMap<string, number>
  waitingUnchanged: boolean
  shutDown: boolean
  stateCommits: number
  taskBuilds: number
  asanaConnection: { known: false } | { known: true; account?: string }
  queueActivity: QueueActivity
  shellsRunning: number
  scheduledChecks: { running: number; waiting: number }
}

export async function openContext({
  directory,
  onProgress,
}: {
  directory: string
  onProgress?: (progress: OpenProgress) => void
}) {
  const total = onProgress ? await eventCount(directory) : 0
  let done = 0
  const marked = await markEventsSynced(directory)
  if (marked.kind === 'failed') {
    console.error(
      redactSecrets(
        `marking the event log as synced failed, so LiveStore keeps every event in memory: ${marked.reason}`,
      ),
    )
  }
  countMaterialized(onProgress && (() => onProgress({ done: Math.min(++done, total), total })))
  const store = await createStorePromise({
    schema,
    storeId,
    adapter: makeAdapter({ storage: { type: 'fs', baseDirectory: directory } }),
    disableDevtools: true,
  })
    .catch((error: unknown) => {
      throw new Error(describeOpenError(error), { cause: error })
    })
    .finally(() => countMaterialized(undefined))
  const eventlogName = path.basename((await eventlogFile(directory)) ?? 'eventlog.db')

  const writeListeners = new Set<(error?: unknown) => void>()
  let writeFailing = false
  const storeState: LiveState = {
    newWorkHeld: undefined,
    piSandboxReason: undefined,
    heldBusy: undefined,
    checksWaiting: new Map(),
    waitingUnchanged: false,
    shutDown: false,
    stateCommits: 0,
    taskBuilds: 0,
    asanaConnection: { known: false },
    queueActivity: {
      queuedTasks: [],
      queuedRuns: [],
      startingRuns: [],
      startingTasks: [],
    },
    shellsRunning: 0,
    scheduledChecks: { running: 0, waiting: 0 },
  }

  const waitingOnSubAgents = new Set<string>()
  const asleepRuns = new Set<string>()
  const liveTokens = new Map<string, number>()
  const checkingTasks = new Set<string>()
  const movingAfterChecks = new Set<string>()
  const heldMerges = new Map<string, string>()
  const stoppingTasks = new Set<string>()

  const tellWriters = (error?: unknown) => {
    for (const listener of writeListeners) listener(error)
  }
  let noteWaiting = () => {}

  let observingWait = false
  const commit = ((...args: unknown[]) => {
    if (observingWait) observingWait = false
    else storeState.stateCommits += 1
    try {
      const result = (store.commit as (...a: unknown[]) => unknown)(...args)
      if (!storeState.waitingUnchanged) noteWaiting()
      if (writeFailing) {
        writeFailing = false
        tellWriters()
      }
      return result
    } catch (error) {
      if (isDiskFullError(error)) {
        writeFailing = true
        tellWriters(error)
      }
      throw error
    }
  }) as typeof store.commit

  const internals = store[StoreInternalsSymbol]
  const persisted = async () => {
    const committed = Effect.runSync(internals.syncProcessor.syncState.get).localHead
    let deadline = Date.now() + persistTimeoutMs
    let last: typeof committed | undefined
    for (;;) {
      const written = Effect.runSync(internals.clientSession.leaderThread.syncState.get).localHead
      if (
        written.global > committed.global ||
        (written.global === committed.global && written.client >= committed.client)
      ) {
        return
      }
      if (last && (written.global !== last.global || written.client !== last.client)) {
        deadline = Date.now() + persistTimeoutMs
      }
      last = written
      if (Date.now() > deadline) throw new Error('the event log did not save in time')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  const allFactories = queryDb(factories.orderBy('createdAt', 'asc'))
  const allTasks = queryDb(tasks.orderBy('number', 'asc'))

  const liveRuns = queryDb(
    runRows.where({ state: { op: '!=', value: 'finished' } }).orderBy('startedAt', 'asc'),
  )

  const allFactoryRepos = queryDb(factoryRepos.orderBy('position', 'asc'))
  const taskDraft = (factoryId: string): TaskDraftState => {
    const row = store.query(queryDb(taskDrafts.where({ factoryId })))[0]
    const clearedRevisions = store
      .query(queryDb(taskDraftConsumptions.where({ factoryId })))
      .map((entry) => entry.revision)
    return {
      draft: row?.draft ? (JSON.parse(row.draft) as NewTaskDraft) : null,
      ...(row?.clearedRevision && { clearedRevision: row.clearedRevision }),
      ...(clearedRevisions.length > 0 && { clearedRevisions }),
    }
  }

  const allFactoryOrder = queryDb(factoryOrder.orderBy('position', 'asc'))
  const listFactories = (): StoredFactory[] => {
    const repos = store.query(allFactoryRepos)
    const placed = new Map(store.query(allFactoryOrder).map((r) => [r.factoryId, r.position]))
    const rows = store.query(allFactories)
    const after = Math.max(-1, ...placed.values()) + 1
    const rank = (id: string, index: number) => placed.get(id) ?? after + index
    return rows
      .map((row, index) => ({ row, rank: rank(row.id, index) }))
      .sort((a, b) => a.rank - b.rank)
      .map(
        (
          { row: { clonedAt, icon, guide: _guide, showTutorial: _tutorial, ...row } },
          position,
        ) => ({
          ...row,
          position,
          ...(icon !== null && { icon: JSON.parse(icon) as FactoryIcon }),
          repos: repos
            .filter((r) => r.factoryId === row.id)
            .map(({ repo, name, cloneUrl }) => ({ repo, name, cloneUrl })),
          ...(clonedAt !== null && { clonedAt }),
        }),
      )
  }

  const sentSetUp = new Map<string, boolean>()
  const guides = (): FactoryGuide[] =>
    store
      .query(queryDb(factories.where({ guide: 'live' }).orderBy('createdAt', 'asc')))
      .map((row) => {
        const setUp = setUpDone(row.id)
        sentSetUp.set(row.id, setUp)
        return { factoryId: row.id, addedAt: row.createdAt, setUp }
      })
  const setUpChanged = (event: DaemonEvent) =>
    (event.type === 'task-created' || event.type === 'task-updated') &&
    event.task.setup === true &&
    store.query(queryDb(factories.where({ id: event.task.factoryId, guide: 'live' }))).length > 0 &&
    sentSetUp.get(event.task.factoryId) !== setUpDone(event.task.factoryId)
  const emitGuides = () => emit({ type: 'guides-changed', guides: guides() })
  const guideEnding = (factoryId: string, reason: GuideEnding) =>
    store.query(queryDb(factories.where({ id: factoryId, guide: 'live' }))).length > 0
      ? [events.factoryGuideEnded({ factoryId, reason, at: new Date().toISOString() })]
      : []
  const setUpDone = (factoryId: string) => {
    const queued = new Set(store.query(queryDb(taskQueue.select())).map((row) => row.taskId))
    return store
      .query(queryDb(tasks.where({ factoryId, setup: true, archivedAt: null })))
      .some(
        (row) =>
          row.stage === 'done' ||
          isCleanup(row.stage) ||
          (row.stage === 'backlog' &&
            !row.startRequested &&
            !queued.has(row.id) &&
            taskRuns(row.id).length === 0),
      )
  }
  const requireFactory = (id: string) => {
    const found = listFactories().find((f) => f.id === id)
    if (!found) throw new Error(`no Factory ${id}`)
    return found
  }
  const keyAmong = (list: readonly StoredFactory[], factoryId: string) =>
    factoryId === placeholderFactory.id
      ? placeholderFactory.key
      : (list.find((f) => f.id === factoryId)?.key ?? '?')
  const factoryKey = (factoryId: string) => keyAmong(listFactories(), factoryId)

  const runName = (run: RunRow) =>
    run.name ?? (run.taskId !== null && run.parentRunId === null ? 'Task Lead' : 'Run')

  const taskRuns = (taskId: string) =>
    store.query(queryDb(runRows.where({ taskId }).orderBy('startedAt', 'desc')))

  const pullRequestFields = (row: typeof pullRequests.Type | undefined): Partial<TaskRepo> => {
    if (!row) return {}
    return {
      ...(row.pushedCommit !== null &&
        row.pushedAt !== null && {
          pushed: {
            commit: row.pushedCommit,
            at: row.pushedAt,
            ci: row.hasCi === true,
            ciSignals: JSON.parse(row.ciSignals ?? '[]') as CiSignal[],
          },
        }),
      ...(row.pushError !== null &&
        row.pushErrorAt !== null && {
          pushFailed: { message: row.pushError, at: row.pushErrorAt },
        }),
      ...(row.number !== null &&
        row.url !== null &&
        row.base !== null &&
        row.state !== null && {
          pullRequest: {
            number: row.number,
            url: row.url,
            base: row.base,
            state: row.state as TaskPullRequest['state'],
            ...(row.mergedAt !== null && {
              merged: {
                at: row.mergedAt,
                ...(row.mergeMethod !== null && { method: row.mergeMethod as MergeMethod }),
                noCi: row.mergedWithoutCi === true,
              },
            }),
            ...(row.autoMerge !== null && { autoMerge: row.autoMerge as MergeMethod }),
            ...(row.waitingOn !== null && { waiting: row.waitingOn as GitHubWait }),
            ...(row.signedOffCommit !== null && { signedOff: row.signedOffCommit }),
            ...(row.closedOnGitHubAt !== null && { closedOnGitHub: row.closedOnGitHubAt }),
            ...(row.previewUrl !== null && {
              preview: {
                url: row.previewUrl,
                source: row.previewSource === 'status' ? 'status' : 'deployment',
                label: row.previewLabel ?? '',
              },
            }),
          },
        }),
    }
  }

  const toTaskRepo = (
    row: typeof taskRepos.Type,
    pullRequest: typeof pullRequests.Type | undefined,
  ): TaskRepo => ({
    ...pullRequestFields(pullRequest),
    name: row.name,
    repo: row.repo,
    branch: row.branch,
    worktree: row.worktree,
    copied: JSON.parse(row.copied) as string[],
    skipped: JSON.parse(row.skipped) as CopySkip[],
    ...(row.setupCommand !== null &&
      row.setupState !== null && {
        setup: {
          command: row.setupCommand,
          state: row.setupState as NonNullable<TaskRepo['setup']>['state'],
          ...(row.setupExitCode !== null && { exitCode: row.setupExitCode }),
        },
      }),
    ...(row.removedAt !== null && {
      removed: {
        at: row.removedAt,
        ...(row.teardownCommand !== null &&
          row.teardownOutcome !== null && {
            teardown: {
              command: row.teardownCommand,
              outcome: row.teardownOutcome as WorktreeCommandOutcome,
            },
          }),
      },
    }),
  })

  const queue = (): QueuedTask[] => {
    const rows = store.query(queryDb(taskQueue.select()))
    return queueOrder(
      rows.flatMap(({ taskId, rank }) => {
        const task = taskRow(taskId)
        return task
          ? [
              {
                id: taskId,
                kind: task.setup ? ('setup-task' as const) : ('task' as const),
                rank,
                priority: task.priority as Priority,
                factoryId: task.factoryId,
              },
            ]
          : []
      }),
    )
  }

  const repoRows = (taskId: string) =>
    store.query(queryDb(taskRepos.where({ taskId }).orderBy('createdAt', 'asc')))

  const pullRequestRows = (id: string) => store.query(queryDb(pullRequests.where({ id })))

  const reposOf = (taskId: string) =>
    repoRows(taskId).map((row) => toTaskRepo(row, pullRequestRows(row.id).at(0)))

  const readTaskLog = (taskId: string): LoggedEvent[] =>
    store
      .query(queryDb(taskLog.where({ taskId })))
      .map(({ id, name, data, at }) => ({
        id,
        name,
        data: JSON.parse(data) as Record<string, unknown>,
        at,
      }))
      .sort((a, b) => sequence(a.id) - sequence(b.id))

  const history = createTaskHistory(
    readTaskLog,
    (taskId) => entryRows(taskId).findLast((e) => mergesHere(e.stage))?.at ?? '',
  )

  const taskPullRequests = (taskId: string) => store.query(queryDb(pullRequests.where({ taskId })))

  const isMerged = (taskId: string): boolean =>
    taskIsMerged(taskRow(taskId)?.stage as StageId, taskPullRequests(taskId))

  const blockerRows = (taskId: string) =>
    store.query(queryDb(taskBlockers.where({ taskId }).orderBy('at', 'asc')))

  const parentRow = (taskId: string) => store.query(queryDb(taskParents.where({ taskId }))).at(0)
  const childRows = (parentId: string) =>
    store.query(queryDb(taskParents.where({ parentId }).orderBy('taskId', 'asc')))

  const deletedRows = (id: string) => store.query(queryDb(deletedTasks.where({ id })))

  const blockerOf = (id: string, reads: TaskReads = perTask) => {
    const blocker = reads.task(id).at(0)
    if (blocker) {
      return {
        displayId: `${reads.factoryKey(blocker.factoryId)}-${blocker.number}`,
        merged: taskIsMerged(blocker.stage as StageId, reads.pullRequests(id)),
        ...(blocker.archivedAt !== null && { ended: 'archived' as const }),
      }
    }
    const deleted = reads.deleted(id).at(0)
    return {
      displayId: deleted ? `${reads.factoryKey(deleted.factoryId)}-${deleted.number}` : id,
      merged: false,
      ended: 'deleted' as const,
    }
  }

  const asanaHolds = (taskId: string, reads: TaskReads): BlockerLink[] =>
    reads
      .comments(taskId)
      .filter((row) => row.asanaMissing !== null && row.answer === null)
      .map((row) => ({
        blockerId: row.id,
        kind: 'asana' as const,
        displayId: 'your answer about missing Asana work',
        merged: false,
        at: row.createdAt,
      }))

  const blockerLinks = (taskId: string, reads: TaskReads = perTask): BlockerLink[] => [
    ...childAndTaskLinks(taskId, reads),
    ...asanaHolds(taskId, reads),
  ]

  const childAndTaskLinks = (taskId: string, reads: TaskReads): BlockerLink[] =>
    [
      ...reads.blockers(taskId),
      ...reads.children(taskId).map((row) => ({
        ...row,
        blockerId: row.taskId,
        setByRunId: null,
        kind: 'child' as const,
      })),
    ].map((row) => {
      const { displayId, merged, ended } = blockerOf(row.blockerId, reads)
      return {
        blockerId: row.blockerId,
        ...('kind' in row && { kind: row.kind, satisfied: ended === 'archived' }),
        displayId,
        merged,
        ...(ended !== undefined && { ended }),
        ...(row.setByRunId !== null && { setByRunId: row.setByRunId }),
        at: row.at,
      }
    })

  const startRequestUsed = (taskId: string, at: string) =>
    taskRow(taskId)?.startRequested
      ? [events.taskStartRequestChanged({ taskId, startRequested: false, at })]
      : []

  const blockersRemovedUsed = (taskId: string, at: string) =>
    taskRow(taskId)?.blockersRemoved
      ? [events.taskBlockersRemovedChanged({ taskId, removed: false, at })]
      : []

  const startCause = (taskId: string, cause: StartCause | undefined, at: string) =>
    cause
      ? [
          events.taskStartCause({
            taskId,
            cause: cause.cause,
            blockers: cause.cause === 'blockers-merged' ? [...cause.blockers] : [],
            at,
          }),
        ]
      : []

  const commentFiles = (commentId: string): Attachment[] =>
    store
      .query(queryDb(commentAttachments.where({ commentId }).orderBy('position', 'asc')))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const attachmentRows = (taskId: string) =>
    store.query(queryDb(taskAttachments.where({ taskId }).orderBy('at', 'asc')))

  const toAttachment = ({
    hash,
    name,
    size,
    mediaType,
  }: typeof taskAttachments.Type): Attachment => ({ hash, name, size, mediaType })

  const browserCapturesOf = (taskId: string): Attachment[] =>
    store
      .query(queryDb(taskBrowserCaptures.where({ taskId })))
      .map(({ hash, name, size, mediaType }) => ({ hash, name, size, mediaType }))

  const toSource = (row: typeof taskSources.Type | undefined): TaskSource | undefined => {
    if (!row) return undefined
    return {
      url: row.url,
      ...(row.linearIdentifier !== null &&
        row.linearTitle !== null && {
          linear: {
            identifier: row.linearIdentifier,
            title: row.linearTitle,
            ...(row.linearBranchName !== null && { branchName: row.linearBranchName }),
            ...(row.linearDescription !== null && { description: row.linearDescription }),
          },
        }),
      ...(row.sentryShortId !== null && { sentry: { shortId: row.sentryShortId } }),
      ...(row.asana !== null && { asana: JSON.parse(row.asana) as TaskAsanaSource }),
      ...(row.github !== null && { github: JSON.parse(row.github) as TaskGitHubSource }),
    }
  }

  const entryRows = (taskId: string) =>
    store.query(queryDb(stageEntries.where({ taskId }).orderBy('at', 'asc')))

  const pauses = (): Partial<Record<AgentKind, string>> =>
    Object.fromEntries(store.query(queryDb(agentPauses)).map((row) => [row.agent, row.reason]))

  const heldRows = (taskId: string) => store.query(queryDb(heldRuns.where({ taskId })))

  const planningFrom = (taskId: string) =>
    store
      .query(queryDb(plans.where({ fromTaskId: taskId })))
      .some((p) => p.state !== 'ended' && p.fromTaskGone === null)

  const taskReads = (everyTask: boolean, oneBuild = false) => {
    const rows = <Row>(
      one: (id: string) => readonly Row[],
      all: () => readonly Row[],
      key: (row: Row) => string | null,
    ): ((id: string) => readonly Row[]) => {
      if (!everyTask) return one
      let groups: Map<string | null, Row[]> | undefined
      return (id) => {
        groups ??= Map.groupBy(all(), key)
        return groups.get(id) ?? []
      }
    }
    const once = <Value>(read: () => Value): (() => Value) => {
      if (!everyTask && !oneBuild) return read
      let held: { value: Value } | undefined
      return () => {
        held ??= { value: read() }
        return held.value
      }
    }
    const everyParent = once(() => store.query(queryDb(taskParents.orderBy('taskId', 'asc'))))
    const everyPullRequest = once(() => store.query(queryDb(pullRequests)))
    const everyUsage = once(
      () => new Map(store.query(queryDb(runUsage)).map((row) => [row.id, row] as const)),
    )
    const factories = once(listFactories)
    return {
      factories,
      factoryKey: (factoryId: string) => keyAmong(factories(), factoryId),
      runs: rows(
        taskRuns,
        () => store.query(queryDb(runRows.orderBy('startedAt', 'desc'))),
        (r) => r.taskId,
      ),
      entries: rows(
        entryRows,
        () => store.query(queryDb(stageEntries.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      parents: rows(
        (taskId) => store.query(queryDb(taskParents.where({ taskId }))),
        everyParent,
        (r) => r.taskId,
      ),
      children: rows(childRows, everyParent, (r) => r.parentId),
      blockers: rows(
        blockerRows,
        () => store.query(queryDb(taskBlockers.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      repos: rows(
        repoRows,
        () => store.query(queryDb(taskRepos.orderBy('createdAt', 'asc'))),
        (r) => r.taskId,
      ),
      usage: (runIds: readonly string[]): (typeof runUsage.Type)[] => {
        if (runIds.length === 0) return []
        if (!everyTask)
          return store.query(queryDb(runUsage.where({ id: { op: 'IN', value: runIds } })))
        const all = everyUsage()
        return runIds.flatMap((id) => all.get(id) ?? [])
      },
      pullRequest: rows(pullRequestRows, everyPullRequest, (r) => r.id),
      pullRequests: rows(taskPullRequests, everyPullRequest, (r) => r.taskId),
      task: rows(
        (id) => store.query(queryDb(tasks.where({ id }))),
        () => store.query(allTasks),
        (r) => r.id,
      ),
      deleted: rows(
        deletedRows,
        () => store.query(queryDb(deletedTasks)),
        (r) => r.id,
      ),
      unfinishedChecks: rows(
        (taskId) =>
          store.query(
            queryDb(checkRuns.where({ taskId, finishedAt: null }).orderBy('startedAt', 'asc')),
          ),
        () =>
          store.query(queryDb(checkRuns.where({ finishedAt: null }).orderBy('startedAt', 'asc'))),
        (r) => r.taskId,
      ),
      queued: rows(
        (taskId) => store.query(queryDb(taskQueue.where({ taskId }))),
        () => store.query(queryDb(taskQueue)),
        (r) => r.taskId,
      ),
      held: rows(
        heldRows,
        () => store.query(queryDb(heldRuns)),
        (r) => r.taskId,
      ),
      log: rows(
        (taskId) => logRows(taskId),
        () => store.query(queryDb(taskLog.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      subAgentRequests: rows(
        (taskId) => store.query(queryDb(subAgentRequests.where({ taskId }))),
        () => store.query(queryDb(subAgentRequests)),
        (r) => r.taskId,
      ),
      comments: rows(
        (taskId) => commentRows(taskId),
        () => commentRows(),
        (r) => r.taskId,
      ),
      tabs: rows(
        (taskId) =>
          store.query(queryDb(conversationTabs.where({ taskId }).orderBy('openedAt', 'asc'))),
        () => store.query(queryDb(conversationTabs.orderBy('openedAt', 'asc'))),
        (r) => r.taskId,
      ),
      briefs: rows(
        (taskId) => store.query(queryDb(briefTimes.where({ taskId }).orderBy('version', 'asc'))),
        () => store.query(queryDb(briefTimes.orderBy('version', 'asc'))),
        (r) => r.taskId,
      ),
      sources: rows(
        (taskId) => store.query(queryDb(taskSources.where({ taskId }))),
        () => store.query(queryDb(taskSources)),
        (r) => r.taskId,
      ),
      planLinks: rows(
        (taskId) => store.query(queryDb(planTasks.where({ taskId }))),
        () => store.query(queryDb(planTasks)),
        (r) => r.taskId,
      ),
      plan: rows(
        (id) => store.query(queryDb(plans.where({ id }))),
        () => store.query(queryDb(plans)),
        (r) => r.id,
      ),
      automationLinks: rows(
        (taskId) => store.query(queryDb(automationTasks.where({ taskId }))),
        () => store.query(queryDb(automationTasks)),
        (r) => r.taskId,
      ),
      attachments: rows(
        attachmentRows,
        () => store.query(queryDb(taskAttachments.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      sendBacks: rows(
        (taskId) => store.query(queryDb(sendBacks.where({ taskId }).orderBy('at', 'asc'))),
        () => store.query(queryDb(sendBacks.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      sendBackResets: rows(
        (taskId) => store.query(queryDb(sendBackResets.where({ taskId }).orderBy('at', 'asc'))),
        () => store.query(queryDb(sendBackResets.orderBy('at', 'asc'))),
        (r) => r.taskId,
      ),
      pauses: once(() => pauses()),
      queue: once(() => queue()),
      settings: once(() => settings()),
    }
  }
  type TaskReads = ReturnType<typeof taskReads>
  const planParent = (log: readonly (typeof taskLog.Type)[]) =>
    log.some(
      (e) =>
        e.name === 'v1.ChildTasksCreated' &&
        (JSON.parse(e.data) as { from?: unknown }).from === 'plan',
    )
  const perTask = taskReads(false)
  // Reading every table once costs about as much as reading 10 Tasks one by one.
  const readEveryTaskFrom = 10
  const sharedReads = (count: number) => {
    const reads = count > readEveryTaskFrom ? taskReads(true) : undefined
    const at = storeState.stateCommits
    return () => (storeState.stateCommits === at ? reads : undefined)
  }

  const backToWork = (taskId: string, reads: TaskReads): TaskBackToWork | undefined => {
    const since = reads.sendBackResets(taskId).findLast((reset) => validates(reset.stage))?.at
    const returns = reads
      .sendBacks(taskId)
      .filter((b) => b.counted && validates(b.fromStage) && (since === undefined || b.at > since))
    const limit = returns.at(-1)?.limit ?? undefined
    return returns.length === 0
      ? undefined
      : { count: returns.length, ...(limit !== undefined && { limit }) }
  }

  let noteTaskWait = (_taskId: string, _facts: TaskFacts) => {}

  const toTask = (
    {
      snoozedUntil,
      clarifyDepthBy,
      branch,
      worktree,
      chosenRepos,
      activity,
      activityEntries,
      leadAgent,
      leadModel,
      leadEffort,
      leadEffortMode,
      stageEffort,
      pendingLeadMessage,
      pendingLeadDeliveries,
      rank,
      changedAt,
      archivedAt,
      waitsForBlockers,
      stoppedAt,
      stoppedRuns,
      stoppedWhy,
      preparation,
      failedAt,
      followUpOf,
      forcedGates,
      gateOverrides,
      autopilotChoice,
      changesSettings,
      splitFrom,
      needsPlanningAt,
      partlyMergedAt,
      setup,
      coordinatorOperation,
      createdByTask,
      createdByRun: _createdByRun,
      ...row
    }: typeof tasks.Type,
    observe = false,
    reads: TaskReads = taskReads(false, true),
  ): StoredTask => {
    storeState.taskBuilds += 1
    tasksBuiltHere += 1
    const stage = row.stage as StageId
    const pendingMessages: LeadMessage[] =
      pendingLeadDeliveries !== null
        ? JSON.parse(pendingLeadDeliveries)
        : pendingLeadMessage !== null
          ? [{ id: `stage-legacy-${row.id}`, text: pendingLeadMessage }]
          : []
    const all = reads.runs(row.id)
    const lead = all.find((r) => r.parentRunId === null)
    const live = all.filter((r) => r.state !== 'finished')
    const tokens = taskTokens(all, reads.usage(all.map((r) => r.id)), liveTokens)
    const entries = reads.entries(row.id)
    const parentId = reads.parents(row.id).at(0)?.parentId
    const blockedBy = reads.blockers(row.id).map((b) => b.blockerId)
    const repos = reads
      .repos(row.id)
      .map((repo) => toTaskRepo(repo, reads.pullRequest(repo.id).at(0)))
    const open = blockerLinks(row.id, reads).filter((b) => !b.merged && !b.satisfied)
    const unmerged = open.filter((b) => b.kind !== 'asana')
    const waitingOn = unmerged.map((b) => b.displayId)
    const firstEnded = unmerged[0]?.ended
    const visit = mergesHere(stage) ? history.mergeHistory(row.id) : undefined
    const leadWorks = visit?.awaitsLead === true && visit.leadAdvanced === undefined
    const waitingFor = mergesHere(stage)
      ? repos.find((r) => !r.removed && r.pullRequest?.waiting !== undefined)?.pullRequest?.waiting
      : undefined
    const github = leadWorks && waitingFor !== 'sign-in' ? undefined : waitingFor
    const openPullRequest = repos.some(
      (r) => !r.removed && r.pullRequest && r.pullRequest.state !== 'merged',
    )
    const merging = mergesHere(stage) && openPullRequest ? history.mergeHistory(row.id) : undefined
    const mergeWaits = merging?.latest === 'started'
    const autoMergeLeft =
      merging !== undefined &&
      !mergeWaits &&
      repos.some(
        (r) =>
          !r.removed && r.pullRequest?.autoMerge !== undefined && r.pullRequest.state !== 'merged',
      ) &&
      merging.canceledAt !== undefined
    const checking = reads.unfinishedChecks(row.id).at(0)
    const checkingNow = checking && checkProgress(checking.id)
    const queued = reads.queued(row.id).at(0)
    const paused = reads.pauses()
    const held = reads.held(row.id).at(0)
    const taskComments = reads.comments(row.id)
    const heldAnswer = taskComments.some(
      (comment) => comment.answerHeld && comment.answerQueuedAt !== null,
    )
    const queuedContinuation = pendingMessages.some((message) => message.waitForSlot) || heldAnswer
    const placed = storeState.queueActivity.taskPlaces?.find((entry) => entry.id === row.id)
    const skipsBusy =
      placed?.skipsBusy === true ||
      heldAnswer ||
      pendingMessages.some((message) => message.waitForSlot && message.after !== undefined)
    const place =
      queued || queuedContinuation
        ? (placed?.place ?? (queued ? reads.queue().findIndex((q) => q.id === row.id) + 1 : 0))
        : 0
    const pausedRuns = taskPauses({
      taskId: row.id,
      heldAgent: held?.agent,
      liveRuns: live,
      queuedAgent: place > 0 && leadAgent !== null ? leadAgent : undefined,
      pauses: paused,
    })
    const pausedReason = pausedRuns[0]?.reason
    const leadLive =
      lead !== undefined && lead.state !== 'finished' && stage !== 'backlog' && stage !== 'done'
    const leadStopped =
      lead?.state === 'finished' &&
      lead.ended !== null &&
      (JSON.parse(lead.ended) as RunEnding).how === 'stopped'
    const lastFailure = leadStopped
      ? reads
          .log(row.id)
          .filter((entry) => entry.name === 'v1.TaskLeadFailed')
          .toSorted((a, b) => sequence(a.id) - sequence(b.id))
          .at(-1)
      : undefined
    const failure = lastFailure && (JSON.parse(lastFailure.data) as Record<string, unknown>)
    const recovering =
      lastFailure !== undefined &&
      failure?.runId === lead?.id &&
      failure?.recovery === 'resume' &&
      (lead?.revivedAt === null || (lead?.revivedAt ?? '') < lastFailure.at)
    const opened = repos.filter((r) => !r.removed && r.pullRequest !== undefined)
    const mergedRepos = opened.filter((r) => r.pullRequest?.state === 'merged')
    const openRepos = opened.filter((r) => r.pullRequest?.state !== 'merged')
    const partlyMerged =
      partlyMergedAt !== null && mergedRepos.length > 0 && openRepos.length > 0
        ? { merged: mergedRepos.map((r) => r.name), open: openRepos.map((r) => r.name) }
        : undefined
    const requests = taskComments.filter((row) => isOpenRequest(row) && row.heldFor === null)
    const facts: TaskFacts = {
      ...(preparation === 'preparing' && { preparing: true }),
      ...(snoozedUntil !== null && { snoozedUntil }),
      ...(archivedAt !== null && { archived: true }),
      ...(failedAt !== null && { failed: true }),
      ...(isCleanup(stage) &&
        requests.some((row) => row.cleanupFailure !== null) && { cleanupFailed: true }),
      ...(isCleanup(stage) && checkingTasks.has(row.id) && { cleanupCommandsRunning: true }),
      ...(partlyMerged && { partlyMerged }),
      ...(stoppedAt !== null && {
        stopped: {
          at: stoppedAt,
          runs: stoppedRuns ?? 0,
          why:
            stoppedWhy === 'blockers-removed' ||
            stoppedWhy === 'repair-incorporation' ||
            stoppedWhy === 'prepared'
              ? stoppedWhy
              : 'human',
        },
      }),
      stage,
      ...(leadWorks && { mergeLeadWorks: true }),
      ...(leadLive && { leadLive }),
      ...(leadStopped &&
        !held &&
        !recovering &&
        !waitsForBlockers &&
        repos.some((r) => !r.removed) && { interrupted: true }),
      ...((place > 0 || held) && {
        queue:
          (leadAgent ?? held?.agent) &&
          !reads.settings().enabledAgents.includes((leadAgent ?? held?.agent) as AgentKind) &&
          (!leadLive || lead?.agent !== (leadAgent ?? held?.agent))
            ? { hold: `${leadAgent ?? held?.agent} is off. Enable it in Settings → Providers.` }
            : storeState.queueActivity.startHolds?.has(row.id)
              ? { hold: storeState.queueActivity.startHolds.get(row.id) ?? '' }
              : place > 0
                ? storeState.newWorkHeld === undefined
                  ? { place, ...(skipsBusy && { skipsBusy: true as const }) }
                  : { hold: storeState.newWorkHeld }
                : { hold: 'Waiting for a Provider' },
      }),
      ...(place > 0 && storeState.heldBusy && { busy: storeState.heldBusy }),
      queuedSubAgents: reads.subAgentRequests(row.id).map((r) => ({
        id: r.id,
        ...(paused[r.agent as AgentKind] !== undefined && {
          paused: paused[r.agent as AgentKind],
        }),
        ...(!reads.settings().enabledAgents.includes(r.agent as AgentKind)
          ? { hold: `${r.agent} is off. Enable it in Settings → Providers.` }
          : storeState.newWorkHeld !== undefined
            ? { hold: storeState.newWorkHeld }
            : storeState.heldBusy
              ? { hold: busyHold }
              : {}),
      })),
      pausedRuns,
      runs: stoppingTasks.has(row.id) ? [] : live.map((r) => r.state as RunState),
      openRequests: requests.filter((r) => !groupAskRow(r)).length,
      ...requestsSnoozed(
        row.id,
        requests.filter((r) => !groupAskRow(r)),
      ),
      ...permissionWait(requests, lead?.id),
      ...(pausedReason !== undefined && { paused: pausedReason }),
      ...(waitingOn.length > 0 && { blockedBy: waitingOn }),
      ...(firstEnded !== undefined && { blockerEnded: firstEnded }),
      ...(row.startRequested && { startsAfterBlockers: true }),
      ...(github !== undefined && { github }),
      ...(mergeWaits && { mergePending: true }),
      ...(autoMergeLeft && { autoMergeLeft: true }),
      ...(stoppedAt === null &&
        place === 0 &&
        repos.some((r) => !r.removed && r.setup?.state === 'running') && { settingUp: true }),
      ...((checking || checkingTasks.has(row.id)) && { checksActive: true }),
      ...(checkingNow && { checking: checkingNow }),
      ...(movingAfterChecks.has(row.id) && { movingAfterChecks: true }),
      testActivity: testInvocationStore.active(row.id),
      ...(storeState.checksWaiting.has(row.id) && {
        checksWaiting: { place: storeState.checksWaiting.get(row.id) ?? 1 },
      }),
      ...(activity !== null && activityEntries === entries.length && { agentActivity: activity }),
      ...(live.some((r) => r.retrying) && { retrying: true }),
      ...(needsPlanningAt !== null && { needsPlanning: true }),
      ...(hasClarifyRounds(stage) && planningFrom(row.id) && { planningInChat: true }),
    }
    if (observe) noteTaskWait(row.id, facts)
    const status = taskStatus(facts)
    const delivery = commentDelivery(facts)
    const unblocked = statusWithoutBlocker(facts, status)
    const shown = taskActivity(facts)
    const tabs: ConversationTab[] = reads.tabs(row.id).flatMap((tab) => {
      const run = all.find((r) => r.id === tab.runId)
      return run
        ? [
            {
              runId: run.id,
              name: runName(run),
              agent: run.agent as AgentKind,
              state: run.state as RunState,
            },
          ]
        : []
    })
    const updatedAt = [
      row.createdAt,
      changedAt,
      queued?.queuedAt,
      entries.at(-1)?.at,
      ...all.map((r) => r.startedAt),
      lastCommentAt(taskComments),
      reads.briefs(row.id).at(-1)?.createdAt,
    ].reduce<string>((a, b) => (b && b > a ? b : a), row.createdAt)
    const ended = (): TaskEnding => {
      if (all.length === 0 && repos.length === 0) return { kind: 'never-started' }
      if (stage === 'done') {
        return {
          kind: 'merged',
          at: entries.findLast((e) => e.stage === 'done')?.at ?? row.createdAt,
        }
      }
      const closedOnGitHub = repos
        .flatMap((r) =>
          r.pullRequest?.state === 'closed' && r.pullRequest.closedOnGitHub !== undefined
            ? [r.pullRequest.closedOnGitHub]
            : [],
        )
        .sort()
        .at(-1)
      if (closedOnGitHub !== undefined) return { kind: 'pull-request-closed', at: closedOnGitHub }
      return { kind: 'stopped', stage }
    }
    const source = toSource(reads.sources(row.id).at(0))
    const taskOrDeleted = (id: string) => reads.task(id).at(0) ?? reads.deleted(id).at(0)
    const original = followUpOf === null ? undefined : taskOrDeleted(followUpOf)
    const splitOriginal = splitFrom === null ? undefined : taskOrDeleted(splitFrom)
    const planLink = reads.planLinks(row.id).at(0)
    const planTitle = planLink && reads.plan(planLink.planId).at(0)?.title
    const merged =
      stage === 'done' || isCleanup(stage)
        ? {
            at:
              entries.findLast((e) => isCleanup(e.stage))?.at ??
              entries.findLast((e) => e.stage === 'done')?.at ??
              row.createdAt,
            pullRequests: repos.flatMap((r) =>
              r.pullRequest?.state === 'merged' ? [r.pullRequest.number] : [],
            ),
          }
        : undefined
    const createdBy: CreatedBy = setup
      ? 'setup'
      : coordinatorOperation !== null
        ? 'coordinator'
        : createdByTask !== null
          ? 'task-lead'
          : followUpOf !== null
            ? 'follow-up'
            : splitFrom !== null
              ? 'split'
              : reads.automationLinks(row.id).length > 0
                ? 'automation'
                : planLink || planParent(reads.log(row.id))
                  ? 'planning'
                  : 'human'
    const backlogWait = storeState.queueActivity.backlogWaits?.get(row.id)
    const linearSync = linearSyncOf(row, source, reads)
    const returns = backToWork(row.id, reads)
    const asanaSync = asanaSyncFor(
      { id: row.id, factoryId: row.factoryId, archived: archivedAt !== null },
      source,
      stage,
      reads,
    )
    return {
      ...row,
      ...(entries[0] && { startedAt: entries[0].at }),
      ...(snoozedUntil !== null && { snoozedUntil }),
      priority: row.priority as Priority,
      clarifyDepth: row.clarifyDepth as ClarifyDepth,
      ...(clarifyDepthBy !== null
        ? { clarifyDepthBy: clarifyDepthBy as ClarifyDepthChooser }
        : row.clarifyDepth !== 'auto' && { clarifyDepthBy: 'human' as const }),
      ...(leadAgent !== null && {
        lead: {
          agent: leadAgent as AgentKind,
          ...(leadEffortMode === 'stage' && { effortMode: 'stage' as const }),
          ...(leadModel !== null && { model: leadModel }),
          ...(leadEffort !== null && { effort: leadEffort as Effort }),
        },
      }),
      ...(stageEffort !== null && { stageEffort: stageEffort as Effort }),
      pendingLeadMessages: pendingMessages,
      blockedBy,
      ...(open.length > 0 && { openBlockers: open.map((b) => b.displayId) }),
      ...(parentId !== undefined && { parentId }),
      childIds: reads.children(row.id).map((child) => child.taskId),
      waitsForBlockers,
      stopped: stoppedAt !== null,
      ...((preparation === 'preparing' || preparation === 'ready') && { preparation }),
      autopilot: {
        choice: (autopilotChoice ?? 'inherit') as AutopilotChoice,
        enabled: autopilotEnabled(
          (autopilotChoice ?? 'inherit') as AutopilotChoice,
          reads.settings().overnightMode,
        ),
      },
      gateOverrides: gateOverrides === null ? {} : (JSON.parse(gateOverrides) as TaskGateOverrides),
      forcedGates: forcedGates === null ? [] : (JSON.parse(forcedGates) as AgentStageId[]),
      changesSettings,
      repos,
      chosenRepos:
        chosenRepos !== null
          ? (JSON.parse(chosenRepos) as string[])
          : reads
              .factories()
              .filter((f) => f.id === row.factoryId)
              .map((f) => f.repo),
      attachments: reads.attachments(row.id).map(toAttachment),
      ...(source && { source }),
      ...(backlogWait !== undefined && { backlogWait }),
      ...(createdByTask !== null && { createdByTaskId: createdByTask }),
      stage,
      rank: rank ?? row.number,
      displayId: `${reads.factoryKey(row.factoryId)}-${row.number}`,
      ...(branch !== null && { branch }),
      ...(worktree !== null && { worktree }),
      ...(lead !== undefined && { leadRunId: lead.id }),
      ...(status !== undefined && { status }),
      ...(unblocked !== undefined && { statusWithoutBlocker: unblocked }),
      statuses: taskStatuses(facts),
      markers: taskMarkers(facts, status),
      ...(shown !== undefined && { activity: shown }),
      track: track(stage, entries),
      commentBox: commentBox(facts, status),
      ...(delivery !== undefined && { commentDelivery: delivery }),
      ...(taskCanResume(facts) && { canResume: true }),
      ...(taskWakesOnComment(facts) && { wakesOnComment: true as const }),
      ...(facts.checksActive && { checksActive: true }),
      ...(facts.mergePending &&
        heldMerges.has(row.id) && { mergeHeld: heldMerges.get(row.id) ?? '' }),
      tabs,
      ...(tokens > 0 && { tokens }),
      runs: live
        .sort(
          (a, b) =>
            Number(b.id === lead?.id) - Number(a.id === lead?.id) ||
            a.startedAt.localeCompare(b.startedAt),
        )
        .map((r) => {
          const reason = paused[r.agent as AgentKind]
          return {
            id: r.id,
            agent: r.agent as AgentKind,
            role: r.parentRunId === null ? ('lead' as const) : ('sub-agent' as const),
            name: runName(r),
            state: r.state as RunState,
            ...(reason !== undefined && { paused: reason }),
            ...(waitingOnSubAgents.has(r.id) && { onSubAgents: true }),
          }
        }),
      ...(setup && { setup: true as const }),
      createdBy,
      ...(linearSync !== undefined && { linearSync }),
      ...(asanaSync !== undefined && { asanaSync }),
      ...(planLink && {
        fromPlan: {
          id: planLink.planId,
          title: planTitle ?? '',
          ...(planTitle === undefined && { deleted: true }),
        },
      }),
      ...(followUpOf !== null && {
        followUpOf: {
          id: followUpOf,
          displayId: original
            ? `${reads.factoryKey(original.factoryId)}-${original.number}`
            : followUpOf,
        },
      }),
      ...(splitFrom !== null && {
        splitFrom: {
          id: splitFrom,
          displayId: splitOriginal
            ? `${reads.factoryKey(splitOriginal.factoryId)}-${splitOriginal.number}`
            : splitFrom,
        },
      }),
      ...(merged && { merged }),
      ...(returns !== undefined && { backToWork: returns }),
      updatedAt,
      ...(archivedAt !== null && { archived: { at: archivedAt, ended: ended() } }),
    }
  }

  const toPublicTask = ({
    pendingLeadMessages: _______,
    leadRestartPending: ________,
    forcedGates: _____,
    changesSettings: ______,
    worktree: _,
    startRequested: __,
    waitsForBlockers: ___,
    stopped: ____,
    createdByTaskId: _________,
    ...task
  }: StoredTask): Task => task

  const toRun = ({
    readOffset: _,
    lastOutputAt: _lastOutputAt,
    taskId,
    sessionId,
    model,
    effort,
    usesDefaultModel,
    problem,
    problemAt: _problemAt,
    parentRunId,
    name,
    failure,
    permissions,
    manualPermissions,
    revivedAt,
    ended,
    retrying: _retrying,
    steeringRelease: _steeringRelease,
    ...row
  }: RunRow): Run => ({
    ...row,
    ...(parentRunId !== null && { parentRunId }),
    ...(name !== null && { name }),
    ...(failure !== null && { failure }),
    permissions: permissions === 'bypass' ? 'bypass' : 'auto',
    ...(manualPermissions && { manualPermissions }),
    agent: row.agent as AgentKind,
    state: row.state as RunState,
    ...(sessionId !== '' && { sessionId }),
    ...(model !== null && { model }),
    ...(effort !== null && { effort: effort as Effort }),
    ...(usesDefaultModel && { usesDefaultModel }),
    ...(problem !== null && { problem: problem as RunProblem }),
    ...(taskId !== null && { taskId }),
    ...(revivedAt !== null && { revivedAt }),
    ...(ended !== null && { ended: JSON.parse(ended) as RunEnding }),
    ...(asleepRuns.has(row.id) && { asleep: true as const }),
  })

  const withPurpose = (comment: Comment, stored: string | null): Comment => {
    if (comment.kind === 'note') return comment
    if (stored !== null) return { ...comment, purpose: JSON.parse(stored) as RequestPurpose }
    const structural = structuralPurpose(comment)
    if (structural && structural.kind !== 'question') return { ...comment, purpose: structural }
    const sendBack = store.query(queryDb(sendBackAsks.where({ commentId: comment.id }))).length > 0
    const failure = failureStore
      .list(comment.taskId)
      .some((f) => f.decisions.some((d) => d.commentId === comment.id))
    const purpose = sendBack
      ? { kind: 'send-back' as const }
      : failure
        ? { kind: 'failure' as const }
        : legacyPurpose(comment, () => {
            const modelRun = store
              .query(queryDb(runRows.where({ taskId: comment.taskId }).orderBy('startedAt', 'asc')))
              .filter((r) => r.parentRunId === null && r.startedAt <= comment.createdAt)
              .at(-1)
            return modelRun?.id
          })
    return purpose ? { ...comment, purpose } : comment
  }

  const commentPeer = (id: string): Pick<Comment, 'peer'> => {
    const peer = store.query(queryDb(peerMessages.where({ id }))).at(0)
    if (!peer) return {}
    const sender = taskRow(peer.senderTaskId) ?? deletedRows(peer.senderTaskId).at(0)
    return {
      peer: {
        ...(sender && { sender: `${factoryKey(sender.factoryId)}-${sender.number}` }),
        text: peer.text,
      },
    }
  }

  const toComment = ({
    authorKind,
    authorRunId,
    stage,
    title,
    choices,
    round,
    proposal,
    sizeCheck,
    gate,
    answer,
    deliveredRunId,
    deliveredAt,
    readAt,
    permission,
    simulator,
    answerHeld: _,
    answerQueuedAt,
    answerSentRunId,
    answerSentAt,
    failedRunId,
    talkRequested,
    talkMessageId: _talkMessageId,
    talkNotifiedAt,
    talkRunId,
    talkStartedAt,
    talkDoneAt,
    design,
    tutorial: _tutorial,
    linearTeam,
    asanaMissing,
    asanaUnfinished,
    archive,
    move,
    cleanupFailure,
    memoryKill,
    multiple,
    purpose,
    heldFor,
    ...row
  }: typeof comments.Type): Comment =>
    withPurpose(
      {
        ...row,
        kind: row.kind as CommentKind,
        author:
          authorKind === 'run' && authorRunId !== null
            ? { kind: 'run', runId: authorRunId }
            : { kind: authorKind === 'ted' ? 'ted' : 'human' },
        ...(heldFor !== null && { held: true as const }),
        ...(stage !== null && { stage: stage as StageId }),
        ...(title !== null && { title }),
        ...(choices !== null && { choices: JSON.parse(choices) as string[] }),
        ...(multiple && { multiple: true as const }),
        ...(round !== null && { round: JSON.parse(round) as Round }),
        ...(talkRequested && { talkRequested: true as const }),
        ...(talkRunId !== null &&
          talkStartedAt !== null && {
            talk: {
              runId: talkRunId,
              startedAt: talkStartedAt,
              ...(talkNotifiedAt !== null && { notifiedAt: talkNotifiedAt }),
              ...(talkDoneAt !== null && { doneAt: talkDoneAt }),
            },
          }),
        ...(proposal !== null && { proposal: JSON.parse(proposal) as Proposal }),
        ...(sizeCheck !== null && { sizeCheck: JSON.parse(sizeCheck) as SizeCheck }),
        ...(gate !== null && { gate: JSON.parse(gate) as NonNullable<Comment['gate']> }),
        ...(permission !== null && { permission: publicPermission(permission) }),
        ...(simulator !== null && { simulator: JSON.parse(simulator) as SimulatorAsk }),
        ...(answer !== null && { answer: JSON.parse(answer) as CommentAnswer }),
        ...(deliveredRunId !== null &&
          deliveredAt !== null && { delivered: { runId: deliveredRunId, at: deliveredAt } }),
        ...(answerQueuedAt !== null && {
          answerDelivery: {
            queuedAt: answerQueuedAt,
            ...(answerSentRunId !== null &&
              answerSentAt !== null && {
                sent: { runId: answerSentRunId, at: answerSentAt },
              }),
          },
        }),
        ...(readAt !== null && { readAt }),
        ...(failedRunId !== null && { failed: { runId: failedRunId } }),
        ...(linearTeam !== null && { linearTeam: JSON.parse(linearTeam) as LinearTeam }),
        ...(asanaMissing !== null && { asanaMissing: JSON.parse(asanaMissing) as AsanaMissing }),
        ...(asanaUnfinished !== null && {
          asanaUnfinished: JSON.parse(asanaUnfinished) as AsanaUnfinished,
        }),
        ...(archive !== null && { archive: JSON.parse(archive) as ArchiveAsk }),
        ...movedAsk(move),
        ...(cleanupFailure !== null && {
          cleanupFailure: JSON.parse(cleanupFailure) as CleanupFailureAsk,
        }),
        ...(memoryKill !== null && { memoryKill: JSON.parse(memoryKill) as MemoryKillAsk }),
        ...(design !== null && { design: JSON.parse(design) as DesignReview }),
        ...withFiles(row.id),
        ...withLineComments(row.id),
        ...commentPeer(row.id),
      },
      purpose,
    )

  const toLineComment = ({
    side,
    quoted,
    editedAt,
    commentId,
    sentAt,
    deleted: _,
    ...row
  }: typeof lineComments.Type): LineComment => ({
    ...row,
    side: side as LineSide,
    quoted: JSON.parse(quoted) as DiffRow[],
    ...(editedAt !== null && { editedAt }),
    ...(commentId !== null && sentAt !== null && { sent: { commentId, at: sentAt } }),
  })

  const withLineComments = (commentId: string): { lineComments?: LineComment[] } => {
    const sent = store
      .query(queryDb(lineComments.where({ commentId }).orderBy('createdAt', 'asc')))
      .map(toLineComment)
    return sent.length > 0 ? { lineComments: sent } : {}
  }

  const lineCommentsSent = (ids: readonly string[] | undefined, commentId: string, at: string) =>
    ids === undefined || ids.length === 0
      ? []
      : [events.lineCommentsSent({ ids: [...ids], commentId, at })]

  const withFiles = (commentId: string): { attachments?: Attachment[] } => {
    const files = commentFiles(commentId)
    return files.length > 0 ? { attachments: files } : {}
  }

  const permissionWait = (
    requests: readonly (typeof comments.Type)[],
    leadId: string | undefined,
  ) => {
    const asking = requests.filter((r) => r.kind === 'permission')
    if (asking.length === 0) return {}
    return {
      ...(asking.some((r) => r.simulator !== null && !androidAsk(r.simulator)) && {
        waitingOnSimulator: true,
      }),
      ...(asking.some((r) => r.simulator !== null && androidAsk(r.simulator)) && {
        waitingOnEmulator: true,
      }),
      waitingOnPermission: asking.some((r) => r.authorRunId === leadId)
        ? ('lead' as const)
        : ('sub-agent' as const),
    }
  }

  const commentRows = (taskId?: string) =>
    store.query(
      queryDb(
        comments
          .where(taskId === undefined ? { tutorial: false } : { taskId, tutorial: false })
          .orderBy('createdAt', 'asc'),
      ),
    )

  const isOpenRequest = (row: typeof comments.Type) => row.kind !== 'note' && row.answer === null

  const requestsSnoozed = (
    taskId: string,
    open: readonly { id: string }[],
  ): { requestsSnoozedUntil?: string } => {
    if (open.length === 0) return {}
    const until = new Map(
      store
        .query(queryDb(requestSnoozes.where({ ownerId: taskId })))
        .map((row) => [row.requestId, row.until]),
    )
    const times = open.flatMap((request) => until.get(request.id) ?? [])
    const first = times.sort()[0]
    return times.length < open.length || first === undefined ? {} : { requestsSnoozedUntil: first }
  }

  const openRequestRows = (taskId?: string) => commentRows(taskId).filter(isOpenRequest)
  const shownRequestRows = () => openRequestRows().filter((row) => row.heldFor === null)

  const descriptionRows = (taskId: string) =>
    store.query(queryDb(taskDescriptions.where({ taskId }).orderBy('version', 'asc')))

  const briefRows = (taskId: string) =>
    store.query(queryDb(taskBriefs.where({ taskId }).orderBy('version', 'asc')))

  const stageEntered = (taskId: string, stage: StageId, entry: NewStageEntry, at: string) =>
    events.taskStageEnteredV4({
      id: randomUUID(),
      taskId,
      stage,
      effort: entry.effort ?? null,
      stageFileLayer: entry.stageFile?.layer ?? null,
      stageFilePath: entry.stageFile?.path ?? null,
      layers: JSON.stringify(entry.layers),
      order: JSON.stringify(entry.order.map(({ stage, enabled }) => ({ stage, enabled }))),
      names: JSON.stringify(
        Object.fromEntries(
          entry.order.flatMap((p) => (p.name === undefined ? [] : [[p.stage, p.name]])),
        ),
      ),
      at,
    })

  const checkRunRows = (taskId?: string) =>
    store.query(
      queryDb(
        (taskId === undefined ? checkRuns : checkRuns.where({ taskId })).orderBy(
          'startedAt',
          'asc',
        ),
      ),
    )
  const checkResultRows = (checkRunId: string) =>
    store.query(queryDb(checkResults.where({ checkRunId }).orderBy('position', 'asc')))
  const toCheckResult = (row: typeof checkResults.Type): CheckResult => ({
    name: row.name,
    ...(row.repo !== null && { repo: row.repo }),
    ...(row.instruction === null && { command: row.command }),
    timeout: row.timeout,
    state: row.state as CheckState,
    ...(row.exitCode !== null && { exitCode: row.exitCode }),
    ...(row.durationMs !== null && { durationMs: row.durationMs }),
    ...(row.builtIn === 'ted-settings' && { builtIn: 'ted-settings' as const }),
    ...(row.instruction !== null && { instruction: row.instruction }),
    ...(row.fix !== null && { fix: row.fix }),
    ...(row.agent !== null && { agent: row.agent }),
    ...(row.model !== null && { model: row.model }),
    ...(row.effort !== null && { effort: row.effort }),
    ...(row.notRerun === true && { notRerun: true }),
    ...(row.noReport !== null && row.state === 'failed' && { noReport: row.noReport }),
  })

  const toCheckRun = (row: typeof checkRuns.Type): CheckRun => {
    const run: CheckRun = {
      id: row.id,
      taskId: row.taskId,
      trigger: row.trigger as CheckRunTrigger,
      stage: row.stage as StageId,
      checks: checkResultRows(row.id).map(toCheckResult),
      startedAt: row.startedAt,
      ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
      ...(row.outcome !== null && { outcome: row.outcome as CheckRunOutcome }),
      ...(row.finishedAt === null && storeState.checksWaiting.has(row.taskId) && { waiting: true }),
    }
    return {
      ...run,
      timing: checkRunTiming(
        run,
        store.query(queryDb(checkBoundaries.where({ checkRunId: row.id }))),
      ),
    }
  }
  const checkProgress = (checkRunId: string) => {
    const rows = checkResultRows(checkRunId)
    const index = rows.findIndex((r) => r.state === 'running')
    const current = rows[index]
    if (!current) return undefined
    return {
      name: current.repo === null ? current.name : `${current.name} (${current.repo})`,
      index: index + 1,
      total: rows.length,
    }
  }

  const conflictFound = (
    taskId: string,
    conflict: FoundConflict,
    at: string,
    sendBackId: string | null,
  ) =>
    events.baseConflictFound({
      id: randomUUID(),
      taskId,
      stage: conflict.stage,
      repo: conflict.repo,
      base: conflict.base,
      tip: conflict.tip,
      fileCount: conflict.fileCount,
      files: [...conflict.files],
      sendBackId,
      at,
    })

  const taskRow = (id: string) => store.query(queryDb(tasks.where({ id }))).at(0)

  const usedNumbers = (factoryId: string) => [
    ...store.query(queryDb(tasks.select('number').where({ factoryId }))),
    ...store.query(queryDb(deletedTasks.select('number').where({ factoryId }))),
    ...store.query(queryDb(taskMoves.select('number').where({ factoryId }))),
  ]
  const lastCommentAt = (rows: readonly (typeof comments.Type)[]) =>
    rows
      .flatMap((c) => [
        c.createdAt,
        ...(c.answer === null ? [] : [(JSON.parse(c.answer) as CommentAnswer).at]),
      ])
      .reduce<string | undefined>((a, b) => (a === undefined || b > a ? b : a), undefined)
  const requireTaskRow = (taskId: string) => {
    const row = taskRow(taskId)
    if (!row) throw new Error(`no Task ${taskId}`)
    return row
  }

  const taskEdited = (
    taskId: string,
    edit: { title?: string; description?: string },
    at: string,
  ) => {
    const row = requireTaskRow(taskId)
    const title = edit.title !== undefined && edit.title !== row.title ? edit.title : null
    const description =
      edit.description !== undefined && edit.description !== row.description
        ? edit.description
        : null
    if (title === null && description === null) return undefined
    const latest = descriptionRows(taskId).at(-1)
    return events.taskEdited({
      taskId,
      title,
      description,
      version: description === null ? null : (latest?.version ?? 1) + 1,
      previous: description === null || latest ? null : row.description,
      previousAt: description === null || latest ? null : row.createdAt,
      at,
    })
  }

  const nextRank = () =>
    store
      .query(queryDb(tasks.select('rank', 'number')))
      .reduce((highest, t) => Math.max(highest, t.rank ?? t.number), 0) + 1
  const runRow = (id: string) => store.query(queryDb(runRows.where({ id }))).at(0)

  const taskIdOfRun = (runId: string) => runRow(runId)?.taskId ?? undefined

  const listeners = new Set<(event: DaemonEvent) => void>()
  const emitting: DaemonEvent[] = []
  const emit = (event: DaemonEvent) => {
    emitting.push(event)
    if (emitting.length > 1) return
    let failure: { error: unknown } | undefined
    for (let next = emitting[0]; next; next = emitting[0]) {
      try {
        for (const listener of listeners) listener(next)
        if (setUpChanged(next)) emitting.push({ type: 'guides-changed', guides: guides() })
      } catch (error) {
        failure ??= { error }
      }
      emitting.shift()
    }
    if (failure) throw failure.error
  }

  const getComment = (id: string) => {
    const row = store.query(queryDb(comments.where({ id }))).at(0)
    return row && toComment(row)
  }

  const requireComment = (id: string) => {
    const comment = getComment(id)
    if (!comment) throw new Error(`no comment ${id}`)
    return comment
  }
  const treeTaskEvents = (
    task: NewTreeTask,
    {
      id,
      factoryId,
      number,
      rank,
      parentId,
      at,
    }: {
      id: string
      factoryId: string
      number: number
      rank: number
      parentId?: string
      at: string
    },
  ) => [
    events.taskCreatedV2({
      id,
      factoryId,
      number,
      title: task.title,
      description: task.description,
      priority: task.priority,
      clarifyDepth: 'auto',
      leadAgent: task.lead?.agent ?? null,
      leadModel: task.lead?.model ?? null,
      leadEffort: task.lead?.effort ?? null,
      startRequested: task.startRequested,
      createdAt: at,
    }),
    ...(task.lead?.effortMode === 'stage'
      ? [events.taskLeadEffortModeSet({ taskId: id, mode: 'stage', at })]
      : []),
    events.taskRanked({ taskId: id, rank, at }),
    ...(parentId !== undefined ? [events.taskParentChanged({ taskId: id, parentId, at })] : []),
    ...task.attachments.map((attachment) =>
      events.taskAttachmentAdded({ taskId: id, ...attachment, at }),
    ),
    events.taskSourceSet({
      taskId: id,
      url: task.sourceUrl,
      linearIdentifier: null,
      linearTitle: null,
      linearBranchName: null,
      linearDescription: null,
      at,
    }),
    ...(task.asana
      ? [events.taskSourceAsanaSet({ taskId: id, asana: JSON.stringify(task.asana), at })]
      : []),
    ...(task.github
      ? [events.taskSourceGitHubSet({ taskId: id, github: JSON.stringify(task.github), at })]
      : []),
    ...(task.asana && task.projects !== undefined
      ? [
          events.trackerItemGroupsSeen({
            taskId: id,
            tracker: 'asana',
            item: task.asana.gid,
            groups: [...task.projects],
            at,
          }),
        ]
      : []),
    ...(task.asana && task.syncAccount !== undefined
      ? [
          events.trackerSyncAllowed({
            taskId: id,
            tracker: 'asana',
            item: task.asana.gid,
            by: 'import',
            account: task.syncAccount,
            at,
          }),
        ]
      : []),
    ...(task.asana && task.syncDeclined
      ? [
          events.trackerSyncDeclined({
            taskId: id,
            tracker: 'asana',
            item: task.asana.gid,
            at,
          }),
        ]
      : []),
    ...(task.automation
      ? [events.automationTaskCreated({ ...task.automation, taskId: id, at })]
      : []),
  ]
  const commentPosted = (
    {
      taskId,
      body,
      author,
      kind = 'note',
      title,
      choices,
      multiple,
      round,
      proposal,
      sizeCheck,
      gate,
      attachments = [],
      design,
      linearTeam,
      asanaMissing,
      asanaUnfinished,
      archive,
      move,
      cleanupFailure,
      memoryKill,
      purpose,
    }: NewComment,
    createdAt: string,
    askedBy = author.kind === 'run' ? author.runId : undefined,
  ) => {
    const id = randomUUID()
    const fields = {
      id,
      taskId,
      kind,
      body,
      authorKind: author.kind,
      authorRunId: author.kind === 'run' ? author.runId : null,
      stage: taskRow(taskId)?.stage ?? null,
      title: title ?? null,
      choices: choices ?? null,
      gate: gate === undefined ? null : JSON.stringify(gate),
      createdAt,
    }
    const event =
      proposal !== undefined || sizeCheck !== undefined
        ? events.commentPostedV4({
            ...fields,
            round: round === undefined ? null : JSON.stringify(round),
            proposal: proposal === undefined ? null : JSON.stringify(proposal),
            sizeCheck: sizeCheck === undefined ? null : JSON.stringify(sizeCheck),
          })
        : round === undefined
          ? events.commentPostedV2(fields)
          : events.commentPostedV3({ ...fields, round: JSON.stringify(round) })
    const files = attachments.map(({ hash, name, size, mediaType }, position) =>
      events.commentAttachmentAdded({
        commentId: id,
        taskId,
        hash,
        name,
        size,
        mediaType,
        position,
      }),
    )
    const recordedPurpose =
      purpose ??
      structuralPurpose({
        kind,
        ...(gate && { gate }),
        ...(sizeCheck && { sizeCheck }),
        ...(linearTeam && { linearTeam }),
        ...(asanaMissing && { asanaMissing }),
        ...(asanaUnfinished && { asanaUnfinished }),
        ...(archive && { archive }),
        ...(move && { move }),
        ...(cleanupFailure && { cleanupFailure }),
        ...(memoryKill && { memoryKill }),
      })
    const heldFor =
      askedBy !== undefined &&
      kind !== 'note' &&
      kind !== 'permission' &&
      runRow(askedBy)?.state === 'working'
        ? askedBy
        : undefined
    const attached = [
      ...(heldFor === undefined ? [] : [events.requestHeld({ commentId: id, runId: heldFor })]),
      ...(recordedPurpose
        ? [
            events.commentPurposeRecorded({
              commentId: id,
              purpose: JSON.stringify(recordedPurpose),
            }),
          ]
        : []),
      ...files,
      ...(design === undefined
        ? []
        : [events.commentDesignAttached({ commentId: id, design: JSON.stringify(design) })]),
      ...(linearTeam ? [events.commentLinearTeamAsked({ commentId: id, ...linearTeam })] : []),
      ...(asanaMissing
        ? [
            events.commentAsanaMissingAsked({
              commentId: id,
              missing: JSON.stringify(asanaMissing),
            }),
          ]
        : []),
      ...(asanaUnfinished
        ? [
            events.commentAsanaUnfinishedAsked({
              commentId: id,
              unfinished: JSON.stringify(asanaUnfinished),
            }),
          ]
        : []),
      ...(archive
        ? [events.commentArchiveAsked({ commentId: id, archive: JSON.stringify(archive) })]
        : []),
      ...(move ? [events.commentMoveAsked({ commentId: id, move: JSON.stringify(move) })] : []),
      ...(multiple && choices?.length
        ? [events.commentMultipleChoiceAsked({ commentId: id })]
        : []),
      ...(cleanupFailure
        ? [
            events.commentCleanupFailureAsked({
              commentId: id,
              failure: JSON.stringify(cleanupFailure),
            }),
          ]
        : []),
      ...(memoryKill
        ? [
            events.commentMemoryKillAsked({
              commentId: id,
              memoryKill: JSON.stringify(memoryKill),
            }),
          ]
        : []),
    ]
    return { id, event, attached }
  }

  const emitComment = (id: string) => {
    const comment = requireComment(id)
    if (!comment.held) emit({ type: 'comment-updated', comment })
    return comment
  }

  const updatedTask = (taskId: string): Task => {
    const row = taskRow(taskId)
    if (!row) throw new Error(`no Task ${taskId}`)
    const task = toPublicTask(toTask(row, true))
    emit({ type: 'task-updated', task })
    return task
  }

  const updatedTasks = (ids: readonly string[]) => {
    const reads = sharedReads(ids.length)
    for (const id of ids) {
      const row = taskRow(id)
      if (!row) continue
      emit({ type: 'task-updated', task: toPublicTask(toTask(row, true, reads())) })
    }
  }

  const updatedQueue = (except?: string) => {
    updatedTasks(queue().flatMap(({ id }) => (id === except ? [] : [id])))
    noteActivity()
  }

  const logRows = (taskId: string) =>
    store.query(queryDb(taskLog.where({ taskId }).orderBy('at', 'asc')))

  const linearRecordFrom = (log: readonly (typeof taskLog.Type)[]): LinearSyncRecord => {
    const record: LinearSyncRecord = { linked: new Set(), allowed: false, allowedTeams: new Set() }
    for (const row of log.filter((entry) => entry.name.startsWith('v1.Linear'))) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      if (row.name === 'v1.LinearIssueSeen') {
        record.seen = {
          stateType: String(data.stateType),
          state: String(data.state),
          team: String(data.team),
        }
      } else if (row.name === 'v1.LinearSyncAllowed') {
        record.allowed = true
      } else if (row.name === 'v1.LinearTeamSyncAllowed') {
        record.allowedTeams.add(String(data.team))
      } else if (row.name === 'v1.LinearIssueMoved') {
        const step = linearSteps.find((s) => s === data.step)
        const before = record.step === undefined ? -1 : linearSteps.indexOf(record.step)
        if (step && linearSteps.indexOf(step) > before) record.step = step
      } else if (row.name === 'v1.LinearPullRequestsLinked' && Array.isArray(data.urls)) {
        for (const url of data.urls) record.linked.add(String(url))
      }
    }
    return record
  }

  const groupAskRow = (row: { linearTeam: string | null; purpose: string | null }): boolean =>
    row.linearTeam !== null ||
    (row.purpose !== null &&
      (JSON.parse(row.purpose) as { kind?: unknown }).kind === 'tracker-group')

  const trackerRecordFrom = (
    log: readonly (typeof taskLog.Type)[],
    tracker: string,
  ): TrackerSyncRecord => {
    const record: TrackerSyncRecord = {
      linked: new Set(),
      allowed: false,
      allowedGroups: new Map(),
    }
    for (const row of log.filter((entry) => entry.name.startsWith('v1.Tracker'))) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      if (data.tracker !== tracker) continue
      if (row.name === 'v1.TrackerItemSeen') {
        record.seen = {
          closed: data.closed === true,
          state: String(data.state),
          ...(typeof data.group === 'string' && { group: data.group }),
        }
      } else if (row.name === 'v1.TrackerSyncDeclined') {
        record.declined = true
      } else if (row.name === 'v1.TrackerSyncAllowed') {
        delete record.declined
        record.allowed = true
        if (typeof data.account === 'string') record.allowedAccount = data.account
        else delete record.allowedAccount
      } else if (row.name === 'v1.TrackerGroupSyncAllowed') {
        record.allowedGroups.set(
          String(data.group),
          typeof data.account === 'string' ? data.account : undefined,
        )
      } else if (row.name === 'v1.TrackerItemGroupsSeen' && Array.isArray(data.groups)) {
        record.groups = data.groups.map(String)
      } else if (row.name === 'v1.TrackerItemMoved') {
        record.step = String(data.step)
        record.moved = {
          ...(typeof data.state === 'string' && { state: data.state }),
          at: String(data.at),
        }
      } else if (row.name === 'v1.TrackerPullRequestsLinked' && Array.isArray(data.urls)) {
        for (const url of data.urls) record.linked.add(String(url))
      }
    }
    return record
  }

  const asanaOpenChildren = new Map<string, number>()
  const asanaLeftOpen = new Set<string>()

  const asanaSyncFor = (
    row: { id: string; factoryId: string; archived: boolean },
    source: TaskSource | undefined,
    stage: StageId,
    reads: TaskReads,
  ): AsanaSync | undefined => {
    if (!source?.asana || !parseAsanaTaskUrl(source.url)) return undefined
    const record = trackerRecordFrom(reads.log(row.id), 'asana')
    const merged = stage === 'done' && isMerged(row.id)
    const openChildren = asanaOpenChildren.get(row.id)
    const unfinishedAsked =
      merged &&
      reads
        .comments(row.id)
        .some((c) => c.asanaUnfinished !== null && c.answer === null && c.heldFor === null)
    const settings = reads.settings()
    const listed = settings.trackerSyncGroups.asana?.[row.factoryId] ?? []
    const listedAccounts = settings.trackerSyncGroupAccounts.asana?.[row.factoryId] ?? {}
    const projectAccounts = (record.declined ? [] : (record.groups ?? [])).flatMap((project) => [
      ...(listed.includes(project) && listedAccounts[project] !== undefined
        ? [listedAccounts[project]]
        : []),
      ...(record.allowedGroups.get(project) !== undefined
        ? [record.allowedGroups.get(project) as string]
        : []),
    ])
    return asanaSyncOf({
      allowed: record.allowed,
      projectAccounts: [...new Set(projectAccounts)],
      ...(record.allowedAccount !== undefined && { allowedAccount: record.allowedAccount }),
      switchOn: settings.asanaSync,
      connection: storeState.asanaConnection,
      archivedUnmerged: row.archived && !merged,
      ...(record.step === 'completed' &&
        record.moved?.state !== undefined && { completedByTed: record.moved.at }),
      completeInAsana: record.seen?.closed === true,
      merged,
      ...(openChildren !== undefined && { openChildren }),
      ...(unfinishedAsked && { unfinishedAsked }),
      ...(asanaLeftOpen.has(row.id) && { leftOpen: true }),
      linked: record.linked.size,
    })
  }

  const asanaTaskIds = (): string[] =>
    store
      .query(queryDb(taskSources))
      .flatMap(({ taskId, url }) => (parseAsanaTaskUrl(url) ? [taskId] : []))

  const linearSyncOf = (
    row: { id: string; factoryId: string },
    source: TaskSource | undefined,
    reads: TaskReads,
  ): 'on' | 'ask' | undefined => {
    if (!source || !parseLinearUrl(source.url)) return undefined
    const record = linearRecordFrom(reads.log(row.id))
    if (record.allowed) return 'on'
    const teams = reads.settings().linearSyncTeams[row.factoryId] ?? []
    const team = record.seen?.team
    return team !== undefined && (teams.includes(team) || record.allowedTeams.has(team))
      ? 'on'
      : 'ask'
  }

  const backlogStartsBeforeSaving = (): BacklogStarts => {
    const factoryIds = store.query(
      queryDb(factories.select('id').where({ autoStartBacklog: true })),
    )
    return { ...noBacklogStarts, enabled: factoryIds.length > 0, factoryIds }
  }
  const machineDefaults: MachineSettings = {
    ...defaultMachineSettings,
    maxWorkingRuns: defaultWorkingRuns(totalMemory()),
  }
  const settings = (): MachineSettings => {
    const legacy = store.query(queryDb(machineSettings.where({ id: 'machine' }))).at(0)
    const values = Object.fromEntries(
      store
        .query(queryDb(machineSettingValues.select()))
        .map(({ name, value }) => [name, JSON.parse(value) as unknown]),
    )
    return {
      ...machineDefaults,
      ...(legacy && { appearance: legacy.appearance as Appearance }),
      ...deviceLimitFromOldLimits(values),
      ...pick(values, Object.keys(defaultMachineSettings)),
      backlogStarts:
        values.backlogStarts === undefined
          ? backlogStartsBeforeSaving()
          : parseSetBacklogStartsRequest(values.backlogStarts),
      billing: {
        ...defaultMachineSettings.billing,
        ...(values.billing as Partial<MachineSettings['billing']> | undefined),
      },
    }
  }

  const checkWork = (): CheckWork => ({
    running: [
      ...new Set([
        ...checkingTasks,
        ...store.query(queryDb(checkRuns.where({ finishedAt: null }))).map((r) => r.taskId),
      ]),
    ].filter((taskId) => !storeState.checksWaiting.has(taskId)),
    waiting: storeState.checksWaiting,
    scheduled: storeState.scheduledChecks,
  })
  const activity = (): Activity => {
    const work = checkWork()
    const active = store.query(liveRuns)
    const runIds = new Set(active.map((run) => run.id))
    const taskIds = new Set(
      active.filter((run) => run.parentRunId === null).flatMap((run) => run.taskId ?? []),
    )
    const startingTasks = new Set(
      storeState.queueActivity.startingTasks.filter((id) => !taskIds.has(id)),
    )
    const startingRuns = new Set(
      storeState.queueActivity.startingRuns.filter((id) => !runIds.has(id)),
    )
    const queuedTasks = new Set(
      [
        ...storeState.queueActivity.queuedTasks,
        ...queue().map((entry) => entry.id),
        ...store.query(queryDb(heldRuns)).map((held) => held.taskId),
      ].filter((id) => !taskIds.has(id) && !startingTasks.has(id)),
    )
    const queuedRuns = new Set(
      storeState.queueActivity.queuedRuns.filter((id) => !startingRuns.has(id)),
    )
    const startingWork = startingTasks.size + startingRuns.size
    const factoryIds = new Set(store.query(allFactories).map((f) => f.id))
    const liveAutomations = store
      .query(queryDb(automations.select()))
      .filter((a) => factoryIds.has(a.factoryId))
    return {
      runs: {
        working: active.filter(
          (run) =>
            run.state === 'working' &&
            pauses()[run.agent as AgentKind] === undefined &&
            !waitingOnSubAgents.has(run.id),
        ).length,
        active: active.length,
        queued: queuedTasks.size + queuedRuns.size,
      },
      ...(startingWork > 0 && { startingWork }),
      scheduledTasks: store
        .query(allTasks)
        .filter(
          (task) =>
            task.stage === 'backlog' && task.archivedAt === null && task.snoozedUntil !== null,
        ).length,
      automationsOn: liveAutomations.filter((a) => a.on).length,
      factoriesSettingUp: store.query(allFactories).filter((f) => f.clonedAt === null).length,
      checksRunning: work.running.length + work.scheduled.running,
      checksWaiting: work.waiting.size + work.scheduled.waiting,
      shellsRunning: storeState.shellsRunning,
    }
  }
  const openRequests = (): WaitingRequest[] => {
    const factoryIds = new Set(store.query(allFactories).map((f) => f.id))
    const requestRows = shownRequestRows()
    const liveTasks = new Map(
      (requestRows.length === 0
        ? []
        : store.query(queryDb(tasks.select('id', 'factoryId', 'number', 'title', 'archivedAt')))
      )
        .filter((t) => t.archivedAt === null)
        .map((t) => [t.id, t]),
    )
    const fromTasks = requestRows.flatMap((row): WaitingRequest[] => {
      const task = liveTasks.get(row.taskId)
      if (!task) return []
      return [
        {
          source: 'task',
          id: row.id,
          factoryId: task.factoryId,
          createdAt: row.createdAt,
          headline: headlineOf(row.title, row.body),
          kind: row.kind as CommentKind,
          failed: row.failedRunId !== null,
          taskId: task.id,
          displayId: `${factoryKey(task.factoryId)}-${task.number}`,
          taskTitle: task.title,
        },
      ]
    })
    const liveAutomations = new Map(
      store
        .query(queryDb(automations.select()))
        .filter((a) => factoryIds.has(a.factoryId))
        .map((a) => [a.id, a]),
    )
    const fromAutomations = store
      .query(queryDb(automationComments.where({ kind: 'question', answer: null })))
      .flatMap((row): WaitingRequest[] => {
        const automation = liveAutomations.get(row.automationId)
        if (!automation) return []
        return [
          {
            source: 'automation',
            id: row.id,
            factoryId: automation.factoryId,
            createdAt: row.createdAt,
            headline: headlineOf(null, row.body),
            automationId: automation.id,
            automationName: automation.name,
          },
        ]
      })
    const livePlans = new Map(
      store
        .query(queryDb(plans.select()))
        .filter((p) => factoryIds.has(p.factoryId))
        .map((p) => [p.id, p]),
    )
    const fromPlans = store
      .query(queryDb(planRequests.where({ answer: null })))
      .flatMap((row): WaitingRequest[] => {
        const plan = livePlans.get(row.planId)
        if (!plan || row.kind === 'note') return []
        return [
          {
            source: 'plan',
            id: row.id,
            factoryId: plan.factoryId,
            createdAt: row.createdAt,
            headline: headlineOf(row.title, row.body),
            kind: row.kind as CommentKind,
            planId: plan.id,
            planTitle: plan.title,
          },
        ]
      })
    const chatRows = store.query(queryDb(chatRequestRows.where({ answer: null })))
    const askedIn = Map.groupBy(chatRows, (row) => row.chatId)
    const fromCoordinators = store
      .query(queryDb(coordinatorRows.where({ endedAt: null })))
      .flatMap((row): WaitingRequest[] => {
        if (!factoryIds.has(row.factoryId)) return []
        const chat = JSON.parse(row.data) as StoredCoordinator
        const chatTitle = row.title ?? titleFromMessage(chat.opening)
        const agentName = chatStore.agent(row.id)?.name ?? 'Coordinator'
        const confirmations = (chat.confirmations ?? [])
          .filter((c) => c.answer === undefined)
          .map(
            (c): WaitingRequest => ({
              source: 'coordinator',
              id: c.id,
              chatId: row.id,
              chatTitle,
              agentName,
              factoryId: row.factoryId,
              createdAt: c.askedAt,
              headline: confirmationHeadline(c),
              confirmationKind: c.kind,
            }),
          )
        const asked = (askedIn.get(row.id) ?? []).map(
          (r): WaitingRequest => ({
            source: 'coordinator',
            id: r.id,
            chatId: row.id,
            chatTitle,
            agentName,
            factoryId: row.factoryId,
            createdAt: r.createdAt,
            headline: headlineOf(r.title, r.body),
            requestKind: isOneOf(r.kind, chatRequestKinds) ? r.kind : 'question',
          }),
        )
        const cards = (chat.automationCards ?? [])
          .filter((c) => c.answer === undefined)
          .map(
            (c): WaitingRequest => ({
              source: 'coordinator',
              id: c.id,
              chatId: row.id,
              chatTitle,
              agentName,
              factoryId: row.factoryId,
              createdAt: c.askedAt,
              headline: automationCardHeadline(c),
              automationCard: c.kind,
            }),
          )
        return [...confirmations, ...cards, ...asked]
      })
    const current = settings()
    return [...fromTasks, ...fromAutomations, ...fromPlans, ...fromCoordinators]
      .map(
        (request): WaitingRequest =>
          factoryNotifications(current, request.factoryId).inboxItems
            ? request
            : { ...request, uncounted: true },
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  if (
    store.query(queryDb(machineSettingValues.where({ name: 'factoryNotifications' }))).length === 0
  ) {
    commit(
      events.machineSettingsChanged({
        changes: JSON.stringify({
          factoryNotifications: firstFactoryNotifications(
            store.query(allFactories).map((f) => f.id),
            settings().notifyTaskMerged,
          ),
        }),
        at: new Date().toISOString(),
      }),
    )
  }
  const inbox = (): { waiting: WaitingRequest[]; snoozed: SnoozedRequest[] } => {
    const until = new Map(
      store.query(queryDb(requestSnoozes.select())).map((row) => [row.requestId, row.until]),
    )
    const open = openRequests()
    return {
      waiting: open.filter((request) => !until.has(request.id)),
      snoozed: open
        .flatMap((request): SnoozedRequest[] => {
          const snoozedUntil = until.get(request.id)
          return snoozedUntil === undefined ? [] : [{ ...request, snoozedUntil }]
        })
        .sort((a, b) => a.snoozedUntil.localeCompare(b.snoozedUntil)),
    }
  }

  const snoozed = (): SnoozedRequest[] => inbox().snoozed
  let lastWaiting: { waiting: WaitingRequest[]; snoozed: SnoozedRequest[] } | undefined
  let waitingNoted = false
  noteWaiting = () => {
    if (waitingNoted) return
    waitingNoted = true
    queueMicrotask(() => {
      waitingNoted = false
      if (storeState.shutDown) return
      const next = inbox()
      if (lastWaiting !== undefined && isDeepStrictEqual(next, lastWaiting)) return
      lastWaiting = next
      emit({ type: 'inbox-changed', ...next })
    })
  }

  let lastActivity = activity()
  const noteActivity = () => {
    const next = activity()
    if (isDeepStrictEqual(next, lastActivity)) return
    lastActivity = next
    emit({ type: 'activity-changed', activity: next })
  }

  const testInvocationStore = createTestInvocationStore({
    store,
    changed: (id) => {
      if (taskRow(id)) updatedTask(id)
    },
    commit,
    checks: (taskId) =>
      checkRunRows(taskId).map((row) => {
        const starts = new Set(
          store
            .query(queryDb(checkBoundaries.where({ checkRunId: row.id, kind: 'start' })))
            .map((boundary) => boundary.position),
        )
        return {
          id: row.id,
          checks: checkResultRows(row.id).map((result) => ({
            state: result.state,
            started: starts.has(result.position),
          })),
        }
      }),
    run: (id) => {
      const row = runRow(id)
      return row && toRun(row)
    },
    check: (id) => {
      const row = store.query(queryDb(checkRuns.where({ id })))[0]
      return row && toCheckRun(row)
    },
  })

  const failureStore = createFailureStore({
    store,
    commit,
    changed: (id) => {
      updatedTask(id)
    },
  })

  const coordinatorStore = createCoordinatorStore({
    store,
    commit,
    changed(factoryId, chatId) {
      emit({ type: 'coordinator-changed', factoryId, chatId })
      noteActivity()
    },
  })

  const chatStore = createChatStore({
    store,
    commit,
    changed(chatId) {
      const chat = coordinatorStore.find(chatId)
      if (chat) emit({ type: 'coordinator-changed', factoryId: chat.factoryId, chatId })
      noteActivity()
    },
    runChanged(runId) {
      emit({ type: 'run-output', runId })
    },
  })
  lastWaiting = inbox()

  const observationSessionId = randomUUID()
  const previousBoundary = store.query(
    queryDb(intervalBoundaries.orderBy('sequence', 'desc').limit(1)),
  )[0]
  commit(
    events.intervalObservationStarted({
      sessionId: observationSessionId,
      previousObservedAt: previousBoundary?.at ?? null,
      at: new Date().toISOString(),
    }),
  )
  const lastTaskWaits = new Map<string, string>()
  noteTaskWait = (taskId, facts) => {
    const reasons = JSON.stringify(
      taskWaitReasons(taskId, facts).filter((r) => r.reason === 'run-slot'),
    )
    if ((lastTaskWaits.get(taskId) ?? '[]') === reasons) return
    observingWait = true
    commit(events.taskWaitObserved({ taskId, reasons, at: new Date().toISOString() }))
    lastTaskWaits.set(taskId, reasons)
  }
  const startRows = store.query(allTasks)
  const startReads = sharedReads(startRows.length)
  for (const row of startRows) toTask(row, true, startReads())
  await persisted()

  function repairApproved(
    approval: RepairApproval,
    repair: Pick<Task, 'id' | 'displayId' | 'title'>,
  ) {
    const { failure, request, brief } = approval
    const assessment = failure.assessments.at(-1)
    if (!assessment) throw new Error('a repair approval needs an assessment')
    const at = new Date().toISOString()
    const next: FailureCase = {
      ...failure,
      resolutions: [
        ...failure.resolutions,
        {
          ...request,
          resolution: 'repair',
          assessmentId: assessment.id,
          at,
          ...(assessment.contextId && { contextId: assessment.contextId }),
          repairTask: { id: repair.id, displayId: repair.displayId, title: repair.title },
        },
      ],
    }
    const row = taskRow(failure.taskId)
    if (!row) throw new Error('no affected Task')
    return {
      next,
      events: [
        failureStore.event(next, 'resolved'),
        events.commentAnswered({
          id: request.requestId,
          answer: JSON.stringify({
            kind: 'answered',
            choice:
              failure.decisions.find((d) => d.commentId === request.requestId)?.repairTask?.id ===
                repair.id && request.repair?.kind === 'existing'
                ? namedRepairChoice(repair.displayId)
                : failureChoices.repair,
            text: [`Waiting for ${repair.displayId}: ${repair.title}`, request.reason]
              .filter(Boolean)
              .join('\n\n'),
            at,
          }),
          at,
        }),
        events.commentAnswerHeld({ id: request.requestId, at }),
        ...lineCommentsSent(approval.drafts, request.requestId, at),
        events.taskBlockerAddedV2({
          taskId: failure.taskId,
          blockerId: repair.id,
          runId: null,
          at,
        }),
        events.taskWaitingForBlockers({ taskId: failure.taskId, at }),
        events.taskBriefWritten({
          id: randomUUID(),
          taskId: failure.taskId,
          version: (briefRows(failure.taskId).at(-1)?.version ?? 0) + 1,
          text: brief.replace('REPAIR_TASK_REFERENCE', `${repair.displayId} (“${repair.title}”)`),
          stage: row.stage,
          runId: null,
          at,
        }),
      ],
    }
  }
  return {
    storeState,
    store,
    eventlogName,
    writeListeners,
    waitingOnSubAgents,
    asleepRuns,
    liveTokens,
    checkingTasks,
    movingAfterChecks,
    heldMerges,
    stoppingTasks,
    commit,
    persisted,
    allFactories,
    allTasks,
    liveRuns,
    taskDraft,
    listFactories,
    guides,
    emitGuides,
    guideEnding,
    setUpDone,
    requireFactory,
    factoryKey,
    taskRuns,
    queue,
    reposOf,
    readTaskLog,
    history,
    isMerged,
    parentRow,
    childRows,
    blockerLinks,
    startRequestUsed,
    blockersRemovedUsed,
    startCause,
    attachmentRows,
    toAttachment,
    browserCapturesOf,
    entryRows,
    pauses,
    heldRows,
    taskReads,
    readEveryTaskFrom,
    toTask,
    toPublicTask,
    toRun,
    toComment,
    toLineComment,
    lineCommentsSent,
    commentRows,
    openRequestRows,
    shownRequestRows,
    descriptionRows,
    briefRows,
    stageEntered,
    checkRunRows,
    checkResultRows,
    toCheckRun,
    conflictFound,
    taskRow,
    usedNumbers,
    requireTaskRow,
    taskEdited,
    nextRank,
    runRow,
    taskIdOfRun,
    listeners,
    emit,
    getComment,
    requireComment,
    treeTaskEvents,
    commentPosted,
    emitComment,
    updatedTask,
    updatedTasks,
    updatedQueue,
    logRows,
    linearRecordFrom,
    trackerRecordFrom,
    asanaOpenChildren,
    asanaLeftOpen,
    asanaTaskIds,
    settings,
    checkWork,
    activity,
    openRequests,
    inbox,
    snoozed,
    noteActivity,
    testInvocationStore,
    failureStore,
    coordinatorStore,
    chatStore,
    observationSessionId,
    repairApproved,
  }
}

export type StoreContext = Awaited<ReturnType<typeof openContext>>
