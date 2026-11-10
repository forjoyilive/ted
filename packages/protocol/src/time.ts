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
