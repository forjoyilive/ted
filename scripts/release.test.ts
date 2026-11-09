import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { checkedCommits, failedTests, fileTimes, summary } from './check.ts'
import { isNewer, parseVersion, pickSigningIdentity } from './release.ts'

describe('release versions', () => {
  test('reads plain versions only', () => {
    expect(parseVersion('1.4.0')).toEqual([1, 4, 0])
    expect(parseVersion('v1.4.0')).toBeUndefined()
    expect(parseVersion('1.4')).toBeUndefined()
    expect(parseVersion('1.4.0-beta.1')).toBeUndefined()
  })

  test('a release must be newer than the current version', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('0.1.10', '0.1.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.0.9', '0.1.0')).toBe(false)
    expect(isNewer('junk', '0.1.0')).toBe(false)
  })
})

describe('checked commits', () => {
  test('reads full commit hashes, one per line, and ignores anything else', () => {
    const sha = 'e3e1150'.padEnd(40, '0')
    expect(checkedCommits(`${sha}\nnot-a-sha\n\n${sha}\n`)).toEqual(new Set([sha]))
  })
})

describe('check output', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const report = {
    testResults: [
      {
        name: path.join(root, 'packages/app/test/app.test.ts'),
        startTime: 1_000,
        endTime: 61_000,
        assertionResults: [
          { fullName: 'TED app launches', status: 'passed' },
          { fullName: 'TED app quits', status: 'failed' },
        ],
      },
    ],
  }

  test('times each test file from the JSON report', () => {
    expect(fileTimes([report, {}])).toEqual({ 'packages/app/test/app.test.ts': 60_000 })
  })

  test('names the failed tests with their file', () => {
    expect(failedTests(report)).toEqual(['packages/app/test/app.test.ts > TED app quits'])
  })

  test('the summary starts at Vitest’s Test Files line', () => {
    const output =
      ' ✓ a.test.ts\n\x1b[2m Test Files \x1b[22m 1 passed (1)\n      Tests  3 passed (3)\n'
    expect(summary(output)).toBe(
      '\x1b[2m Test Files \x1b[22m 1 passed (1)\n      Tests  3 passed (3)',
    )
  })
})

describe('signing identity', () => {
  const listing = (...names: string[]) =>
    names.map((name, i) => `  ${i + 1}) ${'A'.repeat(40)} "${name}"`).join('\n')

  test('prefers a Developer ID, then an Apple Development identity', () => {
    expect(
      pickSigningIdentity(listing('Apple Development: A (1)', 'Developer ID Application: B (2)')),
    ).toBe('Developer ID Application: B (2)')
    expect(pickSigningIdentity(listing('Apple Development: A (1)'))).toBe(
      'Apple Development: A (1)',
    )
  })

  test('ignores other identities and finds none in an empty listing', () => {
    expect(pickSigningIdentity(listing('iPhone Distribution: C (3)'))).toBeUndefined()
    expect(pickSigningIdentity('     0 valid identities found')).toBeUndefined()
  })
})
