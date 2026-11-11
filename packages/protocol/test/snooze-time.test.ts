import { expect, test } from 'vitest'
import { dateTimeFields, dateTimeInZone } from '../src/time.ts'

test('converts app-zone dates independently of system zone and round-trips them', () => {
  const at = dateTimeInZone('2026-11-11', '09:15', 'Asia/Kolkata')
  expect(at).toBe('2026-11-11T03:45:00.000Z')
  expect(dateTimeFields(new Date(at), 'Asia/Kolkata')).toEqual({
    date: '2026-11-11',
    time: '09:15',
  })
  expect(dateTimeInZone('2026-11-11', '09:15', 'UTC')).toBe('2026-11-11T09:15:00.000Z')
})
test('rejects invalid dates and DST gaps and chooses the earlier occurrence of a repeated time', () => {
  for (const date of ['2026-02-30', 'wrong'])
    expect(() => dateTimeInZone(date, '09:00', 'UTC')).toThrow('valid date')
  expect(() => dateTimeInZone('2026-03-08', '02:30', 'America/Los_Angeles')).toThrow(
    'does not exist',
  )
  expect(dateTimeInZone('2026-11-01', '01:30', 'America/Los_Angeles')).toBe(
    '2026-11-01T08:30:00.000Z',
  )
  expect(dateTimeInZone('2026-04-05', '01:45', 'Australia/Lord_Howe')).toBe(
    '2026-04-04T14:45:00.000Z',
  )
})
