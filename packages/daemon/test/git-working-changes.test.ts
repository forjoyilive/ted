import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { mergeConflicts, ownCommits, workingChanges } from '../src/git.ts'

const run = promisify(execFile)
let dir: string
let repo: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-working-changes-'))
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

const write = async (files: Record<string, string>) => {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true })
    await writeFile(path.join(repo, name), text)
  }
}

const commit = async (files: Record<string, string>, message: string) => {
  await write(files)
  await git('add', '-A')
  await git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}

async function taskBranch() {
  await git('init', '-q', '--initial-branch=main')
  await commit(
    {
      'src/search/SearchPanel.tsx': ['one', 'two', 'three', 'four', 'five', ''].join('\n'),
      'README.md': '# widgets\n',
    },
    'base',
  )
  await git('checkout', '-qb', 'task')
  await commit({ 'src/search/SearchPanel.tsx': 'one\ntwo\nTHREE\nfour\nfive\n' }, 'guard')
  await git('checkout', '-q', 'main')
  await commit({ 'README.md': '# widgets\nmoved on\n' }, 'main moved')
  await git('checkout', '-q', 'task')
}

test('lists committed and uncommitted work against the merge-base, not the base tip', async () => {
  await taskBranch()
  await write({ 'src/search/useSearch.ts': 'export {}\n' })
  await write({ 'src/search/SearchPanel.tsx': 'one\ntwo\nTHREE\nfour\nfive\nsix\n' })

  const changes = await workingChanges(repo, 'main')

  expect(changes.head).toBe(await git('rev-parse', 'task'))
  expect(changes.mergeBase).toBe(await git('merge-base', 'main', 'task'))
  expect(changes.files).toEqual([
    {
      path: 'src/search/SearchPanel.tsx',
      added: 2,
      removed: 1,
      uncommitted: true,
      committed: { added: 1, removed: 1 },
    },
    { path: 'src/search/useSearch.ts', added: 1, removed: 0, uncommitted: true },
  ])
})

test('committed-only files are not marked uncommitted, and ignored files are left out', async () => {
  await taskBranch()
  await commit({ '.gitignore': 'dist/\n' }, 'ignore dist')
  await write({ 'dist/bundle.js': 'built\n' })

  const changes = await workingChanges(repo, 'main')

  expect(changes.files).toEqual([
    { path: '.gitignore', added: 1, removed: 0, uncommitted: false },
    { path: 'src/search/SearchPanel.tsx', added: 1, removed: 1, uncommitted: false },
  ])
})

test('a diff has hunks with old and new line numbers', async () => {
  await taskBranch()

  const changes = await workingChanges(repo, 'main', { diffs: ['src/search/SearchPanel.tsx'] })

  expect(changes.diffs).toEqual([
    {
      path: 'src/search/SearchPanel.tsx',
      added: 1,
      removed: 1,
      uncommitted: false,
      hunks: [
        {
          header: '@@ -1,5 +1,5 @@',
          rows: [
            { kind: 'context', text: 'one', old: 1, new: 1 },
            { kind: 'context', text: 'two', old: 2, new: 2 },
            { kind: 'removed', text: 'three', old: 3 },
            { kind: 'added', text: 'THREE', new: 3 },
            { kind: 'context', text: 'four', old: 4, new: 4 },
            { kind: 'context', text: 'five', old: 5, new: 5 },
          ],
        },
      ],
    },
  ])
})

test('binary files are listed without lines', async () => {
  await taskBranch()
  await write({ 'logo.png': '\u0000\u0001\u0002binary' })

  const changes = await workingChanges(repo, 'main', { diffs: ['logo.png'] })

  expect(changes.files).toContainEqual({
    path: 'logo.png',
    added: 0,
    removed: 0,
    uncommitted: true,
    binary: true,
  })
  expect(changes.diffs[0]).toMatchObject({ path: 'logo.png', binary: true, hunks: [] })
})

test('reading changes runs no command the repo’s config names, and changes nothing', async () => {
  await taskBranch()
  await write({ 'src/search/SearchPanel.tsx': 'edited\n', 'new.txt': 'new\n' })
  await write({ '.gitattributes': '* filter=evil diff=evil\n' })
  const status = await git('status', '--porcelain=v1', '-uall')
  const index = await readFile(path.join(repo, '.git', 'index'))
  const marker = path.join(dir, 'ran')
  const touch = `touch '${marker}'`
  await git('config', 'diff.external', touch)
  await git('config', 'core.fsmonitor', touch)
  await git('config', 'filter.evil.clean', touch)
  await git('config', 'filter.evil.required', 'true')
  await git('config', 'diff.evil.textconv', touch)
  await git('config', 'core.hooksPath', path.join(dir, 'hooks'))
  await mkdir(path.join(dir, 'hooks'))
  await writeFile(path.join(dir, 'hooks', 'post-index-change'), `#!/bin/sh\n${touch}\n`, {
    mode: 0o755,
  })

  const changes = await workingChanges(repo, 'main', {
    diffs: ['src/search/SearchPanel.tsx', 'new.txt'],
  })

  expect(changes.files.map((f) => f.path)).toEqual([
    '.gitattributes',
    'new.txt',
    'src/search/SearchPanel.tsx',
  ])
  expect(changes.diffs.map((d) => d.hunks.length)).toEqual([1, 1])
  await expect(access(marker)).rejects.toThrow()
  expect(await readFile(path.join(repo, '.git', 'index'))).toEqual(index)
  await git('config', '--unset', 'core.fsmonitor')
  await git('config', '--unset', 'filter.evil.clean')
  await git('config', '--unset', 'filter.evil.required')
  expect(await git('status', '--porcelain=v1', '-uall')).toBe(status)
})

test('an index the agent edited can’t hide committed work', async () => {
  await taskBranch()
  const base = await git('rev-parse', 'main:src/search/SearchPanel.tsx')
  await git('update-index', '--cacheinfo', `100644,${base},src/search/SearchPanel.tsx`)
  await git('update-index', '--assume-unchanged', 'src/search/SearchPanel.tsx')

  const changes = await workingChanges(repo, 'main')

  expect(changes.files).toEqual([
    { path: 'src/search/SearchPanel.tsx', added: 1, removed: 1, uncommitted: false },
  ])
})

test('a long diff is cut short and says so', async () => {
  await taskBranch()
  const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n')
  await write({ 'big.txt': `${lines}\n` })

  const changes = await workingChanges(repo, 'main', { diffs: ['big.txt'] })

  const [diff] = changes.diffs
  expect(diff?.added).toBe(5_000)
  expect(diff?.truncated).toBe(true)
  expect(diff?.hunks.flatMap((h) => h.rows).length).toBeLessThan(5_000)
})

test('committed work undone in the working tree still shows, with its committed diff', async () => {
  await taskBranch()
  await commit({ 'src/auth.ts': 'allow everyone\n' }, 'backdoor')
  await write({ 'src/search/SearchPanel.tsx': 'one\ntwo\nthree\nfour\nfive\n' })
  await rm(path.join(repo, 'src/auth.ts'))

  const changes = await workingChanges(repo, 'main', {
    diffs: ['src/auth.ts', 'src/search/SearchPanel.tsx'],
  })

  expect(changes.files).toEqual([
    {
      path: 'src/auth.ts',
      added: 0,
      removed: 0,
      uncommitted: true,
      committed: { added: 1, removed: 0 },
    },
    {
      path: 'src/search/SearchPanel.tsx',
      added: 0,
      removed: 0,
      uncommitted: true,
      committed: { added: 1, removed: 1 },
    },
  ])
  expect(changes.diffs.map((d) => [d.path, d.hunks, d.committedHunks?.[0]?.rows])).toEqual([
    ['src/auth.ts', [], [{ kind: 'added', text: 'allow everyone', new: 1 }]],
    [
      'src/search/SearchPanel.tsx',
      [],
      [
        { kind: 'context', text: 'one', old: 1, new: 1 },
        { kind: 'context', text: 'two', old: 2, new: 2 },
        { kind: 'removed', text: 'three', old: 3 },
        { kind: 'added', text: 'THREE', new: 3 },
        { kind: 'context', text: 'four', old: 4, new: 4 },
        { kind: 'context', text: 'five', old: 5, new: 5 },
      ],
    ],
  ])
})

test('an uncommitted edit on top of a committed change keeps both diffs', async () => {
  await taskBranch()
  await write({ 'src/search/SearchPanel.tsx': 'one\ntwo\nTHREE\nfour\nfive\nsix\n' })

  const changes = await workingChanges(repo, 'main', { diffs: ['src/search/SearchPanel.tsx'] })

  expect(changes.files[0]).toEqual({
    path: 'src/search/SearchPanel.tsx',
    added: 2,
    removed: 1,
    uncommitted: true,
    committed: { added: 1, removed: 1 },
  })
  expect(changes.diffs[0]?.committedHunks?.[0]?.rows).toHaveLength(6)
})

test('a test-merge names the files that conflict and leaves the repo as it was', async () => {
  await taskBranch()
  const task = await git('rev-parse', 'task')
  expect(
    await mergeConflicts(repo, { ours: task, theirs: await git('rev-parse', 'main') }),
  ).toEqual([])
  await git('checkout', '-q', 'main')
  const moved = await commit(
    { 'src/search/SearchPanel.tsx': 'one\ntwo\n3\nfour\nfive\n', 'docs/a b.md': 'main\n' },
    'main touched the same line',
  )
  await git('checkout', '-q', 'task')
  const head = await commit({ 'docs/a b.md': 'task\n' }, 'task added the same file')
  const refs = await git('for-each-ref')

  expect(await mergeConflicts(repo, { ours: head, theirs: moved })).toEqual([
    'docs/a b.md',
    'src/search/SearchPanel.tsx',
  ])
  expect(await mergeConflicts(repo, { ours: head, theirs: 'no-such-commit' })).toBeUndefined()
  expect(await git('for-each-ref')).toBe(refs)
  expect(await git('status', '--porcelain')).toBe('')
})

test('a branch’s own commits since a reviewed commit are its first-parent chain, with each merge’s parents', async () => {
  await taskBranch()
  const reviewed = await git('rev-parse', 'task')
  expect(await ownCommits(repo, { from: reviewed, to: reviewed })).toEqual([])
  await git('checkout', '-q', 'main')
  const moved = await commit({ 'docs/base.md': 'main\n' }, 'main moved')
  await git('checkout', '-q', 'task')
  await git('merge', '-q', '--no-ff', '-m', 'merge main', moved)
  const merge = await git('rev-parse', 'HEAD')
  const fix = await commit({ 'docs/fix.md': 'fix\n' }, 'a fix')

  expect(await ownCommits(repo, { from: reviewed, to: fix })).toEqual([
    { commit: merge, parents: [reviewed, moved] },
    { commit: fix, parents: [merge] },
  ])
  expect(await ownCommits(repo, { from: moved, to: fix })).toBeUndefined()
  expect(await ownCommits(repo, { from: 'no-such-commit', to: fix })).toBeUndefined()

  await git('replace', merge, reviewed)
  expect(await ownCommits(repo, { from: reviewed, to: fix })).toEqual([
    { commit: merge, parents: [reviewed, moved] },
    { commit: fix, parents: [merge] },
  ])
})
