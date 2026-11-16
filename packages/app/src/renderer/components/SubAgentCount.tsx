import type { Task } from '@ted/protocol'
import { activeSubAgentCount, activeSubAgentLabel } from '../sub-agents.ts'
import styles from './SubAgentCount.module.css'
import { TaskStatusChips } from './TaskStatus.tsx'

export function TaskStatusWithSubAgents({
  task,
  onOpenTask,
  subAgents = true,
}: {
  task: Pick<Task, 'runs' | 'status' | 'markers'>
  onOpenTask: (ref: string) => void
  subAgents?: boolean
}) {
  const count = subAgents ? activeSubAgentCount(task.runs) : 0
  if (!task.status && task.markers.length === 0 && count === 0) return null
  return (
    <span className={styles.status}>
      <TaskStatusChips task={task} onOpenTask={onOpenTask} />
      <SubAgentCount count={count} />
    </span>
  )
}

function SubAgentCount({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span
      className={styles.count}
      title={`${activeSubAgentLabel(count)}. Started sub-agent Runs that haven’t finished, including idle, waiting and paused Runs.`}
    >
      {count} {count === 1 ? 'Sub-Agent' : 'Sub-Agents'}
    </span>
  )
}

export function SubAgentTotal({
  tasks,
  filtered,
}: {
  tasks: readonly Pick<Task, 'runs'>[]
  filtered: boolean
}) {
  const count = tasks.reduce((total, task) => total + activeSubAgentCount(task.runs), 0)
  return (
    <span title="Active sub-agents on Tasks matching this View’s scope, filters and search. Includes idle, waiting and paused Runs; excludes Task Leads, queued requests and finished Runs.">
      {activeSubAgentLabel(count)}
      {filtered ? ' in results' : ''}
    </span>
  )
}
