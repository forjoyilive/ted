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

test('a GitHub issue is keyed by owner, repo and number, whatever the case or trailing parts', () => {
  const key = sourceKey('https://github.com/acme/widgets/issues/12')
  expect(key).toBe('github:acme/widgets#12')
  for (const same of [
    'https://github.com/Acme/Widgets/issues/12',
    'https://www.github.com/acme/widgets/issues/12/',
    'https://GitHub.com/acme/widgets/issues/12?q=is%3Aopen',
    'https://github.com/acme/widgets/issues/12#issuecomment-99',
    '  https://github.com/acme/widgets/issues/12  ',
  ]) {
    expect(sourceKey(same), same).toBe(key)
  }
  expect(sourceKey('https://github.com/acme/widgets/issues/13')).not.toBe(key)
  expect(sourceKey('https://github.com/acme/widgets/pull/12')).not.toMatch(/^github:/)
  expect(sourceKey('https://github.com/acme/widgets/discussions/12')).not.toMatch(/^github:/)
  expect(sourceKey('http://github.com/acme/widgets/issues/12')).not.toMatch(/^github:/)
  expect(sourceKey('https://github.example.com/acme/widgets/issues/12')).not.toMatch(/^github:/)
})
