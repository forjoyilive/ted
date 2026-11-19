import { queryDb } from '@livestore/livestore'
import type { MachineSettings, Task } from '@ted/protocol'
import type { StoreContext } from './context.ts'
import { events, taskLog, taskSources } from './schema.ts'
import type {
  GitHubNoticeRecord,
  LinearSeen,
  LinearStep,
  LinearSyncRecord,
  TrackerSeen,
  TrackerSyncRecord,
} from './types.ts'

function withGroupAccount(
  current: MachineSettings['trackerSyncGroupAccounts'],
  tracker: string,
  factoryId: string,
  group: string,
  account: string,
): MachineSettings['trackerSyncGroupAccounts'] {
  const byFactory = current[tracker] ?? {}
  return {
    ...current,
    [tracker]: { ...byFactory, [factoryId]: { ...byFactory[factoryId], [group]: account } },
  }
}

export interface TrackersArea {
  gitHubActivitySent(taskId: string, runId: string, notices: readonly GitHubNoticeRecord[]): void
  gitHubActivityQueued(taskId: string, notices: readonly GitHubNoticeRecord[]): Task
  gitHubActivityHeld(taskId: string, notices: readonly GitHubNoticeRecord[]): void
  gitHubSeen(taskId: string): Map<string, string>
  linearIssueSeen(taskId: string, identifier: string, seen: LinearSeen): void
  linearIssueMoved(
    taskId: string,
    identifier: string,
    step: LinearStep,
    state: string | undefined,
  ): void
  linearPullRequestsLinked(taskId: string, identifier: string, urls: readonly string[]): void
  linearSync(taskId: string): LinearSyncRecord
  trackerItemSeen(taskId: string, tracker: string, item: string, seen: TrackerSeen): void
  trackerItemMoved(
    taskId: string,
    tracker: string,
    item: string,
    step: string,
    state: string | undefined,
  ): void
  trackerPullRequestsLinked(
    taskId: string,
    tracker: string,
    item: string,
    urls: readonly string[],
  ): void
  trackerSync(taskId: string, tracker: string): TrackerSyncRecord
  trackerSyncAllowed(
    taskId: string,
    tracker: string,
    item: string,
    account?: string,
    by?: 'menu' | 'import',
  ): Task
  allowTrackerGroup(
    tracker: string,
    factoryId: string,
    group: string,
    consents: readonly { taskId: string; item: string }[],
    account?: string,
  ): MachineSettings
  declineTrackerGroup(tracker: string, factoryId: string, group: string): void
  forgetTrackerGroup(
    tracker: string,
    factoryId: string,
    group: string,
    list: 'allowed' | 'declined',
    consents: readonly { taskId: string; item: string }[],
    account?: string,
  ): MachineSettings
  trackerItemGroupsSeen(
    taskId: string,
    tracker: string,
    item: string,
    groups: readonly string[],
  ): void
  linearSyncAllowed(taskId: string, identifier: string): Task
  allowLinearTeam(
    factoryId: string,
    team: string,
    consents: readonly { taskId: string; identifier: string }[],
  ): MachineSettings
  sourcedTaskIds(): string[]
  taskSourceUrls(): { taskId: string; url: string }[]
  setAsanaConnection(account: string | undefined): void
  asanaAccount(): string | undefined
  setAsanaOpenChildren(taskId: string, count: number | undefined): void
  setAsanaLeftOpen(taskId: string, leftOpen: boolean): void
}

export function trackersArea(ctx: StoreContext): TrackersArea {
  const {
    storeState,
    store,
    commit,
    queue,
    taskRow,
    emit,
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
  } = ctx
  const linearRecord = (taskId: string): LinearSyncRecord => linearRecordFrom(logRows(taskId))

  const trackerRecord = (taskId: string, tracker: string): TrackerSyncRecord =>
    trackerRecordFrom(logRows(taskId), tracker)

  return {
    gitHubActivitySent(taskId, runId, notices) {
      commit(
        events.gitHubActivitySent({
          taskId,
          runId,
          notices: notices.map(({ key, sig, kind, where }) => ({ key, sig, kind, where })),
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    gitHubActivityHeld(taskId, notices) {
      commit(
        events.gitHubActivityHeld({
          taskId,
          notices: notices.map(({ key, sig, kind, where }) => ({ key, sig, kind, where })),
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    gitHubActivityQueued(taskId, notices) {
      const rank = Math.max(0, ...queue().map((q) => q.rank)) + 1
      commit(
        events.gitHubActivityQueued({
          taskId,
          rank,
          notices: notices.map(({ key, sig, kind, where }) => ({ key, sig, kind, where })),
          at: new Date().toISOString(),
        }),
      )
      const task = updatedTask(taskId)
      updatedQueue(taskId)
      return task
    },
    gitHubSeen(taskId) {
      const seen = new Map<string, string>()
      const rows = store
        .query(queryDb(taskLog.where({ taskId }).orderBy('at', 'asc')))
        .filter(
          (row) => row.name === 'v1.GitHubActivitySent' || row.name === 'v1.GitHubActivityHeld',
        )
      for (const row of rows) {
        const notices = (JSON.parse(row.data) as { notices?: unknown }).notices
        if (!Array.isArray(notices)) continue
        for (const n of notices as { key?: unknown; sig?: unknown }[]) {
          if (typeof n.key === 'string' && typeof n.sig === 'string') seen.set(n.key, n.sig)
        }
      }
      return seen
    },
    linearIssueSeen(taskId, identifier, { stateType, state, team }) {
      commit(
        events.linearIssueSeen({
          taskId,
          identifier,
          stateType,
          state,
          team,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    linearSyncAllowed(taskId, identifier) {
      commit(
        events.linearSyncAllowed({ taskId, identifier, by: 'menu', at: new Date().toISOString() }),
      )
      return updatedTask(taskId)
    },
    allowLinearTeam(factoryId, team, consents) {
      const at = new Date().toISOString()
      const current = settings()
      const listed = current.linearSyncTeams[factoryId] ?? []
      const { [factoryId]: declined = [], ...otherDeclined } = current.linearSyncDeclined
      const stillDeclined = declined.filter((t) => t !== team)
      const changes: Partial<MachineSettings> = {
        ...(!listed.includes(team) && {
          linearSyncTeams: { ...current.linearSyncTeams, [factoryId]: [...listed, team] },
        }),
        ...(stillDeclined.length !== declined.length && {
          linearSyncDeclined:
            stillDeclined.length > 0
              ? { ...otherDeclined, [factoryId]: stillDeclined }
              : otherDeclined,
        }),
      }
      const changed = Object.keys(changes).length > 0
      const batch = [
        ...(changed
          ? [events.machineSettingsChanged({ changes: JSON.stringify(changes), at })]
          : []),
        ...consents.map(({ taskId, identifier }) =>
          events.linearTeamSyncAllowed({ taskId, identifier, team, at }),
        ),
      ]
      if (batch.length > 0) commit(...batch)
      if (changed) emit({ type: 'settings-changed', settings: settings() })
      for (const { taskId } of consents) updatedTask(taskId)
      return settings()
    },
    linearIssueMoved(taskId, identifier, step, state) {
      commit(
        events.linearIssueMoved({
          taskId,
          identifier,
          step,
          state: state ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    linearPullRequestsLinked(taskId, identifier, urls) {
      commit(
        events.linearPullRequestsLinked({
          taskId,
          identifier,
          urls: [...urls],
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    linearSync: linearRecord,
    trackerItemSeen(taskId, tracker, item, { closed, state, group }) {
      commit(
        events.trackerItemSeen({
          taskId,
          tracker,
          item,
          closed,
          state,
          group: group ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    trackerItemMoved(taskId, tracker, item, step, state) {
      commit(
        events.trackerItemMoved({
          taskId,
          tracker,
          item,
          step,
          state: state ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    trackerPullRequestsLinked(taskId, tracker, item, urls) {
      commit(
        events.trackerPullRequestsLinked({
          taskId,
          tracker,
          item,
          urls: [...urls],
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    trackerSync: trackerRecord,
    trackerSyncAllowed(taskId, tracker, item, account, by = 'menu') {
      if (tracker === 'asana') {
        asanaOpenChildren.delete(taskId)
        asanaLeftOpen.delete(taskId)
      }
      commit(
        events.trackerSyncAllowed({
          taskId,
          tracker,
          item,
          by,
          account: account ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    allowTrackerGroup(tracker, factoryId, group, consents, account) {
      const at = new Date().toISOString()
      const current = settings()
      const allowed = current.trackerSyncGroups[tracker] ?? {}
      const declined = current.trackerSyncDeclined[tracker] ?? {}
      const listed = allowed[factoryId] ?? []
      const wasDeclined = declined[factoryId] ?? []
      const stillDeclined = wasDeclined.filter((g) => g !== group)
      const { [factoryId]: _, ...otherDeclined } = declined
      const changes: Partial<MachineSettings> = {
        ...(!listed.includes(group) && {
          trackerSyncGroups: {
            ...current.trackerSyncGroups,
            [tracker]: { ...allowed, [factoryId]: [...listed, group] },
          },
        }),
        ...(stillDeclined.length !== wasDeclined.length && {
          trackerSyncDeclined: {
            ...current.trackerSyncDeclined,
            [tracker]:
              stillDeclined.length > 0
                ? { ...otherDeclined, [factoryId]: stillDeclined }
                : otherDeclined,
          },
        }),
        ...(account !== undefined &&
          current.trackerSyncGroupAccounts[tracker]?.[factoryId]?.[group] !== account && {
            trackerSyncGroupAccounts: withGroupAccount(
              current.trackerSyncGroupAccounts,
              tracker,
              factoryId,
              group,
              account,
            ),
          }),
      }
      const changed = Object.keys(changes).length > 0
      const batch = [
        ...(changed
          ? [events.machineSettingsChanged({ changes: JSON.stringify(changes), at })]
          : []),
        ...consents.map(({ taskId, item }) =>
          events.trackerGroupSyncAllowed({
            taskId,
            tracker,
            item,
            group,
            account: account ?? null,
            at,
          }),
        ),
      ]
      if (batch.length > 0) commit(...batch)
      if (changed) emit({ type: 'settings-changed', settings: settings() })
      for (const { taskId } of consents) updatedTask(taskId)
      if (changed && tracker === 'asana') updatedTasks(asanaTaskIds())
      return settings()
    },
    forgetTrackerGroup(tracker, factoryId, group, list, consents, account) {
      const at = new Date().toISOString()
      const current = settings()
      const name = list === 'allowed' ? 'trackerSyncGroups' : 'trackerSyncDeclined'
      const byFactory = current[name][tracker] ?? {}
      const listed = byFactory[factoryId] ?? []
      if (!listed.includes(group)) return current
      const kept = listed.filter((g) => g !== group)
      const { [factoryId]: _, ...others } = byFactory
      const accounts = current.trackerSyncGroupAccounts[tracker]?.[factoryId] ?? {}
      const { [group]: __, ...keptAccounts } = accounts
      const changes: Partial<MachineSettings> = {
        [name]: {
          ...current[name],
          [tracker]: kept.length > 0 ? { ...others, [factoryId]: kept } : others,
        },
        ...(list === 'allowed' &&
          group in accounts && {
            trackerSyncGroupAccounts: {
              ...current.trackerSyncGroupAccounts,
              [tracker]: {
                ...current.trackerSyncGroupAccounts[tracker],
                [factoryId]: keptAccounts,
              },
            },
          }),
      }
      commit(
        ...consents.map(({ taskId, item }) =>
          events.trackerGroupSyncAllowed({
            taskId,
            tracker,
            item,
            group,
            account: account ?? null,
            at,
          }),
        ),
        events.machineSettingsChanged({ changes: JSON.stringify(changes), at }),
      )
      emit({ type: 'settings-changed', settings: settings() })
      for (const { taskId } of consents) updatedTask(taskId)
      if (tracker === 'asana') updatedTasks(asanaTaskIds())
      return settings()
    },
    trackerItemGroupsSeen(taskId, tracker, item, groups) {
      commit(
        events.trackerItemGroupsSeen({
          taskId,
          tracker,
          item,
          groups: [...groups],
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    declineTrackerGroup(tracker, factoryId, group) {
      const current = settings().trackerSyncDeclined
      const byFactory = current[tracker] ?? {}
      const listed = byFactory[factoryId] ?? []
      if (listed.includes(group)) return
      const changes: Partial<MachineSettings> = {
        trackerSyncDeclined: {
          ...current,
          [tracker]: { ...byFactory, [factoryId]: [...listed, group] },
        },
      }
      commit(
        events.machineSettingsChanged({
          changes: JSON.stringify(changes),
          at: new Date().toISOString(),
        }),
      )
      emit({ type: 'settings-changed', settings: settings() })
    },
    sourcedTaskIds: () => store.query(queryDb(taskSources)).map((row) => row.taskId),
    taskSourceUrls: () =>
      store.query(queryDb(taskSources)).map(({ taskId, url }) => ({ taskId, url })),
    setAsanaConnection(account) {
      if (storeState.asanaConnection.known && storeState.asanaConnection.account === account) return
      storeState.asanaConnection = { known: true, ...(account !== undefined && { account }) }
      updatedTasks(asanaTaskIds())
    },
    asanaAccount() {
      return storeState.asanaConnection.known ? storeState.asanaConnection.account : undefined
    },
    setAsanaOpenChildren(taskId, count) {
      if (asanaOpenChildren.get(taskId) === count) return
      if (count === undefined) asanaOpenChildren.delete(taskId)
      else asanaOpenChildren.set(taskId, count)
      if (taskRow(taskId)) updatedTask(taskId)
    },
    setAsanaLeftOpen(taskId, leftOpen) {
      if (asanaLeftOpen.has(taskId) === leftOpen) return
      if (leftOpen) asanaLeftOpen.add(taskId)
      else asanaLeftOpen.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
    },
  }
}
