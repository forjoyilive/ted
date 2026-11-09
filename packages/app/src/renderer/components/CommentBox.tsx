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
  const state = task.commentBox
  const typed = text.trim() !== ''
  const note = notes[state]

  const resumes = state === 'stopped'
  const done = state === 'done'

  if (state === 'archived') {
    return (
      <p className={styles.readOnly} data-state={state}>
        Archived Tasks are read-only. Unarchive to comment.
      </p>
    )
  }

  async function send(then?: 'resume' | 'follow-up') {
    if (!typed || sending) return
    setSending(true)
    setError(undefined)
    try {
      if (then === 'resume') await ted.resumeTask(task.id, text)
      else if (then === 'follow-up') {
        const created = await ted.followUpTask(task.id, text)
        onFollowedUp?.(created)
      } else await ted.postComment(task.id, text)
      setText('')
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.composer} data-state={state}>
      <textarea
        className={styles.box}
        aria-label="Comment"
        placeholder={placeholders[state] ?? 'Comment to the Task Lead…'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          void send(resumes ? 'resume' : done ? 'follow-up' : undefined)
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
          variant={resumes || done ? 'secondary' : 'primary'}
          disabled={sending || !typed}
          onClick={() => void send()}
        >
          {done ? 'Comment only' : 'Send'}
        </Button>
        {resumes && (
          <Button
            variant="primary"
            disabled={sending || !typed}
            onClick={() => void send('resume')}
          >
            Send and resume
          </Button>
        )}
        {done && (
          <Button
            variant="primary"
            disabled={sending || !typed}
            onClick={() => void send('follow-up')}
          >
            Follow up
          </Button>
        )}
      </div>
    </div>
  )
}
