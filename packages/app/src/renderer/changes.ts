import type { ChangeFile, Task, TaskChanges } from '@ted/protocol'
import { useRef } from 'react'
import { useEventValue } from './data.ts'
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
