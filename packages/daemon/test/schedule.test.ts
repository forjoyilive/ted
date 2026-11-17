import {
  type AutomationSchedule,
  checkSchedule,
  describeSchedule,
  nextFirings,
  scheduleFromExpression,
} from '@ted/protocol'
import { describe, expect, test } from 'vitest'

const at = (iso: string) => Date.parse(iso)
const iso = (ms: number[]) => ms.map((t) => new Date(t).toISOString())

describe('schedules', () => {
  test('a weekday cron fires at 09:00 in its own time zone', () => {
    const schedule = scheduleFromExpression('0 9 * * 1-5')
    expect(iso(nextFirings(schedule, 'Europe/London', at('2026-11-06T12:00:00Z'), 3))).toEqual([
      '2026-11-09T09:00:00.000Z',
      '2026-11-10T09:00:00.000Z',
      '2026-11-11T09:00:00.000Z',
    ])
    expect(iso(nextFirings(schedule, 'America/New_York', at('2026-11-06T12:00:00Z'), 1))).toEqual([
      '2026-11-06T14:00:00.000Z',
    ])
  })

  test('clock times follow summer time', () => {
    const daily = { kind: 'daily', at: '09:00' } as const
    expect(iso(nextFirings(daily, 'Europe/London', at('2026-10-24T12:00:00Z'), 2))).toEqual([
      '2026-10-25T09:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ])
    expect(iso(nextFirings(daily, 'Europe/London', at('2026-07-01T12:00:00Z'), 1))).toEqual([
      '2026-07-02T08:00:00.000Z',
    ])
  })

  test('every N minutes counts from midnight in the zone', () => {
    const every = { kind: 'every', every: 45, unit: 'minutes' } as const
    expect(iso(nextFirings(every, 'UTC', at('2026-11-09T23:00:00Z'), 3))).toEqual([
      '2026-11-09T23:15:00.000Z',
      '2026-11-10T00:00:00.000Z',
      '2026-11-10T00:45:00.000Z',
    ])
  })

  test('weekly on chosen days', () => {
    const weekly: AutomationSchedule = { kind: 'weekly', days: ['mon', 'thu'], at: '07:30' }
    expect(iso(nextFirings(weekly, 'UTC', at('2026-11-09T08:00:00Z'), 2))).toEqual([
      '2026-11-12T07:30:00.000Z',
      '2026-11-16T07:30:00.000Z',
    ])
  })

  test('an RRULE fires like its cron twin', () => {
    const rule = scheduleFromExpression('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0')
    expect(iso(nextFirings(rule, 'Europe/London', at('2026-11-06T12:00:00Z'), 2))).toEqual([
      '2026-11-09T09:00:00.000Z',
      '2026-11-10T09:00:00.000Z',
    ])
    const monthly = scheduleFromExpression('RRULE:FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0')
    expect(iso(nextFirings(monthly, 'UTC', at('2026-11-01T00:00:00Z'), 2))).toEqual([
      '2026-11-27T17:00:00.000Z',
      '2026-12-25T17:00:00.000Z',
    ])
  })

  test('RRULE hour and minute intervals count from DTSTART', () => {
    const hourly = scheduleFromExpression('DTSTART:20261109T090000Z\nRRULE:FREQ=HOURLY;INTERVAL=2')
    expect(iso(nextFirings(hourly, 'UTC', at('2026-11-09T09:00:00Z'), 3))).toEqual([
      '2026-11-09T11:00:00.000Z',
      '2026-11-09T13:00:00.000Z',
      '2026-11-09T15:00:00.000Z',
    ])
    const minutely = scheduleFromExpression(
      'DTSTART:20261109T090500Z RRULE:FREQ=MINUTELY;INTERVAL=20',
    )
    expect(iso(nextFirings(minutely, 'UTC', at('2026-11-09T09:06:00Z'), 2))).toEqual([
      '2026-11-09T09:25:00.000Z',
      '2026-11-09T09:45:00.000Z',
    ])
    expect(describeSchedule(hourly, 'UTC')).toBe('Every 2 hours')
  })

  test('RRULE text with a long run of spaces is read in one pass', () => {
    const spaces = ' '.repeat(100_000)
    const spaced = scheduleFromExpression(`RRULE:FREQ=DAILY;${spaces};INTERVAL=2`)
    expect(checkSchedule(spaced, 'UTC', at('2026-11-09T10:00:00Z'))).toMatch(/has no value$/)
    const daily = scheduleFromExpression(`dtstart:20261109T090000Z${spaces}rrule:FREQ=DAILY`)
    expect(iso(nextFirings(daily, 'UTC', at('2026-11-09T10:00:00Z'), 1))).toEqual([
      '2026-11-10T09:00:00.000Z',
    ])
  })

  test('cron with both day fields fires on either', () => {
    const schedule = scheduleFromExpression('0 6 1 * MON')
    expect(iso(nextFirings(schedule, 'UTC', at('2026-11-28T00:00:00Z'), 3))).toEqual([
      '2026-11-30T06:00:00.000Z',
      '2026-12-01T06:00:00.000Z',
      '2026-12-07T06:00:00.000Z',
    ])
  })

  test('the shortest interval is 15 minutes', () => {
    const now = at('2026-11-09T00:00:00Z')
    expect(checkSchedule({ kind: 'every', every: 10, unit: 'minutes' }, 'UTC', now)).toBe(
      'The shortest interval is 15 minutes.',
    )
    expect(checkSchedule(scheduleFromExpression('*/5 * * * *'), 'UTC', now)).toBe(
      'The shortest interval is 15 minutes.',
    )
    expect(checkSchedule(scheduleFromExpression('0,10 9 * * *'), 'UTC', now)).toBe(
      'The shortest interval is 15 minutes.',
    )
    expect(checkSchedule(scheduleFromExpression('*/15 * * * *'), 'UTC', now)).toBeUndefined()
  })

  test('bad expressions and zones are refused in plain words', () => {
    const now = at('2026-11-09T00:00:00Z')
    expect(checkSchedule(scheduleFromExpression('0 9 * *'), 'UTC', now)).toMatch(
      /^Not a valid cron or RRULE: /,
    )
    expect(checkSchedule(scheduleFromExpression('FREQ=SOMETIMES'), 'UTC', now)).toMatch(
      /^Not a valid cron or RRULE: /,
    )
    expect(checkSchedule({ kind: 'daily', at: '09:00' }, 'Mars/Olympus', now)).toBe(
      'Unknown time zone: Mars/Olympus',
    )
    expect(checkSchedule({ kind: 'weekly', days: [], at: '09:00' }, 'UTC', now)).toBe(
      'Pick at least one day.',
    )
  })

  test('schedules read in words, clock times with their zone', () => {
    expect(describeSchedule(scheduleFromExpression('0 9 * * 1-5'), 'Europe/London')).toBe(
      'Weekdays at 09:00 · Europe/London',
    )
    expect(describeSchedule(scheduleFromExpression('30 8 * * *'), 'UTC')).toBe(
      'Daily at 08:30 · UTC',
    )
    expect(describeSchedule({ kind: 'every', every: 2, unit: 'hours' }, 'UTC')).toBe(
      'Every 2 hours',
    )
    expect(describeSchedule(scheduleFromExpression('*/30 * * * *'), 'UTC')).toBe('Every 30 minutes')
    expect(
      describeSchedule({ kind: 'weekly', days: ['mon', 'thu'], at: '07:30' }, 'Asia/Tokyo'),
    ).toBe('Mon and Thu at 07:30 · Asia/Tokyo')
    expect(describeSchedule(scheduleFromExpression('0 9,17 1 * *'), 'UTC')).toBe(
      'At 09:00 and 17:00 on day 1 of the month · UTC',
    )
  })
})
