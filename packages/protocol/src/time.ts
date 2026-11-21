import type { MachineSettings } from './settings.ts'

export type TimePreferences = Pick<MachineSettings, 'timeFormat' | 'timeZone'>

export function systemTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function effectiveTimeZone(preferences: TimePreferences, system?: string): string {
  return preferences.timeZone === 'system' ? (system ?? systemTimeZone()) : preferences.timeZone
}

export function uses12HourTime(preferences: TimePreferences, locale?: string): boolean {
  return preferences.timeFormat === 'system'
    ? new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === true
    : preferences.timeFormat === '12-hour'
}

export function timeOptions(preferences: TimePreferences): Intl.DateTimeFormatOptions {
  return {
    timeZone: effectiveTimeZone(preferences),
    hourCycle: uses12HourTime(preferences) ? 'h12' : 'h23',
  }
}

export function formatClockTime(at: string, format: MachineSettings['timeFormat']): string {
  const [hour = 0, minute = 0] = at.split(':').map(Number)
  const twelve = uses12HourTime({ timeFormat: format, timeZone: 'UTC' })
  return `${twelve ? hour % 12 || 12 : String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}${twelve ? (hour < 12 ? ' AM' : ' PM') : ''}`
}

export function dateTimeFields(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  }
}

export function dateTimeInZone(date: string, time: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('Choose a valid date and time')
  }
  const wall = Date.parse(`${date}T${time}:00.000Z`)
  if (!Number.isFinite(wall) || new Date(wall).toISOString() !== `${date}T${time}:00.000Z`) {
    throw new Error('Choose a valid date and time')
  }
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wall + hours * 3_600_000
    const fields = dateTimeFields(new Date(sample), timeZone)
    offsets.add(Date.parse(`${fields.date}T${fields.time}:00.000Z`) - sample)
  }
  const matches = [...offsets].flatMap((offset) => {
    const at = wall - offset
    const fields = dateTimeFields(new Date(at), timeZone)
    return fields.date === date && fields.time === time ? [at] : []
  })
  if (matches.length === 0)
    throw new Error('That time does not exist in this time zone. Choose another time.')
  return new Date(Math.min(...matches)).toISOString()
}

export const snoozePresetIds = ['hour', 'tomorrow', 'next-week', 'month'] as const

export interface SnoozePreset {
  id: (typeof snoozePresetIds)[number]
  label: string
  until: string
}

export function requestSnoozePresets(now: Date, timeZone: string): SnoozePreset[] {
  const [year = 0, month = 1, day = 1] = dateTimeFields(now, timeZone).date.split('-').map(Number)
  const at9 = (y: number, monthIndex: number, d: number) =>
    dateTimeInZone(
      new Date(Date.UTC(y, monthIndex, d)).toISOString().slice(0, 10),
      '09:00',
      timeZone,
    )
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const toMonday = (8 - weekday) % 7 || 7
  const lastDayNextMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return [
    {
      id: 'hour',
      label: 'An hour from now',
      until: new Date(now.getTime() + 3_600_000).toISOString(),
    },
    { id: 'tomorrow', label: 'Tomorrow', until: at9(year, month - 1, day + 1) },
    { id: 'next-week', label: 'Next week', until: at9(year, month - 1, day + toMonday) },
    {
      id: 'month',
      label: 'A month from now',
      until: at9(year, month, Math.min(day, lastDayNextMonth)),
    },
  ]
}
