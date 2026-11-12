import type { ChangeFile, PullRequestChanges, Task, TaskChanges } from '@ted/protocol'
import { useEffect, useRef } from 'react'
import { useConnection, useEventValue } from './data.ts'
import { useRefreshAction } from './refresh-action.ts'
import { ted } from './ted.ts'

export interface ChangedFile extends ChangeFile {
  repo: string
  baseBranch: string
}

export function changedFiles(changes: TaskChanges | undefined): ChangedFile[] {
  return (changes?.repos ?? []).flatMap((repo) =>
    repo.files.map((file) => ({ ...file, repo: repo.name, baseBranch: repo.baseBranch })),
  )
}

export function splitPath(file: string): { name: string; folder: string } {
  const slash = file.lastIndexOf('/')
  return slash < 0
    ? { name: file, folder: '' }
    : { name: file.slice(slash + 1), folder: file.slice(0, slash) }
}

const settleMs = 1_500

export function useTaskChanges(task: Task): TaskChanges | undefined {
  const runIds = useRef(new Set<string>())
  runIds.current = new Set(task.runs.map((r) => r.id))
  const live = task.repos.filter((r) => !r.removed).length
  return useEventValue<TaskChanges | undefined>({
    initial: undefined,
    key: `${task.id}:${live}`,
    focus: true,
    load: () => ted.taskChanges(task.id),
    event: (event) =>
      (event.type === 'task-updated' && event.task.id === task.id) ||
      (event.type === 'run-output' && runIds.current.has(event.runId)) ||
      (event.type === 'run-updated' && runIds.current.has(event.run.id))
        ? settleMs
        : undefined,
  }).value
}

export interface PullRequestChangesState {
  changes: TaskChanges | undefined
  snapshots: ReadonlyMap<string, PullRequestChanges>
  refresh: () => void
}

export function usePullRequestChanges(task: Task, active: boolean): PullRequestChangesState {
  const { epoch } = useConnection()
  const { revision: version, refresh, settled } = useRefreshAction()
  const identity = JSON.stringify(
    task.repos
      .filter((r) => r.pullRequest)
      .map((r) => ({ name: r.name, pr: r.pullRequest, pushed: r.pushed })),
  )
  useEffect(() => {
    if (!active) {
      settled(version)
      return
    }
    const focus = () => {
      void refresh()
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [active, refresh, settled, version])
  const resource = useEventValue<
    | {
        changes: TaskChanges
        snapshots: Map<string, PullRequestChanges>
      }
    | undefined
  >({
    initial: undefined,
    key: `${task.id}\0${identity}\0${epoch}\0${version}\0${active}`,
    enabled: active,
    event: () => undefined,
    load: async () => {
      try {
        const snapshots = new Map<string, PullRequestChanges>()
        const repos = task.repos.filter((r) => r.pullRequest)
        const changed = await Promise.all(
          repos.map(async (repo) => {
            try {
              const snapshot = await ted.pullRequestChanges(task.id, repo.name)
              snapshots.set(repo.name, snapshot)
              return snapshot.repo
            } catch {
              return {
                name: repo.name,
                baseBranch: repo.pullRequest?.base ?? '',
                files: [],
                added: 0,
                removed: 0,
                unavailable: `${repo.name}: Couldn’t load pull request #${repo.pullRequest?.number} changes. Check your connection and GitHub access, then retry.`,
              }
            }
          }),
        )
        return {
          changes: {
            taskId: task.id,
            files: changed.reduce((n, r) => n + r.files.length, 0),
            repos: changed,
          },
          snapshots,
        }
      } finally {
        settled(version)
      }
    },
  })
  return {
    changes: active ? resource.value?.changes : undefined,
    snapshots: active && resource.value ? resource.value.snapshots : new Map(),
    refresh,
  }
}
