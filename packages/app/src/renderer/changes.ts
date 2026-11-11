import type { ChangeFile, PullRequestChanges, Task, TaskChanges } from '@ted/protocol'
import { useEffect, useRef, useState } from 'react'
import { useConnection } from './data.ts'
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
  const [changes, setChanges] = useState<TaskChanges>()
  const { epoch } = useConnection()
  const runIds = useRef(new Set<string>())
  runIds.current = new Set(task.runs.map((r) => r.id))
  const live = task.repos.filter((r) => !r.removed).length
  const taskId = task.id

  useEffect(() => {
    void epoch
    void live
    let latest = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setChanges((current) => (current?.taskId === taskId ? current : undefined))
    const load = () => {
      const call = ++latest
      void ted.taskChanges(taskId).then(
        (loaded) => {
          if (call === latest) setChanges(loaded)
        },
        () => undefined,
      )
    }
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(load, settleMs)
    }
    const unsubscribe = ted.onEvent((event) => {
      if (event.type === 'task-updated' && event.task.id === taskId) later()
      if (event.type === 'run-output' && runIds.current.has(event.runId)) later()
      if (event.type === 'run-updated' && runIds.current.has(event.run.id)) later()
    })
    window.addEventListener('focus', load)
    load()
    return () => {
      latest = -1
      clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('focus', load)
    }
  }, [taskId, epoch, live])

  return changes
}

export interface PullRequestChangesState {
  changes: TaskChanges | undefined
  snapshots: ReadonlyMap<string, PullRequestChanges>
  refresh: () => void
}

export function usePullRequestChanges(task: Task, active: boolean): PullRequestChangesState {
  const { epoch } = useConnection()
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<{
    key: string
    changes: TaskChanges
    snapshots: Map<string, PullRequestChanges>
  }>()
  const identity = JSON.stringify(
    task.repos
      .filter((r) => r.pullRequest)
      .map((r) => ({ name: r.name, pr: r.pullRequest, pushed: r.pushed })),
  )
  const key = `${task.id}\0${identity}\0${epoch}\0${version}`
  const refresh = () => {
    setResult(undefined)
    setVersion((v) => v + 1)
  }
  useEffect(() => {
    if (!active) return
    const focus = () => {
      setResult(undefined)
      setVersion((v) => v + 1)
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [active])
  useEffect(() => {
    if (!active) {
      setResult(undefined)
      return
    }
    let live = true
    const repos = JSON.parse(identity) as { name: string; pr: { number: number; base: string } }[]
    const snapshots = new Map<string, PullRequestChanges>()
    const changes: TaskChanges = { taskId: task.id, files: 0, repos: [] }
    for (const repo of repos) {
      changes.repos.push({
        name: repo.name,
        baseBranch: repo.pr.base,
        files: [],
        added: 0,
        removed: 0,
      })
    }
    setResult(undefined)
    void Promise.all(
      repos.map(async (repo, index) => {
        try {
          const snapshot = await ted.pullRequestChanges(task.id, repo.name)
          snapshots.set(repo.name, snapshot)
          changes.repos[index] = snapshot.repo
        } catch {
          changes.repos[index] = {
            name: repo.name,
            baseBranch: repo.pr.base,
            files: [],
            added: 0,
            removed: 0,
            unavailable: `${repo.name}: Couldn’t load pull request #${repo.pr.number} changes. Check your connection and GitHub access, then retry.`,
          }
        }
      }),
    ).then(() => {
      if (live)
        setResult({
          key,
          changes: { ...changes, files: changes.repos.reduce((n, r) => n + r.files.length, 0) },
          snapshots,
        })
    })
    return () => {
      live = false
    }
  }, [task.id, identity, key, active])
  return {
    changes: active && result?.key === key ? result.changes : undefined,
    snapshots: active && result?.key === key ? result.snapshots : new Map(),
    refresh,
  }
}
