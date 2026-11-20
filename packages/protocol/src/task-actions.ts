import type { Task, TaskPullRequest, TaskRepo } from './task.ts'

export type StatusActionKind =
  | 'start'
  | 'move-to-backlog'
  | 'resume'
  | 'retry'
  | 'stop'
  | 'follow-up'

export type StatusActionTask = Pick<
  Task,
  'archived' | 'stage' | 'statuses' | 'canResume' | 'runs' | 'repos' | 'leadRunId'
>

export function statusActionKind(task: StatusActionTask): StatusActionKind | undefined {
  if (task.archived) return undefined
  if (task.stage === 'done') return 'follow-up'
  if (task.statuses.includes('failed')) return 'retry'
  if (task.statuses.includes('stopped') || task.canResume) return 'resume'
  if (task.stage === 'backlog') return 'start'
  if (
    task.statuses.includes('queued') &&
    task.runs.length === 0 &&
    task.repos.length === 0 &&
    task.leadRunId === undefined
  ) {
    return 'move-to-backlog'
  }
  return 'stop'
}

export function openPullRequests(
  task: Pick<Task, 'repos'>,
): { repo: TaskRepo; pr: TaskPullRequest }[] {
  return task.repos.flatMap((r) =>
    r.pullRequest && r.pullRequest.state !== 'closed' && r.pullRequest.state !== 'merged'
      ? [{ repo: r, pr: r.pullRequest }]
      : [],
  )
}
