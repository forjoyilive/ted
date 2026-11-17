import type { ChangeFile, FileDiff, PullRequestChanges, TaskRepo } from '@ted/protocol'
import { parsePatch } from '../git.ts'
import type { Gh } from '../github/gh.ts'
import { isSafeRepo } from './repos.ts'

const maxFiles = 1_000
const maxPatchBytes = 256_000
const maxSnapshotBytes = 4_000_000
const maxSnapshotRows = 20_000

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid GitHub response.')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error('Invalid GitHub text.')
  return value
}

function sha(value: unknown): string {
  const result = text(value)
  if (!/^[a-f0-9]{40,64}$/.test(result)) throw new Error('Invalid GitHub revision.')
  return result
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid GitHub count.')
  return value
}

function metadata(value: unknown) {
  const pr = record(value)
  const base = record(pr.base)
  return {
    head: sha(record(pr.head).sha),
    base: sha(base.sha),
    branch: text(base.ref),
    files: count(pr.changed_files),
    state:
      pr.draft === true
        ? 'Draft'
        : pr.state === 'open'
          ? 'Open'
          : pr.merged === true
            ? 'Merged'
            : 'Closed',
  }
}

export async function readPullRequestChanges(
  gh: Pick<Gh, 'api'>,
  repo: TaskRepo,
): Promise<PullRequestChanges> {
  const pr = repo.pullRequest
  if (!pr || !isSafeRepo(repo.repo) || !Number.isSafeInteger(pr.number) || pr.number < 1)
    throw new Error('No valid pull request.')
  const url = new URL(pr.url)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname.toLowerCase() !== `/${repo.repo}/pull/${pr.number}`.toLowerCase()
  )
    throw new Error('Invalid pull request URL.')
  const prefix = `repos/${repo.repo}`
  const route = `${prefix}/pulls/${pr.number}`
  const options = { host: url.hostname }
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = metadata(await gh.api(route, options))
    const comparison = record(
      await gh.api(`${prefix}/compare/${before.base}...${before.head}?per_page=1`, options),
    )
    const mergeBase = sha(record(comparison.merge_base_commit).sha)
    const files: ChangeFile[] = []
    const diffs: FileDiff[] = []
    let bytes = 0
    let remainingRows = maxSnapshotRows
    const paths = new Set<string>()
    for (let page = 1; files.length < Math.min(before.files, maxFiles); page++) {
      const response = await gh.api(`${route}/files?per_page=100&page=${page}`, options)
      if (
        !Array.isArray(response) ||
        response.length !== Math.min(100, before.files - files.length)
      )
        throw new Error('Incomplete GitHub file list.')
      for (const value of response) {
        if (files.length >= maxFiles) break
        const item = record(value)
        const path = text(item.filename)
        if (paths.has(path)) throw new Error('GitHub file list changed while loading.')
        paths.add(path)
        const file: ChangeFile = {
          path,
          added: count(item.additions),
          removed: count(item.deletions),
          uncommitted: false,
          ...(typeof item.previous_filename === 'string' && {
            previousPath: text(item.previous_filename),
          }),
        }
        files.push(file)
        const patch = typeof item.patch === 'string' ? item.patch : undefined
        const size = patch === undefined ? 0 : Buffer.byteLength(patch)
        bytes += size
        let parsed: Pick<FileDiff, 'hunks' | 'truncated' | 'unavailable'>
        if (patch === undefined) {
          parsed = {
            hunks: [],
            unavailable:
              'GitHub did not provide a text patch. This may be a binary file or a diff GitHub omitted.',
          }
        } else if (size > maxPatchBytes || bytes > maxSnapshotBytes) {
          parsed = { hunks: [], unavailable: 'This patch exceeds Ted’s display limit.' }
        } else {
          parsed = parsePatch(patch)
          const rows = parsed.hunks.flatMap((h) => h.rows)
          if (rows.length > remainingRows) {
            parsed = { hunks: [], unavailable: 'This patch exceeds Ted’s display limit.' }
          } else {
            remainingRows -= rows.length
            const added = rows.filter((r) => r.kind === 'added').length
            const removed = rows.filter((r) => r.kind === 'removed').length
            if (added !== file.added || removed !== file.removed) parsed.truncated = true
          }
        }
        diffs.push({ ...file, repo: repo.name, head: before.head, mergeBase, ...parsed })
      }
    }
    const after = metadata(await gh.api(route, options))
    if (JSON.stringify(before) !== JSON.stringify(after)) continue
    if (files.length !== Math.min(before.files, maxFiles))
      throw new Error('Incomplete GitHub file list.')
    return {
      repo: {
        name: repo.name,
        baseBranch: before.branch,
        head: before.head,
        mergeBase,
        added: files.reduce((n, f) => n + f.added, 0),
        removed: files.reduce((n, f) => n + f.removed, 0),
        files,
      },
      number: pr.number,
      state: before.state,
      head: before.head,
      base: before.base,
      loadedAt: new Date().toISOString(),
      diffs,
      ...(before.files > maxFiles && { limited: true }),
    }
  }
  throw new Error('The pull request changed while loading. Refresh to try again.')
}
