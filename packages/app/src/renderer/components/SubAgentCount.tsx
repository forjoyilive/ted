import type { Task } from '@ted/protocol'
import {
  activeSubAgentCount,
  activeSubAgentLabel,
  subAgentsRunningLabel,
  subAgentWorking,
} from '../sub-agents.ts'
import { SubAgentsIcon } from './icons.tsx'
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
      <SubAgentCount count={count} working={count > 0 && subAgentWorking(task.runs)} />
    </span>
  )
}

function SubAgentCount({ count, working }: { count: number; working: boolean }) {
  if (count === 0) return null
  const label = subAgentsRunningLabel(count)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-working={working}
      className={`${styles.count} ${working ? styles.working : ''}`}
    >
      <SubAgentsIcon className={styles.icon} />
      {count}
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
