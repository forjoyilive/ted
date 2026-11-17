import type { Task } from '@ted/protocol'
import { startTask } from './setup-notice.ts'
import { ted } from './ted.ts'

export type StatusActionKind =
  | 'start'
  | 'move-to-backlog'
  | 'resume'
  | 'retry'
  | 'stop'
  | 'follow-up'

export interface StatusAction {
  kind: StatusActionKind
  label: string
  help: string
}

export function statusAction(task: Task): StatusAction | undefined {
  if (task.archived) return undefined
  if (task.stage === 'done') {
    return {
      kind: 'follow-up',
      label: 'Follow-up…',
      help: 'Creates a new Task linked to this one, starting from its brief. This Task stays Done.',
    }
  }
  if (task.statuses.includes('failed')) {
    return {
      kind: 'retry',
      label: 'Retry',
      help: 'Starts a fresh Task Lead Run from the brief plus the comments since.',
    }
  }
  if (task.statuses.includes('stopped') || task.canResume) {
    return {
      kind: 'resume',
      label: 'Resume',
      help: 'Starts a fresh Task Lead Run from the brief plus the comments since, when a slot is free.',
    }
  }
  if (task.stage === 'backlog') {
    return { kind: 'start', label: 'Start', help: 'Joins the queue as Queued.' }
  }
  if (
    task.statuses.includes('queued') &&
    task.runs.length === 0 &&
    task.repos.length === 0 &&
    task.leadRunId === undefined
  ) {
    return {
      kind: 'move-to-backlog',
      label: 'Move to Backlog',
      help: 'Takes the Task out of the queue. It hasn’t had a Run yet.',
    }
  }
  return { kind: 'stop', label: 'Stop Task', help: stopHelp(task.runs.length) }
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
