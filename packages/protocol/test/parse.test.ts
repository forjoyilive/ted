import { expect, test } from 'vitest'
import {
  isArray,
  isBoolean,
  isInteger,
  isNumber,
  isObject,
  isOneOf,
  isString,
  ParseError,
  parseJson,
  reader,
} from '../src/parse.ts'

test('checks tell the kinds of value apart', () => {
  const values = ['a', '', 1, 1.5, Number.NaN, Infinity, 2 ** 53, true, null, undefined, [], {}]
  const passing = (check: (value: (typeof values)[number]) => boolean) => values.filter(check)
  expect(passing(isString)).toEqual(['a', ''])
  expect(passing(isNumber)).toEqual([1, 1.5, 2 ** 53])
  expect(passing(isInteger)).toEqual([1])
  expect(passing(isBoolean)).toEqual([true])
  expect(passing(isObject)).toEqual([{}])
  expect(passing(isArray)).toEqual([[]])
  expect(isOneOf('b', ['a', 'b'])).toBe(true)
  expect(isOneOf('c', ['a', 'b'])).toBe(false)
  expect(isOneOf(1, ['1'])).toBe(false)
})

test('parseJson returns the value, or undefined for text that isn’t JSON', () => {
  expect(parseJson('{"a":[1,"b",null]}')).toEqual({ a: [1, 'b', null] })
  expect(parseJson('"text"')).toBe('text')
  expect(parseJson('{')).toBeUndefined()
  expect(parseJson('')).toBeUndefined()
})

test('readers return each field and name it in their default errors', () => {
  const read = reader()
  const body = read.object({ s: 'x', n: 1.5, i: 3, b: false, l: [1], k: 'two' }, 'body')
  expect(read.string(body, 's')).toBe('x')
  expect(read.number(body, 'n')).toBe(1.5)
  expect(read.integer(body, 'i')).toBe(3)
  expect(read.boolean(body, 'b')).toBe(false)
  expect(read.list(body, 'l')).toEqual([1])
  expect(read.oneOf(body, 'k', ['one', 'two'])).toBe('two')
  expect(read.optional(body, 's', read.string)).toBe('x')
  expect(read.optional(body, 'missing', read.string)).toBeUndefined()

  expect(() => read.object([], 'body')).toThrow('body must be an object')
  expect(() => read.object(null, 'body')).toThrow(ParseError)
  expect(() => read.string(body, 'n')).toThrow('n must be text')
  expect(() => read.number(body, 's')).toThrow('s must be a number')
  expect(() => read.integer(body, 'n')).toThrow('n must be a whole number')
  expect(() => read.boolean(body, 's')).toThrow('s must be true or false')
  expect(() => read.list(body, 's')).toThrow('s must be a list')
  expect(() => read.oneOf(body, 's', ['one', 'two'])).toThrow('s must be one of one, two')
  expect(() => read.optional({ s: null }, 's', read.string)).toThrow('s must be text')
  expect(() => read.string(body, 'missing')).toThrow(
    expect.objectContaining({ field: 'missing', message: 'missing must be text' }),
  )
})

test('a reader uses the given message and failure', () => {
  class Refused extends Error {}
  const read = reader((message, field) => {
    throw new Refused(`${field}: ${message}`)
  })
  expect(() => read.string({}, 'name', 'name is required')).toThrow('name: name is required')
  expect(() => read.string({}, 'name')).toThrow(Refused)
})
