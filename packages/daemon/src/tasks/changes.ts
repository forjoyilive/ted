import {
  type CommitChanges,
  type FileDiff,
  isCommitId,
  maxCommitLookups,
  type RepoChanges,
  type TaskChanges,
  type TaskCommit,
} from '@ted/protocol'
import * as git from '../git.ts'
import { redactSecrets } from '../redact.ts'

export interface ChangesTarget {
  name: string
  worktree: string
  base: string
}

export async function taskChanges(
  taskId: string,
  targets: readonly ChangesTarget[],
): Promise<TaskChanges> {
  const repos = await Promise.all(targets.map(repoChanges))
  return { taskId, files: repos.reduce((sum, r) => sum + r.files.length, 0), repos }
}

async function repoChanges(target: ChangesTarget): Promise<RepoChanges> {
  try {
    const changes = await git.workingChanges(target.worktree, `origin/${target.base}`)
    return {
      name: target.name,
      baseBranch: target.base,
      head: changes.head,
      mergeBase: changes.mergeBase,
      added: changes.files.reduce((sum, f) => sum + f.added, 0),
      removed: changes.files.reduce((sum, f) => sum + f.removed, 0),
      files: changes.files,
    }
  } catch (error) {
    console.error(
      `couldn’t read the changes in ${target.name}:`,
      redactSecrets(error instanceof Error ? error.message : String(error)),
    )
    return {
      name: target.name,
      baseBranch: target.base,
      added: 0,
      removed: 0,
      files: [],
      unavailable: `Couldn’t read the changes in ${target.name}.`,
    }
  }
}

export interface CommitRepo {
  name: string
  worktree: string
}

export async function taskCommits(
  repos: readonly CommitRepo[],
  ids: readonly string[],
): Promise<TaskCommit[]> {
  const wanted = [...new Set(ids)].filter(isCommitId).slice(0, maxCommitLookups)
  const found: TaskCommit[] = []
  let left = wanted
  for (const repo of repos) {
    if (left.length === 0) break
    const commits = await git.findCommits(repo.worktree, left).catch(() => new Map())
    for (const [id, commit] of commits) found.push({ id, repo: repo.name, commit })
    left = left.filter((id) => !commits.has(id))
  }
  return found
}

export async function commitChanges(
  repos: readonly CommitRepo[],
  id: string,
): Promise<CommitChanges | undefined> {
  if (!isCommitId(id)) return undefined
  for (const repo of repos) {
    const diff = await git.commitDiff(repo.worktree, id).catch(() => undefined)
    if (!diff) continue
    const [parent] = diff.parents
    return {
      repo: repo.name,
      commit: diff.commit,
      subject: diff.subject.slice(0, 300),
      author: diff.author.slice(0, 100),
      date: diff.date,
      ...(parent !== undefined && { parent }),
      ...(diff.parents.length > 1 && { merge: true as const }),
      files: diff.files,
      diffs: diff.diffs.map((file) => ({
        repo: repo.name,
        head: diff.commit,
        mergeBase: parent ?? '',
        ...file,
      })),
      ...(diff.limited && { limited: true as const }),
    }
  }
  return undefined
}

export async function fileDiffs(target: ChangesTarget, path?: string): Promise<FileDiff[]> {
  const changes = await git.workingChanges(target.worktree, `origin/${target.base}`, {
    diffs: path === undefined ? 'all' : [path],
  })
  return changes.diffs.map((diff) => ({
    repo: target.name,
    head: changes.head,
    mergeBase: changes.mergeBase,
    ...diff,
  }))
}
