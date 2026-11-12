import type { TimeFormat } from './settings.ts'
import { formatClockTime } from './time.ts'

export const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export type Weekday = (typeof weekdays)[number]

export type AutomationSchedule =
  | { kind: 'every'; every: number; unit: 'minutes' | 'hours' }
  | { kind: 'daily'; at: string }
  | { kind: 'weekdays'; at: string }
  | { kind: 'weekly'; days: Weekday[]; at: string }
  | { kind: 'custom'; expression: string }

export const shortestIntervalMinutes = 15

const dayMs = 24 * 60 * 60 * 1000
const minuteMs = 60_000
const searchDays = 8 * 366
const gapSamples = 200
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const monthNames = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

class ScheduleError extends Error {}

interface DayIndex {
  unit: 'day' | 'week' | 'month' | 'year'
  every: number
  from: number
}

interface Rule {
  months?: ReadonlySet<number>
  monthDays?: ReadonlySet<number>
  weekDays?: ReadonlySet<number>
  nthWeekDays?: readonly { day: number; nth: number }[]
  eitherDay: boolean
  times: readonly number[]
  interval?: DayIndex
  step?: { every: number; unitMinutes: number; from: number }
  until?: number
}

const allTimes = (stepMinutes: number) =>
  Array.from({ length: Math.ceil(1440 / stepMinutes) }, (_, i) => i * stepMinutes)

function clockMinutes(at: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at)
  if (!match) throw new ScheduleError('Times are HH:MM, from 00:00 to 23:59.')
  return Number(match[1]) * 60 + Number(match[2])
}

const sundayFirst = (day: Weekday) => (weekdays.indexOf(day) + 1) % 7

function ruleOf(schedule: AutomationSchedule): Rule {
  switch (schedule.kind) {
    case 'every': {
      const minutes = schedule.unit === 'hours' ? schedule.every * 60 : schedule.every
      if (!Number.isInteger(schedule.every) || schedule.every < 1) {
        throw new ScheduleError('The interval is a whole number.')
      }
      if (minutes < shortestIntervalMinutes) {
        throw new ScheduleError(`The shortest interval is ${shortestIntervalMinutes} minutes.`)
      }
      if (minutes > 1440) throw new ScheduleError('The longest interval is 24 hours.')
      return { eitherDay: false, times: allTimes(minutes) }
    }
    case 'daily':
      return { eitherDay: false, times: [clockMinutes(schedule.at)] }
    case 'weekdays':
      return {
        eitherDay: false,
        weekDays: new Set([1, 2, 3, 4, 5]),
        times: [clockMinutes(schedule.at)],
      }
    case 'weekly':
      if (schedule.days.length === 0) throw new ScheduleError('Pick at least one day.')
      return {
        eitherDay: false,
        weekDays: new Set(schedule.days.map(sundayFirst)),
        times: [clockMinutes(schedule.at)],
      }
    case 'custom':
      return expressionRule(schedule.expression)
  }
}

function expressionRule(text: string): Rule {
  const trimmed = text.trim()
  try {
    return /FREQ=/i.test(trimmed) ? rruleRule(trimmed) : cronRule(trimmed)
  } catch (error) {
    if (error instanceof ScheduleError) {
      throw new ScheduleError(`Not a valid cron or RRULE: ${error.message}`)
    }
    throw error
  }
}

const cronMacros: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

function cronField(
  field: string,
  min: number,
  max: number,
  what: string,
  names: readonly string[] = [],
): number[] | undefined {
  if (field === '*' || field === '?') return undefined
  const values = new Set<number>()
  const value = (part: string) => {
    const named = names.findIndex((n) => n.toLowerCase() === part.toLowerCase())
    const n = named !== -1 ? named + (names === monthNames ? 1 : 0) : Number(part)
    if (part === '' || !Number.isInteger(n) || n < min || n > max) {
      throw new ScheduleError(`“${part}” isn’t a valid ${what}`)
    }
    return n
  }
  for (const piece of field.split(',')) {
    const [range = '', stepText] = piece.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      throw new ScheduleError(`“${piece}” has a bad step`)
    }
    let from: number
    let to: number
    if (range === '*') {
      from = min
      to = max
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-')
      from = value(a)
      to = value(b)
      if (to < from) throw new ScheduleError(`“${piece}” runs backwards`)
    } else {
      from = value(range)
      to = stepText === undefined ? from : max
    }
    for (let n = from; n <= to; n += step) values.add(n)
  }
  return [...values].sort((a, b) => a - b)
}

function cronRule(text: string): Rule {
  const fields = (cronMacros[text.toLowerCase()] ?? text).split(/\s+/)
  if (fields.length !== 5) {
    throw new ScheduleError('a cron has 5 fields: minute, hour, day of month, month, day of week')
  }
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields
  const minutes = cronField(minute, 0, 59, 'minute') ?? allTimes(1).slice(0, 60)
  const hours = cronField(hour, 0, 23, 'hour') ?? allTimes(60).map((m) => m / 60)
  const monthDays = cronField(dom, 1, 31, 'day of the month')
  const months = cronField(month, 1, 12, 'month', monthNames)
  const weekDays = cronField(dow, 0, 7, 'day of the week', dayNames)?.map((d) => d % 7)
  return {
    times: hours.flatMap((h) => minutes.map((m) => h * 60 + m)),
    eitherDay: monthDays !== undefined && weekDays !== undefined,
    ...(monthDays && { monthDays: new Set(monthDays) }),
    ...(months && { months: new Set(months) }),
    ...(weekDays && { weekDays: new Set(weekDays) }),
  }
}

const rruleDays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const epochMonday = Date.UTC(1970, 0, 5)

function rruleNumbers(value: string, min: number, max: number, what: string): number[] {
  return value.split(',').map((part) => {
    const n = Number(part)
    const valid = part !== '' && Number.isInteger(n) && n >= min && n <= max
    if (!valid || (min < 0 && n === 0)) throw new ScheduleError(`“${part}” isn’t a valid ${what}`)
    return n
  })
}

function rruleRule(text: string): Rule {
  let dtstart: number | undefined
  const parts = new Map<string, string>()
  for (const line of text.split(/\s*\n\s*|\s+(?=DTSTART|RRULE)/i)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const start = /^DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/i.exec(
      trimmed,
    )
    if (start) {
      const [, y, mo, d, h = '0', mi = '0'] = start
      dtstart = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
      continue
    }
    for (const part of trimmed.replace(/^RRULE:/i, '').split(';')) {
      if (part === '') continue
      const [name = '', value] = part.split('=')
      if (value === undefined) throw new ScheduleError(`“${part}” has no value`)
      parts.set(name.toUpperCase(), value.toUpperCase())
    }
  }
  const known = new Set([
    'FREQ',
    'INTERVAL',
    'BYMINUTE',
    'BYHOUR',
    'BYDAY',
    'BYMONTHDAY',
    'BYMONTH',
    'UNTIL',
    'WKST',
  ])
  for (const name of parts.keys()) {
    if (name === 'COUNT') throw new ScheduleError('COUNT isn’t supported; use UNTIL')
    if (!known.has(name)) throw new ScheduleError(`${name} isn’t supported`)
  }
  const freq = parts.get('FREQ') ?? ''
  const freqs = ['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
  if (!freqs.includes(freq))
    throw new ScheduleError(`FREQ “${freq}” isn’t one of ${freqs.join(', ')}`)
  const interval = parts.has('INTERVAL')
    ? (rruleNumbers(parts.get('INTERVAL') ?? '', 1, 10_000, 'INTERVAL')[0] ?? 1)
    : 1
  const startMinutes =
    dtstart === undefined
      ? 0
      : new Date(dtstart).getUTCHours() * 60 + new Date(dtstart).getUTCMinutes()
  const byMinute = parts.has('BYMINUTE')
    ? rruleNumbers(parts.get('BYMINUTE') ?? '', 0, 59, 'BYMINUTE')
    : undefined
  const byHour = parts.has('BYHOUR')
    ? rruleNumbers(parts.get('BYHOUR') ?? '', 0, 23, 'BYHOUR')
    : undefined
  let times: number[]
  let step: Rule['step']
  const anchor = dtstart ?? 0
  if (freq === 'MINUTELY') {
    times = allTimes(1)
    if (byHour) times = times.filter((t) => byHour.includes(Math.floor(t / 60)))
    if (byMinute) times = times.filter((t) => byMinute.includes(t % 60))
    if (interval > 1) step = { every: interval, unitMinutes: 1, from: anchor }
  } else if (freq === 'HOURLY') {
    const hours = Array.from({ length: 24 }, (_, h) => h).filter(
      (h) => byHour === undefined || byHour.includes(h),
    )
    const minutes = byMinute ?? [startMinutes % 60]
    times = hours.flatMap((h) => minutes.map((m) => h * 60 + m))
    if (interval > 1) {
      step = { every: interval, unitMinutes: 60, from: anchor - (anchor % (60 * minuteMs)) }
    }
  } else {
    const hours = byHour ?? [Math.floor(startMinutes / 60)]
    const minutes = byMinute ?? [startMinutes % 60]
    times = hours.flatMap((h) => minutes.map((m) => h * 60 + m))
  }
  const weekDays = new Set<number>()
  const nthWeekDays: { day: number; nth: number }[] = []
  for (const day of parts.get('BYDAY')?.split(',') ?? []) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(day)
    if (!match) throw new ScheduleError(`“${day}” isn’t a valid BYDAY`)
    const index = rruleDays.indexOf(match[2] ?? '')
    if (match[1] === undefined) weekDays.add(index)
    else {
      const nth = Number(match[1])
      if (nth === 0 || nth > 5 || nth < -5) throw new ScheduleError(`“${day}” isn’t a valid BYDAY`)
      nthWeekDays.push({ day: index, nth })
    }
  }
  const monthDays = parts.has('BYMONTHDAY')
    ? rruleNumbers(parts.get('BYMONTHDAY') ?? '', -31, 31, 'BYMONTHDAY')
    : undefined
  const months = parts.has('BYMONTH')
    ? rruleNumbers(parts.get('BYMONTH') ?? '', 1, 12, 'BYMONTH')
    : undefined
  const startDay = dtstart === undefined ? epochMonday : dtstart - (dtstart % dayMs)
  const rule: Rule = {
    times: [...new Set(times)].sort((a, b) => a - b),
    eitherDay: false,
    ...(months && { months: new Set(months) }),
    ...(monthDays && { monthDays: new Set(monthDays) }),
    ...(weekDays.size > 0 && { weekDays }),
    ...(nthWeekDays.length > 0 && { nthWeekDays }),
    ...(step && { step }),
  }
  if (freq === 'WEEKLY' && !rule.weekDays && !rule.nthWeekDays) {
    rule.weekDays = new Set([new Date(startDay).getUTCDay()])
  }
  if (freq === 'MONTHLY' && !rule.monthDays && !rule.weekDays && !rule.nthWeekDays) {
    rule.monthDays = new Set([new Date(startDay).getUTCDate()])
  }
  if (freq === 'YEARLY' && !rule.months)
    rule.months = new Set([new Date(startDay).getUTCMonth() + 1])
  if (freq === 'YEARLY' && !rule.monthDays && !rule.weekDays && !rule.nthWeekDays) {
    rule.monthDays = new Set([new Date(startDay).getUTCDate()])
  }
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as const
  const intervalUnit = unit[freq as keyof typeof unit]
  if (interval > 1 && intervalUnit) {
    rule.interval = { unit: intervalUnit, every: interval, from: startDay }
  }
  const until = parts.get('UNTIL')
  if (until !== undefined) {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(until)
    if (!match) throw new ScheduleError(`UNTIL “${until}” isn’t a date`)
    const [, y, mo, d, h = '23', mi = '59'] = match
    rule.until = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
  }
  if (rule.times.length === 0) throw new ScheduleError('it never fires')
  return rule
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, found)
  }
  return found
}

export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

function wallClock(at: number, timeZone: string): number {
  const parts: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  )
}

function instantOf(wall: number, timeZone: string): number {
  const at = (t: number) => Math.floor(t / 1000) * 1000
  const offset = wallClock(at(wall), timeZone) - at(wall)
  const guess = wall - offset
  const second = wallClock(guess, timeZone) - guess
  return second === offset ? guess : wall - second
}

function nthOfMonth(day: Date): { nth: number; last: number } {
  const date = day.getUTCDate()
  const daysInMonth = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0),
  ).getUTCDate()
  return { nth: Math.ceil(date / 7), last: -Math.ceil((daysInMonth - date + 1) / 7) }
}

function dayMatches(rule: Rule, dayStart: number): boolean {
  const day = new Date(dayStart)
  if (rule.months && !rule.months.has(day.getUTCMonth() + 1)) return false
  if (rule.interval && !onInterval(rule.interval, dayStart)) return false
  const daysInMonth = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0),
  ).getUTCDate()
  const date = day.getUTCDate()
  const byMonthDay =
    rule.monthDays === undefined
      ? undefined
      : rule.monthDays.has(date) || rule.monthDays.has(date - daysInMonth - 1)
  const { nth, last } = nthOfMonth(day)
  const byWeekDay =
    rule.weekDays === undefined && rule.nthWeekDays === undefined
      ? undefined
      : (rule.weekDays?.has(day.getUTCDay()) ?? false) ||
        (rule.nthWeekDays?.some(
          (n) => n.day === day.getUTCDay() && (n.nth === nth || n.nth === last),
        ) ??
          false)
  if (byMonthDay === undefined) return byWeekDay ?? true
  if (byWeekDay === undefined) return byMonthDay
  return rule.eitherDay ? byMonthDay || byWeekDay : byMonthDay && byWeekDay
}

function onInterval({ unit, every, from }: DayIndex, dayStart: number): boolean {
  const start = new Date(from)
  const day = new Date(dayStart)
  let index: number
  if (unit === 'day') index = Math.round((dayStart - from) / dayMs)
  else if (unit === 'week') {
    const monday = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * dayMs
    index = Math.round((monday(dayStart) - monday(from)) / (7 * dayMs))
  } else if (unit === 'month') {
    index =
      (day.getUTCFullYear() - start.getUTCFullYear()) * 12 + day.getUTCMonth() - start.getUTCMonth()
  } else index = day.getUTCFullYear() - start.getUTCFullYear()
  return index >= 0 && index % every === 0
}

function onStep({ every, unitMinutes, from }: NonNullable<Rule['step']>, wall: number): boolean {
  const index = Math.floor((wall - from) / (unitMinutes * minuteMs))
  return index >= 0 && index % every === 0
}

function firings(rule: Rule, timeZone: string, after: number, count: number): number[] {
  const found: number[] = []
  const wall = wallClock(after, timeZone)
  const firstDay = wall - (wall % dayMs) - dayMs
  for (let i = 0; i < searchDays && found.length < count; i++) {
    const dayStart = firstDay + i * dayMs
    if (!dayMatches(rule, dayStart)) continue
    for (const minutes of rule.times) {
      if (rule.step && !onStep(rule.step, dayStart + minutes * minuteMs)) continue
      const at = instantOf(dayStart + minutes * minuteMs, timeZone)
      if (rule.until !== undefined && dayStart + minutes * minuteMs > rule.until) return found
      if (at > after && !found.includes(at)) found.push(at)
      if (found.length >= count) break
    }
  }
  return found.sort((a, b) => a - b)
}

export function nextFirings(
  schedule: AutomationSchedule,
  timeZone: string,
  after: number,
  count: number,
): number[] {
  try {
    return firings(ruleOf(schedule), timeZone, after, count)
  } catch {
    return []
  }
}

export function checkSchedule(
  schedule: AutomationSchedule,
  timeZone: string,
  now: number,
): string | undefined {
  if (!isTimeZone(timeZone)) return `Unknown time zone: ${timeZone}`
  let rule: Rule
  try {
    rule = ruleOf(schedule)
  } catch (error) {
    if (error instanceof ScheduleError) return error.message
    throw error
  }
  const next = firings(rule, timeZone, now, gapSamples)
  if (next.length === 0) return 'This schedule never fires.'
  for (let i = 1; i < next.length; i++) {
    const gap = (next[i] ?? 0) - (next[i - 1] ?? 0)
    if (gap < shortestIntervalMinutes * minuteMs) {
      return `The shortest interval is ${shortestIntervalMinutes} minutes.`
    }
  }
  return undefined
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

function and(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const weekdayLabels: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
}

export function scheduleFromExpression(text: string): AutomationSchedule {
  const expression = text.trim()
  const cron = /^(\d{1,2}) (\d{1,2}) \* \* (\S+)$/.exec(expression)
  if (cron) {
    const [, minute = '', hour = '', dow = ''] = cron
    const m = Number(minute)
    const h = Number(hour)
    if (m <= 59 && h <= 23) {
      const at = clock(h * 60 + m)
      if (dow === '*') return { kind: 'daily', at }
      if (dow === '1-5' || dow.toUpperCase() === 'MON-FRI') return { kind: 'weekdays', at }
      if (/^[0-7](,[0-7])*$/.test(dow)) {
        const days = [...new Set(dow.split(',').map((d) => Number(d) % 7))]
          .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
          .map((d) => weekdays[(d + 6) % 7] as Weekday)
        return { kind: 'weekly', days, at }
      }
    }
  }
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(expression)
  if (every && 60 % Number(every[1]) === 0) {
    return { kind: 'every', every: Number(every[1]), unit: 'minutes' }
  }
  const hourly = /^0 \*\/(\d+) \* \* \*$/.exec(expression)
  if (hourly && 24 % Number(hourly[1]) === 0) {
    return { kind: 'every', every: Number(hourly[1]), unit: 'hours' }
  }
  if (expression === '0 * * * *') return { kind: 'every', every: 1, unit: 'hours' }
  return { kind: 'custom', expression }
}

function timesInWords(times: readonly number[], format: TimeFormat): string | undefined {
  if (times.length > 4) {
    const step = (times[1] ?? 0) - (times[0] ?? 0)
    const regular =
      step > 0 && times.every((t, i) => t === (times[0] ?? 0) + i * step) && 1440 % step === 0
    if (regular && times[0] === 0 && times.length === 1440 / step) {
      if (step % 60 === 0) return step === 60 ? 'Every hour' : `Every ${step / 60} hours`
      return `Every ${step} minutes`
    }
    return undefined
  }
  return and(times.map((minutes) => formatClockTime(clock(minutes), format)))
}

export function describeSchedule(
  schedule: AutomationSchedule,
  timeZone: string,
  format: TimeFormat = '24-hour',
): string {
  const zone = ` · ${timeZone}`
  switch (schedule.kind) {
    case 'every':
      if (schedule.unit === 'hours') {
        return schedule.every === 1 ? 'Every hour' : `Every ${schedule.every} hours`
      }
      return `Every ${schedule.every} minutes`
    case 'daily':
      return `Daily at ${formatClockTime(schedule.at, format)}${zone}`
    case 'weekdays':
      return `Weekdays at ${formatClockTime(schedule.at, format)}${zone}`
    case 'weekly': {
      const days = weekdays.filter((d) => schedule.days.includes(d)).map((d) => weekdayLabels[d])
      return `${and(days)} at ${formatClockTime(schedule.at, format)}${zone}`
    }
    case 'custom': {
      const simple = scheduleFromExpression(schedule.expression)
      if (simple.kind !== 'custom') return describeSchedule(simple, timeZone, format)
      let rule: Rule
      try {
        rule = expressionRule(schedule.expression)
      } catch {
        return `Custom: ${schedule.expression}`
      }
      return describeRule(rule, timeZone, format) ?? `Custom: ${schedule.expression}${zone}`
    }
  }
}

function describeRule(rule: Rule, timeZone: string, format: TimeFormat): string | undefined {
  const times = rule.step
    ? `Every ${rule.step.every} ${rule.step.unitMinutes === 60 ? 'hours' : 'minutes'}`
    : timesInWords(rule.times, format)
  if (times === undefined) return undefined
  const repeating = times.startsWith('Every')
  const days: string[] = []
  if (rule.weekDays) {
    const list = [1, 2, 3, 4, 5, 6, 0].filter((d) => rule.weekDays?.has(d))
    days.push(
      list.join(',') === '1,2,3,4,5'
        ? 'on weekdays'
        : `on ${and(list.map((d) => dayNames[d] ?? ''))}`,
    )
  }
  if (rule.nthWeekDays) {
    const ordinal = (n: number) =>
      n === -1
        ? 'last'
        : n < 0
          ? `${-n}th from last`
          : (['1st', '2nd', '3rd', '4th', '5th'][n - 1] ?? `${n}th`)
    days.push(
      `on the ${and(rule.nthWeekDays.map((n) => `${ordinal(n.nth)} ${dayNames[n.day] ?? ''}`))} of the month`,
    )
  }
  if (rule.monthDays) {
    const list = [...rule.monthDays].sort((a, b) => a - b)
    const named = list.map((d) => (d === -1 ? 'the last day' : String(d)))
    days.push(`on day ${and(named)} of the month`)
  }
  const dayPart = days.join(rule.eitherDay ? ' or ' : ' ')
  const monthPart = rule.months
    ? ` in ${and([...rule.months].sort((a, b) => a - b).map((m) => monthNames[m - 1] ?? ''))}`
    : ''
  const every = rule.interval ? ` every ${rule.interval.every} ${rule.interval.unit}s` : ''
  const lead = repeating ? times : `At ${times}`
  const text = [lead, dayPart].filter((s) => s !== '').join(' ') + monthPart + every
  return repeating && dayPart === '' && monthPart === '' && every === ''
    ? text
    : `${text} · ${timeZone}`
}
