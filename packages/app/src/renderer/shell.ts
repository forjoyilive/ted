import type { Task } from '@ted/protocol'

export const openShellEvent = 'ted:open-shell'

export interface OpenShellRequest {
  taskId: string
  repo?: string
}

let pending: OpenShellRequest | undefined

export function hasWorktree(task: Task): boolean {
  return task.repos.some((r) => !r.removed)
}

export function openTaskShell(task: Task, repo?: string): void {
  const request = { taskId: task.id, ...(repo !== undefined && { repo }) }
  pending = request
  window.dispatchEvent(new CustomEvent<OpenShellRequest>(openShellEvent, { detail: request }))
}

export function takeShellRequest(taskId: string): OpenShellRequest | undefined {
  if (pending?.taskId !== taskId) return undefined
  const request = pending
  pending = undefined
  return request
}

export function isShellShortcut(event: {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === '`' || event.code === 'Backquote')
  )
}
