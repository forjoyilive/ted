import type { Task } from '@ted/protocol'
import { useState } from 'react'
import { readableError, ted } from '../ted.ts'
import { formatDate } from '../time.ts'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import styles from './SnoozeTaskDialog.module.css'
import { SnoozeTimeFields, useSnoozeTime } from './SnoozeTimeFields.tsx'

export const snoozeTaskEvent = 'ted:snooze-task'

export function SnoozeTaskDialog({
  task,
  tasks = [task],
  onClose,
}: {
  task: Task
  tasks?: readonly Task[]
  onClose: () => void
}) {
  const when = useSnoozeTime(task.snoozedUntil)
  const { instant, invalid } = when
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const save = async () => {
    if (!instant || Date.parse(instant) <= Date.now()) {
      setError(invalid ?? 'Choose a future date and time')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      for (const target of tasks) {
        try {
          await ted.setTaskSnooze(target.id, instant)
        } catch (failure) {
          if (tasks.length > 1)
            throw new Error(
              `${target.displayId}: ${readableError(failure)} Some selected Tasks may already be snoozed.`,
            )
          throw failure
        }
      }
      onClose()
    } catch (failure) {
      setError(readableError(failure))
      setBusy(false)
    }
  }
  return (
    <Dialog onClose={onClose}>
      {(heading) => (
        <>
          <h2 id={heading} className={styles.heading}>
            {tasks.length > 1
              ? `Snooze ${tasks.length} Tasks`
              : task.snoozedUntil
                ? 'Change snooze'
                : 'Snooze Task'}
          </h2>
          <p className={styles.note}>
            {tasks.length > 1
              ? `Keep ${tasks.length} Tasks in Backlog until:`
              : 'Keep this Task in Backlog until:'}
          </p>
          <SnoozeTimeFields value={when} onEdit={() => setError(undefined)} />
          {instant && (
            <p className={styles.note}>
              Starts{' '}
              {formatDate(instant, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'shortOffset',
              })}
            </p>
          )}
          <p className={styles.note}>
            TED starts it automatically when due, even if automatic Backlog starts are off. It waits
            for blockers and a free slot. If TED is quit, it starts when TED next runs.
          </p>
          {(error ?? invalid) && (
            <p className={styles.error} role="alert">
              {error ?? invalid}
            </p>
          )}
          <div className={styles.footer}>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !instant}>
              {busy
                ? 'Saving…'
                : tasks.length > 1
                  ? `Snooze ${tasks.length} Tasks`
                  : task.snoozedUntil
                    ? 'Save snooze'
                    : 'Snooze Task'}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
