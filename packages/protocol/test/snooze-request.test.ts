import { expect, test } from 'vitest'
import { parseSetTaskSnoozeRequest, parseSnoozeRequestRequest } from '../src/task.ts'
import { requestSnoozePresets } from '../src/time.ts'
import { RequestValidationError } from '../src/validation.ts'

test('parses the entire schedule request and cancellation without carrying unknown fields', () => {
  const until = '2099-11-11T03:45:00.000Z'
  expect(parseSetTaskSnoozeRequest({ snoozedUntil: until, unsafe: true })).toEqual({
    snoozedUntil: until,
  })
  expect(parseSetTaskSnoozeRequest({ snoozedUntil: null })).toEqual({ snoozedUntil: null })
})
test('rejects non-object requests, missing fields, wrong types and invalid instants', () => {
  for (const value of [
    null,
    undefined,
    [],
    1,
    'date',
    {},
    { snoozedUntil: 1 },
    { snoozedUntil: '' },
    { snoozedUntil: '2099-02-30T00:00:00.000Z' },
    { snoozedUntil: '2099-11-11T09:00' },
  ]) {
    expect(() => parseSetTaskSnoozeRequest(value)).toThrow(RequestValidationError)
  }
})

test('parses a request snooze and an unsnooze, and rejects anything else', () => {
  const until = '2099-11-11T03:45:00.000Z'
  expect(parseSnoozeRequestRequest({ until, unsafe: true })).toEqual({ until })
  expect(parseSnoozeRequestRequest({ until: null })).toEqual({ until: null })
  for (const value of [
    null,
    undefined,
    [],
    1,
    'date',
    {},
    { until: 1 },
    { until: '' },
    { until: '2099-02-30T00:00:00.000Z' },
    { until: '2099-11-11T09:00' },
    { snoozedUntil: until },
  ]) {
    expect(() => parseSnoozeRequestRequest(value)).toThrow(RequestValidationError)
  }
})

test('request snooze presets are 9:00 in the given time zone, whatever the machine’s', () => {
  const times = (now: string, zone: string) =>
    Object.fromEntries(requestSnoozePresets(new Date(now), zone).map((p) => [p.id, p.until]))
  expect(
    requestSnoozePresets(new Date('2026-11-12T23:42:00.000Z'), 'America/Los_Angeles').map(
      (p) => p.label,
    ),
  ).toEqual(['An hour from now', 'Tomorrow', 'Next week', 'A month from now'])
  // Thursday 12 November 2026, 15:42 in Los Angeles (UTC-8).
  expect(times('2026-11-12T23:42:00.000Z', 'America/Los_Angeles')).toEqual({
    hour: '2026-11-13T00:42:00.000Z',
    tomorrow: '2026-11-13T17:00:00.000Z',
    'next-week': '2026-11-16T17:00:00.000Z',
    month: '2026-12-12T17:00:00.000Z',
  })
  // The same instant is already Friday 13 November in Kolkata (UTC+5:30).
  expect(times('2026-11-12T23:42:00.000Z', 'Asia/Kolkata')).toMatchObject({
    tomorrow: '2026-11-14T03:30:00.000Z',
    'next-week': '2026-11-16T03:30:00.000Z',
    month: '2026-12-13T03:30:00.000Z',
  })
  // On a Monday, Next week is the Monday after.
  expect(times('2026-11-16T12:00:00.000Z', 'UTC')).toMatchObject({
    tomorrow: '2026-11-17T09:00:00.000Z',
    'next-week': '2026-11-23T09:00:00.000Z',
  })
  // 31 January has no same date in February; the year also rolls over from December.
  expect(times('2027-01-31T12:00:00.000Z', 'UTC')).toMatchObject({
    tomorrow: '2027-02-01T09:00:00.000Z',
    month: '2027-02-28T09:00:00.000Z',
  })
  expect(times('2026-12-31T12:00:00.000Z', 'UTC')).toMatchObject({
    tomorrow: '2027-01-01T09:00:00.000Z',
    month: '2027-01-31T09:00:00.000Z',
  })
})
