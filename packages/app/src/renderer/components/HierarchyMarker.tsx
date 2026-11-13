import type { Task } from '@ted/protocol'
import { childProgress, parentOf, progressText } from '../hierarchy.ts'
import styles from './HierarchyMarker.module.css'

export function HierarchyMarker({
  task,
  tasks,
  showParent = true,
}: {
  task: Task
  tasks: readonly Task[]
  showParent?: boolean
}) {
  const parent = showParent ? parentOf(task, tasks) : undefined
  const progress = (task.childIds?.length ?? 0) > 0 ? childProgress(task, tasks) : undefined
  const counted = progress !== undefined && progress.total > 0 ? progress : undefined
  if (!parent && !counted) return null
  return (
    <span className={styles.markers}>
      {parent && (
        <span className={styles.marker} data-parent-marker title={`Child of ${parent.displayId}`}>
          ↑ {parent.displayId}
        </span>
      )}
      {counted && (
        <span className={styles.marker} data-child-progress>
          {progressText(counted)}
        </span>
      )}
    </span>
  )
}
