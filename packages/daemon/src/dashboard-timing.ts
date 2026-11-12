import type {
  CheckRun,
  CheckTimingInterval,
  FlowInterval,
  FlowMeasuredInterval,
  FlowReason,
  FlowReasonId,
  FlowReasonSample,
  FlowTestEvidence,
  TaskIntervalHistory,
  TestInvocation,
} from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'

export interface FlowTimingFacts {
  history: TaskIntervalHistory
  checks: CheckRun[]
  invocations: TestInvocation[]
}

export const flowReasons: FlowReasonId[] = [
  'run-working',
  'running-check',
  'user-request',
  'run-slot',
  'check-slot',
  'test-lock',
  'github',
  'agent-paused',
  'blocker',
  'stopped',
]
const iso = (at: number) => new Date(at).toISOString()
const ms = Date.parse
const length = (i: FlowInterval) => ms(i.to) - ms(i.from)

export function unionMeasured(input: FlowMeasuredInterval[]): FlowMeasuredInterval[] {
  const result: FlowMeasuredInterval[] = []
  for (const interval of input.toSorted((a, b) => a.from.localeCompare(b.from))) {
    if (!(ms(interval.to) > ms(interval.from))) continue
    const last = result.at(-1)
    if (last && last.to >= interval.from) {
      if (last.to < interval.to) last.to = interval.to
      last.contributors.push(...interval.contributors)
    } else result.push({ ...interval, contributors: [...interval.contributors] })
  }
  return result
}

function clip(interval: FlowMeasuredInterval, windows: FlowInterval[]): FlowMeasuredInterval[] {
  if (!Number.isFinite(ms(interval.from)) || !Number.isFinite(ms(interval.to))) return []
  return windows.flatMap((w) => {
    const from = iso(Math.max(ms(w.from), ms(interval.from)))
    const to = iso(Math.min(ms(w.to), ms(interval.to)))
    if (from >= to) return []
    return [
      {
        from,
        to,
        contributors: interval.contributors.flatMap((c) => {
          const start = iso(Math.max(ms(c.start), ms(from)))
          const end = iso(Math.min(ms(c.end), ms(to)))
          return start < end ? [{ ...c, start, end }] : []
        }),
      },
    ]
  })
}

export function timingSamples(
  taskId: string,
  facts: FlowTimingFacts | undefined,
  active: FlowInterval[],
  asOf: string,
  incomplete: readonly string[],
): Map<FlowReasonId, FlowReasonSample> {
  const windows = unionMeasured(active.map((i) => ({ ...i, contributors: [] })))
  const eligibleMs = windows.reduce((n, i) => n + length(i), 0)
  const result = new Map<FlowReasonId, FlowReasonSample>()
  for (const reason of flowReasons) {
    const sample: FlowReasonSample = {
      taskId,
      elapsedMs: null,
      eligibleMs,
      coveredMs: null,
      coverage: 'unavailable',
      intervals: [],
      coverageIntervals: [],
      notices: [...incomplete],
      invocations: [],
    }
    result.set(reason, sample)
    if (!facts || eligibleMs === 0) {
      sample.notices.push('No supported timing evidence for this Task interval.')
      continue
    }
    if (reason === 'check-slot' || reason === 'running-check') {
      checkSample(sample, reason, facts, windows, asOf)
    } else if (reason === 'test-lock') {
      testSample(sample, facts, windows, asOf)
    } else {
      sample.intervals = unionMeasured(
        facts.history.intervals
          .filter((i) => i.reason === reason)
          .flatMap((i) =>
            clip({ from: i.start, to: i.end, contributors: i.contributors }, windows),
          ),
      )
      sample.coverageIntervals = facts.history.coverage
        .filter((i) => i.reason === reason)
        .flatMap((i) =>
          clip({ from: i.start, to: i.end, contributors: [] }, windows).map((w) => ({
            ...i,
            start: w.from,
            end: w.to,
          })),
        )
      sample.coveredMs = unionMeasured(
        sample.coverageIntervals
          .filter((c) => c.state === 'known')
          .map((c) => ({ from: c.start, to: c.end, contributors: [] })),
      ).reduce((n, i) => n + length(i), 0)
      const recording = facts.history.coverage.find(
        (c) => c.reason === reason && c.source === 'observation',
      )
      if (recording) sample.notices.push(`Observed recording starts ${recording.start}.`)
      if (sample.coverageIntervals.some((c) => c.state === 'unknown'))
        sample.notices.push('Unknown history is excluded; recording gaps do not establish absence.')
      if (sample.coveredMs > 0 || sample.intervals.length) {
        sample.elapsedMs = sample.intervals.reduce((n, i) => n + length(i), 0)
        sample.coverage =
          sample.coveredMs === eligibleMs && incomplete.length === 0 ? 'full' : 'partial'
      }
    }
    if (sample.coverage === 'full' && incomplete.length) sample.coverage = 'partial'
  }
  return result
}

function checkSample(
  sample: FlowReasonSample,
  reason: 'check-slot' | 'running-check',
  facts: FlowTimingFacts,
  windows: FlowInterval[],
  asOf: string,
) {
  const first = windows[0]
  const last = windows.at(-1)
  if (!first || !last) return
  let missing = false
  const add = (run: CheckRun, interval: CheckTimingInterval, position?: number) => {
    if (interval.status === 'unavailable') {
      missing = true
      sample.notices.push(
        `Check ${run.id}${position === undefined ? ' queue' : ` position ${position}`}: timing not recorded.`,
      )
      return
    }
    if (!('endedAt' in interval) && interval.status !== 'ongoing') {
      missing = true
      sample.notices.push(
        `Check ${run.id}: start ${interval.startedAt}; interruption detected ${interval.detectedAt}; end unavailable.`,
      )
      return
    }
    const end = 'endedAt' in interval ? interval.endedAt : asOf
    if (end === interval.startedAt)
      sample.notices.push(
        `Check ${run.id}: ${position === undefined ? 'immediate admission' : 'zero command duration'} at ${end}; recorded zero.`,
      )
    if (ms(end) < ms(interval.startedAt)) {
      missing = true
      return
    }
    sample.intervals.push(
      ...clip(
        {
          from: interval.startedAt,
          to: end,
          contributors: [
            {
              id: run.id,
              detail:
                position === undefined
                  ? 'Check-slot queue'
                  : `Check position ${position}; command time can contain test-lock waits`,
              start: interval.startedAt,
              end,
              startSource: position === undefined ? 'Check queue entered' : 'Check command started',
              endSource: 'endedAt' in interval ? interval.status : 'response-as-of',
            },
          ],
        },
        windows,
      ),
    )
  }
  for (const run of facts.checks) {
    if (
      run.startedAt >= asOf ||
      run.startedAt >= last.to ||
      (run.finishedAt !== undefined && run.finishedAt <= first.from)
    )
      continue
    if (!run.timing) {
      missing = true
      sample.notices.push(`Check ${run.id}: timing unavailable.`)
      continue
    }
    if (reason === 'check-slot') add(run, run.timing.queue)
    else
      for (const [position, check] of run.checks.entries()) {
        const interval = run.timing.execution.find((e) => e.position === position)
        if (
          interval?.status === 'unavailable' &&
          ['waiting', 'skipped', 'not-run'].includes(check.state)
        )
          continue
        if (interval) add(run, interval, position)
        else if (!['waiting', 'skipped', 'not-run'].includes(check.state)) missing = true
      }
  }
  sample.intervals = unionMeasured(sample.intervals)
  if (!missing || sample.intervals.length) {
    sample.elapsedMs = sample.intervals.reduce((n, i) => n + length(i), 0)
    sample.coveredMs = missing ? null : sample.eligibleMs
    sample.coverage = missing ? 'partial' : 'full'
  }
}

function testSample(
  sample: FlowReasonSample,
  facts: FlowTimingFacts,
  windows: FlowInterval[],
  asOf: string,
) {
  const first = windows[0]
  const last = windows.at(-1)
  if (!first || !last) return
  sample.notices.push(
    'Only registered invocations are measured; other direct commands and unsupported runners are outside coverage.',
  )
  let supported = false
  let missingReports = 0
  const associations = new Set<string>()
  for (const invocation of facts.invocations) {
    if (invocation.registeredAt >= ms(asOf)) continue
    const reports = invocation.reports.filter((r) => r.at <= ms(asOf))
    const terminal = reports.find((r) => ['finished', 'canceled', 'interrupted'].includes(r.kind))
    const end = terminal?.at ?? ms(asOf)
    if (
      !windows.some(
        (w) =>
          invocation.registeredAt < ms(w.to) &&
          (end > ms(w.from) || (end === invocation.registeredAt && end >= ms(w.from))),
      )
    )
      continue
    if (invocation.checkRunId !== undefined)
      associations.add(`${invocation.checkRunId}:${invocation.position}`)
    const evidence: FlowTestEvidence = {
      id: invocation.id,
      registeredAt: iso(invocation.registeredAt),
      ...(invocation.runId !== undefined && { runId: invocation.runId }),
      ...(invocation.checkRunId !== undefined && {
        checkRunId: invocation.checkRunId,
        position: invocation.position,
      }),
      coverage: !invocation.supported
        ? 'unsupported'
        : !terminal && invocation.ownerEnded
          ? 'incomplete'
          : reports.length
            ? 'reported'
            : 'unreported',
      ...(terminal && { outcome: terminal.kind }),
    }
    let start: number | undefined
    const before = sample.intervals.length
    for (const report of invocation.supported ? reports : []) {
      if (report.kind === 'wait-start') start = report.at
      else if (start !== undefined) {
        sample.intervals.push(
          ...clip(
            {
              from: iso(start),
              to: iso(report.at),
              contributors: [
                {
                  id: invocation.id,
                  detail: invocation.checkRunId
                    ? `Associated Check ${invocation.checkRunId}, position ${invocation.position}; overlapping command time is also counted in Running Checks`
                    : `Direct Run ${invocation.runId ? shortReference(invocation.runId) : 'unknown'}`,
                  start: iso(start),
                  end: iso(report.at),
                  startSource: 'reported wait-start',
                  endSource: `reported ${report.kind}`,
                },
              ],
            },
            windows,
          ),
        )
        start = undefined
      }
    }
    if (start !== undefined) {
      evidence.openWaitStartedAt = iso(start)
      sample.notices.push(
        `Invocation ${invocation.id}: wait started ${iso(start)}; no closing report, final duration unavailable.`,
      )
    }
    const command =
      invocation.checkRunId === undefined
        ? undefined
        : facts.checks
            .find((c) => c.id === invocation.checkRunId)
            ?.timing?.execution.find((e) => e.position === invocation.position)
    if (
      command &&
      command.status !== 'unavailable' &&
      ('endedAt' in command || command.status === 'ongoing')
    ) {
      const to = 'endedAt' in command ? command.endedAt : asOf
      const confirmed = unionMeasured(
        sample.intervals.slice(before).flatMap((i) => clip(i, [{ from: command.startedAt, to }])),
      )
      evidence.checkCommand = {
        from: command.startedAt,
        to,
        overlapMs: confirmed.reduce((n, i) => n + length(i), 0),
      }
    }
    if (invocation.supported && (terminal || sample.intervals.length > before)) supported = true
    sample.invocations.push(evidence)
  }
  for (const run of facts.checks)
    for (const [position, check] of run.checks.entries()) {
      const interval = run.timing?.execution.find((e) => e.position === position)
      if (
        ['waiting', 'skipped', 'not-run'].includes(check.state) &&
        (!interval || interval.status === 'unavailable')
      )
        continue
      if (run.startedAt >= last.to || (run.finishedAt && run.finishedAt <= first.from)) continue
      if (associations.has(`${run.id}:${position}`)) continue
      if (missingReports < 256)
        sample.notices.push(
          `Check ${run.id}, position ${position}: no invocation report; ${check.state}.`,
        )
      missingReports++
    }
  if (missingReports > 256)
    sample.notices.push(
      `${missingReports - 256} additional unreported Check references omitted (limit 256).`,
    )
  if (facts.invocations.length >= 256)
    sample.notices.push(
      'Invocation recording limit reached (256 per Task); further commands may be missing.',
    )
  sample.intervals = unionMeasured(sample.intervals)
  if (supported) {
    sample.elapsedMs = sample.intervals.reduce((n, i) => n + length(i), 0)
    sample.coverage = 'partial'
  }
}

export function summarizeReasons(samples: Map<FlowReasonId, FlowReasonSample>[]): FlowReason[] {
  const quantile = (values: number[], p: number): number | null => {
    if (!values.length) return null
    const index = (values.length - 1) * p
    const a = values[Math.floor(index)] ?? 0
    return a + ((values[Math.ceil(index)] ?? a) - a) * (index % 1)
  }
  return flowReasons.map((reason) => {
    const own = samples.flatMap((s) => s.get(reason) ?? [])
    const values = own
      .flatMap((s) => (s.elapsedMs === null ? [] : [s.elapsedMs]))
      .sort((a, b) => a - b)
    return {
      reason,
      totalMs: values.reduce((n, v) => n + v, 0),
      medianMs: quantile(values, 0.5),
      p25Ms: quantile(values, 0.25),
      p75Ms: quantile(values, 0.75),
      samples: own,
    }
  })
}
