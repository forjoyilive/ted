import type { Task, TaskFileRef, TaskFiles } from '@ted/protocol'
import { useEffect, useState } from 'react'
import { useConnection } from './data.ts'
import { useRefreshAction } from './refresh-action.ts'
import { readableError, ted } from './ted.ts'

export const quickOpenEvent = 'ted:quick-open'
let pending: string | undefined

export function openTaskFiles(taskId: string): void {
  pending = taskId
  window.dispatchEvent(new CustomEvent(quickOpenEvent))
}

export function takeFileRequest(taskId: string): boolean {
  if (pending !== taskId) return false
  pending = undefined
  return true
}

export function matchingFiles(files: TaskFiles | undefined, query: string): TaskFileRef[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const matches = (files?.repos ?? [])
    .flatMap((repo) => repo.paths.map((path) => ({ repo: repo.repo, path })))
    .filter((file) =>
      terms.every((term) => `${file.repo}/${file.path}`.toLowerCase().includes(term)),
    )
  const rank = (file: TaskFileRef) => {
    const name = file.path.split('/').at(-1)?.toLowerCase() ?? ''
    const q = query.toLowerCase().trim()
    return name === q ? 0 : name.startsWith(q) ? 1 : 2
  }
  return matches
    .sort(
      (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.repo.localeCompare(b.repo),
    )
    .slice(0, 200)
}

export function useTaskFiles(task: Task, enabled: boolean) {
  const [result, setResult] = useState<{ key: string; files?: TaskFiles; error?: string }>()
  const { revision, refresh, settled } = useRefreshAction()
  const { epoch } = useConnection()
  const repos = task.repos
    .filter((r) => !r.removed)
    .map((r) => `${r.name}:${r.worktree}`)
    .join('\0')
  const key = `${task.id}:${repos}`
  useEffect(() => {
    if (!enabled || !repos) {
      settled(revision)
      return
    }
    let latest = 0
    let current = true
    const load = () => {
      const call = ++latest
      return ted.taskFiles(task.id).then(
        (files) => {
          if (current && call === latest) setResult({ key, files })
        },
        (failure: unknown) => {
          if (current && call === latest) setResult({ key, error: readableError(failure) })
        },
      )
    }
    void epoch
    void revision
    void load().finally(() => settled(revision))
    window.addEventListener('focus', load)
    return () => {
      current = false
      settled(revision)
      window.removeEventListener('focus', load)
    }
  }, [task.id, key, repos, enabled, revision, epoch, settled])
  return {
    files: result?.key === key ? result.files : undefined,
    error: result?.key === key ? result.error : undefined,
    refresh,
  }
}
