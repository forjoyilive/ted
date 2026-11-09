import type {
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
  if (blocker !== undefined) return { kind: 'blocked', by: blocker }
  if (facts.queue) return { kind: 'queued', ...facts.queue }
  if (facts.github) return { kind: 'waiting-for-github', on: facts.github }
  return undefined
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
  const blocker = facts.blockedBy?.[0]
  if (blocker !== undefined) return `Starts when ${blocker} merges`
  if (facts.stage === 'backlog') return 'Not started'
  return undefined
}
