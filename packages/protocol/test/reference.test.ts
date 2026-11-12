import { expect, test } from 'vitest'
import { matchReference, shortReference } from '../src/reference.ts'

test('references display six characters and resolve only an exact ID or a unique prefix', () => {
  const a = 'abcdef01-0000-4000-8000-000000000000'
  const b = 'abcdef02-0000-4000-8000-000000000000'
  expect(shortReference(a)).toBe('abcdef')
  expect(shortReference('old')).toBe('old')
  expect(matchReference('abcdef', [a])).toEqual({ kind: 'found', id: a })
  expect(matchReference('abcdef', [a, b])).toEqual({ kind: 'ambiguous' })
  expect(matchReference('abcdef01', [a, b])).toEqual({ kind: 'found', id: a })
  expect(matchReference(a, [a, b])).toEqual({ kind: 'found', id: a })
  expect(matchReference('abcde', [a])).toEqual({ kind: 'missing' })
  expect(matchReference('', [a])).toEqual({ kind: 'missing' })
  expect(matchReference('ffffff', [a])).toEqual({ kind: 'missing' })
  expect(matchReference('abcdef', [a, a])).toEqual({ kind: 'found', id: a })
  expect(matchReference('old', ['old', 'older-id'])).toEqual({ kind: 'found', id: 'old' })
})
