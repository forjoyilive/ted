import { defaultMachineSettings } from '@ted/protocol/settings'
import { type TimePreferences, timeOptions } from '@ted/protocol/time'

let preferences: TimePreferences = defaultMachineSettings
let resolved = timeOptions(preferences)
const formatters = new Map<string, Intl.DateTimeFormat>()

export function setTimePreferences(value: TimePreferences): void {
  preferences = value
  resolved = timeOptions(value)
  formatters.clear()
}

export function timePreferences(): TimePreferences {
  return preferences
}

export function formatDate(
  at: string | Date,
  options: Intl.DateTimeFormatOptions,
  locale = 'en-GB',
): string {
  const key = JSON.stringify([locale, options])
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, ...resolved })
    formatters.set(key, formatter)
  }
  return formatter.format(typeof at === 'string' ? new Date(at) : at)
}

export function formatTime(at: string | Date): string {
  return formatDate(at, { hour: '2-digit', minute: '2-digit' })
}
