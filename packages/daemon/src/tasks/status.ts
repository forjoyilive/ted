import type {
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
  partlyMerged?: boolean
  paused?: string
  tedWorking?: boolean
  settingUp?: boolean
  stopped?: boolean
  blockedBy?: readonly string[]
  queue?: { place: number } | { hold: string }
  github?: GitHubWait
  needsPlanning?: boolean
  agentActivity?: string
  leadLive?: boolean
  archived?: boolean
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
  if (facts.stopped) return { kind: 'stopped' }
  if (facts.stage === 'backlog') return undefined
  const blocker = facts.blockedBy?.[0]
  if (blocker !== undefined && facts.runs.length === 0) return { kind: 'blocked', by: blocker }
  if (facts.queue) return { kind: 'queued', ...facts.queue }
  if (facts.github) return { kind: 'waiting-for-github', on: facts.github }
  return undefined
}

export function commentBox(facts: TaskFacts, status: TaskStatus | undefined): CommentBox {
  if (facts.stage === 'done') return 'done'
  if (status?.kind === 'failed') return 'failed'
  if (status?.kind === 'stopped') return 'stopped'
  if (status?.kind === 'paused') return 'paused'
  return facts.leadLive ? 'live' : 'no-run'
}

export function taskStatuses(facts: TaskFacts): TaskStatusKind[] {
  if (facts.stage === 'done' || facts.archived) return []
  const has: Record<TaskStatusKind, boolean> = {
    failed: facts.failed === true,
    'partly-merged': facts.partlyMerged === true,
    'waiting-on-you': (facts.openRequests ?? 0) > 0 || facts.runs.includes('waiting'),
    paused: facts.paused !== undefined,
    working:
      facts.tedWorking === true || facts.settingUp === true || facts.runs.includes('working'),
    stopped: facts.stopped === true,
    blocked: (facts.blockedBy?.length ?? 0) > 0,
    queued: facts.queue !== undefined,
    'waiting-for-github': facts.github !== undefined,
  }
  return (Object.keys(has) as TaskStatusKind[]).filter((kind) => has[kind])
}

export function taskMarkers(facts: TaskFacts, status: TaskStatus | undefined): TaskMarker[] {
  if (facts.archived) return []
  const blocker = facts.blockedBy?.[0]
  return [
    ...(facts.needsPlanning ? [{ kind: 'needs-planning' } as const] : []),
    ...(blocker !== undefined && status?.kind !== 'blocked'
      ? [{ kind: 'blocked-by', by: blocker } as const]
      : []),
  ]
}

export function taskActivity(facts: TaskFacts): string | undefined {
  if (facts.archived) return undefined
  if (facts.agentActivity !== undefined) return facts.agentActivity
  if (facts.settingUp) return 'Setting up the worktree'
  if (facts.paused !== undefined && facts.queue && 'place' in facts.queue) {
    return `Queued · ${ordinal(facts.queue.place)}`
  }
  const blocker = facts.blockedBy?.[0]
  if (blocker !== undefined && facts.runs.length === 0) return `Starts when ${blocker} merges`
  if (facts.stage === 'backlog') return 'Not started'
  return undefined
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
