import { expect, test } from 'vitest'
import {
  isReportEmail,
  maxProblemDescription,
  parseProblemReportRequest,
  withinDescriptionLimit,
} from '../src/problem-report.ts'

test('a problem report request reads every field and trims the text', () => {
  expect(
    parseProblemReportRequest({
      description: '  The Board froze.  ',
      email: ' me@example.com ',
      includeLog: false,
    }),
  ).toEqual({ description: 'The Board froze.', email: 'me@example.com', includeLog: false })
  expect(parseProblemReportRequest({ description: 'x', email: '', includeLog: true })).toEqual({
    description: 'x',
    email: '',
    includeLog: true,
  })
})

test('a problem report request is refused without a description, with a bad email or a bad field', () => {
  const base = { description: 'x', email: '', includeLog: true }
  expect(() => parseProblemReportRequest({ ...base, description: '   ' })).toThrow(
    'Write what happened first.',
  )
  expect(() =>
    parseProblemReportRequest({ ...base, description: 'x'.repeat(maxProblemDescription + 1) }),
  ).toThrow('Keep what happened under 4,096 characters.')
  expect(() => parseProblemReportRequest({ ...base, email: 'not an email' })).toThrow(
    'Enter an email address, or leave it empty.',
  )
  expect(() => parseProblemReportRequest({ ...base, includeLog: 'yes' })).toThrow('includeLog')
  expect(() => parseProblemReportRequest({ ...base, email: undefined })).toThrow('email')
  expect(() => parseProblemReportRequest('report')).toThrow('request')
})

test('the description limit is Sentry’s 4,096 code points, not UTF-16 units', () => {
  const emoji = '🙂'.repeat(maxProblemDescription)
  expect(emoji.length).toBe(maxProblemDescription * 2)
  expect(
    parseProblemReportRequest({ description: emoji, email: '', includeLog: true }).description,
  ).toBe(emoji)
  expect(withinDescriptionLimit(`${emoji}🙂`)).toBe(emoji)
  expect(withinDescriptionLimit('short')).toBe('short')
})

test('a report email is empty or one address', () => {
  expect(isReportEmail('')).toBe(true)
  expect(isReportEmail('a@b.co')).toBe(true)
  expect(isReportEmail('a@b')).toBe(false)
  expect(isReportEmail('a b@c.co')).toBe(false)
  expect(isReportEmail(`${'a'.repeat(250)}@b.co`)).toBe(false)
})
