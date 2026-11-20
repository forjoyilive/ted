import type { Task } from '@ted/protocol'
import { type StatusActionKind, statusActionKind } from '@ted/protocol/task-actions'
import { startTask } from './setup-notice.ts'
import { ted } from './ted.ts'

export type { StatusActionKind }

export interface StatusAction {
  kind: StatusActionKind
  label: string
  help: string
}

export function statusAction(task: Task): StatusAction | undefined {
  const kind = statusActionKind(task)
  switch (kind) {
    case undefined:
      return undefined
    case 'follow-up':
      return {
        kind,
        label: 'Follow-up…',
        help: 'Creates a new Task linked to this one, starting from its brief. This Task stays Done.',
      }
    case 'retry':
      return {
        kind,
        label: 'Retry',
        help: 'Starts a fresh Task Lead Run from the brief plus the comments since.',
      }
    case 'resume':
      return {
        kind,
        label: 'Resume',
        help: 'Starts a fresh Task Lead Run from the brief plus the comments since, when a slot is free.',
      }
    case 'start':
      return { kind, label: 'Start', help: 'Joins the queue as Queued.' }
    case 'move-to-backlog':
      return {
        kind,
        label: 'Move to Backlog',
        help: 'Takes the Task out of the queue. It hasn’t had a Run yet.',
      }
    case 'stop':
      return { kind, label: 'Stop Task', help: stopHelp(task.runs.length) }
  }
}

function stopHelp(runs: number): string {
  if (runs === 0) return 'Its worktree and Apps stay.'
  if (runs === 1) return 'Stops its Run. Its worktree and Apps stay.'
  return `Stops all ${runs} Runs. Its worktree and Apps stay.`
}

export function shortcutAction(task: Task): StatusAction | undefined {
  const action = statusAction(task)
  if (action?.kind === 'start' && task.markers.some((m) => m.kind === 'blocked-by')) {
    return undefined
  }
  return action?.kind === 'start' || action?.kind === 'resume' || action?.kind === 'retry'
    ? action
    : undefined
}

export function runStatusAction(kind: StatusActionKind, task: Task): Promise<Task | undefined> {
  switch (kind) {
    case 'start':
      return startTask(task)
    case 'move-to-backlog':
      return ted.moveToBacklog(task.id)
    case 'resume':
    case 'retry':
      return ted.resumeTask(task.id)
    case 'stop':
      return ted.stopTask(task.id)
    case 'follow-up':
      return ted.followUpTask(task.id)
  }
}
