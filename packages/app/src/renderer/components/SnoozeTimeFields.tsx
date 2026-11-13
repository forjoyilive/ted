import { dateTimeFields, dateTimeInZone, effectiveTimeZone } from '@ted/protocol/time'
import { useId, useState } from 'react'
import { useSettings } from '../data.ts'
import { readableError } from '../ted.ts'
import { timePreferences } from '../time.ts'
import { ScheduleTime } from './ScheduleTime.tsx'
import styles from './SnoozeTaskDialog.module.css'

export interface SnoozeTime {
  zone: string
  date: string
  time: string
  setDate: (date: string) => void
  setTime: (time: string) => void
  instant: string | undefined
  invalid: string | undefined
}

export function useSnoozeTime(current: string | undefined): SnoozeTime {
  const settings = useSettings()
  const zone = effectiveTimeZone(settings ?? timePreferences())
  const [initial] = useState(() => {
    if (current) return dateTimeFields(new Date(current), zone)
    const today = dateTimeFields(new Date(), zone).date
    const tomorrow = new Date(`${today}T12:00:00Z`)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    return { date: tomorrow.toISOString().slice(0, 10), time: '09:00' }
  })
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  let instant: string | undefined
  let invalid: string | undefined
  try {
    instant = dateTimeInZone(date, time, zone)
  } catch (failure) {
    invalid = readableError(failure)
  }
  return { zone, date, time, setDate, setTime, instant, invalid }
}

export function SnoozeTimeFields({ value, onEdit }: { value: SnoozeTime; onEdit: () => void }) {
  const id = useId()
  return (
    <>
      <label className={styles.label} htmlFor={id}>
        Date
      </label>
      <input
        className={styles.date}
        id={id}
        type="date"
        value={value.date}
        onChange={(event) => {
          value.setDate(event.target.value)
          onEdit()
        }}
      />
      <div className={styles.label}>Time</div>
      <div className={styles.time}>
        <ScheduleTime
          value={value.time}
          onChange={(time) => {
            value.setTime(time)
            onEdit()
          }}
        />
      </div>
      <p className={styles.note}>Time zone: {value.zone} · App-wide in General settings</p>
    </>
  )
}
