import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { changesBetween } from '../src/git.ts'

const run = promisify(execFile)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-changes-test-'))
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

const commit = async (files: Record<string, string>, message: string) => {
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
  await git('add', '-A')
  await git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}

test('changes since sign-off leave out what the base added, after a rebase', async () => {
  await git('init', '-q', '--initial-branch=main')
  await commit({ 'search.ts': 'a\nb\nc\n', 'other.ts': 'x\n' }, 'base')
  await git('checkout', '-qb', 'task')
  const approved = await commit({ 'search.ts': 'a\nb\nc\nguard\n' }, 'guard')
  await git('checkout', '-q', 'main')
  await commit({ 'other.ts': 'x\ny\nz\n' }, 'main moved')
  const baseTip = await git('rev-parse', 'main')
  await git('checkout', '-q', 'task')
  await git('rebase', '-q', 'main')
  const head = await commit({ 'search.test.ts': 'test\ntest\n' }, 'test')
  const marker = path.join(dir, '..', `${path.basename(dir)}-ran`)
  await git('config', 'diff.external', `touch '${marker}'`)

  const changes = await changesBetween(dir, { from: approved, to: head, baseTip })

  expect(changes).toEqual([{ path: 'search.test.ts', added: 2, removed: 0 }])
  await expect(access(marker)).rejects.toThrow()
})

test('with no trusted base, a rebase shows everything that differs, never less', async () => {
  await git('init', '-q', '--initial-branch=main')
  await commit({ 'search.ts': 'a\n', 'other.ts': 'x\n' }, 'base')
  await git('checkout', '-qb', 'task')
  const approved = await commit({ 'search.ts': 'a\nguard\n' }, 'guard')
  await git('checkout', '-q', 'main')
  await commit({ 'other.ts': 'x\ny\n' }, 'main moved')
  await git('checkout', '-q', 'task')
  await git('rebase', '-q', 'main')
  const head = await git('rev-parse', 'HEAD')

  const changes = await changesBetween(dir, { from: approved, to: head })

  expect(changes).toEqual([{ path: 'other.ts', added: 1, removed: 0 }])
})

test('no changes when the head is the approved commit', async () => {
  await git('init', '-q', '--initial-branch=main')
  const only = await commit({ 'a.ts': 'a\n' }, 'one')
  expect(await changesBetween(dir, { from: only, to: only })).toEqual([])
})
