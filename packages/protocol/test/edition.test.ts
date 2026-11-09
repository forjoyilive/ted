import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { edition, identity, tedHome } from '../src/index.ts'

describe('TED Dev and the release', () => {
  test('code run from source is TED Dev', () => {
    expect(edition).toBe('dev')
    expect(identity()).toEqual(identity('dev'))
  })

  test('each edition has its own name, home, and keyring service', () => {
    expect(identity('release')).toEqual({
      edition: 'release',
      name: 'TED',
      homeFolder: '.ted',
      keyringService: 'TED',
    })
    expect(identity('dev')).toEqual({
      edition: 'dev',
      name: 'TED Dev',
      homeFolder: '.ted-dev',
      keyringService: 'TED Dev',
    })
  })

  test('TED Dev defaults to ~/.ted-dev and TED_HOME overrides it', () => {
    expect(tedHome({})).toBe(path.join(homedir(), '.ted-dev'))
    expect(tedHome({}, 'release')).toBe(path.join(homedir(), '.ted'))
    expect(tedHome({ TED_HOME: '/somewhere' }, 'release')).toBe('/somewhere')
    expect(tedHome({ TED_HOME: '/somewhere' })).toBe('/somewhere')
  })
})
