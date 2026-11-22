import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { edition, identity, tedHome } from '../src/index.ts'

describe('Ted Dev and the release', () => {
  test('code run from source is Ted Dev', () => {
    expect(edition).toBe('dev')
    expect(identity()).toEqual(identity('dev'))
  })

  test('each edition has its own name, home, sample home and keyring service', () => {
    expect(identity('release')).toEqual({
      edition: 'release',
      name: 'Ted',
      homeFolder: '.ted',
      sampleFolder: '.ted-sample',
      keyringService: 'TED',
    })
    expect(identity('dev')).toEqual({
      edition: 'dev',
      name: 'Ted Dev',
      homeFolder: '.ted-dev',
      sampleFolder: '.ted-dev-demo',
      keyringService: 'TED Dev',
    })
  })

  test('Ted Dev defaults to ~/.ted-dev and TED_HOME overrides it', () => {
    expect(tedHome({})).toBe(path.join(homedir(), '.ted-dev'))
    expect(tedHome({}, 'release')).toBe(path.join(homedir(), '.ted'))
    expect(tedHome({ TED_HOME: '/somewhere' }, 'release')).toBe('/somewhere')
    expect(tedHome({ TED_HOME: '/somewhere' })).toBe('/somewhere')
  })
})
