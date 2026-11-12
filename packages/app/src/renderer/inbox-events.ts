import type { InboxItem } from '@ted/protocol'
import type { EventChange } from './event-value.ts'
import type { TedEvent } from './ted.ts'

const unarchivedEveryMs = 2_000

export function inboxChange(
  event: TedEvent,
  shown: readonly InboxItem[],
  list: 'waiting' | 'answered',
): EventChange<InboxItem[]> {
  switch (event.type) {
    case 'inbox-changed':
      return 'reload'
    case 'comment-posted':
    case 'comment-updated':
      return event.comment.kind === 'note' ? undefined : 'reload'
    case 'task-deleted': {
      const { taskId } = event
      return (items) =>
        items.some((item) => item.task.id === taskId)
          ? items.filter((item) => item.task.id !== taskId)
          : items
    }
    case 'task-updated': {
      const { task } = event
      const has = (item: InboxItem) => item.task.id === task.id
      if (list === 'answered' && !task.archived && !shown.some(has)) return unarchivedEveryMs
      return (items) =>
        !items.some(has)
          ? items
          : task.archived
            ? items.filter((item) => !has(item))
            : items.map((item) => (has(item) ? { ...item, task } : item))
    }
    default:
      return undefined
  }
}
