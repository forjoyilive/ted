import type { Attachment, CommentBox as BoxState, Task } from '@ted/protocol'
import { type ClipboardEvent, type DragEvent, useRef, useState } from 'react'
import { formatSize } from '../task-fields.ts'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import styles from './CommentBox.module.css'
import { Help } from './Help.tsx'
import { CloseIcon, PaperclipIcon } from './icons.tsx'

const maxAttachmentBytes = 25 * 1024 * 1024

const notes: Partial<Record<BoxState, string>> = {
  paused: 'The Task Lead reads this when it continues.',
  'no-run': 'The Task Lead gets this with the brief when the Task starts.',
  stopped: 'Send keeps the Task stopped; the next Task Lead Run gets your Comment with the brief.',
  done: 'This Task is done and nothing runs on it. Comment only keeps this in the thread; Follow up creates a new Task from its brief with this text.',
}

const placeholders: Partial<Record<BoxState, string>> = {
  'no-run': 'Comment…',
  done: 'Comment…',
}

export function CommentBox({
  task,
  onFollowedUp,
}: {
  task: Task
  onFollowedUp?: (followUp: Task) => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const state = task.commentBox
  const typed = text.trim() !== ''
  const ready = (typed || files.length > 0) && uploading === 0
  const note = notes[state]

  const resumes = state === 'stopped'
  const done = state === 'done'
  const cancels = state === 'merge-pending'

  if (state === 'archived') {
    return (
      <p className={styles.readOnly} data-state={state}>
        Archived Tasks are read-only. Unarchive to comment.
      </p>
    )
  }

  async function attach(picked: readonly File[]) {
    const tooBig = picked.find((file) => file.size > maxAttachmentBytes)
    if (tooBig) {
      setError(`${tooBig.name} is over 25 MB.`)
      return
    }
    setError(undefined)
    setUploading((n) => n + picked.length)
    for (const file of picked) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const name = file.name || `pasted.${file.type.split('/')[1] ?? 'bin'}`
        const added = await ted.uploadAttachment({ name, mediaType: file.type }, bytes)
        setFiles((current) =>
          current.some((a) => a.hash === added.hash && a.name === added.name)
            ? current
            : [...current, added],
        )
      } catch (failure) {
        setError(`Couldn’t attach ${file.name}: ${readableError(failure)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    void attach([...event.dataTransfer.files])
  }

  function onPaste(event: ClipboardEvent) {
    const pasted = [...event.clipboardData.files]
    if (pasted.length === 0) return
    event.preventDefault()
    void attach(pasted)
  }

  async function send(then?: 'resume' | 'follow-up') {
    if (!ready || sending || (cancels && !typed)) return
    setSending(true)
    setError(undefined)
    const refs = files.map(({ hash, name, mediaType }) => ({ hash, name, mediaType }))
    try {
      if (then === 'resume') await ted.resumeTask(task.id, text, refs)
      else if (then === 'follow-up') {
        const created = await ted.followUpTask(task.id, text, refs)
        onFollowedUp?.(created)
      } else if (cancels) await ted.cancelMerge(task.id, text, refs)
      else await ted.postComment(task.id, text, refs)
      setText('')
      setFiles([])
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <fieldset
      className={styles.composer}
      data-state={state}
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {cancels && (
        <p className={styles.mergeNote}>
          The merge is pending. Sending a Comment now cancels it and counts as Request changes.
        </p>
      )}
      <textarea
        className={styles.box}
        aria-label="Comment"
        placeholder={placeholders[state] ?? 'Comment to the Task Lead…'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          void send(resumes ? 'resume' : done ? 'follow-up' : undefined)
        }}
      />
      {(files.length > 0 || uploading > 0) && (
        <ul className={styles.files} aria-label="Attached files">
          {files.map((a) => (
            <li key={`${a.hash}:${a.name}`} className={styles.chip}>
              {a.name}
              <span className={styles.chipMeta}>{formatSize(a.size)}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove ${a.name}`}
                onClick={() => setFiles((current) => current.filter((c) => c !== a))}
              >
                <CloseIcon size={11} />
              </button>
            </li>
          ))}
          {uploading > 0 && <li className={styles.chipMeta}>Attaching…</li>}
        </ul>
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.attach}
          aria-label="Attach files"
          title="Attach files — or drop or paste them into the box"
          onClick={() => fileInput.current?.click()}
        >
          <PaperclipIcon />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Choose files to attach"
          onChange={(event) => {
            void attach([...(event.target.files ?? [])])
            event.target.value = ''
          }}
        />
        <span className={styles.spacer} />
        {note !== undefined && <Help>{note}</Help>}
        <Button
          variant={cancels ? 'danger' : resumes || done ? 'secondary' : 'primary'}
          disabled={sending || !ready || (cancels && !typed)}
          onClick={() => void send()}
        >
          {done ? 'Comment only' : cancels ? 'Send and cancel merge' : 'Send'}
        </Button>
        {resumes && (
          <Button
            variant="primary"
            disabled={sending || !ready}
            onClick={() => void send('resume')}
          >
            Send and resume
          </Button>
        )}
        {done && (
          <Button
            variant="primary"
            disabled={sending || !ready}
            onClick={() => void send('follow-up')}
          >
            Follow up
          </Button>
        )}
      </div>
    </fieldset>
  )
}
