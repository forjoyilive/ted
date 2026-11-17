import type { GitHubSetupPlan, IntegrationsHealth } from '@ted/protocol'
import { keyProblem, suggestFactoryName, suggestKey } from '@ted/protocol/factory'
import { setupSteps } from '@ted/protocol/github-setup'
import { describe, expect, test } from 'vitest'
import {
  footer,
  githubProblem,
  moveRow,
  nameProblem,
  protectedFolderNote,
  type RepoRow,
  shortPath,
} from '../src/renderer/add-factory.ts'
import { stepLabel, suggestedRepoName } from '../src/renderer/github-setup.ts'

let n = 0
function row(fields: Partial<RepoRow> = {}): RepoRow {
  return { id: `r${n++}`, text: '', name: '', nameEdited: false, checking: false, ...fields }
}

const ok = (repo: string, notes: string[] = []) =>
  row({
    source: { remote: repo },
    name: repo.split('/')[1] ?? repo,
    check: { repo, name: repo.split('/')[1] ?? repo, ok: true, notes },
  })

const broken = (repo: string) =>
  row({
    source: { remote: repo },
    check: { repo, ok: false, notes: [], problem: { kind: 'not-found', text: 'x', fixes: [] } },
  })

const base = { name: 'Billing', key: 'BL', keyProblem: undefined, github: undefined }

describe('Add Factory footer', () => {
  test('says what happens next when everything is valid', () => {
    expect(footer({ ...base, rows: [ok('kriya/billing-web'), ok('kriya/notebook-api')] })).toEqual({
      text: 'Ted clones both repos, then starts the setup Task BL-1.',
      blocked: false,
      problem: false,
    })
    expect(footer({ ...base, rows: [ok('kriya/app', ['Has Ted settings already.'])] }).text).toBe(
      'Ted clones the repo. The setup Task BL-1 will wait in Backlog.',
    )
  })

  test('counts repo problems and the key', () => {
    const rows = [broken('a/b'), broken('a/c'), broken('a/d'), broken('a/e')]
    expect(footer({ ...base, rows, keyProblem: 'taken' })).toEqual({
      text: 'Fix the 4 repo problems and the key to continue.',
      blocked: true,
      problem: true,
    })
  })

  test('waits for access checks and names rows to fix', () => {
    const sketches = row({
      source: { folder: '/Users/n/Documents/sketches' },
      check: { ok: false, notes: [], problem: { kind: 'no-remote', text: 'x', fixes: [] } },
    })
    const rows = [
      ok('kriya/notebook-app'),
      row({ source: { remote: 'x/y' }, checking: true }),
      sketches,
      row(),
    ]
    expect(footer({ ...base, rows }).text).toBe(
      'Waiting for 1 access check. Fix or remove the sketches row.',
    )
  })

  test('a signed-out GitHub CLI blocks adding', () => {
    const health = {
      github: {
        cli: { state: 'ready', version: '2.89.0' },
        hosts: [{ host: 'github.com', state: 'signed-out', scopes: [], usedBy: [] }],
      },
      git: { state: 'ready' },
      checkedAt: '',
    } as IntegrationsHealth
    const github = githubProblem(health)
    expect(github).toMatchObject({ fix: 'gh-login', host: 'github.com' })
    expect(footer({ ...base, rows: [ok('a/b')], github }).blocked).toBe(true)
  })

  test('an empty primary row asks for a repo', () => {
    expect(footer({ ...base, rows: [row()] })).toMatchObject({ blocked: true, problem: false })
  })
})

describe('Add Factory fields', () => {
  test('key format and uniqueness', () => {
    const factories = [{ key: 'NB', name: 'Notebook' }]
    expect(keyProblem('NB', factories)).toBe('NB is already the key of Notebook.')
    expect(keyProblem('1A', factories)).toMatch(/starting with a letter/)
    expect(keyProblem('ABCDEF', factories)).toMatch(/2 to 5/)
    expect(keyProblem('BL', factories)).toBeUndefined()
  })

  test('names and keys are suggested', () => {
    expect(suggestFactoryName('kriya/billing-web')).toBe('Billing-web')
    expect(suggestKey('Nabha’s Blog')).toBe('NB')
    expect(suggestKey('Billing')).toBe('BL')
    expect(suggestKey('Nabha’s Blog', [{ key: 'NB' }])).toBe('NB2')
  })

  test('repo names must be valid and unique', () => {
    const a = ok('a/web')
    const b = { ...ok('b/web') }
    expect(nameProblem(a, [a, b])).toBe('Another repo has this name.')
    expect(nameProblem({ ...a, name: 'Web' }, [a])).toMatch(/lowercase/)
  })

  test('the primary row stays first', () => {
    expect(moveRow(['p', 'a', 'b'], 2, 1)).toEqual(['p', 'b', 'a'])
    expect(moveRow(['p', 'a', 'b'], 2, 0)).toEqual(['p', 'a', 'b'])
  })

  test('folders under home show with ~', () => {
    expect(shortPath('/Users/n/code/web', '/Users/n')).toBe('~/code/web')
    expect(shortPath('/opt/web', '/Users/n')).toBe('/opt/web')
  })

  test('a folder macOS protects gets a note saying macOS may ask, only on macOS', () => {
    const home = '/Users/n'
    expect(protectedFolderNote('/Users/n/Documents/code/web', home, true)).toContain(
      'your Documents folder',
    )
    expect(protectedFolderNote('/Users/n/Desktop', home, true)).toContain('your Desktop folder')
    expect(protectedFolderNote('/Users/n/Library/Mobile Documents/web', home, true)).toContain(
      'your iCloud Drive',
    )
    expect(protectedFolderNote('/Users/n/Documents-old/web', home, true)).toBeUndefined()
    expect(protectedFolderNote('/Users/n/code/web', home, true)).toBeUndefined()
    expect(protectedFolderNote('/Users/n/Documents/web', home, false)).toBeUndefined()
    expect(protectedFolderNote('/Users/n/Documents/web', undefined, true)).toBeUndefined()
  })
})

describe('GitHub repo setup', () => {
  const plan: GitHubSetupPlan = {
    folder: '/Users/me/Websites/ted and bill',
    git: false,
    commits: false,
    uncommitted: 0,
    files: 216,
    hasIgnoreFile: false,
    leaveOut: [
      { path: 'node_modules/', files: 12, secret: false },
      { path: '/.env', files: 1, secret: true },
    ],
    remoteName: 'origin',
    owners: ['me', 'acme'],
    signedIn: true,
  }
  const choice = {
    owner: 'acme',
    name: 'ted-and-bill',
    description: '',
    branch: 'main',
    leaveOut: ['node_modules/', '/.env'],
  }

  test('the plan lists each step Ted takes, in order', () => {
    const steps = setupSteps(plan, choice)
    expect(steps).toEqual(['init', 'ignore', 'commit', 'create', 'push'])
    expect(steps.map((step) => stepLabel(step, plan, choice))).toEqual([
      'Start git in this folder',
      'Write a .gitignore that leaves out node_modules/ and /.env',
      'Commit 203 files on main as “Initial commit”',
      'Create the private repo acme/ted-and-bill',
      'Add it as the remote origin and push main',
    ])
    const kept = { ...choice, leaveOut: [] }
    expect(setupSteps(plan, kept)).toEqual(['init', 'commit', 'create', 'push'])
    expect(stepLabel('commit', plan, kept)).toBe('Commit 216 files on main as “Initial commit”')
    expect(setupSteps({ ...plan, git: true, commits: true }, choice)).toEqual(['create', 'push'])
  })

  test('the suggested name comes from the folder', () => {
    expect(suggestedRepoName(plan.folder)).toBe('ted-and-bill')
    expect(suggestedRepoName('/x/Notes!')).toBe('Notes')
  })
})
