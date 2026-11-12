import type { Task } from '@ted/protocol'
import { useState } from 'react'
import { type SetupNotice, setupNoticeText } from '../setup-notice.ts'
import { readableError, ted } from '../ted.ts'
import styles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'

export function SetupNoticeDialog({
  task,
  notice,
  onStart,
  onCancel,
  onOpenTask,
}: {
  task: Task
  notice: SetupNotice
  onStart: () => void
  onCancel: () => void
  onOpenTask: (task: Task) => void
}) {
  const [error, setError] = useState<string>()
  return (
    <Dialog onClose={onCancel}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>
            {`Start ${task.displayId}?`}
          </h2>
          <p className={styles.body}>{setupNoticeText(notice)}</p>
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            {notice.kind === 'open' ? (
              <Button
                onClick={() => {
                  onCancel()
                  onOpenTask(notice.task)
                }}
              >
                Open setup Task
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setError(undefined)
                  ted.newSetupTask(task.factoryId).then(
                    (created) => {
                      onCancel()
                      onOpenTask(created)
                    },
                    (failure: unknown) => setError(readableError(failure)),
                  )
                }}
              >
                New setup Task
              </Button>
            )}
            <Button variant="primary" onClick={onStart}>
              Start anyway
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
