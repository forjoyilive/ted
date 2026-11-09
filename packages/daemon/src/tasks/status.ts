import type {
  BlockerEnded,
  CommentBox,
  GitHubWait,
  RunState,
  StageId,
  TaskMarker,
  TaskStatus,
  TaskStatusKind,
} from '@ted/protocol'

export interface TaskFacts {
  stage: StageId
  runs: readonly RunState[]
  openRequests?: number
  failed?: boolean
  partlyMerged?: { merged: readonly string[]; open: readonly string[] }
  paused?: string
  tedWorking?: boolean
  settingUp?: boolean
  checking?: { name: string; index: number; total: number }
  stopped?: { at: string; runs: number; why: 'human' | 'blockers-removed' }
  blockedBy?: readonly string[]
  blockerEnded?: BlockerEnded
  queue?: { place: number } | { hold: string }
  github?: GitHubWait
  mergePending?: boolean
  autoMergeLeft?: boolean
  needsPlanning?: boolean
  agentActivity?: string
  archived?: boolean
  leadLive?: boolean
  waitingOnPermission?: 'lead' | 'sub-agent'
  retrying?: boolean
}

export function taskStatus(facts: TaskFacts): TaskStatus | undefined {
  if (facts.stage === 'done' || facts.archived) return undefined
  if (facts.failed) return { kind: 'failed' }
  if (facts.partlyMerged) return { kind: 'partly-merged' }
  if ((facts.openRequests ?? 0) > 0 || facts.runs.includes('waiting')) {
    return { kind: 'waiting-on-you' }
  }
  if (facts.paused !== undefined) return { kind: 'paused', reason: facts.paused }
  if (facts.tedWorking || facts.settingUp || facts.runs.includes('working')) {
    return { kind: 'working' }
  }
  if (facts.stopped) return { kind: 'stopped', at: facts.stopped.at }
  if (facts.stage === 'backlog') return undefined
  const blocker = facts.blockedBy?.[0]
  if (blocker !== undefined && facts.runs.length === 0) {
    return {
      kind: 'blocked',
      by: blocker,
      ...(facts.blockerEnded !== undefined && { ended: facts.blockerEnded }),
    }
  }
  if (facts.queue) return { kind: 'queued', ...facts.queue }
  if (facts.github) return { kind: 'waiting-for-github', on: facts.github }
  return undefined
}

export function taskStatuses(facts: TaskFacts): TaskStatusKind[] {
  if (facts.stage === 'done' || facts.archived) return []
  const has: Record<TaskStatusKind, boolean> = {
    failed: facts.failed === true,
    'partly-merged': facts.partlyMerged !== undefined,
    'waiting-on-you': (facts.openRequests ?? 0) > 0 || facts.runs.includes('waiting'),
    paused: facts.paused !== undefined,
    working:
      facts.tedWorking === true || facts.settingUp === true || facts.runs.includes('working'),
    stopped: facts.stopped !== undefined,
    blocked: (facts.blockedBy?.length ?? 0) > 0,
    queued: facts.queue !== undefined,
    'waiting-for-github': facts.github !== undefined,
  }
  return (Object.keys(has) as TaskStatusKind[]).filter((kind) => has[kind])
}

export function commentBox(facts: TaskFacts, status: TaskStatus | undefined): CommentBox {
  if (facts.archived) return 'archived'
  if (facts.stage === 'done') return 'done'
  if (status?.kind === 'failed') return 'failed'
  if (status?.kind === 'stopped') return 'stopped'
  if (status?.kind === 'paused') return 'paused'
  if (facts.mergePending) return 'merge-pending'
  return facts.leadLive ? 'live' : 'no-run'
}

export function taskMarkers(facts: TaskFacts, status: TaskStatus | undefined): TaskMarker[] {
  if (facts.archived) return []
  const blocker = facts.blockedBy?.[0]
  return [
    ...(facts.needsPlanning ? [{ kind: 'needs-planning' } as const] : []),
    ...(blocker !== undefined && status?.kind !== 'blocked'
      ? [
          {
            kind: 'blocked-by' as const,
            by: blocker,
            ...(facts.blockerEnded !== undefined && { ended: facts.blockerEnded }),
          },
        ]
      : []),
  ]
}

export function taskActivity(facts: TaskFacts): string | undefined {
  if (facts.archived) return undefined
  if (facts.failed) return 'Waiting on you to retry'
  if (facts.waitingOnPermission === 'lead') return 'The Task Lead is waiting on your permission'
  if (facts.waitingOnPermission === 'sub-agent') return 'A sub-agent is waiting on your permission'
  if (facts.stopped) return stoppedActivity(facts.stopped)
  if (facts.autoMergeLeft) {
    return 'Merge cancelled · GitHub auto-merge is still on; TED keeps trying to turn it off'
  }
  if (facts.checking) {
    const { name, index, total } = facts.checking
    return `Running Checks · ${name} (${index} of ${total})`
  }
  if (facts.retrying && facts.paused === undefined) return 'Retrying (rate limited)'
  if (facts.agentActivity !== undefined) return facts.agentActivity
  if (facts.partlyMerged) {
    const { merged, open } = facts.partlyMerged
    return `${joinAnd(merged)} merged · ${joinAnd(open)} not yet`
  }
  if (facts.settingUp) return 'Setting up the worktree'
  if (facts.paused !== undefined && facts.queue && 'place' in facts.queue) {
    return `Queued · ${ordinal(facts.queue.place)}`
  }
  const blocker = facts.blockedBy?.[0]
  if (blocker !== undefined && facts.blockerEnded !== undefined) {
    return `Blocked by ${facts.blockerEnded} ${blocker}`
  }
  if (blocker !== undefined && facts.runs.length === 0) return `Starts when ${blocker} merges`
  if (facts.stage === 'backlog') return 'Not started'
  return undefined
}

function stoppedActivity({ runs, why }: NonNullable<TaskFacts['stopped']>): string {
  if (why === 'blockers-removed') return 'Its blockers are gone. Resume to carry on.'
  if (runs === 0) return 'Worktree and Apps kept.'
  return `Worktree and Apps kept. ${runs} ${runs === 1 ? 'Run' : 'Runs'} stopped.`
}

function ordinal(n: number): string {
  const tens = n % 100
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : n % 10 === 1
        ? 'st'
        : n % 10 === 2
          ? 'nd'
          : n % 10 === 3
            ? 'rd'
            : 'th'
  return `${n}${suffix}`
}

function joinAnd(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
