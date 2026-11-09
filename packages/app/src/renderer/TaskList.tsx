import type { Task } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { ted } from './ted.ts'

function merge(current: Task[], incoming: Task[]): Task[] {
  const byId = new Map(current.map((task) => [task.id, task]))
  for (const task of incoming) byId.set(task.id, task)
  return [...byId.values()].sort((a, b) => a.number - b.number)
}

export function TaskList() {
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    const add = (incoming: Task[]) => setTasks((current) => merge(current, incoming))
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'task-created') add([event.task])
    })
    void ted.listTasks().then(add)
    return unsubscribe
  }, [])

  if (tasks.length === 0) return <p>No Tasks yet.</p>
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task.id}>
          {task.displayId} {task.title}
        </li>
      ))}
    </ul>
  )
}
