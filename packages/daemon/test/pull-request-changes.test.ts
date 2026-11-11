import type { TaskRepo } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { readPullRequestChanges } from '../src/tasks/pull-request-changes.ts'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const mergeBase = 'c'.repeat(40)
const repo: TaskRepo = {
  name: 'web',
  repo: 'acme/web',
  branch: 'task',
  worktree: '/not-a-worktree',
  copied: [],
  skipped: [],
  removed: { at: '2026-11-11T12:00:00Z' },
  pullRequest: {
    number: 7,
    url: 'https://github.com/acme/web/pull/7',
    base: 'main',
    state: 'ready',
  },
}
const metadata = (changed_files = 1, sha = head) => ({
  head: { sha },
  base: { sha: base, ref: 'main' },
  changed_files,
  state: 'open',
})
const file = (filename = 'new.ts') => ({
  filename,
  additions: 1,
  deletions: 1,
  previous_filename: 'old.ts',
  status: 'renamed',
  patch: '@@ -1 +1 @@\n-old\n+<script>new</script>',
})

function github(files: unknown[] = [file()]) {
  return {
    api: vi.fn(async (route: string, _options?: { host?: string }) => {
      if (route.includes('/compare/')) return { merge_base_commit: { sha: mergeBase } }
      if (route.includes('/files?')) return files
      return metadata(files.length)
    }),
  }
}

test('a removed worktree’s PR snapshot preserves paths and escaped text as data at the pushed revision', async () => {
  const gh = github([
    file(),
    {
      filename: 'deleted.ts',
      additions: 0,
      deletions: 1,
      status: 'removed',
      patch: '@@ -1 +0,0 @@\n-gone',
    },
    { filename: 'image.png', additions: 0, deletions: 0 },
  ])
  const snapshot = await readPullRequestChanges(gh, repo)
  expect(snapshot).toMatchObject({
    number: 7,
    state: 'Open',
    head,
    base,
    repo: { name: 'web', baseBranch: 'main', mergeBase },
  })
  expect(snapshot.repo.files[0]).toMatchObject({
    path: 'new.ts',
    previousPath: 'old.ts',
    uncommitted: false,
  })
  expect(snapshot.diffs[0]).toMatchObject({
    head,
    mergeBase,
    hunks: [
      {
        rows: [
          { kind: 'removed', old: 1, text: 'old' },
          { kind: 'added', new: 1, text: '<script>new</script>' },
        ],
      },
    ],
  })
  expect(snapshot.diffs[1]?.hunks[0]?.rows).toEqual([{ kind: 'removed', old: 1, text: 'gone' }])
  expect(snapshot.diffs[2]).toMatchObject({
    hunks: [],
    unavailable: expect.stringContaining('did not provide a text patch'),
  })
  expect(gh.api.mock.calls.every(([, options]) => options?.host === 'github.com')).toBe(true)
})

test('a head change during retrieval retries the whole snapshot, then refuses continued movement', async () => {
  const gh = github()
  let reads = 0
  const api = gh.api.getMockImplementation()
  if (!api) throw new Error('missing implementation')
  gh.api.mockImplementation(async (route) =>
    route.endsWith('/pulls/7') ? metadata(1, ++reads === 1 ? head : base) : api(route),
  )
  expect((await readPullRequestChanges(gh, repo)).head).toBe(base)
  expect(reads).toBe(4)
  reads = 0
  gh.api.mockImplementation(async (route) =>
    route.endsWith('/pulls/7') ? metadata(1, ++reads % 2 ? head : base) : api(route),
  )
  await expect(readPullRequestChanges(gh, repo)).rejects.toThrow('changed while loading')
})

test('pagination and display bounds are explicit; omitted and incomplete patches are never complete diffs', async () => {
  const gh = github()
  gh.api.mockImplementation(async (route) => {
    if (route.includes('/compare/')) return { merge_base_commit: { sha: mergeBase } }
    if (!route.includes('/files?')) return metadata(1001)
    const page = Number(new URL(`https://github.com/${route}`).searchParams.get('page'))
    return Array.from({ length: 100 }, (_, i) => ({
      ...file(`file-${(page - 1) * 100 + i}.ts`),
      patch: i === 0 ? 'x'.repeat(256001) : '@@ -1 +1 @@\n+only-added',
    }))
  })
  const snapshot = await readPullRequestChanges(gh, repo)
  expect(snapshot.limited).toBe(true)
  expect(snapshot.repo.files).toHaveLength(1000)
  expect(snapshot.diffs[0]?.unavailable).toContain('display limit')
  expect(snapshot.diffs[1]?.truncated).toBe(true)
})

test('empty lists, missing pages, GitHub errors and invalid PR identities do not become local diffs', async () => {
  const gh = github([])
  expect((await readPullRequestChanges(gh, repo)).diffs).toEqual([])
  gh.api.mockImplementation(async (route) =>
    route.includes('/compare/')
      ? { merge_base_commit: { sha: mergeBase } }
      : route.includes('/files?')
        ? []
        : metadata(),
  )
  await expect(readPullRequestChanges(gh, repo)).rejects.toThrow('Incomplete')
  gh.api.mockRejectedValue(new Error('GitHub unavailable'))
  await expect(readPullRequestChanges(gh, repo)).rejects.toThrow('GitHub unavailable')
  gh.api.mockClear()
  await expect(readPullRequestChanges(gh, { ...repo, repo: '../web' })).rejects.toThrow(
    'valid pull request',
  )
  expect(gh.api).not.toHaveBeenCalled()
})

test('the snapshot limits rendered rows even when many tiny lines fit in its byte budget', async () => {
  const gh = github(
    Array.from({ length: 9 }, (_, i) => ({
      filename: `file-${i}.ts`,
      additions: 2500,
      deletions: 0,
      patch: `@@ -0,0 +1,2500 @@\n${'+x\n'.repeat(2500)}`,
    })),
  )
  const snapshot = await readPullRequestChanges(gh, repo)
  expect(snapshot.diffs.slice(0, 8).every((d) => !d.unavailable)).toBe(true)
  expect(snapshot.diffs[8]?.unavailable).toContain('display limit')
})
