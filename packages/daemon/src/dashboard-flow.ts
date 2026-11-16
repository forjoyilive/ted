import type {
  DashboardFlow,
  FlowInterval,
  FlowPeriod,
  FlowReasonId,
  FlowStage,
  FlowStageSample,
  StageParts,
} from '@ted/protocol'
import { builtInStageOrder, isCleanup, isEntryStage, isHoldingStage } from '@ted/protocol/stage'
import { addStageParts, noStageParts, splitStage } from '@ted/protocol/stage-parts'
import type { DashboardTaskFacts } from './dashboard.ts'
import { type FlowTimingFacts, summarizeReasons, timingSamples } from './dashboard-timing.ts'

export interface FlowFacts {
  activity?: FlowTimingFacts
  transitions?: readonly { stage: string; at: string; sequence?: number }[]
  archivedAt?: string | null
  archives?: readonly string[]
  sendBacks?: readonly { at: string }[]
}

const iso = (at: number) => new Date(at).toISOString()
const time = (at: string | null | undefined) => Date.parse(at ?? '')
const finite = Number.isFinite
export const quantile = (values: number[], p: number): number | null => {
  if (!values.length) return null
  const index = (values.length - 1) * p
  const lower = values[Math.floor(index)] ?? 0
  const upper = values[Math.ceil(index)] ?? lower
  return lower + (upper - lower) * (index - Math.floor(index))
}

export function stageTiming(task: DashboardTaskFacts, asOf: number) {
  const entries = (task.transitions ?? task.entries).map((entry, index) => ({
    ...entry,
    index,
    ms: time(entry.at),
  }))
  const start = entries.find((entry) => isEntryStage(entry.stage) && finite(entry.ms))
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
        isEntryStage(entry.stage) &&
        isEntryStage(entries[index - 1]?.stage ?? '') &&
        previous !== undefined &&
        isEntryStage(previous.stage) &&
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

type Timing = ReturnType<typeof stageTiming>

export function stageSampleParts(
  sample: Pick<FlowStageSample, 'intervals'>,
  reasons: ReadonlyMap<FlowReasonId, { intervals: readonly FlowInterval[] }>,
): StageParts {
  return splitStage(
    sample.intervals,
    new Map([...reasons].map(([reason, s]) => [reason, s.intervals])),
  )
}

function period(
  facts: readonly DashboardTaskFacts[],
  timings: Map<string, Timing>,
  from: number | null,
  to: number,
): FlowPeriod {
  const result: FlowPeriod = {
    from: from === null ? null : iso(from),
    to: iso(to),
    taskIds: [],
    incomplete: [],
    stages: [],
    reasons: [],
  }
  const order: string[] = builtInStageOrder.filter((id) => !isHoldingStage(id) && !isCleanup(id))
  const stages = new Map<string, FlowStage>(
    order.map((stage) => [
      stage,
      {
        stage,
        factoryIds: [],
        totalMs: 0,
        medianMs: null,
        p25Ms: null,
        p75Ms: null,
        parts: noStageParts(),
        samples: [],
      },
    ]),
  )
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
        parts: noStageParts(),
      }
      sample.elapsedMs += b - a
      sample.intervals.push({ from: iso(a), to: iso(b) })
      perStage.set(interval.stage, sample)
    }
    if (overlaps && measured.start !== undefined) {
      const own = timingSamples(
        task.id,
        task.activity,
        [...perStage.values()].flatMap((s) => s.intervals),
        task.activity?.history.asOf ?? iso(to),
        measured.reasons,
      )
      reasonSamples.push(own)
      for (const sample of perStage.values()) sample.parts = stageSampleParts(sample, own)
    }
    for (const [name, sample] of perStage) {
      const stage = stages.get(name) ?? {
        stage: name,
        factoryIds: [],
        totalMs: 0,
        medianMs: null,
        p25Ms: null,
        p75Ms: null,
        parts: noStageParts(),
        samples: [],
      }
      stage.totalMs += sample.elapsedMs
      addStageParts(stage.parts, sample.parts)
      stage.samples.push(sample)
      if (!stage.factoryIds.includes(task.factoryId)) stage.factoryIds.push(task.factoryId)
      stages.set(name, stage)
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
  return result
}

export function dashboardFlow(
  input: readonly DashboardTaskFacts[],
  from: number | null,
  to: number,
  before: { from: number; to: number } | null,
  asOf: number,
): DashboardFlow {
  const facts = input.filter((task) => !task.setup)
  const timings = new Map(facts.map((task) => [task.id, stageTiming(task, asOf)]))
  const current = period(facts, timings, from, to)
  const previous = before ? period(facts, timings, before.from, before.to) : null
  const selected = new Set([
    ...current.taskIds,
    ...current.incomplete.map((s) => s.taskId),
    ...(previous?.taskIds ?? []),
    ...(previous?.incomplete.map((s) => s.taskId) ?? []),
  ])
  return {
    tasks: facts
      .filter((t) => selected.has(t.id))
      .map(({ id, factoryId, displayId, title, archived }) => {
        const timing = timings.get(id)
        return {
          id,
          factoryId,
          displayId,
          title,
          archived,
          endedAt: timing?.endedAt ?? null,
          endReason: timing?.endReason ?? 'unknown',
        }
      }),
    current,
    previous,
    stageNames: recordedNames(facts),
  }
}

function recordedNames(facts: readonly DashboardTaskFacts[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const task of facts)
    for (const entry of task.entries) if (entry.name !== undefined) names[entry.stage] = entry.name
  return names
}
