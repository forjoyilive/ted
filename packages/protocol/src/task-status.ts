import type { GitHubWait, TaskStatus } from './task.ts'

const gitHubLabels: Record<GitHubWait, string> = {
  ci: 'Waiting for CI',
  review: 'Waiting for GitHub review',
  merge: 'Waiting for merge',
  'sign-in': 'Waiting for GitHub sign-in',
  rerun: 'Waiting for a CI rerun on GitHub',
  'required-check': 'Waiting: GitHub requires a failed check',
}

export function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')
  return `${n}${suffix}`
}

export function statusLabel(status: TaskStatus): string {
  switch (status.kind) {
    case 'failed':
      return 'Failed'
    case 'partly-merged':
      return 'Partly merged'
    case 'waiting-on-you':
      return status.snoozedUntil === undefined ? 'Waiting on you' : 'Snoozed'
    case 'paused':
      return `Paused · ${status.reason}`
    case 'working':
      return status.app === undefined ? 'Working' : 'Starting app'
    case 'stopped':
      return status.prepared ? 'Ready for Work' : 'Stopped'
    case 'blocked':
      return `Blocked by ${status.ended ? `${status.ended} ` : ''}${status.by}`
    case 'queued':
      if ('hold' in status) return `Queued · ${status.hold}`
      return `Queued · ${ordinal(status.place)}`
    case 'waiting-for-github':
      return gitHubLabels[status.on]
  }
}
