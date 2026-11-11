import type {
  Comment,
  GitHubWait,
  StageId,
  TaskInterval,
  TaskIntervalContributor,
  TaskIntervalCoverage,
  TaskIntervalHistory,
  TaskIntervalReason,
} from '@ted/protocol'
import { type TaskWaitReason, taskIsMerged, taskPauses, taskWaitReasons } from '../tasks/status.ts'
import type { LoggedEvent } from './index.ts'
import type { intervalBoundaries } from './interval-schema.ts'

export function taskIntervalHistory(input: {
  taskId: string
  createdAt: string
  asOf: string
  log: LoggedEvent[]
  comments: Pick<Comment, 'id' | 'kind' | 'createdAt' | 'answer'>[]
  observations: (typeof intervalBoundaries.Type)[]
  boundaries: (typeof intervalBoundaries.Type)[]
  sessionId: string
  agents: (typeof intervalBoundaries.Type)[]
  runAgents: ReadonlyMap<string, string>
  blockerCompletions: LoggedEvent[]
}): TaskIntervalHistory {
  const { taskId, createdAt, asOf, comments } = input
  const time = Date.parse(asOf)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== asOf || time > Date.now())
    throw new RangeError('asOf must be a UTC ISO timestamp no later than now')
  if (asOf < createdAt) return { taskId, asOf, intervals: [], coverage: [], lifecycle: [] }
  const log = [
    ...input.log,
    ...input.boundaries
      .filter((b) => b.subject.startsWith('task:') && b.name !== 'v1.TaskWaitObserved')
      .map((b) => ({
        id: b.id,
        name: b.name,
        at: b.at,
        data: JSON.parse(b.data) as Record<string, unknown>,
      })),
  ]
    .filter((e) => e.at <= asOf)
    .sort((a, b) => eventOrder(a.id) - eventOrder(b.id))
  const lifecycle = log.filter((e) =>
    /Task(?:Stopped|Resumed|Retried|Archived|Unarchived|StageEntered|StageChanged)$/.test(e.name),
  )
  const terminal = (e: LoggedEvent) =>
    e.name.endsWith('TaskArchived') ||
    (/TaskStage(?:Entered|Changed)$/.test(e.name) && e.data.stage === 'done')
  const durableIntervals = durableWaits({ ...input, log })
  const intervals: TaskInterval[] = []
  const push = (reason: TaskIntervalReason, contributor: TaskIntervalContributor) => {
    if (contributor.start < contributor.end)
      intervals.push({
        reason,
        start: contributor.start,
        end: contributor.end,
        contributors: [
          {
            id: contributor.id,
            start: contributor.start,
            end: contributor.end,
            startSource: contributor.startSource,
            endSource: contributor.endSource,
            ...(contributor.detail !== undefined && { detail: contributor.detail }),
          },
        ],
      })
  }
  const add = (reason: TaskIntervalReason, contributor: TaskIntervalContributor) => {
    if (reason !== 'run-slot' || contributor.startSource !== 'v1.TaskWaitObserved') {
      push(reason, contributor)
      return
    }
    for (const queued of durableIntervals.filter((i) => i.reason === 'run-slot')) {
      for (const source of queued.contributors) {
        if (source.id !== contributor.id) continue
        const start = [source.start, contributor.start].sort().at(-1) ?? contributor.start
        const end = [source.end, contributor.end].sort()[0] ?? contributor.end
        push(reason, {
          ...contributor,
          start,
          end,
          startSource: start === contributor.start ? contributor.startSource : source.startSource,
          endSource: end === contributor.end ? contributor.endSource : source.endSource,
        })
      }
    }
  }
  for (const comment of comments) {
    if (comment.kind === 'note' || comment.createdAt > asOf) continue
    const creation = log.find((e) => e.data.intervalRequestId === comment.id)
    const boundary = lifecycle.find(
      (e) =>
        e.at >= comment.createdAt &&
        (creation === undefined || eventOrder(e.id) > eventOrder(creation.id)) &&
        (terminal(e) || e.name.endsWith('TaskStopped')),
    )
    const answer = comment.answer && comment.answer.at <= asOf ? comment.answer : undefined
    const end =
      boundary && (!answer || boundary.at < answer.at)
        ? { at: boundary.at, source: boundary.name }
        : answer
          ? { at: answer.at, source: 'CommentAnswered' }
          : { at: asOf, source: 'query' }
    add('user-request', {
      id: comment.id,
      start: comment.createdAt,
      end: end.at,
      startSource: 'CommentPosted',
      endSource: end.source,
    })
  }
  for (const [index, event] of log.entries()) {
    if (!event.name.endsWith('TaskStopped')) continue
    const end = log
      .slice(index + 1)
      .find((e) => /Task(?:Resumed|Retried|Unarchived)$/.test(e.name) || terminal(e))
    add('stopped', {
      id: event.id,
      start: event.at,
      end: end?.at ?? asOf,
      startSource: event.name,
      endSource: end?.name ?? 'query',
    })
  }
  const sessions = input.observations.filter((b) => b.name === 'v1.IntervalObservationStarted')
  const windows: { start: string; end: string; source: string }[] = []
  const unreconciled: { start: string; end: string }[] = []
  for (const [index, session] of sessions.entries()) {
    if (session.at > asOf) continue
    const next = sessions[index + 1]
    const data = JSON.parse(session.data) as { sessionId: string }
    const closed = input.observations.find(
      (b) =>
        b.name === 'v1.IntervalObservationEnded' && JSON.parse(b.data).sessionId === data.sessionId,
    )
    const observedEnd =
      closed?.at ??
      (next
        ? (JSON.parse(next.data).previousObservedAt as string)
        : data.sessionId === input.sessionId
          ? asOf
          : session.at)
    const end = [observedEnd, asOf].sort()[0] ?? asOf
    const endSource = end === asOf ? 'query' : (closed?.name ?? 'last-observation')
    windows.push({
      start: [session.at, createdAt].sort().at(-1) ?? createdAt,
      end,
      source: endSource,
    })
    const runSubjects = new Set(
      input.boundaries.filter((b) => b.subject.startsWith('run:')).map((b) => b.subject),
    )
    for (const subject of runSubjects) {
      const before = input.boundaries
        .filter((b) => b.subject === subject && b.sequence < session.sequence)
        .sort((a, b) => a.sequence - b.sequence)
        .at(-1)
      if (!before || JSON.parse(before.data).state === 'finished') continue
      const first = input.boundaries
        .filter(
          (b) =>
            b.subject === subject &&
            b.sequence > session.sequence &&
            (!next || b.sequence < next.sequence),
        )
        .sort((a, b) => a.sequence - b.sequence)[0]
      const until = first && first.at < end ? first.at : end
      if (session.at < until) unreconciled.push({ start: session.at, end: until })
    }
    const active = new Map<string, typeof intervalBoundaries.Type>()
    const closures = log
      .filter((e) => lifecycle.includes(e))
      .map((e) => ({
        ...e,
        sequence: eventOrder(e.id),
        subject: 'lifecycle',
        data: JSON.stringify(e.data),
      }))
    let workingAllowed = true
    for (const e of closures.filter((e) => e.sequence < session.sequence)) {
      if (e.name.endsWith('TaskStopped') || terminal({ ...e, data: JSON.parse(e.data) }))
        workingAllowed = false
      else if (/Task(?:Resumed|Retried|Unarchived)$/.test(e.name)) workingAllowed = true
    }
    for (const boundary of [...input.boundaries, ...closures]
      .filter(
        (b) =>
          (b.subject.startsWith('run:') || b.subject === 'lifecycle') &&
          b.sequence > session.sequence &&
          (!next || b.sequence < next.sequence) &&
          b.at <= end,
      )
      .sort((a, b) => a.sequence - b.sequence)) {
      if (boundary.subject === 'lifecycle') {
        if (
          boundary.name.endsWith('TaskStopped') ||
          terminal({ ...boundary, data: JSON.parse(boundary.data) })
        ) {
          workingAllowed = false
          for (const [id, start] of active)
            add('run-working', {
              id,
              start: start.at,
              end: boundary.at,
              startSource: start.name,
              endSource: boundary.name,
            })
          active.clear()
        } else if (/Task(?:Resumed|Retried|Unarchived)$/.test(boundary.name)) workingAllowed = true
        continue
      }
      const id = boundary.subject.slice(4)
      const state = (JSON.parse(boundary.data) as { state: string }).state
      const start = active.get(id)
      if (start && state !== 'working') {
        add('run-working', {
          id,
          start: start.at,
          end: boundary.at,
          startSource: start.name,
          endSource: boundary.name,
        })
        active.delete(id)
      } else if (!start && state === 'working' && workingAllowed) active.set(id, boundary)
    }
    for (const [id, start] of active)
      add('run-working', { id, start: start.at, end, startSource: start.name, endSource })
    const waits = new Map<string, TaskIntervalContributor & { reason: TaskWaitReason['reason'] }>()
    for (const boundary of input.boundaries
      .filter(
        (b) =>
          b.name === 'v1.TaskWaitObserved' &&
          b.sequence > session.sequence &&
          (!next || b.sequence < next.sequence) &&
          b.at <= end,
      )
      .sort((a, b) => a.sequence - b.sequence)) {
      const reasons = JSON.parse(JSON.parse(boundary.data).reasons) as TaskWaitReason[]
      const current = new Map(reasons.map((r) => [`${r.reason}:${r.id}`, r]))
      for (const [key, start] of waits) {
        if (current.get(key)?.detail === start.detail && current.has(key)) continue
        add(start.reason, { ...start, end: boundary.at, endSource: boundary.name })
        waits.delete(key)
      }
      for (const [key, reason] of current)
        if (!waits.has(key))
          waits.set(key, {
            ...reason,
            start: boundary.at,
            end,
            startSource: boundary.name,
            endSource,
          })
    }
    for (const start of waits.values()) add(start.reason, start)
  }
  for (const interval of durableIntervals) {
    const contributor = interval.contributors[0]
    if (!contributor) continue
    if (interval.reason === 'blocker' || interval.reason === 'run-slot') {
      add(interval.reason, contributor)
      continue
    }
    for (const window of windows) {
      const start = [interval.start, window.start].sort().at(-1) ?? interval.start
      const end = [interval.end, window.end].sort()[0] ?? interval.end
      add(interval.reason, {
        ...contributor,
        start,
        end,
        startSource:
          start === interval.start ? contributor.startSource : 'v1.IntervalObservationStarted',
        endSource: end === interval.end ? contributor.endSource : window.source,
      })
    }
  }
  return {
    taskId,
    asOf,
    intervals: unionIntervals(intervals),
    coverage: [
      ...observedCoverage(createdAt, asOf, windows, unreconciled),
      ...(['user-request', 'stopped', 'blocker', 'run-slot'] as const).map((reason) => ({
        reason,
        start: createdAt,
        end: asOf,
        state: 'known' as const,
        source: 'durable-history' as const,
      })),
    ],
    lifecycle: lifecycle.map((e) => ({ at: e.at, event: e.name })),
  }
}

function unionIntervals(intervals: TaskInterval[]): TaskInterval[] {
  const result: TaskInterval[] = []
  for (const interval of intervals.sort(
    (a, b) => a.reason.localeCompare(b.reason) || a.start.localeCompare(b.start),
  )) {
    const last = result.at(-1)
    if (last && last.reason === interval.reason && last.end >= interval.start) {
      if (last.end < interval.end) last.end = interval.end
      last.contributors.push(...interval.contributors)
    } else result.push({ ...interval, contributors: [...interval.contributors] })
  }
  return result
}

function observedCoverage(
  createdAt: string,
  asOf: string,
  windows: { start: string; end: string }[],
  unreconciled: { start: string; end: string }[],
): TaskIntervalCoverage[] {
  const cuts = [
    ...new Set([
      createdAt,
      asOf,
      ...windows.flatMap((w) => [w.start, w.end]),
      ...unreconciled.flatMap((w) => [w.start, w.end]),
    ]),
  ]
    .filter((at) => at >= createdAt && at <= asOf)
    .sort()
  const result: TaskIntervalCoverage[] = []
  for (const reason of ['run-working', 'github', 'agent-paused'] as const) {
    for (let i = 0; i < cuts.length - 1; i++) {
      const start = cuts[i]
      const end = cuts[i + 1]
      if (start === undefined || end === undefined) continue
      const observed = windows.some((w) => w.start <= start && w.end >= end)
      const pending =
        reason === 'run-working' && unreconciled.some((w) => w.start <= start && w.end >= end)
      const state = observed && !pending ? 'known' : 'unknown'
      const source = observed
        ? pending
          ? 'unreconciled'
          : 'observation'
        : windows[0] === undefined || start < windows[0].start
          ? 'not-recorded'
          : 'daemon-gap'
      const last = result.at(-1)
      if (
        last?.reason === reason &&
        last.end === start &&
        last.state === state &&
        last.source === source
      )
        last.end = end
      else result.push({ reason, start, end, state, source })
    }
  }
  return result
}

function eventOrder(id: string): number {
  const [global = 0, client = 0] = id.split('.').map(Number)
  return global * 1_000_000 + client
}

function durableWaits(input: {
  taskId: string
  asOf: string
  log: LoggedEvent[]
  agents: (typeof intervalBoundaries.Type)[]
  boundaries: (typeof intervalBoundaries.Type)[]
  runAgents: ReadonlyMap<string, string>
  blockerCompletions: LoggedEvent[]
}): TaskInterval[] {
  const timeline = new Map([...input.log, ...input.blockerCompletions].map((e) => [e.id, e]))
  for (const row of [
    ...input.agents,
    ...input.boundaries.filter(
      (b) => b.subject.startsWith('run:') || b.name === 'v1.SubAgentRequestDropped',
    ),
  ]) {
    timeline.set(row.id, { ...row, data: { ...JSON.parse(row.data), subject: row.subject } })
  }
  const pauses: Record<string, string | undefined> = {}
  const live = new Set<string>()
  const pendingRuns = new Map<string, string>()
  const blockers = new Set<string>()
  const merged = new Set<string>()
  let heldAgent: string | undefined
  let queued = false
  let queuedAgent: string | undefined
  let stage: StageId = 'backlog'
  let archived = false
  const github = new Map<string, string>()
  const active = new Map<
    string,
    { reason: TaskWaitReason['reason']; contributor: TaskIntervalContributor }
  >()
  const intervals: TaskInterval[] = []
  for (const event of [...timeline.values()].sort((a, b) => eventOrder(a.id) - eventOrder(b.id))) {
    if (event.at > input.asOf) continue
    const data = event.data
    if (event.name === 'v1.SubAgentRequested')
      pendingRuns.set(String(data.queuedRunId), String(data.agent))
    if (event.name === 'v1.SubAgentRequestDropped') pendingRuns.delete(String(data.id))
    if (typeof data.intervalBlockerId === 'string') {
      if (data.merged === true) merged.add(data.intervalBlockerId)
      else merged.delete(data.intervalBlockerId)
    }
    if (event.name.endsWith('TaskBlockerAdded')) blockers.add(String(data.blockerId))
    if (event.name.endsWith('TaskBlockerRemoved')) blockers.delete(String(data.blockerId))
    if (typeof data.stage === 'string') stage = data.stage as StageId
    if (event.name.endsWith('TaskArchived')) {
      archived = true
      queued = false
      heldAgent = undefined
    }
    if (event.name.endsWith('TaskUnarchived')) {
      archived = false
      queued = data.queued === true
    }
    if (event.name.endsWith('TaskLeadSet')) queuedAgent = String(data.agent)
    if (event.name.endsWith('TaskRunHeld')) heldAgent = String(data.agent)
    if (event.name.endsWith('TaskRunReleased')) heldAgent = undefined
    if (
      /Task(?:Queued|Resumed|Retried|RequeuedAfterBlockers|StartedAfterPlanning)$/.test(
        event.name,
      ) ||
      event.name.endsWith('GitHubActivityQueued')
    )
      queued = true
    if (
      /Task(?:Dequeued|Started|Stopped|MovedToBacklog|WaitingForBlockers|NeedsPlanning)$/.test(
        event.name,
      )
    )
      queued = false
    if (event.name.endsWith('TaskLeadFailed') && data.recovery === 'fresh') queued = true
    if (event.name === 'v1.AgentPaused' || event.name === 'v1.AgentResumed')
      pauses[String(data.agent)] = typeof data.reason === 'string' ? data.reason : undefined
    if (typeof data.subject === 'string' && data.subject.startsWith('run:')) {
      const id = data.subject.slice(4)
      if (/RunStarted$/.test(event.name)) pendingRuns.delete(id)
      if (data.state === 'finished') live.delete(id)
      else live.add(id)
    }
    if (
      event.name === 'v1.PullRequestMerged' ||
      event.name === 'v1.PullRequestClosedOnGitHub' ||
      event.name === 'v1.TaskWorktreeRemoved'
    )
      github.delete(String(data.name))
    if (event.name === 'v1.PullRequestWaitChanged') {
      if (typeof data.github === 'string') github.set(String(data.repo), data.github)
      else github.delete(String(data.repo))
    }
    const pausedRuns = taskPauses({
      taskId: input.taskId,
      heldAgent,
      queuedAgent: queued ? queuedAgent : undefined,
      liveRuns: [...live].flatMap((id) => {
        const agent = input.runAgents.get(id)
        return agent === undefined ? [] : [{ id, agent }]
      }),
      pauses,
    })
    const selected: TaskWaitReason[] = taskWaitReasons(input.taskId, {
      stage,
      archived,
      runs: [],
      blockedBy: [...blockers].filter((id) => !merged.has(id)),
      ...(queued && { queue: { place: 1 } }),
      queuedSubAgents: [...pendingRuns].map(([id, agent]) => ({
        id,
        ...(pauses[agent] !== undefined && { paused: pauses[agent] }),
      })),
      pausedRuns,
    })
    for (const [repo, on] of github)
      for (const reason of taskWaitReasons(input.taskId, {
        stage,
        archived,
        runs: [],
        ...(stage === 'merge' && { github: on as GitHubWait }),
      }))
        selected.push({ ...reason, id: repo })
    const next = new Map(selected.map((r) => [`${r.reason}:${r.id}`, r]))
    for (const [key, start] of active) {
      if (
        next.has(key) &&
        (start.reason === 'run-slot' || next.get(key)?.detail === start.contributor.detail)
      )
        continue
      intervals.push({
        reason: start.reason,
        start: start.contributor.start,
        end: event.at,
        contributors: [{ ...start.contributor, end: event.at, endSource: event.name }],
      })
      active.delete(key)
    }
    for (const [key, reason] of next)
      if (!active.has(key))
        active.set(key, {
          reason: reason.reason,
          contributor: {
            id: reason.id,
            ...(reason.reason !== 'run-slot' &&
              reason.detail !== undefined && { detail: reason.detail }),
            start: event.at,
            end: input.asOf,
            startSource: event.name,
            endSource: 'query',
          },
        })
  }
  for (const start of active.values())
    intervals.push({
      reason: start.reason,
      start: start.contributor.start,
      end: input.asOf,
      contributors: [start.contributor],
    })
  return intervals
}

export function blockerTransitions(blockerId: string, history: LoggedEvent[]): LoggedEvent[] {
  let stage: StageId = 'backlog'
  let merged = false
  const requests = new Map<string, { number: number; state: string }>()
  const changes: LoggedEvent[] = []
  for (const event of history.sort((a, b) => eventOrder(a.id) - eventOrder(b.id))) {
    if (typeof event.data.stage === 'string') stage = event.data.stage as StageId
    if (event.name.endsWith('PullRequestOpened'))
      requests.set(String(event.data.repo), { number: Number(event.data.number), state: 'draft' })
    const repo = String(event.data.repo ?? event.data.name)
    const request = requests.get(repo)
    if (request) {
      if (event.name.endsWith('PullRequestMerged')) request.state = 'merged'
      if (
        event.name.endsWith('PullRequestClosed') ||
        event.name.endsWith('PullRequestClosedOnGitHub')
      )
        request.state = 'closed'
      if (event.name.endsWith('PullRequestReopened')) request.state = String(event.data.state)
    }
    const next = taskIsMerged(stage, [...requests.values()])
    if (next !== merged)
      changes.push({ ...event, data: { intervalBlockerId: blockerId, merged: next } })
    merged = next
  }
  return changes
}
