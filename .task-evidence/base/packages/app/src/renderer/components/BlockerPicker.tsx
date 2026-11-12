import type { Task } from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
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
  onAdd: (id: string) => void
  onRemove: (id: string) => void
}) {
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
    onAdd(task.id)
    setQuery('')
    setSearching(false)
  }

  return (
    <div className={styles.blockers}>
      {blockers.map((task) => (
        <span key={task.id} className={styles.blocker}>
          <span className={styles.blockerId}>{task.displayId}</span>
          <span className={styles.blockerTitle}>{task.title}</span>
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove ${task.displayId}`}
            onClick={() => onRemove(task.id)}
          >
            <CloseIcon size={11} />
          </button>
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
              <button
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
              </button>
            ))}
          </div>
        </span>
      ) : (
        <Button size="small" onClick={() => setSearching(true)}>
          <PlusIcon />
          {addLabel ?? (blockers.length === 0 ? 'Add blocker' : 'Add')}
        </Button>
      )}
    </div>
  )
}
