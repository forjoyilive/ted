import type { ChangeFile, Task, TaskChanges } from '@ted/protocol'
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
