import { uses12HourTime } from '@ted/protocol/time'
import { timePreferences } from '../time.ts'
import { Select } from './Select.tsx'

export function ScheduleTime({
  value,
  onChange,
}: {
  value: string
  onChange: (at: string) => void
}) {
  const [hour = 0, minute = 0] = value.split(':').map(Number)
  const twelve = uses12HourTime(timePreferences())
  const change = (h: number, m: number) =>
    onChange(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  return (
    <>
      <Select
        aria-label="Hour"
        value={twelve ? hour % 12 || 12 : hour}
        onChange={(event) => {
          const chosen = Number(event.target.value)
          change(twelve ? (chosen % 12) + (hour >= 12 ? 12 : 0) : chosen, minute)
        }}
      >
        {Array.from({ length: twelve ? 12 : 24 }, (_, i) => (twelve ? i + 1 : i)).map((h) => (
          <option key={h} value={h}>
            {twelve ? h : String(h).padStart(2, '0')}
          </option>
        ))}
      </Select>
      <span aria-hidden>:</span>
      <Select
        aria-label="Minute"
        value={minute}
        onChange={(event) => change(hour, Number(event.target.value))}
      >
        {Array.from({ length: 60 }, (_, i) => i).map((minute) => (
          <option key={minute} value={minute}>
            {String(minute).padStart(2, '0')}
          </option>
        ))}
      </Select>
      {twelve && (
        <Select
          aria-label="AM or PM"
          value={hour < 12 ? 'AM' : 'PM'}
          onChange={(event) => change((hour % 12) + (event.target.value === 'PM' ? 12 : 0), minute)}
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </Select>
      )}
    </>
  )
}
