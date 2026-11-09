import type { CommentBox as BoxState, Task } from '@ted/protocol'
import { useState } from 'react'
import { readableError, ted } from '../ted.ts'
import { Button } from './Button.tsx'
import styles from './CommentBox.module.css'
import { Help } from './Help.tsx'

const notes: Partial<Record<BoxState, string>> = {
  paused: 'The Task Lead reads this when it continues.',
  'no-run': 'The Task Lead gets this with the brief when the Task starts.',
  stopped: 'Send keeps the Task stopped; the next Task Lead Run gets your Comment with the brief.',
  done: 'The Task is done, so no Run reads this. It stays in the thread.',
}

const placeholders: Partial<Record<BoxState, string>> = {
  'no-run': 'Comment…',
  done: 'Comment…',
}

export function CommentBox({ task }: { task: Task }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const state = task.commentBox
  const typed = text.trim() !== ''
  const note = notes[state]

  const resumes = state === 'stopped'
  const cancels = state === 'merge-pending'

  async function send(andResume = false) {
    if (!typed || sending) return
    setSending(true)
    setError(undefined)
    try {
      if (andResume) await ted.resumeTask(task.id, text)
      else if (cancels) await ted.cancelMerge(task.id, text)
      else await ted.postComment(task.id, text)
      setText('')
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.composer} data-state={state}>
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
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          void send(resumes)
        }}
      />
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        {note !== undefined && <Help>{note}</Help>}
        <Button
          variant={cancels ? 'danger' : resumes ? 'secondary' : 'primary'}
          disabled={sending || !typed}
          onClick={() => void send()}
        >
          {state === 'done' ? 'Comment only' : cancels ? 'Send and cancel merge' : 'Send'}
        </Button>
        {resumes && (
          <Button variant="primary" disabled={sending || !typed} onClick={() => void send(true)}>
            Send and resume
          </Button>
        )}
      </div>
    </div>
  )
}
