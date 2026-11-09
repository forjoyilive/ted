import type { FileDiff, RepoChanges, TaskChanges } from '@ted/protocol'
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
