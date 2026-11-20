import { expect, test } from 'vitest'
import { type PhoneProblemsBody, parsePhoneProblemsBody } from '../src/phone-problems.ts'

test('parsePhoneProblemsBody reads every field and leaves factory out for app-wide problems', () => {
  const body: PhoneProblemsBody = {
    problems: [
      {
        id: 'clone-failed:f1',
        factory: 'Notebook',
        text: 'Couldn’t clone forjoyilive/notebook',
        raisedAt: '2026-11-19T08:55:00.000Z',
      },
      {
        id: 'disk-full:app',
        text: 'Disk full · new work held',
        raisedAt: '2026-11-19T09:30:00.000Z',
      },
    ],
  }
  expect(parsePhoneProblemsBody(JSON.parse(JSON.stringify(body)))).toEqual(body)
})

test('parsePhoneProblemsBody refuses a problem without text', () => {
  expect(() =>
    parsePhoneProblemsBody({ problems: [{ id: 'x', raisedAt: '2026-11-19T09:30:00.000Z' }] }),
  ).toThrow(/text/)
})
