import { expect, test } from 'vitest'
import { crashFrom, maxCrashText, maxCrashType, parseRendererCrash } from '../src/crash-report.ts'

test('a renderer crash reads every field', () => {
  expect(
    parseRendererCrash({
      source: 'render',
      type: 'TypeError',
      message: 'x is undefined',
      stack: 'TypeError: x is undefined\n    at Board (index.js:1:2)',
    }),
  ).toEqual({
    source: 'render',
    type: 'TypeError',
    message: 'x is undefined',
    stack: 'TypeError: x is undefined\n    at Board (index.js:1:2)',
  })
  expect(parseRendererCrash({ source: 'rejection', type: 'NonError', message: 'no' })).toEqual({
    source: 'rejection',
    type: 'NonError',
    message: 'no',
  })
})

test('a renderer crash is cut to size and refused with a bad field', () => {
  const crash = parseRendererCrash({
    source: 'uncaught',
    type: 'T'.repeat(maxCrashType + 5),
    message: 'm'.repeat(maxCrashText + 5),
    stack: 's'.repeat(maxCrashText + 5),
  })
  expect(crash.type).toHaveLength(maxCrashType)
  expect(crash.message).toHaveLength(maxCrashText)
  expect(crash.stack).toHaveLength(maxCrashText)
  const base = { source: 'uncaught', type: 'Error', message: 'boom' }
  expect(() => parseRendererCrash({ ...base, source: 'gone' })).toThrow('source')
  expect(() => parseRendererCrash({ ...base, message: 3 })).toThrow('message')
  expect(() => parseRendererCrash({ ...base, stack: false })).toThrow('stack')
  expect(() => parseRendererCrash('crash')).toThrow('crash')
})

test('crashFrom reads an Error, and keeps no content from any other thrown value', () => {
  const error = new RangeError('too far')
  expect(crashFrom('uncaught', error)).toEqual({
    source: 'uncaught',
    type: 'RangeError',
    message: 'too far',
    stack: error.stack,
  })
  expect(crashFrom('rejection', 'a prompt with secrets')).toEqual({
    source: 'rejection',
    type: 'NonError',
    message: '<text>',
  })
  expect(crashFrom('rejection', { prompt: 'secret' })).toMatchObject({
    type: 'NonError',
    message: '<text>',
  })
})
