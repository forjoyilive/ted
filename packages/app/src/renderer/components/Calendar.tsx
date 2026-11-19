import { localDayStart } from '@ted/protocol/dashboard'
import { type KeyboardEvent, useState } from 'react'
import { calendarMonth, monthOf, monthTitle, shiftMonth, weekdayNames } from '../calendar.ts'
import styles from './Calendar.module.css'

const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const fullDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' })

export function Calendar({
  label,
  value,
  min,
  max,
  rangeFrom,
  rangeTo,
  onPick,
}: {
  label: string
  value: string
  min?: string | undefined
  max: string
  rangeFrom?: string
  rangeTo?: string
  onPick: (date: string) => void
}) {
  const [month, setMonth] = useState(() => monthOf(value || max))
  const { lead, days } = calendarMonth(month)
  const step = (by: number) => setMonth((shown) => shiftMonth(shown, by))
  const lastMonth = month >= monthOf(max)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return
    event.preventDefault()
    if (event.key === 'PageDown' && lastMonth) return
    step(event.key === 'PageUp' ? -1 : 1)
  }
  return (
    <div className={styles.calendar} role="dialog" aria-label={label} onKeyDown={onKeyDown}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.nav}
          aria-label="Previous month"
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <span className={styles.title} aria-live="polite">
          {monthTitle(month)}
        </span>
        <button
          type="button"
          className={styles.nav}
          aria-label="Next month"
          disabled={lastMonth}
          onClick={() => step(1)}
        >
          ›
        </button>
      </div>
      <div className={styles.grid}>
        {weekdayNames().map((name, index) => (
          <span key={weekdays[index]} className={styles.weekday} aria-hidden>
            {name}
          </span>
        ))}
        {days.map((day, index) => {
          const ends = day === rangeFrom || day === rangeTo
          const within = rangeFrom && rangeTo && day > rangeFrom && day < rangeTo
          return (
            <button
              key={day}
              type="button"
              className={[
                styles.day,
                ends && styles.end,
                within && styles.within,
                day === max && styles.today,
              ]
                .filter(Boolean)
                .join(' ')}
              style={index === 0 ? { gridColumnStart: lead + 1 } : undefined}
              disabled={day > max || (min !== undefined && day < min)}
              aria-pressed={day === value}
              aria-label={fullDate.format(new Date(localDayStart(day)))}
              onClick={() => onPick(day)}
            >
              {Number(day.slice(8))}
            </button>
          )
        })}
      </div>
    </div>
  )
}
