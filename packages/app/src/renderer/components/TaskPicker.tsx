import type { Task } from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { usePendingAction } from '../pending-action.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './BlockerPicker.module.css'

export function TaskPicker({
  tasks,
  label = 'Find a Task',
  note,
  error,
  menuAlign = 'start',
  onChoose,
  onClose,
}: {
  tasks: readonly Task[]
  label?: string
  note?: string | undefined
  error?: string | undefined
  menuAlign?: 'start' | 'end'
  onChoose: (task: Task) => unknown
  onClose: () => void
}) {
  const activity = usePendingAction()
  const [query, setQuery] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLSpanElement>(null)
  const listId = useId()

  useEffect(() => {
    field.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  const needle = query.trim().toLowerCase()
  const matches = tasks
    .filter(
      (t) =>
        needle === '' ||
        t.displayId.toLowerCase().includes(needle) ||
        t.title.toLowerCase().includes(needle),
    )
    .slice(0, 8)

  function choose(task: Task) {
    const result = activity.run(() => onChoose(task))
    if (result) return result.then(() => setQuery(''))
    setQuery('')
  }

  return (
    <span className={styles.search} ref={box}>
      <input
        className={styles.searchInput}
        aria-label={label}
        placeholder={label}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        ref={field}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            const [first] = matches
            if (first) choose(first)
          }
        }}
      />
      <div
        className={`${styles.options} ${menuAlign === 'end' ? styles.alignEnd : ''}`}
        id={listId}
        role="listbox"
        aria-label="Tasks"
      >
        {note !== undefined && <p className={styles.noMatch}>{note}</p>}
        {matches.length === 0 && <p className={styles.noMatch}>No matching Tasks</p>}
        {matches.map((task) => (
          <ActionButton
            key={task.id}
            type="button"
            role="option"
            data-nav-item
            aria-selected={false}
            disabled={activity.pending}
            className={styles.option}
            onClick={() => choose(task)}
          >
            <span className={styles.blockerId}>{task.displayId}</span>
            <span className={styles.blockerTitle}>{task.title}</span>
          </ActionButton>
        ))}
        {error !== undefined && (
          <p className={styles.pickError} role="alert">
            {error}
          </p>
        )}
      </div>
    </span>
  )
}
