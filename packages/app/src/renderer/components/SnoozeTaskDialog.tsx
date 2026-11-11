import type { Task } from '@ted/protocol'
import { dateTimeFields, dateTimeInZone, effectiveTimeZone } from '@ted/protocol/time'
import { useId, useState } from 'react'
import { useSettings } from '../data.ts'
import { readableError, ted } from '../ted.ts'
import { formatDate, timePreferences } from '../time.ts'
import { Dialog } from './ArchiveDialogs.tsx'
import { Button } from './Button.tsx'
import { ScheduleTime } from './ScheduleTime.tsx'
import styles from './SnoozeTaskDialog.module.css'

export const snoozeTaskEvent = 'ted:snooze-task'

export function SnoozeTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const settings = useSettings()
  const zone = effectiveTimeZone(settings ?? timePreferences())
  const [initial] = useState(() => {
    if (task.snoozedUntil) return dateTimeFields(new Date(task.snoozedUntil), zone)
    const today = dateTimeFields(new Date(), zone).date
    const tomorrow = new Date(`${today}T12:00:00Z`)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    return { date: tomorrow.toISOString().slice(0, 10), time: '09:00' }
  })
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const id = useId()
  let instant: string | undefined
  let invalid: string | undefined
  try {
    instant = dateTimeInZone(date, time, zone)
  } catch (failure) {
    invalid = readableError(failure)
  }
  const save = async () => {
    if (!instant || Date.parse(instant) <= Date.now()) {
      setError(invalid ?? 'Choose a future date and time')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await ted.setTaskSnooze(task.id, instant)
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
            {task.snoozedUntil ? 'Change snooze' : 'Snooze Task'}
          </h2>
          <p className={styles.note}>Keep this Task in Backlog until:</p>
          <label className={styles.label} htmlFor={id}>
            Date
          </label>
          <input
            className={styles.date}
            id={id}
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value)
              setError(undefined)
            }}
            autoFocus
          />
          <div className={styles.label}>Time</div>
          <div className={styles.time}>
            <ScheduleTime
              value={time}
              onChange={(value) => {
                setTime(value)
                setError(undefined)
              }}
            />
          </div>
          <p className={styles.note}>Time zone: {zone} · App-wide in General settings</p>
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
              {busy ? 'Saving…' : task.snoozedUntil ? 'Save snooze' : 'Snooze Task'}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
