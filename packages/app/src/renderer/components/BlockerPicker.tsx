import type { Task } from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { usePendingAction } from '../pending-action.ts'
import { ActionButton } from './ActionButton.tsx'
import styles from './BlockerPicker.module.css'
import { Button } from './Button.tsx'
import { CloseIcon, PlusIcon } from './icons.tsx'

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
  const [query, setQuery] = useState('')
  const searchField = useRef<HTMLInputElement>(null)
  const search = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!searching) return
    const onPointerDown = (event: PointerEvent) => {
      if (!search.current?.contains(event.target as Node)) setSearching(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [searching])

  useEffect(() => {
    if (searching) searchField.current?.focus()
  }, [searching])
  useEffect(() => {
    if (searchRequest > 0) {
      setSearching(true)
      searchField.current?.focus()
    }
  }, [searchRequest])
  const listId = useId()
  const needle = query.trim().toLowerCase()
  const matches = tasks
    .filter((t) => t.stage !== 'done' && !blockers.includes(t))
    .filter(
      (t) =>
        needle === '' ||
        t.displayId.toLowerCase().includes(needle) ||
        t.title.toLowerCase().includes(needle),
    )
    .slice(0, 8)

  function choose(task: Task) {
    const done = () => {
      setQuery('')
      setSearching(false)
    }
    const result = activity.run(() => onAdd(task.id))
    if (result) return result.then(done)
    done()
  }

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
        <span className={styles.search} ref={search}>
          <input
            className={styles.searchInput}
            aria-label="Find a Task"
            placeholder="Find a Task"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            ref={searchField}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setSearching(false)
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
            {matches.length === 0 && <p className={styles.noMatch}>No matching Tasks</p>}
            {matches.map((task) => (
              <ActionButton
                key={task.id}
                type="button"
                role="option"
                data-nav-item
                aria-selected={false}
                className={styles.option}
                onClick={() => choose(task)}
              >
                <span className={styles.blockerId}>{task.displayId}</span>
                <span className={styles.blockerTitle}>{task.title}</span>
              </ActionButton>
            ))}
          </div>
        </span>
      ) : (
        <Button onClick={() => setSearching(true)}>
          <PlusIcon />
          {addLabel ?? (blockers.length === 0 ? 'Add blocker' : 'Add')}
        </Button>
      )}
    </div>
  )
}
