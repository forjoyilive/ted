import { describe, expect, test } from 'vitest'
import { isNewer, parseVersion } from './release.ts'

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
