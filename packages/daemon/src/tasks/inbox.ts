import type { Comment, CommentAnswer, InboxItem, Task } from '@ted/protocol'
import { priorities } from '@ted/protocol'

export const answeredDays = 30

const byHuman: ReadonlySet<CommentAnswer['kind']> = new Set([
  'answered',
  'approved',
  'changes-requested',
  'denied',
])

function withTasks(requests: readonly Comment[], tasks: readonly Task[]): InboxItem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return requests.flatMap((request) => {
    const task = byId.get(request.taskId)
    return task && !task.archived ? [{ request, task }] : []
  })
}

export function waiting(requests: readonly Comment[], tasks: readonly Task[]): InboxItem[] {
  const rank = (task: Task) => priorities.indexOf(task.priority)
  return withTasks(
    requests.filter((r) => r.kind !== 'note' && r.answer === undefined),
    tasks,
  ).sort(
    (a, b) => rank(a.task) - rank(b.task) || a.request.createdAt.localeCompare(b.request.createdAt),
  )
}

export function answered(
  requests: readonly Comment[],
  tasks: readonly Task[],
  now: Date,
): InboxItem[] {
  const since = new Date(now.getTime() - answeredDays * 24 * 60 * 60 * 1000).toISOString()
  const at = (item: InboxItem) => item.request.answer?.at ?? ''
  return withTasks(
    requests.filter(
      (r) =>
        r.kind !== 'note' &&
        r.answer !== undefined &&
        byHuman.has(r.answer.kind) &&
        r.answer.at >= since,
    ),
    tasks,
  ).sort((a, b) => at(b).localeCompare(at(a)))
}
