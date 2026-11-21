import type { PhoneTaskAction, Task } from '@ted/protocol'
import { statusActionKind } from '@ted/protocol/task-actions'

export function phoneTaskActions(task: Task): PhoneTaskAction[] {
  if (task.archived) return []
  const kind = statusActionKind(task)
  const status: PhoneTaskAction[] =
    kind === 'start' || kind === 'stop'
      ? [kind]
      : kind === 'resume' || kind === 'retry'
        ? ['resume']
        : []
  const comment: PhoneTaskAction[] = task.commentBox === 'merge-pending' ? [] : ['comment']
  return [...status, 'priority', ...comment, 'archive', 'delete']
}
