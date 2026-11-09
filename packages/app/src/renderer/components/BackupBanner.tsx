import { useState } from 'react'
import { useDailyBackupFailure } from '../data.ts'
import styles from './BackupBanner.module.css'

const dismissForMs = 24 * 60 * 60 * 1000

export function BackupBanner({ onOpen }: { onOpen: () => void }) {
  const failure = useDailyBackupFailure()
  const [dismissedAt, setDismissedAt] = useState<number>()

  if (!failure) return null
  if (dismissedAt !== undefined && Date.now() - dismissedAt < dismissForMs) return null

  return (
    <div className={styles.banner} role="status">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.text}>Today’s backup failed: {failure.reason}</span>
      <button type="button" className={styles.action} onClick={onOpen}>
        Open
      </button>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss for 24 hours"
        onClick={() => setDismissedAt(Date.now())}
      >
        ×
      </button>
    </div>
  )
}
