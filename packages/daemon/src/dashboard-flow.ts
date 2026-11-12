import type {
  DashboardFlow,
  DashboardRange,
  FlowPeriod,
  FlowSendBack,
  FlowStage,
  FlowValidateSample,
  ValidationSnapshot,
} from '@ted/protocol'
import type { DashboardTaskFacts } from './dashboard.ts'
import { type FlowTimingFacts, summarizeReasons, timingSamples } from './dashboard-timing.ts'

export interface FlowJudgment {
  at: string
  sequence?: number
  outcome: string
  checkRunId: string | null
  review: boolean | null
  visual: boolean | null
  validation?: ValidationSnapshot
}

export interface FlowCheck {
  id: string
  startedAt: string
  finishedAt: string | null
  outcome: string | null
  states: string[]
}

export interface FlowFacts {
  activity?: FlowTimingFacts
  transitions?: readonly { stage: string; at: string; sequence?: number }[]
  archivedAt?: string | null
  archives?: readonly string[]
  sendBacks?: readonly FlowSendBack[]
  judgments?: readonly FlowJudgment[]
  checks?: readonly FlowCheck[]
}

const day = 86_400_000
const iso = (at: number) => new Date(at).toISOString()
const time = (at: string | null | undefined) => Date.parse(at ?? '')
const finite = Number.isFinite
const failed = (state: string) => state === 'failed' || state === 'timed-out'
const quantile = (values: number[], p: number): number | null => {
  if (!values.length) return null
  const index = (values.length - 1) * p
  const lower = values[Math.floor(index)] ?? 0
  const upper = values[Math.ceil(index)] ?? lower
  return lower + (upper - lower) * (index - Math.floor(index))
}

function timing(task: DashboardTaskFacts, asOf: number) {
  const entries = (task.transitions ?? task.entries).map((entry, index) => ({
    ...entry,
    index,
    ms: time(entry.at),
  }))
  const start = entries.find((entry) => entry.stage === 'intake' && finite(entry.ms))
  const ends = [
    ...entries.filter((entry) => entry.stage === 'done').map((entry) => entry.ms),
    ...(task.archives ?? []).map(time),
    time(task.archivedAt),
  ].filter((at) => finite(at) && (!start || at >= start.ms) && at <= asOf)
  const end = ends.reduce((a, b) => Math.min(a, b), asOf)
  const reasons: string[] = []
  if (
    !start &&
    (task.stage !== 'backlog' ||
      entries.some((e) => e.stage !== 'backlog') ||
      task.sendBacks?.length)
  )
    reasons.push('First Intake timestamp is missing.')
  const invalid = entries.some((entry) => !finite(entry.ms))
  const invalidArchive = [
    ...(task.archives ?? []),
    ...(task.archivedAt ? [task.archivedAt] : []),
  ].some((at) => !finite(time(at)))
  const unordered = entries.some((entry, i) => i > 0 && entry.ms < (entries[i - 1]?.ms ?? entry.ms))
  if (invalid) reasons.push('A Stage timestamp is invalid.')
  if (invalidArchive) reasons.push('An archive timestamp is invalid.')
  if (unordered) reasons.push('Stage timestamps are out of recorded order.')
  const tailUnknown =
    end === asOf &&
    ((task.archived && !ends.length) ||
      (task.stage === 'done' && !ends.length) ||
      entries.at(-1)?.stage !== task.stage)
  if (tailUnknown && start) reasons.push('The final Stage interval has no reliable endpoint.')
  const intervals: { stage: string; from: number; to: number }[] = []
  if (start && !invalid && !invalidArchive && !unordered) {
    for (let index = start.index; index < entries.length; index++) {
      const entry = entries[index]
      if (!entry || !finite(entry.ms) || entry.ms < start.ms || entry.ms > end) continue
      const next = entries[index + 1]
      if (!next && tailUnknown) continue
      const to = Math.min(next ? next.ms : end, end)
      if (!finite(to) || to < entry.ms || entry.stage === 'backlog' || entry.stage === 'done')
        continue
      const previous = intervals.at(-1)
      if (
        entry.stage === 'intake' &&
        entries[index - 1]?.stage === 'intake' &&
        previous?.stage === 'intake' &&
        previous.to === entry.ms
      )
        previous.to = to
      else intervals.push({ stage: entry.stage, from: entry.ms, to })
    }
  }
  const archivedEnd = [...(task.archives ?? []), task.archivedAt].some((at) => time(at) === end)
  const endReason: DashboardFlow['tasks'][number]['endReason'] = ends.length
    ? archivedEnd
      ? 'archived'
      : 'done'
    : tailUnknown
      ? 'unknown'
      : 'open'
  return {
    start: start?.ms,
    end,
    endedAt: ends.length ? iso(end) : null,
    endReason,
    reasons,
    intervals,
  }
}

type Timing = ReturnType<typeof timing>

function firstVisit(task: DashboardTaskFacts, asOf: number): FlowValidateSample {
  const result: FlowValidateSample = {
    taskId: task.id,
    outcome: 'unknown',
    enteredAt: null,
    exitedAt: null,
    checkRunIds: [],
    failureIds: [],
    reasons: [],
  }
  const entries = task.transitions ?? task.entries
  const index = entries.findIndex((entry) => entry.stage === 'validate')
  const entered = entries[index]
  if (!entered) return { ...result, outcome: 'no-visit', reasons: ['No recorded Validate visit.'] }
  result.enteredAt = entered.at
  const exit = entries[index + 1]
  const start = time(entered.at)
  const end = time(exit?.at)
  if (!finite(start) || !finite(end) || end < start || end > asOf) {
    result.reasons.push('First Validate visit has no reliable recorded exit.')
    return result
  }
  result.exitedAt = exit?.at ?? null
  const judgments = (task.judgments ?? []).filter((j) => {
    const at = time(j.at)
    return (
      at >= start &&
      at <= end &&
      (j.sequence === undefined ||
        ((entered.sequence === undefined || j.sequence > entered.sequence) &&
          (exit?.sequence === undefined || j.sequence < exit.sequence)))
    )
  })
  const judgment = judgments.at(-1)
  if (!judgment) {
    result.reasons.push('No recorded first-visit verification judgment.')
    return result
  }
  const snapshot = judgment.validation
  const progress = snapshot?.progress
  const check = task.checks?.find((c) => c.id === judgment.checkRunId)
  if (check) result.checkRunIds.push(check.id)
  if (progress?.visit === entered.at) {
    for (const execution of progress.executions) {
      if (!result.checkRunIds.includes(execution.runId)) result.checkRunIds.push(execution.runId)
    }
  }
  const snapshotChecks = progress?.visit === entered.at ? progress.checks : undefined
  const states = snapshotChecks?.map((c) => c.state) ?? check?.states
  if (states) {
    const counts = new Map<string, number>()
    for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1)
    result.reasons.push(
      `Recorded Checks: ${[...counts].map(([state, count]) => `${count} ${state}`).join(', ') || 'empty run'}.`,
    )
  }
  if (judgment.review !== null)
    result.reasons.push(`Recorded review: ${judgment.review ? 'passed' : 'failed'}.`)
  if (judgment.visual !== null)
    result.reasons.push(`Recorded visual: ${judgment.visual ? 'passed' : 'failed'}.`)
  const checkBound =
    check !== undefined &&
    time(check.startedAt) >=
      time(entries[index - 1]?.stage === 'work' ? entries[index - 1]?.at : entered.at) &&
    finite(time(check.finishedAt)) &&
    time(check.startedAt) <= time(check.finishedAt) &&
    time(check.finishedAt) <= time(judgment.at)
  const accepted = (snapshot?.failures ?? []).filter((f) => {
    const resolution = f.resolutions.at(-1)
    return (
      resolution?.resolution === 'accepted' &&
      !f.verifications?.length &&
      !f.invalidations.some((i) => i.requestId === resolution.requestId)
    )
  })
  result.failureIds = accepted.map((f) => f.id)
  const sentBack = (task.sendBacks ?? []).some(
    (s) =>
      s.from === 'validate' &&
      time(s.at) >= start &&
      time(s.at) <= end &&
      (s.sequence === undefined ||
        ((entered.sequence === undefined || s.sequence > entered.sequence) &&
          (exit?.sequence === undefined || s.sequence < exit.sequence))),
  )
  const knownFailure =
    states?.some(failed) ||
    (snapshotChecks === undefined && check?.outcome === 'failed') ||
    judgment.review === false ||
    judgment.visual === false ||
    accepted.length > 0 ||
    sentBack ||
    judgment.outcome === 'sent-back'
  if (knownFailure)
    result.reasons.push('The first visit has a recorded failure or actual send-back.')
  if (accepted.length) result.reasons.push('Accepted failures remain failures, not passes.')
  const skipped = states?.some((s) => s === 'skipped') || states?.length === 0
  if (skipped) {
    result.outcome = 'skipped'
    result.reasons.push('Checks were explicitly skipped or no Checks were recorded in the run.')
    return result
  }
  const completeChecks =
    states !== undefined &&
    states.length > 0 &&
    (snapshotChecks !== undefined
      ? progress?.pending === false
      : checkBound && (check?.outcome === 'passed' || check?.outcome === 'failed')) &&
    states.every((s) => s === 'passed' || failed(s))
  if (!completeChecks) result.reasons.push('Complete recorded Check results are unavailable.')
  if (judgment.review === null) result.reasons.push('Recorded review verification is missing.')
  if (judgment.visual === null)
    result.reasons.push('Visual verification or its applicability was not recorded.')
  if (!completeChecks || judgment.review === null || judgment.visual === null) return result
  result.outcome = knownFailure ? 'failed' : judgment.outcome === 'passed' ? 'passed' : 'unknown'
  if (result.outcome === 'passed')
    result.reasons.push('Checks, review and visual passed; no actual first-visit send-back.')
  return result
}

function period(
  facts: readonly DashboardTaskFacts[],
  timings: Map<string, Timing>,
  visits: Map<string, FlowValidateSample>,
  from: number | null,
  to: number,
  completedIds: readonly string[],
): FlowPeriod {
  const result: FlowPeriod = {
    from: from === null ? null : iso(from),
    to: iso(to),
    taskIds: [],
    incomplete: [],
    stages: [],
    reasons: [],
    sendBacks: [],
    firstPass: { passed: 0, denominator: 0, percent: null, samples: [] },
  }
  const order = ['intake', 'clarify', 'design', 'work', 'validate', 'review', 'merge']
  const stages = new Map<string, FlowStage>(
    order.map((stage) => [
      stage,
      {
        stage,
        totalMs: 0,
        medianMs: null,
        p25Ms: null,
        p75Ms: null,
        samples: [],
      },
    ]),
  )
  const completed = new Set(completedIds)
  const groups = new Map<string, FlowPeriod['sendBacks'][number]>()
  const reasonSamples: ReturnType<typeof timingSamples>[] = []
  for (const task of facts) {
    const measured = timings.get(task.id)
    if (!measured) continue
    const lower = from ?? -Infinity
    const overlaps = (measured.start ?? time(task.createdAt)) < to && measured.end > lower
    if (overlaps && measured.start !== undefined) result.taskIds.push(task.id)
    if (overlaps && measured.reasons.length)
      result.incomplete.push({ taskId: task.id, reasons: measured.reasons })
    const perStage = new Map<string, FlowStage['samples'][number]>()
    for (const interval of overlaps ? measured.intervals : []) {
      const a = Math.max(lower, interval.from)
      const b = Math.min(to, interval.to)
      if (a > b || (a === b && !(interval.from === interval.to && a >= lower && a < to))) continue
      const sample = perStage.get(interval.stage) ?? {
        taskId: task.id,
        elapsedMs: 0,
        intervals: [],
      }
      sample.elapsedMs += b - a
      sample.intervals.push({ from: iso(a), to: iso(b) })
      perStage.set(interval.stage, sample)
    }
    if (overlaps && measured.start !== undefined)
      reasonSamples.push(
        timingSamples(
          task.id,
          task.activity,
          [...perStage.values()].flatMap((s) => s.intervals),
          task.activity?.history.asOf ?? iso(to),
          measured.reasons,
        ),
      )
    for (const [name, sample] of perStage) {
      const stage = stages.get(name) ?? {
        stage: name,
        totalMs: 0,
        medianMs: null,
        p25Ms: null,
        p75Ms: null,
        samples: [],
      }
      stage.totalMs += sample.elapsedMs
      stage.samples.push(sample)
      stages.set(name, stage)
    }
    for (const sendBack of task.sendBacks ?? []) {
      const at = time(sendBack.at)
      if (!(at >= lower && at < to)) continue
      const key = JSON.stringify([sendBack.from, sendBack.to])
      const group = groups.get(key) ?? {
        from: sendBack.from,
        to: sendBack.to,
        counted: 0,
        taskIds: [],
        transitions: [],
      }
      group.transitions.push(sendBack)
      if (sendBack.counted) group.counted++
      groups.set(key, group)
    }
    if (completed.has(task.id)) {
      const visit = visits.get(task.id)
      if (visit) result.firstPass.samples.push(visit)
    }
  }
  result.reasons = summarizeReasons(reasonSamples)
  result.stages = [...stages.values()].sort((a, b) => {
    const ai = order.indexOf(a.stage)
    const bi = order.indexOf(b.stage)
    return (
      (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.stage.localeCompare(b.stage)
    )
  })
  for (const stage of result.stages) {
    const values = stage.samples.map((s) => s.elapsedMs).sort((a, b) => a - b)
    stage.medianMs = quantile(values, 0.5)
    stage.p25Ms = quantile(values, 0.25)
    stage.p75Ms = quantile(values, 0.75)
  }
  result.sendBacks = [...groups.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
  for (const group of result.sendBacks)
    group.taskIds = [...new Set(group.transitions.map((s) => s.taskId))]
  result.firstPass.passed = result.firstPass.samples.filter((s) => s.outcome === 'passed').length
  result.firstPass.denominator = result.firstPass.samples.filter(
    (s) => s.outcome === 'passed' || s.outcome === 'failed',
  ).length
  if (result.firstPass.denominator)
    result.firstPass.percent = (result.firstPass.passed / result.firstPass.denominator) * 100
  return result
}

export function dashboardFlow(
  input: readonly DashboardTaskFacts[],
  range: DashboardRange,
  asOf: number,
  currentCompleted: readonly string[],
  previousCompleted: readonly string[],
): DashboardFlow {
  const facts = input.filter((task) => !task.setup)
  const timings = new Map(facts.map((task) => [task.id, timing(task, asOf)]))
  const completed = new Set([...currentCompleted, ...previousCompleted])
  const visits = new Map(
    facts.filter((task) => completed.has(task.id)).map((task) => [task.id, firstVisit(task, asOf)]),
  )
  const from = range === 'all' ? null : asOf - (range === '7d' ? 7 : 30) * day
  const current = period(facts, timings, visits, from, asOf, currentCompleted)
  const previous =
    range === 'all' || from === null
      ? null
      : period(facts, timings, visits, from - (asOf - from), from, previousCompleted)
  const selected = new Set([
    ...current.taskIds,
    ...current.incomplete.map((s) => s.taskId),
    ...current.sendBacks.flatMap((g) => g.taskIds),
    ...currentCompleted,
    ...(previous?.taskIds ?? []),
    ...(previous?.incomplete.map((s) => s.taskId) ?? []),
    ...(previous?.sendBacks.flatMap((g) => g.taskIds) ?? []),
    ...previousCompleted,
  ])
  return {
    tasks: facts
      .filter((t) => selected.has(t.id))
      .map(({ id, displayId, title, archived }) => {
        const timing = timings.get(id)
        return {
          id,
          displayId,
          title,
          archived,
          endedAt: timing?.endedAt ?? null,
          endReason: timing?.endReason ?? 'unknown',
        }
      }),
    current,
    previous,
  }
}
