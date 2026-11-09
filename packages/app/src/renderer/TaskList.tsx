import type { Comment, Task } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { CodeSection } from './CodeSection.tsx'
import { ted } from './ted.ts'

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()]
}

const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

export function TaskList() {
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    const add = (incoming: Task[]) =>
      setTasks((current) =>
        mergeById(current, incoming).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      )
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'task-created' || event.type === 'task-updated') add([event.task])
    })
    void ted.listTasks().then(add)
    return unsubscribe
  }, [])

  if (tasks.length === 0) return <p>No Tasks yet.</p>
  return (
    <ul>
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} />
      ))}
    </ul>
  )
}

function TaskItem({ task }: { task: Task }) {
  const [comments, setComments] = useState<Comment[]>([])

  useEffect(() => {
    const add = (incoming: Comment[]) =>
      setComments((current) =>
        mergeById(current, incoming).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      )
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'comment-posted' && event.comment.taskId === task.id) add([event.comment])
    })
    void ted.listComments(task.id).then(add)
    return unsubscribe
  }, [task.id])

  return (
    <li>
      <strong>
        {task.displayId} {task.title}
      </strong>{' '}
      <span>{stageName(task.stage)}</span>
      <CodeSection task={task} />
      {comments.length > 0 && (
        <ul>
          {comments.map((comment) => (
            <li key={comment.id}>{comment.body}</li>
          ))}
        </ul>
      )}
    </li>
  )
}
