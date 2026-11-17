import { useState } from 'react'
import { useSettings, useTedStops } from '../data.ts'
import { reportingHelp, reportingLabel } from '../reporting.ts'
import { readableError, ted } from '../ted.ts'
import styles from './ArchiveDialogs.module.css'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'

export function ReportingDialog() {
  const settings = useSettings()
  const stops = useTedStops()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!settings?.firstLaunchDone || settings.reportingAsked || stops.length > 0) return null

  const answer = (reporting: boolean) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    ted
      .updateSettings({ reporting, reportingAsked: true })
      .catch((failure) => setError(readableError(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <Dialog onClose={() => answer(false)}>
      {(headingId) => (
        <>
          <h2 id={headingId} className={styles.heading}>
            {`${reportingLabel}?`}
          </h2>
          <p className={styles.body}>{reportingHelp}</p>
          <p className={styles.body}>You can change this any time in Settings → General.</p>
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.buttons}>
            <Button disabled={busy} onClick={() => answer(false)}>
              Don’t send
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => answer(true)}>
              Send reports
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
