import type { Task } from '@ted/protocol'
import type { TedStore } from '../../store/index.ts'
import type { TrackerRecords } from './connector.ts'

export function trackerRecords<Handle>(
  store: TedStore,
  tracker: string,
  account: () => string | undefined = () => undefined,
): TrackerRecords<Handle> {
  const record = (taskId: string) => store.trackerSync(taskId, tracker)
  const groups = (settings: ReturnType<TedStore['settings']>, factoryId: string) => ({
    allowed: settings.trackerSyncGroups[tracker]?.[factoryId] ?? [],
    declined: settings.trackerSyncDeclined[tracker]?.[factoryId] ?? [],
  })
  return {
    record,
    see(taskId, label, item) {
      const before = record(taskId).seen
      const group = item.group?.key
      if (before?.closed === item.closed && before.state === item.state && before.group === group)
        return
      store.trackerItemSeen(taskId, tracker, label, {
        closed: item.closed,
        state: item.state,
        ...(group !== undefined && { group }),
      })
    },
    moved(taskId, label, step, state) {
      store.trackerItemMoved(taskId, tracker, label, step, state)
    },
    linked(taskId, label, urls) {
      store.trackerPullRequestsLinked(taskId, tracker, label, urls)
    },
    syncState(task: Task) {
      const current = record(task.id)
      if (current.allowed) return 'on'
      const group = current.seen?.group
      if (group === undefined) return 'ask'
      return groups(store.settings(), task.factoryId).allowed.includes(group) ||
        current.allowedGroups.has(group)
        ? 'on'
        : 'ask'
    },
    allowTask(task, label) {
      store.trackerSyncAllowed(task.id, tracker, label, account())
    },
    groups,
    allowGroup(factoryId, group, consents) {
      return store.allowTrackerGroup(
        tracker,
        factoryId,
        group,
        consents.map(({ taskId, label }) => ({ taskId, item: label })),
        account(),
      )
    },
    declineGroup(factoryId, group) {
      store.declineTrackerGroup(tracker, factoryId, group)
    },
    closedPurpose: { kind: 'tracker-closed', tracker },
    isClosedQuestion(comment) {
      return comment.purpose?.kind === 'tracker-closed' && comment.purpose.tracker === tracker
    },
    groupAsk(group) {
      return { purpose: { kind: 'tracker-group', tracker, group } }
    },
    isGroupAsk(comment) {
      return comment.purpose?.kind === 'tracker-group' && comment.purpose.tracker === tracker
    },
    askedGroup(comment) {
      return comment.purpose?.kind === 'tracker-group' && comment.purpose.tracker === tracker
        ? comment.purpose.group.key
        : undefined
    },
    withdrawn(why, at) {
      return { kind: 'withdrawn', at, tracker: why }
    },
  }
}
