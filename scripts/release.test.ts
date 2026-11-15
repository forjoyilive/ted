import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { checkedCommits, failedTests, fileTimes, summary } from './check.ts'
import {
  builderIdentity,
  changedFiles,
  discardPlan,
  isNewer,
  notaryCredentials,
  type PublishFacts,
  parseVersion,
  pickSigningIdentity,
  publishRefusal,
  type ReleaseRecord,
  releaseFiles,
  signingRefusal,
} from './release.ts'

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

  test('picks only a Developer ID Application identity', () => {
    expect(
      pickSigningIdentity(listing('Apple Development: A (1)', 'Developer ID Application: B (2)')),
    ).toBe('Developer ID Application: B (2)')
    expect(pickSigningIdentity(listing('Apple Development: A (1)'))).toBeUndefined()
    expect(pickSigningIdentity(listing('iPhone Distribution: C (3)'))).toBeUndefined()
    expect(pickSigningIdentity('     0 valid identities found')).toBeUndefined()
  })

  test('hands electron-builder the name without the certificate type', () => {
    expect(builderIdentity('Developer ID Application: B (2)')).toBe('B (2)')
    expect(builderIdentity('B (2)')).toBe('B (2)')
  })
})

describe('signing overrides', () => {
  test('accept only a Developer ID Application identity, and never a certificate file', () => {
    const developerId = 'Developer ID Application: B (2)'
    expect(signingRefusal({})).toBeUndefined()
    expect(signingRefusal({ CSC_NAME: developerId, TED_SIGN_IDENTITY: '' })).toBeUndefined()
    expect(signingRefusal({ TED_SIGN_IDENTITY: developerId })).toBeUndefined()
    expect(signingRefusal({ CSC_NAME: 'Apple Development: A (1)' })).toMatch(/^CSC_NAME must name/)
    expect(signingRefusal({ TED_SIGN_IDENTITY: 'Apple Development: A (1)' })).toMatch(
      /^TED_SIGN_IDENTITY must name/,
    )
    expect(signingRefusal({ CSC_LINK: 'cert.p12', CSC_NAME: developerId })).toMatch(
      /unset CSC_LINK/,
    )
  })
})

describe('notarization credentials', () => {
  test('uses the keychain profile unless the Apple variables are all set', () => {
    expect(notaryCredentials({})).toEqual({ kind: 'profile', name: 'ted-notary' })
    expect(notaryCredentials({ TED_NOTARY_PROFILE: 'mine' })).toEqual({
      kind: 'profile',
      name: 'mine',
    })
    expect(notaryCredentials({ APPLE_KEYCHAIN_PROFILE: 'set' })).toEqual({
      kind: 'profile',
      name: 'set',
    })
    expect(notaryCredentials({ APPLE_API_KEY: 'k.p8', APPLE_API_KEY_ID: 'id' })).toEqual({
      kind: 'profile',
      name: 'ted-notary',
    })
    expect(
      notaryCredentials({ APPLE_API_KEY: 'k.p8', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'i' }),
    ).toEqual({ kind: 'environment' })
    expect(
      notaryCredentials({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 't' }),
    ).toEqual({ kind: 'environment' })
  })
})

describe('release files', () => {
  test('publishes the installers, their blockmaps and the update feed only', () => {
    expect(
      releaseFiles([
        'TED-1.2.0-arm64.dmg',
        'TED-1.2.0-arm64.dmg.blockmap',
        'TED-1.2.0-arm64-mac.zip',
        'TED-1.2.0-arm64-mac.zip.blockmap',
        'latest-mac.yml',
        'builder-debug.yml',
        'ted-release.json',
        'mac-arm64',
      ]),
    ).toEqual([
      'TED-1.2.0-arm64.dmg',
      'TED-1.2.0-arm64.dmg.blockmap',
      'TED-1.2.0-arm64-mac.zip',
      'TED-1.2.0-arm64-mac.zip.blockmap',
      'latest-mac.yml',
    ])
  })

  test('names files added, removed or changed since the build', () => {
    const record = { version: '1.2.0', base: 'b', commit: 'c', files: { a: '1', b: '2' } }
    expect(changedFiles(record, { a: '1', b: '2' })).toEqual([])
    expect(changedFiles(record, { a: '1', b: '3', c: '4' })).toEqual(['b', 'c'])
    expect(changedFiles(record, { a: '1' })).toEqual(['b'])
  })
})

describe('publishing a release', () => {
  const record: ReleaseRecord = {
    version: '1.2.0',
    base: 'base',
    commit: 'release',
    files: { 'latest-mac.yml': 'x' },
  }
  const ready: PublishFacts = {
    record,
    head: 'release',
    localTag: 'release',
    remoteTag: undefined,
    changed: [],
    visibility: 'PUBLIC',
  }

  test('publishes the build that was tried, from where it was built', () => {
    expect(publishRefusal(ready)).toBeUndefined()
    expect(publishRefusal({ ...ready, remoteTag: 'release' })).toBeUndefined()
  })

  test('refuses anything that would publish something other than the tried build', () => {
    const refused = (change: Partial<PublishFacts>) => publishRefusal({ ...ready, ...change })
    expect(refused({ record: undefined })).toMatch(/no build to publish/)
    expect(refused({ record: { ...record, files: {} } })).toMatch(/didn’t finish/)
    expect(refused({ head: 'other' })).toMatch(/release checkout isn’t at the commit/)
    expect(refused({ localTag: undefined })).toMatch(/tag v1\.2\.0 isn’t at the commit/)
    expect(refused({ changed: ['latest-mac.yml'] })).toMatch(/latest-mac\.yml; build again/)
    expect(refused({ remoteTag: 'other' })).toMatch(/already on GitHub at another commit/)
    expect(refused({ visibility: 'PRIVATE' })).toMatch(/is private/)
  })
})

describe('discarding a build', () => {
  const record: ReleaseRecord = { version: '1.2.0', base: 'base', commit: 'release', files: {} }

  test('deletes the tag and undoes the release commit while it is checked out', () => {
    expect(discardPlan({ record, head: 'release', remoteTag: undefined })).toEqual({
      tag: 'v1.2.0',
      resetTo: 'base',
    })
    expect(discardPlan({ record, head: 'later', remoteTag: undefined })).toEqual({
      tag: 'v1.2.0',
      resetTo: undefined,
    })
    expect(
      discardPlan({ record: { ...record, commit: 'base' }, head: 'base', remoteTag: undefined }),
    ).toEqual({ tag: 'v1.2.0', resetTo: undefined })
  })

  test('refuses once the tag is on GitHub, or with nothing built', () => {
    expect(discardPlan({ record, head: 'release', remoteTag: 'release' })).toEqual({
      refusal: 'v1.2.0 is already on GitHub; fix the problem in a new version instead',
    })
    expect(discardPlan({ record: undefined, head: 'x', remoteTag: undefined })).toEqual({
      refusal: 'there’s no build to discard',
    })
  })
})
