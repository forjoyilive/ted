import type { CommentBox as BoxState, RunSummary, Task } from '@ted/protocol'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { sendOnEnter } from '../composer-keys.ts'
import { useMessageDraft } from '../message-drafts.ts'
import { readableError, ted } from '../ted.ts'
import { AttachButton, useAttachFiles } from './AttachFiles.tsx'
import { AttachmentTiles } from './AttachmentTiles.tsx'
import { Button } from './Button.tsx'
import styles from './CommentBox.module.css'
import { Help } from './Help.tsx'
import { StopIcon } from './icons.tsx'
import grow from './TextGrow.module.css'

const notes: Partial<Record<BoxState, string>> = {
  paused: 'The Task Lead reads this when it continues.',
  'no-run': 'The Task Lead gets this with the brief when the Task starts.',
  stopped: 'Send keeps the Task stopped; the next Task Lead Run gets your comment with the brief.',
  done: 'This Task is Done and nothing runs on it. Comment only keeps this in the thread; Follow-up creates a new Task from its brief with this text.',
}

const placeholders: Partial<Record<BoxState, string>> = {
  'no-run': 'Comment…',
  done: 'Comment…',
}

export function CommentBox({
  task,
  onFollowedUp,
  run,
  hasLineComments = false,
  dropInto,
}: {
  task: Task
  run?: RunSummary | undefined
  hasLineComments?: boolean
  onFollowedUp?: (followUp: Task) => void
  dropInto?: RefObject<(() => ((files: File[]) => unknown) | undefined) | undefined>
}) {
  const state = task.commentBox
  const draft = useMessageDraft(state === 'archived' ? undefined : { kind: 'comment', id: task.id })
  const { text, setText, attachments: files, setAttachments: setFiles } = draft
  const [sending, setSending] = useState(false)
  const [submission, setSubmission] = useState<'comment' | 'resume' | 'follow-up' | 'interrupt'>()
  const submitting = useRef(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()
  const { uploading, attach, onPaste } = useAttachFiles({ setFiles, setError })
  const composer = useRef<HTMLFieldSetElement>(null)
  const direct =
    state === 'live' &&
    run !== undefined &&
    run.id === task.leadRunId &&
    run.current &&
    run.state !== 'finished'
  const working = direct && run?.state === 'working'
  const typed = text.trim() !== ''
  const ready = (typed || files.length > 0) && uploading === 0
  const note = task.canResume
    ? undefined
    : task.wakesOnComment
      ? 'Send starts the Task Lead, and it gets this with the brief.'
      : notes[state]

  const resumes = state === 'stopped'
  const done = state === 'done'
  const cancels = state === 'merge-pending'

  useEffect(() => {
    if (!dropInto || state === 'archived') return
    dropInto.current = () => (composer.current?.closest('[hidden]') ? undefined : attach)
    return () => {
      dropInto.current = undefined
    }
  })

  if (state === 'archived') {
    return (
      <p className={styles.readOnly} data-state={state}>
        Archived Tasks are read-only. Unarchive to comment.
      </p>
    )
  }

  async function send(then?: 'resume' | 'follow-up', interrupting = false) {
    if (!ready || submitting.current || (cancels && !typed)) return
    submitting.current = true
    setSubmission(interrupting ? 'interrupt' : (then ?? 'comment'))
    setSending(true)
    setError(undefined)
    const refs = files.map(({ hash, name, mediaType }) => ({ hash, name, mediaType }))
    try {
      if (then === 'resume') await ted.resumeTask(task.id, text, refs)
      else if (then === 'follow-up') {
        const created = await ted.followUpTask(task.id, text, refs)
        onFollowedUp?.(created)
      } else if (cancels) await ted.cancelMerge(task.id, text, refs)
      else if (direct && run && refs.length === 0 && !hasLineComments) {
        await ted.sendRunMessage(run.id, text, { interrupt: interrupting && working })
      } else {
        await ted.postComment(task.id, { body: text, attachments: refs })
      }
      draft.clear()
      if (direct && run && (refs.length > 0 || hasLineComments) && interrupting && working) {
        try {
          await ted.interruptRun(run.id)
        } catch (failed) {
          setError(`Message sent, but couldn’t interrupt: ${readableError(failed)}`)
        }
      }
    } catch (failed) {
      setError(readableError(failed))
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  return (
    <fieldset ref={composer} className={styles.composer} data-state={state}>
      {cancels && (
        <p className={styles.mergeNote}>
          The merge is pending. Posting a comment cancels Ted’s merge and counts as Request changes.
          If you then merge the pull request on GitHub, Ted still moves the Task to Done.
          {task.mergeHeld !== undefined && (
            <span className={styles.mergeHeld} data-merge-held>
              {task.mergeHeld}
            </span>
          )}
        </p>
      )}
      {task.canResume && (
        <p className={styles.resumeNote}>
          Resume starts a fresh Task Lead Run from the brief and comments when a slot is free.
        </p>
      )}
      <textarea
        className={`${styles.box} ${grow.text}`}
        data-comment-box
        aria-label={direct ? 'Message the Task Lead' : 'Comment'}
        placeholder={
          direct ? 'Message the Task Lead…' : (placeholders[state] ?? 'Comment to the Task Lead…')
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={onPaste}
        onKeyDown={sendOnEnter(
          (command) => send(resumes ? 'resume' : done ? 'follow-up' : undefined, command),
          (typedText) => typedText.trim() !== '' || (files.length > 0 && !cancels),
        )}
      />
      {(files.length > 0 || uploading > 0) && (
        <div className={styles.files}>
          <AttachmentTiles
            files={files}
            uploading={uploading > 0}
            onRemove={(a) => setFiles((current) => current.filter((c) => c !== a))}
          />
        </div>
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <AttachButton pending={uploading > 0} onPick={attach} />
        <span className={styles.spacer} />
        {direct && run && (
          <Button
            aria-label="Stop the turn"
            disabled={stopping || !working}
            onClick={async () => {
              setStopping(true)
              setError(undefined)
              try {
                await ted.interruptRun(run.id)
              } catch (failed) {
                setError(readableError(failed))
              } finally {
                setStopping(false)
              }
            }}
          >
            <StopIcon />
          </Button>
        )}
        {direct && (
          <Button
            shortcut="⌘↵"
            disabled={sending || !ready || !working}
            pending={sending && submission === 'interrupt'}
            onClick={() => send(undefined, true)}
          >
            Interrupt and send
          </Button>
        )}
        {note !== undefined && <Help>{note}</Help>}
        <Button
          variant={cancels ? 'danger' : resumes || done ? 'secondary' : 'primary'}
          disabled={sending || !ready || (cancels && !typed)}
          {...(!resumes && !done && { shortcut: '↵' })}
          pending={sending && submission === 'comment'}
          onClick={() => send()}
        >
          {done ? 'Comment only' : cancels ? 'Send and cancel merge' : 'Send'}
        </Button>
        {resumes && (
          <Button
            variant="primary"
            disabled={sending || !ready}
            shortcut="↵"
            pending={sending && submission === 'resume'}
            onClick={() => send('resume')}
          >
            Send and resume
          </Button>
        )}
        {done && (
          <Button
            variant="primary"
            disabled={sending || !ready}
            shortcut="↵"
            pending={sending && submission === 'follow-up'}
            onClick={() => send('follow-up')}
          >
            Follow-up
          </Button>
        )}
      </div>
    </fieldset>
  )
}
