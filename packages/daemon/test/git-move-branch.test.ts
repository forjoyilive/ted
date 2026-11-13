import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { moveBranchTo } from '../src/git.ts'

const run = promisify(execFile)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-move-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const git = async (...args: string[]) =>
  (
    await run('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    })
  ).stdout.trim()

test('moving the branch never runs filters or hooks from the repo’s own config', async () => {
  const marker = path.join(dir, '..', `${path.basename(dir)}-ran`)
  await git('init', '-q', '--initial-branch=main')
  await writeFile(path.join(dir, '.gitattributes'), '*.txt filter=evil\n')
  await writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git('add', '-A')
  await git('commit', '-qm', 'one')
  const first = await git('rev-parse', 'HEAD')
  await writeFile(path.join(dir, 'a.txt'), 'two\n')
  await git('commit', '-qam', 'two')
  const second = await git('rev-parse', 'HEAD')
  await git('reset', '-q', '--hard', first)
  await git('config', 'filter.evil.smudge', `touch '${marker}'; cat`)
  await git('config', 'filter.evil.clean', `touch '${marker}'; cat`)
  await git('config', 'filter.evil.process', `touch '${marker}'`)
  await git('config', 'filter.evil.required', 'true')
  await git('config', 'core.hooksPath', '.hooks')

  await moveBranchTo(dir, second)

  expect(await git('rev-parse', 'HEAD')).toBe(second)
  expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n')
  await expect(access(marker)).rejects.toThrow()
})

test('moving the branch writes only the worktree, ignores replace refs and undoes a move from a commit it didn’t check', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'ted-move-outside-'))
  try {
    await git('init', '-q', '--initial-branch=main')
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    await git('add', '-A')
    await git('commit', '-qm', 'one')
    const first = await git('rev-parse', 'HEAD')
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await git('commit', '-qam', 'two')
    const second = await git('rev-parse', 'HEAD')
    await writeFile(path.join(dir, 'a.txt'), 'evil\n')
    await git('commit', '-qam', 'evil')
    const evil = await git('rev-parse', 'HEAD')
    await git('reset', '-q', '--hard', first)
    await git('replace', second, evil)
    await git('config', 'core.worktree', outside)

    expect(await moveBranchTo(dir, second, first)).toBe(true)

    await git('config', '--unset', 'core.worktree')
    expect(await git('rev-parse', 'HEAD')).toBe(second)
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n')
    await expect(access(path.join(outside, 'a.txt'))).rejects.toThrow()

    await git('replace', '-d', second)
    await git('reset', '-q', '--hard', first)
    expect(await moveBranchTo(dir, second, evil)).toBe(false)
    expect(await git('rev-parse', 'HEAD')).toBe(first)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})
