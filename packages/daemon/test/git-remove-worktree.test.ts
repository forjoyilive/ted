import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { removeWorktree } from '../src/git.ts'

const run = promisify(execFile)
let dir: string
let repo: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-remove-')))
  repo = path.join(dir, 'repo')
  await mkdir(repo)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const git = async (...args: string[]) =>
  (
    await run('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    })
  ).stdout.trim()

test('removing a worktree whose folder is already gone succeeds and forgets it', async () => {
  await git('init', '-q', '--initial-branch=main')
  await writeFile(path.join(repo, 'a.txt'), 'one\n')
  await git('add', '-A')
  await git('commit', '-qm', 'one')
  const kept = path.join(dir, 'kept')
  const gone = path.join(dir, 'gone')
  await git('worktree', 'add', '-q', '-b', 'kept', kept)
  await git('worktree', 'add', '-q', '-b', 'gone', gone)
  await rm(gone, { recursive: true, force: true })

  await removeWorktree(repo, gone)
  expect(await git('worktree', 'list', '--porcelain')).not.toContain(gone)

  await writeFile(path.join(kept, 'b.txt'), 'uncommitted\n')
  await removeWorktree(repo, kept)
  expect(await git('worktree', 'list', '--porcelain')).not.toContain(kept)
  await expect(removeWorktree(repo, path.join(repo, 'a.txt'))).rejects.toThrow()
})
