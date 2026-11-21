import { queryDb, StoreInternalsSymbol } from '@livestore/livestore'
import {
  type Activity,
  type Banner,
  type BannerAction,
  type BannerSeverity,
  type BusyHold,
  bannerOrder,
  type DaemonEvent,
  type DashboardRange,
  type DashboardReport,
  type MachineSettings,
  type WaitingRequest,
} from '@ted/protocol'
import { Effect } from 'effect'
import type { StoreContext } from './context.ts'
import { readDashboard } from './dashboard.ts'
import { createExecutionStore, type ExecutionStore } from './execution.ts'
import { createOperationStore, type OperationStore } from './execution-operations.ts'
import { createPairingStore, type PairingStore } from './execution-pairing.ts'
import { banners, events, heldRuns, subAgentRequests, taskRepos } from './schema.ts'
import type { CheckWork, NewBanner, QueueActivity } from './types.ts'

export interface MachineArea {
  execution: ExecutionStore
  operations: OperationStore
  pairing: PairingStore
  dashboard(factoryIds: readonly string[], range: DashboardRange, asOf?: number): DashboardReport
  subscribe(listener: (event: DaemonEvent) => void): () => void
  settings(): MachineSettings
  activity(): Activity
  waiting(): WaitingRequest[]
  setQueueActivity(activity: QueueActivity): void
  setShellsRunning(count: number): void
  setScheduledChecks(counts: { running: number; waiting: number }): void
  checkWork(): CheckWork
  updateSettings(changes: Partial<MachineSettings>): MachineSettings
  raiseBanner(input: NewBanner): Banner
  dismissProblem(id: string, raisedAt: string): Banner
  dismissBanner(id: string, until: string): Banner | undefined
  clearBanner(id: string): void
  getBanner(id: string): Banner | undefined
  listBanners(): Banner[]
  exportEventlog(): { fileName: string; data: Uint8Array }
  persisted(): Promise<void>
  holdNewWork(reason: string | undefined): void
  newWorkHold(): string | undefined
  setPiSandboxProblem(reason: string | undefined): void
  piSandboxProblem(): string | undefined
  holdWhenBusy(held: BusyHold | undefined): void
  busyHold(): BusyHold | undefined
  onWriteResult(listener: (error?: unknown) => void): () => void
  close(): Promise<void>
}

export function machineArea(ctx: StoreContext): MachineArea {
  const {
    storeState,
    store,
    eventlogName,
    writeListeners,
    commit,
    persisted,
    allTasks,
    taskRuns,
    queue,
    taskReads,
    toTask,
    taskRow,
    listeners,
    emit,
    updatedTask,
    updatedTasks,
    updatedQueue,
    asanaTaskIds,
    settings,
    checkWork,
    activity,
    inbox,
    noteActivity,
    testInvocationStore,
    observationSessionId,
  } = ctx
  const tasksWaitingForSlots = (): string[] => [
    ...new Set([
      ...queue().map(({ id }) => id),
      ...(storeState.queueActivity.taskPlaces ?? []).map(({ id }) => id),
      ...store.query(queryDb(subAgentRequests.select('taskId'))),
    ]),
  ]

  const waiting = (): WaitingRequest[] => inbox().waiting

  const toBanner = (row: typeof banners.Type): Banner => ({
    id: row.id,
    problem: row.problem,
    severity: row.severity as BannerSeverity,
    ...(row.factoryId !== null && { factoryId: row.factoryId }),
    text: row.text,
    ...(row.action !== null && { action: JSON.parse(row.action) as BannerAction }),
    raisedAt: row.raisedAt,
    ...(row.dismissed === 1 && { dismissed: true }),
    ...(row.dismissedUntil !== null && { dismissedUntil: row.dismissedUntil }),
  })
  const bannerRow = (id: string) => store.query(queryDb(banners.where({ id }))).at(0)
  const getBanner = (id: string) => {
    const row = bannerRow(id)
    return row && toBanner(row)
  }
  const requireBanner = (id: string) => {
    const banner = getBanner(id)
    if (!banner) throw new Error(`no banner ${id}`)
    return banner
  }

  const execution = createExecutionStore({
    store,
    commit,
    task(id) {
      const row = taskRow(id)
      return (
        row && {
          started:
            row.branch !== null ||
            row.worktree !== null ||
            taskRuns(id).length > 0 ||
            store.query(queryDb(taskRepos.where({ taskId: id }))).length > 0,
        }
      )
    },
  })

  return {
    execution,
    operations: createOperationStore(store, commit, (id) => taskRow(id) !== undefined),
    pairing: createPairingStore(store, commit),
    dashboard(factoryIds, range, asOf = Date.now()) {
      const shown = new Set(factoryIds)
      const reads = taskReads(true)
      const statuses = new Map(
        store
          .query(allTasks)
          .filter(
            (row) =>
              shown.has(row.factoryId) &&
              row.archivedAt === null &&
              !row.setup &&
              row.stage !== 'done',
          )
          .map((row) => [row.id, toTask(row, false, reads).status?.kind]),
      )
      return readDashboard(store, factoryIds, range, asOf, observationSessionId, statuses)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    settings,
    activity,
    waiting,
    setQueueActivity(value) {
      const placeOf = (entry: { place: number; skipsBusy?: true }) =>
        `${entry.place}${entry.skipsBusy ? ' skips busy' : ''}`
      const before = new Map(
        storeState.queueActivity.taskPlaces?.map((entry) => [entry.id, placeOf(entry)]),
      )
      const after = new Map(value.taskPlaces?.map((entry) => [entry.id, placeOf(entry)]))
      const waitsBefore = storeState.queueActivity.backlogWaits
      const waitsAfter = value.backlogWaits
      const holdsBefore = storeState.queueActivity.startHolds
      const holdsAfter = value.startHolds
      const moved = [
        ...new Set([
          ...before.keys(),
          ...after.keys(),
          ...(waitsBefore?.keys() ?? []),
          ...(waitsAfter?.keys() ?? []),
          ...(holdsBefore?.keys() ?? []),
          ...(holdsAfter?.keys() ?? []),
        ]),
      ].filter(
        (id) =>
          before.get(id) !== after.get(id) ||
          waitsBefore?.get(id) !== waitsAfter?.get(id) ||
          holdsBefore?.get(id) !== holdsAfter?.get(id),
      )
      storeState.queueActivity = value
      if (moved.length > 0) storeState.stateCommits += 1
      updatedTasks(moved)
      noteActivity()
    },
    setShellsRunning(count) {
      storeState.shellsRunning = count
      noteActivity()
    },
    checkWork,
    setScheduledChecks(counts) {
      if (
        counts.running === storeState.scheduledChecks.running &&
        counts.waiting === storeState.scheduledChecks.waiting
      )
        return
      storeState.scheduledChecks = counts
      noteActivity()
    },
    updateSettings(changes) {
      const current = settings()
      const changed = Object.fromEntries(
        Object.entries(changes).filter(
          ([name, value]) =>
            value !== undefined && current[name as keyof MachineSettings] !== value,
        ),
      )
      if (Object.keys(changed).length > 0) {
        commit(
          events.machineSettingsChanged({
            changes: JSON.stringify(changed),
            at: new Date().toISOString(),
          }),
        )
        emit({ type: 'settings-changed', settings: settings() })
        if (changes.enabledAgents) {
          updatedQueue()
          for (const held of store.query(queryDb(heldRuns))) updatedTask(held.taskId)
        }
        if ('overnightMode' in changed) for (const row of store.query(allTasks)) updatedTask(row.id)
        else if ('asanaSync' in changed) updatedTasks(asanaTaskIds())
      }
      return settings()
    },
    raiseBanner({ id, problem, severity, factoryId, text, action }) {
      const current = bannerRow(id)
      const actionJson = action === undefined ? null : JSON.stringify(action)
      if (
        current &&
        current.severity === severity &&
        current.text === text &&
        current.action === actionJson
      ) {
        return toBanner(current)
      }
      commit(
        events.bannerRaised({
          id,
          problem,
          severity,
          factoryId: factoryId ?? null,
          text,
          action: actionJson,
          at: new Date().toISOString(),
        }),
      )
      const banner = requireBanner(id)
      emit({ type: current ? 'banner-updated' : 'banner-raised', banner })
      return banner
    },
    dismissProblem(id, raisedAt) {
      commit(events.problemDismissed({ id, raisedAt }))
      const banner = requireBanner(id)
      emit({ type: 'banner-updated', banner })
      return banner
    },
    dismissBanner(id, until) {
      if (!bannerRow(id)) return undefined
      commit(events.bannerDismissed({ id, until, at: new Date().toISOString() }))
      const banner = requireBanner(id)
      emit({ type: 'banner-updated', banner })
      return banner
    },
    clearBanner(id) {
      if (!bannerRow(id)) return
      commit(events.bannerCleared({ id, at: new Date().toISOString() }))
      emit({ type: 'banner-cleared', id })
    },
    getBanner,
    listBanners: () => store.query(queryDb(banners)).map(toBanner).sort(bannerOrder),
    exportEventlog: () => ({
      fileName: eventlogName,
      data: Effect.runSync(store[StoreInternalsSymbol].clientSession.leaderThread.getEventlogData),
    }),
    persisted,
    holdNewWork(reason) {
      if (reason === storeState.newWorkHeld) return
      storeState.newWorkHeld = reason
      storeState.stateCommits += 1
      updatedTasks(tasksWaitingForSlots())
    },
    newWorkHold: () => storeState.newWorkHeld,
    setPiSandboxProblem(reason) {
      storeState.piSandboxReason = reason
    },
    piSandboxProblem: () => storeState.piSandboxReason,
    busyHold: () => storeState.heldBusy,
    holdWhenBusy(held) {
      const changed =
        (held === undefined) !== (storeState.heldBusy === undefined) ||
        held?.cpuHeld !== storeState.heldBusy?.cpuHeld ||
        held?.memoryHeld !== storeState.heldBusy?.memoryHeld
      storeState.heldBusy = held
      if (!changed) return
      storeState.stateCommits += 1
      updatedTasks(tasksWaitingForSlots())
    },
    onWriteResult(listener) {
      writeListeners.add(listener)
      return () => writeListeners.delete(listener)
    },
    close: async () => {
      if (storeState.shutDown) return
      try {
        commit(
          events.intervalObservationEnded({
            sessionId: observationSessionId,
            at: new Date().toISOString(),
          }),
        )
        await persisted()
      } finally {
        storeState.shutDown = true
        testInvocationStore.close()
        await store.shutdownPromise()
      }
    },
  }
}
