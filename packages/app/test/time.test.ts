import { describeSchedule, nextFirings } from '@ted/protocol/schedule'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { effectiveTimeZone, formatClockTime, timeOptions, uses12HourTime } from '@ted/protocol/time'
import { afterEach, describe, expect, test } from 'vitest'
import { firingDate } from '../src/renderer/automations.ts'
import { when } from '../src/renderer/plans.ts'
import { clockTime } from '../src/renderer/requests.ts'
import { formatDate, setTimePreferences } from '../src/renderer/time.ts'

afterEach(() => setTimePreferences(defaultMachineSettings))

describe('app-wide time preferences', () => {
  test('system mode follows the system clock convention and zone', () => {
    expect(uses12HourTime(defaultMachineSettings, 'en-US')).toBe(true)
    expect(uses12HourTime(defaultMachineSettings, 'en-GB')).toBe(false)
    expect(effectiveTimeZone(defaultMachineSettings, 'Asia/Tokyo')).toBe('Asia/Tokyo')
    expect(effectiveTimeZone({ timeFormat: 'system', timeZone: 'UTC' }, 'Asia/Tokyo')).toBe('UTC')
  })

  test('midnight and noon have unambiguous 12-hour and 24-hour forms', () => {
    expect(formatClockTime('00:00', '12-hour')).toBe('12:00 AM')
    expect(formatClockTime('12:00', '12-hour')).toBe('12:00 PM')
    expect(formatClockTime('23:45', '12-hour')).toBe('11:45 PM')
    expect(formatClockTime('00:00', '24-hour')).toBe('00:00')
    expect(formatClockTime('12:00', '24-hour')).toBe('12:00')
    expect(timeOptions({ timeFormat: '24-hour', timeZone: 'UTC' }).hourCycle).toBe('h23')
  })

  test('Comments, plans and Automation history change format and cross dates together', () => {
    const at = '2026-11-09T23:35:00Z'
    setTimePreferences({ timeFormat: '12-hour', timeZone: 'Asia/Tokyo' })
    expect(clockTime(at)).toBe('08:35 am')
    expect(when(at)).toBe('Tue 10 Nov 08:35 am')
    expect(firingDate(at)).toBe('Tue 10 Nov 08:35 am')
    expect(formatDate(at, { day: 'numeric', month: 'short' })).toBe('10 Nov')
    setTimePreferences({ timeFormat: '24-hour', timeZone: 'America/Los_Angeles' })
    expect(clockTime(at)).toBe('15:35')
    expect(when(at)).toBe('Mon 9 Nov 15:35')
    expect(firingDate(at)).toBe('Mon 9 Nov 15:35')
  })

  test('readable schedules honor format while their clock values and firings stay canonical', () => {
    const schedule = { kind: 'daily', at: '09:00' } as const
    const before = nextFirings(schedule, 'Europe/London', Date.parse('2026-11-09T08:00Z'), 1)
    expect(describeSchedule(schedule, 'Europe/London', '12-hour')).toBe(
      'Daily at 9:00 AM · Europe/London',
    )
    expect(
      describeSchedule({ kind: 'custom', expression: '0 9,14 * * 1-5' }, 'UTC', '12-hour'),
    ).toBe('At 9:00 AM and 2:00 PM on weekdays · UTC')
    expect(describeSchedule(schedule, 'Europe/London', '24-hour')).toBe(
      'Daily at 09:00 · Europe/London',
    )
    expect(nextFirings(schedule, 'Europe/London', Date.parse('2026-11-09T08:00Z'), 1)).toEqual(
      before,
    )
    expect(schedule.at).toBe('09:00')
  })
})
