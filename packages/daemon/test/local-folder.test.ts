import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkFolder, updateFolder } from '../src/chats/local-folder.ts'

const run = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const git = async (cwd: string, ...args: string[]) =>
  (await run('git', args, { cwd, env })).stdout.trim()

let scratch: string, origin: string, seed: string, local: string, clone: string
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-local-folder-')))
  origin = path.join(scratch, 'origin.git')
  seed = path.join(scratch, 'seed')
  local = path.join(scratch, 'local')
  clone = path.join(scratch, 'clone')
  await mkdir(origin)
  await git(origin, 'init', '--bare', '--initial-branch=main')
  await mkdir(seed)
  await git(seed, 'init', '--initial-branch=main')
  await git(seed, 'remote', 'add', 'origin', origin)
  await commit(seed, 'README.md', '# widgets\n')
  await git(seed, 'push', 'origin', 'main')
  await git(scratch, 'clone', '--quiet', origin, local)
  await git(scratch, 'clone', '--quiet', origin, clone)
})
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function commit(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await writeFile(path.join(dir, file), content)
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '--quiet', '-m', `change ${file}`)
}

async function pushed(file: string, content: string): Promise<void> {
  await commit(seed, file, content)
  await git(seed, 'push', '--quiet', 'origin', 'HEAD')
}

test('a clean folder behind main is fast-forwarded to the commit Ted checked, and changed dependency files are named', async () => {
  expect(await checkFolder({ folder: local, clone })).toMatchObject({ checked: true, main: 'main' })
  expect((await checkFolder({ folder: local, clone })).behind).toBeUndefined()

  await pushed('package.json', '{}\n')
  await pushed('src/a.ts', 'export {}\n')
  const before = await git(local, 'rev-parse', 'HEAD')
  const check = await checkFolder({ folder: local, clone })
  expect(check).toMatchObject({
    checked: true,
    branch: 'main',
    against: 'main',
    head: before,
    target: await git(seed, 'rev-parse', 'HEAD'),
    behind: 2,
  })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(before)
  expect(await git(local, 'rev-parse', 'origin/main')).toBe(before)

  const update = await updateFolder(local, check, clone)
  expect(update).toEqual({
    from: before,
    to: check.target,
    commits: 2,
    dependencies: ['package.json'],
  })
  expect(await git(local, 'rev-parse', 'HEAD')).toBe(check.target)
  expect(await git(local, 'status', '--porcelain')).toBe('')
})

test('uncommitted changes, own commits, other branches and a non-repo folder are reported without touching the folder', async () => {
  await pushed('b.txt', 'b\n')
  await writeFile(path.join(local, 'README.md'), 'edited\n')
  await writeFile(path.join(local, 'untracked.txt'), 'new\n')
  expect(await checkFolder({ folder: local, clone })).toMatchObject({ behind: 1, uncommitted: 1 })
  await git(local, 'checkout', '--quiet', '--', 'README.md')

  const head = await git(local, 'rev-parse', 'HEAD')
  await commit(local, 'mine.txt', 'mine\n')
  const own = await checkFolder({ folder: local, clone })
  expect(own).toMatchObject({ behind: 1, ahead: 1 })
  expect(own.uncommitted).toBeUndefined()

  await git(local, 'reset', '--quiet', '--hard', head)
  await git(seed, 'checkout', '--quiet', '-b', 'fix-x')
  await pushed('c.txt', 'c\n')
  await git(local, 'fetch', '--quiet', 'origin')
  await git(local, 'checkout', '--quiet', '-b', 'fix-x', 'origin/fix-x')
  await pushed('d.txt', 'd\n')
  expect(await checkFolder({ folder: local, clone })).toMatchObject({
    branch: 'fix-x',
    against: 'fix-x',
    behind: 1,
  })

  await git(local, 'checkout', '--quiet', '-b', 'only-here')
  const off = await checkFolder({ folder: local, clone })
  expect(off).toMatchObject({ branch: 'only-here', against: 'main', offGitHub: true })
  expect(off.behind).toBeUndefined()

  const plain = path.join(scratch, 'plain')
  await mkdir(plain)
  expect(await checkFolder({ folder: plain, clone })).toEqual({
    checked: false,
    problem: 'the folder isn’t a git repository with a commit',
  })
})

test('the chat’s own copy is counted against main', async () => {
  const copy = path.join(scratch, 'copy')
  await git(clone, 'worktree', 'add', '--quiet', '--detach', copy, 'origin/main')
  await pushed('e.txt', 'e\n')
  await git(local, 'pull', '--quiet', '--ff-only')
  expect(await checkFolder({ folder: local, clone, copy })).toMatchObject({ copyBehind: 1 })
})
