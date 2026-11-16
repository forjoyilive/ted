import type { Task } from '@ted/protocol'
import { childProgress, parentOf } from '../hierarchy.ts'
import styles from './HierarchyMarker.module.css'
import { ProgressRing } from './ProgressRing.tsx'

export function HierarchyMarker({ task, tasks }: { task: Task; tasks: readonly Task[] }) {
  const parent = parentOf(task, tasks)
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
      {counted && <ProgressRing merged={counted.merged} total={counted.total} />}
    </span>
  )
}
