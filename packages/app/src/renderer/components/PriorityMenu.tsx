import type { Priority, Task } from '@ted/protocol'
import { ted } from '../ted.ts'
import { buttonPosition, type MenuAction, useActionMenu } from './ContextMenu.tsx'
import { PriorityIcon } from './PriorityIcon.tsx'
import styles from './PriorityMenu.module.css'

export const priorityMenuOrder: readonly Priority[] = ['none', 'urgent', 'high', 'medium', 'low']

const names: Record<Priority, string> = {
  none: 'No priority',
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export function priorityMenuItems(task: Task): MenuAction[] {
  return priorityMenuOrder.map((priority, index) => ({
    label: names[priority],
    icon: <PriorityIcon priority={priority} />,
    checked: task.priority === priority,
    shortcut: String(index),
    action: () => (task.priority === priority ? undefined : ted.setPriority(task.id, priority)),
  }))
}

export function PriorityButton({ task }: { task: Task }) {
  const actions = useActionMenu(`priority:${task.id}`)
  if (task.archived) return <PriorityIcon priority={task.priority} />
  return (
    <>
      <button
        type="button"
        className={styles.button}
        aria-haspopup="menu"
        aria-expanded={actions.isOpen}
        aria-label={`Priority: ${names[task.priority]}. Change priority of ${task.displayId}`}
        title="Change priority"
        draggable={false}
        onClick={(event) => {
          event.stopPropagation()
          actions.open(buttonPosition(event.currentTarget), 'Priority', priorityMenuItems(task))
        }}
      >
        <PriorityIcon priority={task.priority} />
      </button>
      {actions.menu}
    </>
  )
}
