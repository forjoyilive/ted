import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { discardCopy, makeCopy, removeCopy } from '../src/code-copy.ts'
import type { StoredFactory } from '../src/store/index.ts'
import type { FactoryRepoEntry } from '../src/tasks/repos.ts'
import { makeOriginRepo } from './helpers.ts'

const execFileAsync = promisify(execFile)
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync('git', args, { cwd, env: gitEnv })).stdout.trim()

let scratch: string | undefined
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

async function setUp() {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-code-copy-'))
  const origin = await makeOriginRepo(scratch)
  const first = await git(path.join(scratch, 'seed'), 'rev-parse', 'HEAD')
  await writeFile(path.join(scratch, 'seed', 'second.txt'), 'second\n')
  await git(path.join(scratch, 'seed'), 'add', 'second.txt')
  await git(path.join(scratch, 'seed'), 'commit', '-m', 'second')
  await git(path.join(scratch, 'seed'), 'push', origin, 'main')
  const tip = await git(path.join(scratch, 'seed'), 'rev-parse', 'HEAD')
  const reposDir = path.join(scratch, 'repos')
  const clone = path.join(reposDir, 'acme', 'widgets')
  await mkdir(path.dirname(clone), { recursive: true })
  await git(scratch, 'clone', origin, clone)
  const local = path.join(scratch, 'local')
  await mkdir(local)
  await writeFile(path.join(local, '.env'), 'KEY=1\n')
  const folder = path.join(scratch, 'copy')
  await mkdir(folder)
  const store = { localFolder: (repo: string) => (repo === 'acme/widgets' ? local : undefined) }
  return { first, tip, reposDir, clone, folder, deps: { reposDir, store } }
}

function entry(name: string, fields: Partial<FactoryRepoEntry> = {}): FactoryRepoEntry {
  return {
    name,
    repo: 'acme/widgets',
    cloneUrl: 'unused',
    primary: false,
    env: {},
    copy: ['.env'],
    ...fields,
  }
}

const factory = { id: 'f1', repo: 'acme/widgets' } as StoredFactory

test('a copy has each repo at its base branch tip, the primary at a given commit, with copied files', async () => {
  const { first, tip, clone, folder, deps } = await setUp()
  const made = await makeCopy(deps, {
    folder,
    factory,
    entries: [entry('app', { primary: true }), entry('docs', { baseBranch: 'main' })],
    branch: 'base',
    commit: first,
    clone: 'existing',
    fetch: 'none',
    copyFiles: 'required',
  })
  expect(made.map((m) => [m.entry.name, m.clone, m.worktree])).toEqual([
    ['app', clone, path.join(folder, 'app')],
    ['docs', clone, path.join(folder, 'docs')],
  ])
  expect(await git(path.join(folder, 'app'), 'rev-parse', 'HEAD')).toBe(first)
  expect(await git(path.join(folder, 'docs'), 'rev-parse', 'HEAD')).toBe(tip)
  expect(await readFile(path.join(folder, 'docs', '.env'), 'utf8')).toBe('KEY=1\n')
})

test('a failed step removes the worktrees the copy already made', async () => {
  const { clone, folder, deps } = await setUp()
  await expect(
    makeCopy(deps, {
      folder,
      factory,
      entries: [entry('app', { primary: true }), entry('docs', { baseBranch: 'no-such-branch' })],
      branch: 'base',
      clone: 'existing',
      fetch: 'none',
      copyFiles: 'required',
    }),
  ).rejects.toThrow()
  expect(await readdir(folder)).toEqual([])
  const worktrees = (await git(clone, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
  expect(worktrees).toHaveLength(1)
})

test('discarding a copy leaves a linked folder alone and removes a plain one', async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-code-copy-'))
  const outside = path.join(scratch, 'outside')
  await mkdir(path.join(outside, 'repo'), { recursive: true })
  await writeFile(path.join(outside, 'repo', 'keep.txt'), 'keep')
  const copies = path.join(scratch, 'copies')
  await mkdir(copies)
  const linked = path.join(copies, 'linked')
  await symlink(outside, linked)
  const sandboxRoot = path.join(scratch, 'sandbox')
  await mkdir(sandboxRoot)
  await discardCopy([{ clone: outside, worktree: path.join(linked, 'repo') }], linked, {
    root: sandboxRoot,
    name: 'linked',
  })
  expect(existsSync(path.join(outside, 'repo', 'keep.txt'))).toBe(true)
  expect(existsSync(linked)).toBe(true)

  const plain = path.join(copies, 'plain')
  await mkdir(path.join(plain, 'repo'), { recursive: true })
  await mkdir(path.join(sandboxRoot, 'plain', 'cache'), { recursive: true })
  await discardCopy([], plain, { root: sandboxRoot, name: 'plain' })
  expect(existsSync(plain)).toBe(false)
  expect(existsSync(path.join(sandboxRoot, 'plain'))).toBe(false)
})

test('removing a copy ends the processes left in it and its sandbox folder before deleting them', async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-code-copy-'))
  const root = path.join(await realpath(scratch), 'copies')
  const sandboxRoot = path.join(await realpath(scratch), 'sandbox')
  await mkdir(path.join(root, 'run-1', 'app'), { recursive: true })
  await mkdir(path.join(sandboxRoot, 'run-1'), { recursive: true })
  await mkdir(path.join(root, 'run-2'), { recursive: true })
  const exited = (child: ChildProcess) =>
    new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_, signal) => resolve(signal)),
    )
  const inCopy = spawn('sleep', ['60'], { stdio: 'ignore' })
  const inSandbox = spawn('sleep', ['60'], { stdio: 'ignore' })
  const elsewhere = spawn('sleep', ['60'], { stdio: 'ignore' })
  const ended = [exited(inCopy), exited(inSandbox)]
  const running = new Set([inCopy.pid, inSandbox.pid, elsewhere.pid])
  for (const child of [inCopy, inSandbox, elsewhere])
    child.once('exit', () => running.delete(child.pid))
  const seen: boolean[] = []
  const list = async () => {
    seen.push(existsSync(path.join(root, 'run-1')))
    return [
      { pid: inCopy.pid ?? 0, path: path.join(root, 'run-1', 'app') },
      { pid: inSandbox.pid ?? 0, path: path.join(sandboxRoot, 'run-1') },
      { pid: elsewhere.pid ?? 0, path: path.join(root, 'run-2') },
    ].filter(({ pid }) => running.has(pid))
  }
  try {
    await removeCopy([], root, 'run-1', {
      sandbox: { root: sandboxRoot, name: 'run-1' },
      processes: { list, graceMs: 2_000 },
    })
    expect(await Promise.all(ended)).toEqual(['SIGTERM', 'SIGTERM'])
    expect(running.has(elsewhere.pid)).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    expect(existsSync(path.join(root, 'run-1'))).toBe(false)
  } finally {
    for (const child of [inCopy, inSandbox, elsewhere]) child.kill('SIGKILL')
  }
})

test('removing a copy that is already gone looks for no processes', async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-code-copy-'))
  let listed = 0
  const list = async () => {
    listed += 1
    return []
  }
  await removeCopy([], scratch, 'missing', { processes: { list } })
  expect(listed).toBe(0)
})
