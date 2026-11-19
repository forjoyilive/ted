import { dashboardRange } from '@ted/protocol/dashboard'
import { expect, test } from 'vitest'
import { calendarMonth, shiftMonth } from '../src/renderer/calendar.ts'
import {
  customRangeLabel,
  customRangeProblem,
  customStart,
  rangeComparison,
  rememberDashboard,
  rememberedDashboard,
} from '../src/renderer/dashboard.ts'

test('a custom range parses only real dates in order, and survives being remembered', () => {
  expect(dashboardRange('30d')).toBe('30d')
  expect(dashboardRange({ from: '2026-11-03', to: '2026-11-03' })).toEqual({
    from: '2026-11-03',
    to: '2026-11-03',
  })
  for (const bad of [
    { from: '2026-11-04', to: '2026-11-03' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-11-3', to: '2026-11-04' },
    { from: '2026-11-03' },
    'custom',
  ])
    expect(dashboardRange(bad)).toBeUndefined()

  const stored = new Map<string, string>()
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  }
  rememberDashboard({ range: { from: '2026-10-26', to: '2026-11-12' } }, storage)
  expect(rememberedDashboard(storage).range).toEqual({ from: '2026-10-26', to: '2026-11-12' })
  stored.set('ted.dashboard', JSON.stringify({ range: { from: '2026-11-12', to: '2026-10-26' } }))
  expect(rememberedDashboard(storage).range).toBe('30d')
})

test('a custom range is labelled by its dates and compared with the same number of days', () => {
  const now = new Date(2026, 10, 19)
  expect(customRangeLabel({ from: '2026-11-03', to: '2026-11-15' }, now)).toBe('3 Nov – 15 Nov')
  expect(customRangeLabel({ from: '2025-11-03', to: '2025-11-15' }, now)).toBe(
    '3 Nov – 15 Nov 2025',
  )
  expect(customRangeLabel({ from: '2025-12-28', to: '2026-01-04' }, now)).toBe(
    '28 Dec 2025 – 4 Jan 2026',
  )
  expect(customRangeLabel({ from: '2026-11-03', to: '2026-11-03' }, now)).toBe('3 Nov')
  expect(rangeComparison({ from: '2026-11-03', to: '2026-11-15' })).toEqual({
    earlier: 'Previous 13 days',
    against: 'previous 13 days',
    versus: 'vs previous 13 days',
  })
  expect(rangeComparison({ from: '2026-11-03', to: '2026-11-03' }).versus).toBe('vs previous day')
  expect(rangeComparison('30d').versus).toBe('vs previous period')
})

test('the Custom range box checks its dates and starts from the range on screen', () => {
  expect(customRangeProblem('2026-11-03', '2026-11-19', '2026-11-19')).toBeUndefined()
  expect(customRangeProblem('2026-11-19', '2026-11-19', '2026-11-19')).toBeUndefined()
  expect(customRangeProblem('2026-11-03', '2026-11-20', '2026-11-19')).toBe(
    'End can’t be after today.',
  )
  expect(customRangeProblem('2026-11-04', '2026-11-03', '2026-11-19')).toBe(
    'Start must be on or before End.',
  )
  expect(customRangeProblem('', '2026-11-03', '2026-11-19')).toBe('Choose a start and an end date.')

  const now = new Date(2026, 10, 19, 10).getTime()
  const at = (day: number, hours = 0) => new Date(2026, 10, day, hours).toISOString()
  expect(customStart('30d', { from: at(1), to: at(19) }, now)).toEqual({
    from: '2026-11-01',
    to: '2026-11-18',
  })
  expect(customStart('week', { from: at(16), to: at(19, 10) }, now)).toEqual({
    from: '2026-11-16',
    to: '2026-11-19',
  })
  expect(customStart('all', { from: null, to: at(19, 10) }, now)).toEqual({
    from: '2026-11-13',
    to: '2026-11-19',
  })
  const custom = { from: '2026-10-26', to: '2026-11-12' }
  expect(customStart(custom, { from: at(1), to: at(19) }, now)).toBe(custom)
})

test('a calendar month starts on Monday and steps across years', () => {
  expect(calendarMonth('2026-11')).toMatchObject({ lead: 6 })
  expect(calendarMonth('2026-11').days).toHaveLength(30)
  expect(calendarMonth('2026-02').days.at(-1)).toBe('2026-02-28')
  expect(calendarMonth('2028-02').days.at(-1)).toBe('2028-02-29')
  expect(calendarMonth('2026-06')).toMatchObject({ lead: 0 })
  expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  expect(shiftMonth('2026-12', 1)).toBe('2027-01')
})
