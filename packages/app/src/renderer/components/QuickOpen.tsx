import type { TaskFileRef, TaskFiles } from '@ted/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { matchingFiles } from '../files.ts'
import { Button } from './Button.tsx'
import { FileListState } from './FilesSection.tsx'
import styles from './QuickOpen.module.css'

export function QuickOpen({
  files,
  error,
  onClose,
  onOpen,
  refresh,
}: {
  files: TaskFiles | undefined
  error: string | undefined
  onClose: () => void
  onOpen: (file: TaskFileRef) => void
  refresh: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const results = matchingFiles(files, query)
  const selected = Math.min(index, Math.max(0, results.length - 1))
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.showModal()
    input.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    void query
    dialog.current?.querySelector(`[id="${id}-${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, query, id])
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label="Quick open"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <input
        ref={input}
        className={styles.input}
        role="combobox"
        aria-label="File name or path"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={id}
        aria-activedescendant={results.length ? `${id}-${selected}` : undefined}
        value={query}
        placeholder="Find a file in this Task…"
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            setIndex(
              Math.max(
                0,
                Math.min(results.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)),
              ),
            )
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            const file = results[selected]
            if (file) onOpen(file)
          }
        }}
      />
      <div className={styles.body}>
        <FileListState files={files} error={error} />
        <div id={id} role="listbox" aria-label="Files">
          {results.map((file, i) => (
            <button
              type="button"
              role="option"
              id={`${id}-${i}`}
              key={`${file.repo}/${file.path}`}
              aria-selected={i === selected}
              className={styles.result}
              onClick={() => onOpen(file)}
            >
              <span>{file.path.split('/').at(-1)}</span>
              <span className={styles.path}>
                {file.repo} / {file.path}
              </span>
            </button>
          ))}
        </div>
        {files && !error && results.length === 0 && (
          <p className={styles.message}>
            {query ? 'No files match this name or path.' : 'No files to show.'}
          </p>
        )}
        {results.length === 200 && (
          <p className={styles.message}>
            Showing the first 200 matches. Type more to narrow the list.
          </p>
        )}
      </div>
      <footer className={styles.footer}>
        <span>↑ ↓ to choose · ↵ to open · Esc to close</span>
        <Button size="small" variant="quiet" onClick={refresh}>
          Refresh files
        </Button>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </footer>
    </dialog>
  )
}
