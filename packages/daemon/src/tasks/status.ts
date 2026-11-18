import {
  type ActiveTestInvocations,
  type BlockerEnded,
  type BusyHold,
  busyHold,
  type CommentBox,
  type CommentDelivery,
  type GitHubWait,
  type RunState,
  type StageId,
  type TaskMarker,
  type TaskStatus,
  type TaskStatusKind,
} from '@ted/protocol'
import { isCleanup, mergesHere } from '@ted/protocol/stage'

export interface TaskFacts {
  preparing?: boolean
  snoozedUntil?: string
  stage: StageId
  runs: readonly RunState[]
  openRequests?: number
  requestsSnoozedUntil?: string
  failed?: boolean
  cleanupFailed?: boolean
  cleanupCommandsRunning?: boolean
  partlyMerged?: { merged: readonly string[]; open: readonly string[] }
  paused?: string
  pausedRuns?: readonly { id: string; reason: string }[]
  checksActive?: boolean
  settingUp?: boolean
  checking?: { name: string; index: number; total: number }
  movingAfterChecks?: boolean
  checksWaiting?: { place: number }
  testActivity?: ActiveTestInvocations
  stopped?: {
    at: string
    runs: number
    why: 'human' | 'blockers-removed' | 'repair-incorporation' | 'prepared'
  }
  blockedBy?: readonly string[]
  blockerEnded?: BlockerEnded
  startsAfterBlockers?: boolean
  queue?: { place: number; skipsBusy?: true } | { hold: string }
  queuedSubAgents?: readonly { id: string; hold?: string; paused?: string }[]
  busy?: BusyHold
  github?: GitHubWait
  mergePending?: boolean
  autoMergeLeft?: boolean
  needsPlanning?: boolean
  planningInChat?: boolean
  agentActivity?: string
  archived?: boolean
  leadLive?: boolean
  waitingOnPermission?: 'lead' | 'sub-agent'
  waitingOnSimulator?: boolean
  waitingOnEmulator?: boolean
  retrying?: boolean
  interrupted?: boolean
  mergeLeadWorks?: boolean
}

export function taskCanResume(facts: TaskFacts): boolean {
  return (
    facts.interrupted === true &&
    !facts.archived &&
    !facts.failed &&
    !facts.stopped &&
    !facts.partlyMerged &&
    !facts.paused &&
    facts.stage !== 'backlog' &&
    facts.stage !== 'done' &&
    (!mergesHere(facts.stage) || facts.mergeLeadWorks === true) &&
    facts.runs.length === 0 &&
    !facts.leadLive &&
    (facts.openRequests ?? 0) === 0 &&
    !facts.queue &&
    !facts.checksActive &&
    !facts.settingUp &&
    !facts.checking &&
    !facts.github &&
    !facts.mergePending &&
    (facts.blockedBy?.length ?? 0) === 0 &&
    !facts.planningInChat
  )
}

export function taskWakesOnComment(facts: TaskFacts): boolean {
  const { openRequests: _, ...withoutRequests } = facts
  return taskCanResume(withoutRequests)
}

export function commentDelivery(facts: TaskFacts): CommentDelivery | undefined {
  if (facts.stage === 'done' || facts.archived || facts.stopped || facts.failed) return undefined
  if (facts.paused !== undefined) return 'paused'
  if (facts.queue) return waitsForSlot(facts.queue, facts.busy) ? 'queued' : undefined
  if (facts.leadLive) return 'starting'
  return undefined
}

function waitsForSlot(queue: NonNullable<TaskFacts['queue']>, busy: BusyHold | undefined): boolean {
  return 'place' in queue && (busy === undefined || queue.skipsBusy === true)
}

export function leadAskedAtMerge(facts: {
  stage: StageId
  leadRunId: string | undefined
  askedBy: string | undefined
  leadEnded: string | undefined
  openRequests: number
}): boolean {
  return (
    mergesHere(facts.stage) &&
    facts.askedBy !== undefined &&
    facts.askedBy === facts.leadRunId &&
    facts.leadEnded === 'stopped' &&
    facts.openRequests === 0
  )
}

export function taskStatus(facts: TaskFacts): TaskStatus | undefined {
  if (facts.stage === 'done' || facts.archived) return undefined
  if (facts.failed) return { kind: 'failed' }
  if (facts.partlyMerged) return { kind: 'partly-merged' }
  if ((facts.openRequests ?? 0) > 0 || facts.runs.includes('waiting')) {
    return {
      kind: 'waiting-on-you',
      ...(facts.requestsSnoozedUntil !== undefined && { snoozedUntil: facts.requestsSnoozedUntil }),
    }
  }
  if (facts.paused !== undefined) return { kind: 'paused', reason: facts.paused }
  if (working(facts)) return { kind: 'working' }
  if (facts.stopped)
    return {
      kind: 'stopped',
      at: facts.stopped.at,
      ...(facts.stopped.why === 'prepared' && { prepared: true }),
    }
  if (facts.stage === 'backlog') return undefined
  const blocker = facts.blockedBy?.[0]
  if (blocker !== undefined && facts.runs.length === 0) {
    return {
      kind: 'blocked',
      by: blocker,
      ...(facts.blockerEnded !== undefined && { ended: facts.blockerEnded }),
    }
  }
  if (facts.queue) {
    if ('hold' in facts.queue) return { kind: 'queued', hold: facts.queue.hold }
    return { kind: 'queued', place: facts.queue.place }
  }
  if (facts.github) return { kind: 'waiting-for-github', on: facts.github }
  return undefined
}

function working(facts: TaskFacts): boolean {
  return (
    facts.settingUp === true ||
    facts.cleanupCommandsRunning === true ||
    facts.runs.includes('working')
  )
}

export function statusWithoutBlocker(
  facts: TaskFacts,
  status: TaskStatus | undefined,
): TaskStatus | undefined {
  if (status?.kind !== 'blocked') return undefined
  const { blockedBy: _, ...unblocked } = facts
  return taskStatus(unblocked)
}

export function taskStatuses(facts: TaskFacts): TaskStatusKind[] {
  if (facts.stage === 'done' || facts.archived) return []
  const has: Record<TaskStatusKind, boolean> = {
    failed: facts.failed === true,
    'partly-merged': facts.partlyMerged !== undefined,
    'waiting-on-you': (facts.openRequests ?? 0) > 0 || facts.runs.includes('waiting'),
    paused: facts.paused !== undefined,
    working: working(facts),
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
  if (taskCanResume(facts)) return 'stopped'
  if (status?.kind === 'paused') return 'paused'
  if (facts.mergePending) return 'merge-pending'
  return facts.leadLive ? 'live' : 'no-run'
}

function testMarkers(facts: TaskFacts): TaskMarker[] {
  if (facts.stage === 'done' || facts.stopped) return []
  const markers: TaskMarker[] = []
  const add = (source: 'tests' | 'checks', phase: 'running' | 'waiting', detail: string) => {
    markers.push({
      kind: 'test-activity',
      source,
      phase,
      label: `${phase === 'running' ? 'Running' : 'Waiting for'} ${source}`,
      detail,
    })
  }
  if (facts.checksWaiting) {
    add(
      'checks',
      'waiting',
      `Waiting for a check slot · ${ordinal(facts.checksWaiting.place)} in line`,
    )
  } else if (facts.checking) {
    const { name, index, total } = facts.checking
    if (facts.testActivity?.checksWaiting)
      add('checks', 'waiting', `${name} · Waiting for a shared test slot`)
    else add('checks', 'running', `${name} · ${index} of ${total} checks`)
  }
  for (const phase of ['running', 'waiting'] as const) {
    const count = facts.testActivity?.[phase] ?? 0
    if (count > 0)
      add(
        'tests',
        phase,
        `${count} supported test ${count === 1 ? 'command' : 'commands'} ${phase === 'running' ? 'running' : 'waiting for a shared test slot'}`,
      )
  }
  return markers
}

export function taskMarkers(facts: TaskFacts, status: TaskStatus | undefined): TaskMarker[] {
  if (facts.archived) return []
  const blocker = facts.blockedBy?.[0]
  return [
    ...(facts.preparing ? [{ kind: 'preparing' } as const] : []),
    ...(facts.snoozedUntil && facts.stage === 'backlog'
      ? [{ kind: 'snoozed' as const, until: facts.snoozedUntil }]
      : []),
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
    ...testMarkers(facts),
  ]
}

export function taskActivity(facts: TaskFacts): string | undefined {
  if (facts.archived) return undefined
  if (facts.failed) return 'Waiting on you to retry'
  if (facts.cleanupFailed) return 'Cleanup failed · waiting on you'
  if (facts.cleanupCommandsRunning) return 'Running Cleanup commands'
  if (facts.waitingOnSimulator) return 'Waiting for a simulator slot'
  if (facts.waitingOnEmulator) return 'Waiting for an emulator slot'
  if (facts.waitingOnPermission === 'lead') return 'The Task Lead is waiting on your permission'
  if (facts.waitingOnPermission === 'sub-agent') return 'A sub-agent is waiting on your permission'
  if (facts.stopped) return stoppedActivity(facts.stopped)
  if (taskCanResume(facts)) return 'The Task Lead has stopped. Resume to carry on.'
  if (facts.autoMergeLeft) {
    return 'Merge cancelled · GitHub auto-merge is still on; Ted keeps trying to turn it off'
  }
  if (facts.movingAfterChecks) {
    if (!facts.checking) return 'Running checks before moving on'
    const { name, index, total } = facts.checking
    return `Running checks before moving on · ${name} (${index} of ${total})`
  }
  if (facts.checking) {
    const { name, index, total } = facts.checking
    if (facts.testActivity?.checksWaiting) return `Waiting for a shared test slot · ${name}`
    return `Running checks · ${name} (${index} of ${total})`
  }
  if (facts.checksWaiting) return `Waiting to run checks · ${ordinal(facts.checksWaiting.place)}`
  if (facts.stage !== 'done' && facts.testActivity) {
    const { running, waiting } = facts.testActivity
    if (running > 0 && waiting > 0)
      return `${running} test ${running === 1 ? 'command' : 'commands'} running · ${waiting} waiting`
    if (running > 0) return `Running tests · ${running} ${running === 1 ? 'command' : 'commands'}`
    if (waiting > 0)
      return `Waiting for a shared test slot · ${waiting} test ${waiting === 1 ? 'command' : 'commands'}`
  }
  if (facts.retrying && facts.paused === undefined) return 'Retrying (rate limited)'
  if (facts.planningInChat) return 'Planning in chat'
  if (facts.agentActivity !== undefined) return facts.agentActivity
  if (facts.partlyMerged) {
    const { merged, open } = facts.partlyMerged
    return `${joinAnd(merged)} merged · ${joinAnd(open)} not yet`
  }
  if (facts.settingUp) return 'Setting up the worktree'
  if (facts.queue && 'hold' in facts.queue && facts.runs.length === 0) return facts.queue.hold
  if (facts.paused !== undefined && facts.queue && 'place' in facts.queue) {
    return `Queued · ${ordinal(facts.queue.place)}`
  }
  const blocker = facts.blockedBy?.[0]
  if (blocker !== undefined && facts.blockerEnded !== undefined) {
    return `Blocked by ${facts.blockerEnded} ${blocker}`
  }
  if (blocker !== undefined && facts.runs.length === 0)
    return facts.stage === 'backlog' && facts.startsAfterBlockers !== true
      ? `Blocked by ${blocker}`
      : `Starts when ${blocker} merges`
  if (facts.stage === 'backlog' && facts.needsPlanning) return 'Waiting for a plan made outside Ted'
  if (facts.stage === 'backlog' && facts.snoozedUntil) return 'Scheduled to start'
  if (facts.stage === 'backlog') return 'Not started'
  return undefined
}

function stoppedActivity({ runs, why }: NonNullable<TaskFacts['stopped']>): string {
  if (why === 'repair-incorporation')
    return 'Repair incorporation needs attention. See the thread, then Resume.'
  if (why === 'prepared') return 'Ready for Work · Resume or turn on Autopilot.'
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

export interface TaskWaitReason {
  reason: 'run-slot' | 'github' | 'agent-paused' | 'blocker'
  id: string
  detail?: string
}

export function taskWaitReasons(taskId: string, facts: TaskFacts): TaskWaitReason[] {
  if (facts.archived || facts.stage === 'done') return []
  const reasons: TaskWaitReason[] = []
  if (facts.queue)
    reasons.push({
      reason: 'run-slot',
      id: taskId,
      detail:
        facts.busy !== undefined && 'place' in facts.queue && !facts.queue.skipsBusy
          ? busyHold
          : 'hold' in facts.queue
            ? facts.queue.hold
            : 'slot',
    })
  for (const queued of facts.queuedSubAgents ?? []) {
    reasons.push({ reason: 'run-slot', id: queued.id, detail: queued.hold ?? 'slot' })
    if (queued.paused !== undefined)
      reasons.push({ reason: 'agent-paused', id: queued.id, detail: queued.paused })
  }
  if (facts.pausedRuns !== undefined) {
    for (const paused of facts.pausedRuns)
      reasons.push({ reason: 'agent-paused', id: paused.id, detail: paused.reason })
  } else if (facts.paused !== undefined)
    reasons.push({ reason: 'agent-paused', id: taskId, detail: facts.paused })
  for (const id of facts.blockedBy ?? []) reasons.push({ reason: 'blocker', id })
  if (facts.github !== undefined)
    reasons.push({ reason: 'github', id: taskId, detail: facts.github })
  return reasons
}

export function taskPauses(input: {
  taskId: string
  heldAgent: string | undefined
  liveRuns: readonly { id: string; agent: string }[]
  queuedAgent: string | undefined
  pauses: Readonly<Record<string, string | undefined>>
}): { id: string; reason: string }[] {
  const subjects = [
    ...(input.heldAgent ? [{ id: input.taskId, agent: input.heldAgent }] : []),
    ...input.liveRuns,
    ...(input.queuedAgent ? [{ id: input.taskId, agent: input.queuedAgent }] : []),
  ]
  const paused = new Map<string, { id: string; reason: string }>()
  for (const { id, agent } of subjects) {
    const reason = input.pauses[agent]
    if (reason !== undefined && !paused.has(id)) paused.set(id, { id, reason })
  }
  return [...paused.values()]
}

export function taskIsMerged(
  stage: StageId,
  pullRequests: readonly { number: number | null; state: string | null }[],
): boolean {
  return (
    (stage === 'done' || isCleanup(stage)) &&
    pullRequests.every((request) => request.number === null || request.state === 'merged')
  )
}
