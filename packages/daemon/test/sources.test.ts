import { expect, test } from 'vitest'
import { sourceKey } from '../src/tasks/sources.ts'

test('two URLs for the same source have one key', () => {
  const key = sourceKey('https://sentry.example.com/issues/4821')
  for (const same of [
    'https://sentry.example.com/issues/4821/',
    'https://sentry.example.com/issues/4821//',
    'https://sentry.example.com/issues/4821?project=7',
    'https://sentry.example.com/issues/4821/?project=7#events',
    'https://SENTRY.example.com/issues/4821',
    'http://www.sentry.example.com/issues/4821',
  ]) {
    expect(sourceKey(same), same).toBe(key)
  }
  expect(sourceKey('https://sentry.example.com/issues/4822')).not.toBe(key)
  expect(sourceKey('https://sentry.example.com/issues/4821/events')).not.toBe(key)
})

test('a Linear issue is keyed by workspace and identifier, whatever its title slug', () => {
  const key = sourceKey('https://linear.app/acme/issue/ENG-12/fix-the-login')
  expect(key).toBe('linear:acme/ENG-12')
  expect(sourceKey('https://linear.app/Acme/issue/eng-12/renamed-since')).toBe(key)
  expect(sourceKey('https://linear.app/acme/issue/ENG-13/fix-the-login')).not.toBe(key)
})

test('text that isn’t a URL is its own key, trimmed', () => {
  expect(sourceKey('  ticket 42 ')).toBe('ticket 42')
})
