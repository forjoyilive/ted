import type { Task } from '@ted/protocol'
import { useCallback, useEffect, useState } from 'react'
import { usePendingAction } from '../pending-action.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './BlockerPicker.module.css'
import { Button } from './Button.tsx'
import { CloseIcon, PlusIcon } from './icons.tsx'
import { TaskPicker } from './TaskPicker.tsx'

export function BlockerPicker({
  tasks,
  blockers,
  onAdd,
  onRemove,
  menuAlign = 'start',
  searchRequest = 0,
  addLabel,
}: {
  addLabel?: string | undefined
  menuAlign?: 'start' | 'end'
  searchRequest?: number
  tasks: readonly Task[]
  blockers: readonly Task[]
  onAdd: (id: string) => unknown
  onRemove: (id: string) => void
}) {
  const activity = usePendingAction()
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    if (searchRequest > 0) setSearching(true)
  }, [searchRequest])
  const close = useCallback(() => setSearching(false), [])
  const choices = tasks.filter((t) => t.stage !== 'done' && !blockers.includes(t))

  return (
    <div className={styles.blockers}>
      {blockers.map((task) => (
        <span key={task.id} className={styles.blocker}>
          <span className={styles.blockerId}>{task.displayId}</span>
          <span className={styles.blockerTitle}>{task.title}</span>
          <ActionButton
            type="button"
            className={styles.remove}
            disabled={activity.pending}
            aria-label={`Remove ${task.displayId}`}
            onClick={() => onRemove(task.id)}
          >
            <CloseIcon size={11} />
          </ActionButton>
        </span>
      ))}
      {searching ? (
        <TaskPicker
          tasks={choices}
          menuAlign={menuAlign}
          onChoose={(task) => {
            const result = activity.run(() => onAdd(task.id))
            return result ? result.then(close) : close()
          }}
          onClose={close}
        />
      ) : (
        <Button onClick={() => setSearching(true)}>
          <PlusIcon />
          {addLabel ?? (blockers.length === 0 ? 'Add blocker…' : 'Add…')}
        </Button>
      )}
    </div>
  )
}
