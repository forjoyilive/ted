import { localDayStart } from '@ted/protocol/dashboard'

export interface CalendarMonth {
  lead: number
  days: string[]
}

const pad = (n: number) => String(n).padStart(2, '0')

export const monthOf = (date: string) => date.slice(0, 7)

export function shiftMonth(month: string, step: number): string {
  const [year = 0, index = 1] = month.split('-').map(Number)
  const shifted = new Date(year, index - 1 + step, 1)
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}`
}

export function calendarMonth(month: string): CalendarMonth {
  const [year = 0, index = 1] = month.split('-').map(Number)
  const first = new Date(year, index - 1, 1)
  const count = new Date(year, index, 0).getDate()
  return {
    lead: (first.getDay() + 6) % 7,
    days: Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`),
  }
}

export function monthTitle(month: string): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(
    new Date(localDayStart(`${month}-01`)),
  )
}

export function weekdayNames(): string[] {
  const format = new Intl.DateTimeFormat('en-GB', { weekday: 'narrow' })
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2026, 10, 16 + i)))
}
