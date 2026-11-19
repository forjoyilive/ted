import type { Task } from '@ted/protocol'
import {
  activeSubAgentCount,
  activeSubAgentLabel,
  subAgentsRunningLabel,
  subAgentWorking,
} from '../sub-agents.ts'
import { SubAgentsIcon } from './icons.tsx'
import { statusChipClass } from './StatusChip.tsx'
import styles from './SubAgentCount.module.css'
import { TaskStatusChips } from './TaskStatus.tsx'

export function TaskStatusWithSubAgents({
  task,
  onOpenTask,
  subAgents = true,
  startsAutomatically = false,
}: {
  task: Pick<Task, 'runs' | 'status' | 'markers'>
  onOpenTask: (ref: string) => void
  subAgents?: boolean
  startsAutomatically?: boolean
}) {
  const count = subAgents ? activeSubAgentCount(task.runs) : 0
  if (!task.status && task.markers.length === 0 && count === 0 && !startsAutomatically) return null
  return (
    <span className={styles.status}>
      <TaskStatusChips
        task={task}
        onOpenTask={onOpenTask}
        startsAutomatically={startsAutomatically}
      />
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
      className={statusChipClass(working ? 'working' : 'neutral')}
    >
      <SubAgentsIcon className={styles.icon} />
      <span className={styles.count}>{count}</span>
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
