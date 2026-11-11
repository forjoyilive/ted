import { expect, test } from 'vitest'
import { parseSetTaskSnoozeRequest } from '../src/task.ts'
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
