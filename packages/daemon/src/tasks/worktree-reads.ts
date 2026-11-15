import * as git from '../git.ts'

export interface WorktreeReads {
  changes(worktree: string, base: string): Promise<git.WorkingChanges>
  forget(): void
}

export function worktreeReads(): WorktreeReads {
  const reads = new Map<string, Promise<git.WorkingChanges>>()
  const read = (key: string, worktree: string, base: string) => {
    const started = git.workingChanges(worktree, base)
    reads.set(key, started)
    started.catch(() => {
      if (reads.get(key) === started) reads.delete(key)
    })
    return started
  }
  return {
    async changes(worktree, base) {
      const key = `${worktree}\0${base}`
      const earlier = reads.get(key)
      if (earlier === undefined) return read(key, worktree, base)
      const kept = await earlier.catch(() => undefined)
      if (kept !== undefined) {
        const [head, tip] = await Promise.all([
          git.headCommit(worktree),
          git.revParse(worktree, base),
        ])
        if (head === kept.head && tip === kept.base) return kept
      }
      const newer = reads.get(key)
      return newer === undefined || newer === earlier ? read(key, worktree, base) : newer
    },
    forget() {
      reads.clear()
    },
  }
}

export function readChanges(
  reads: WorktreeReads | undefined,
  worktree: string,
  base: string,
): Promise<git.WorkingChanges> {
  return reads === undefined ? git.workingChanges(worktree, base) : reads.changes(worktree, base)
}
