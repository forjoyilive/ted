import type { Task } from '@ted/protocol'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { CloseIcon } from '../components/icons.tsx'
import { readableError, ted } from '../ted.ts'
import styles from './NewTaskDialog.module.css'

export const editTaskEvent = 'ted:edit-task'

function hasLiveRun(task: Task): boolean {
  return task.commentBox === 'live' || task.commentBox === 'paused'
}

export function EditTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const headingId = useId()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    dialog.current?.showModal()
    const field = descriptionField.current
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  }, [])

  const changed = title.trim() !== task.title || description.trim() !== task.description
  const canSave = !busy && title.trim() !== '' && changed

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(undefined)
    try {
      await ted.editTask(task.id, {
        ...(title.trim() !== task.title && { title }),
        ...(description.trim() !== task.description && { description }),
      })
      onClose()
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }

  const note = hasLiveRun(task)
    ? 'The Task Lead gets the change as a Comment with the diff.'
    : 'The Task Lead reads the new version when its next Run starts.'

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <h2 id={headingId} className={styles.heading}>
          Edit {task.displayId}
        </h2>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <input
        className={styles.title}
        aria-label="Title"
        placeholder="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className={styles.descriptionBox}>
        <textarea
          ref={descriptionField}
          className={styles.description}
          aria-label="Description"
          placeholder="Describe what you want done."
          rows={6}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <footer className={styles.footer}>
        <span className={styles.note}>Each edit keeps the earlier versions. {note}</span>
        <span className={styles.spacer} />
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          shortcut="⌘↵"
          aria-keyshortcuts="Meta+Enter"
          disabled={!canSave}
          onClick={() => void save()}
        >
          Save
        </Button>
      </footer>
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </dialog>
  )
}
