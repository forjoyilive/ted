import type { DashboardCustomRange, DashboardRange } from '@ted/protocol'
import {
  dashboardRange,
  dashboardRanges,
  isPreset,
  localCalendarDate,
  rangeDays,
} from '@ted/protocol/dashboard'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Calendar } from '../components/Calendar.tsx'
import { Select } from '../components/Select.tsx'
import { customRangeProblem, rangeLabel, rangeLabels } from '../dashboard.ts'
import styles from './DashboardRangePicker.module.css'

const customValue = 'custom'
const editValue = 'custom-edit'

export function DashboardRangePicker({
  range,
  start,
  onChange,
}: {
  range: DashboardRange
  start: () => DashboardCustomRange
  onChange: (range: DashboardRange) => void
}) {
  const [editing, setEditing] = useState<DashboardCustomRange | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => {
    setEditing(null)
    ref.current?.querySelector('select')?.focus()
  }
  return (
    <div className={styles.picker} ref={ref}>
      <Select
        aria-label="Historical period"
        value={isPreset(range) ? range : customValue}
        onChange={(event) => {
          if (event.target.value === editValue) return setEditing(start())
          const chosen = dashboardRange(event.target.value)
          if (chosen) onChange(chosen)
        }}
      >
        {dashboardRanges.map((preset) => (
          <option key={preset} value={preset}>
            {rangeLabels[preset]}
          </option>
        ))}
        {!isPreset(range) && (
          <option value={customValue} data-divider-before>
            {rangeLabel(range)}
          </option>
        )}
        <option value={editValue} data-divider-before={isPreset(range) || undefined}>
          Custom range…
        </option>
      </Select>
      {editing && (
        <CustomRangeBox
          initial={editing}
          onApply={(chosen) => {
            close()
            onChange(chosen)
          }}
          onClose={close}
        />
      )}
    </div>
  )
}

const calendarKeys = (event: KeyboardEvent) =>
  event.key === ' ' || event.key === 'F4' || (event.key === 'ArrowDown' && event.altKey)

function CustomRangeBox({
  initial,
  onApply,
  onClose,
}: {
  initial: DashboardCustomRange
  onApply: (range: DashboardCustomRange) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const startRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const startId = useId()
  const endId = useId()
  const hintId = useId()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [open, setOpen] = useState<'from' | 'to' | null>(null)
  const today = localCalendarDate(Date.now())
  const problem = customRangeProblem(from, to, today)
  const length = problem ? 0 : rangeDays({ from, to })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    startRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return
      closeRef.current()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  const apply = () => {
    if (!problem) onApply({ from, to })
  }
  const pickFrom = (day: string) => {
    setFrom(day)
    if (to < day) setTo(day)
    setOpen('to')
    endRef.current?.focus()
  }
  const pickTo = (day: string) => {
    setTo(day)
    setOpen(null)
    endRef.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (open) setOpen(null)
      else onClose()
    } else if (
      event.key === 'Enter' &&
      event.target instanceof HTMLInputElement &&
      problem === undefined
    ) {
      event.preventDefault()
      apply()
    }
  }
  const field = (which: 'from' | 'to') => ({
    type: 'date',
    max: today,
    'aria-invalid':
      (which === 'from' && problem?.startsWith('Start')) ||
      (which === 'to' && problem?.startsWith('End')) ||
      undefined,
    'aria-describedby': hintId,
    onClick: () => setOpen(which),
    onKeyDown: (event: KeyboardEvent) => {
      if (!calendarKeys(event)) return
      event.preventDefault()
      setOpen(which)
    },
  })

  return (
    <div
      className={styles.box}
      role="dialog"
      aria-labelledby={titleId}
      ref={ref}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (
          event.target instanceof Element &&
          !event.target.closest('input, [role="dialog"] [role="dialog"]')
        )
          setOpen(null)
      }}
    >
      <h2 className={styles.title} id={titleId}>
        Custom range
      </h2>
      <div className={styles.fields}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={startId}>
            Start
          </label>
          <input
            {...field('from')}
            ref={startRef}
            id={startId}
            className={styles.input}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          {open === 'from' && (
            <Calendar
              label="Choose start date"
              value={from}
              max={today}
              rangeFrom={from}
              rangeTo={to}
              onPick={pickFrom}
            />
          )}
        </div>
        <div className={`${styles.field} ${styles.end}`}>
          <label className={styles.label} htmlFor={endId}>
            End
          </label>
          <input
            {...field('to')}
            ref={endRef}
            id={endId}
            className={styles.input}
            min={from || undefined}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          {open === 'to' && (
            <Calendar
              key={from}
              label="Choose end date"
              value={to}
              min={from || undefined}
              max={today}
              rangeFrom={from}
              rangeTo={to}
              onPick={pickTo}
            />
          )}
        </div>
      </div>
      <p className={problem ? styles.problem : styles.hint} id={hintId}>
        {problem ?? `${length === 1 ? '1 day' : `${length} days`}, end day included`}
      </p>
      <div className={styles.actions}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={problem !== undefined} onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  )
}
