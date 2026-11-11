import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { copyFiles } from '../src/tasks/worktree.ts'

let scratch: string
let localFolder: string
let worktree: string

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-copy-'))
  localFolder = path.join(scratch, 'local')
  worktree = path.join(scratch, 'worktree')
  await mkdir(localFolder)
  await mkdir(worktree)
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

test('copies named files and glob matches into the worktree and reports a pattern that matches nothing', async () => {
  await writeFile(path.join(localFolder, '.env'), 'SECRET=1\n')
  await mkdir(path.join(localFolder, 'config'))
  await writeFile(path.join(localFolder, 'config', 'master.key'), 'key\n')
  await writeFile(path.join(localFolder, 'config', 'other.key'), 'other\n')
  await writeFile(path.join(localFolder, 'config', 'notes.txt'), 'notes\n')

  const result = await copyFiles(localFolder, worktree, ['.env', 'config/*.key', 'absent.txt'])

  expect(result).toEqual({
    copied: ['.env', 'config/master.key', 'config/other.key'],
    skipped: [{ path: 'absent.txt', reason: 'missing' }],
  })
  expect(await readFile(path.join(worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
  expect(await readFile(path.join(worktree, 'config', 'master.key'), 'utf8')).toBe('key\n')
  expect(await readFile(path.join(worktree, 'config', 'other.key'), 'utf8')).toBe('other\n')
  expect(await exists(path.join(worktree, 'config', 'notes.txt'))).toBe(false)
  expect(await exists(path.join(worktree, 'absent.txt'))).toBe(false)
})

test('no patterns copies nothing and skips nothing, even without a local folder', async () => {
  expect(await copyFiles(undefined, worktree, [])).toEqual({ copied: [], skipped: [] })
  expect(await copyFiles(path.join(scratch, 'nope'), worktree, [])).toEqual({
    copied: [],
    skipped: [],
  })
})

test('every pattern is skipped when the Factory has no local folder, or the folder is gone or is a file', async () => {
  await writeFile(path.join(scratch, 'a-file'), 'not a folder\n')

  expect(await copyFiles(undefined, worktree, ['.env', 'config/*.key'])).toEqual({
    copied: [],
    skipped: [
      { path: '.env', reason: 'no-local-folder' },
      { path: 'config/*.key', reason: 'no-local-folder' },
    ],
  })
  for (const folder of [path.join(scratch, 'nope'), path.join(scratch, 'a-file')]) {
    expect(await copyFiles(folder, worktree, ['.env', 'config/*.key']), folder).toEqual({
      copied: [],
      skipped: [
        { path: '.env', reason: 'local-folder-missing' },
        { path: 'config/*.key', reason: 'local-folder-missing' },
      ],
    })
  }
  expect(await exists(path.join(worktree, '.env'))).toBe(false)
})

test('copy never reads outside the local folder or writes outside the worktree', async () => {
  const secret = path.join(scratch, 'secret.txt')
  await writeFile(secret, 'secret\n')
  await symlink(secret, path.join(localFolder, 'linked.txt'))
  await writeFile(path.join(localFolder, 'inside.txt'), 'ok\n')
  await mkdir(path.join(localFolder, 'out'))
  await writeFile(path.join(localFolder, 'out', 'inside.txt'), 'escaped\n')
  const elsewhere = path.join(scratch, 'elsewhere')
  await mkdir(elsewhere)
  await symlink(elsewhere, path.join(worktree, 'out'))

  const result = await copyFiles(localFolder, worktree, [
    '../secret.txt',
    '/etc/hosts',
    'linked.txt',
    'out/inside.txt',
    'inside.txt',
  ])

  expect(result.copied).toEqual(['inside.txt'])
  expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([
    ['../secret.txt', 'outside'],
    ['/etc/hosts', 'outside'],
    ['linked.txt', 'outside'],
    ['out/inside.txt', 'outside'],
  ])
  expect(await readFile(path.join(worktree, 'inside.txt'), 'utf8')).toBe('ok\n')
  expect(await exists(path.join(elsewhere, 'inside.txt'))).toBe(false)
  expect(await exists(path.join(worktree, 'linked.txt'))).toBe(false)
  expect(await exists(path.join(worktree, 'secret.txt'))).toBe(false)
  expect(await exists(path.join(worktree, 'hosts'))).toBe(false)
})

test('a link already at the destination is not written through, and a matched folder is not copied', async () => {
  const victim = path.join(scratch, 'victim.txt')
  await writeFile(victim, 'untouched\n')
  await writeFile(path.join(localFolder, '.env'), 'A=1\n')
  await symlink(victim, path.join(worktree, '.env'))
  await mkdir(path.join(localFolder, 'config'))

  const result = await copyFiles(localFolder, worktree, ['.env', 'config'])

  expect(result).toEqual({
    copied: [],
    skipped: [
      { path: '.env', reason: 'outside' },
      { path: 'config', reason: 'not-a-file' },
    ],
  })
  expect(await readFile(victim, 'utf8')).toBe('untouched\n')
  expect(await exists(path.join(worktree, 'config'))).toBe(false)
})

test('a file already in the worktree is replaced by the local folder’s copy', async () => {
  await writeFile(path.join(localFolder, '.env'), 'A=2\n')
  await writeFile(path.join(worktree, '.env'), 'A=1\n')

  const result = await copyFiles(localFolder, worktree, ['.env'])

  expect(result).toEqual({ copied: ['.env'], skipped: [] })
  expect(await readFile(path.join(worktree, '.env'), 'utf8')).toBe('A=2\n')
})
