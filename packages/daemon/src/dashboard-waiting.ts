import type { DashboardWait, DashboardWaiting, DashboardWaitStage } from '@ted/protocol'
import { builtInStageOrder, isHoldingStage } from '@ted/protocol/stage'
import type { DashboardTaskFacts } from './dashboard.ts'
import { stageTiming } from './dashboard-flow.ts'
import type { WaitRequest } from './dashboard-timing.ts'

const questionKinds: Readonly<Record<string, string>> = {
  failure: 'Failure decision',
  'size-check': 'Size check',
  'send-back': 'Send-back decision',
  archive: 'Archive request',
  'failed-run': 'Failed Run',
  'cleanup-failure': 'Cleanup failure',
  'memory-kill': 'Out of memory',
  'idle-run': 'Idle Run',
  'ci-stuck': 'Stuck CI',
  model: 'Model unavailable',
  simulator: 'Simulator slot',
  'linear-closed': 'Closed in tracker',
  'tracker-closed': 'Closed in tracker',
  'linear-team': 'Tracker sync question',
  'tracker-group': 'Tracker sync question',
  'asana-missing': 'Missing Asana items',
  'asana-unfinished': 'Unfinished Asana items',
}

const stageName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

export function waitKind(request: Pick<WaitRequest, 'kind' | 'purpose'>, stage: string | null) {
  if (request.kind === 'signoff' || request.kind === 'review' || request.purpose === 'gate')
    return stage ? `${stageName(stage)} Sign-Off` : 'Sign-Off'
  if (request.kind === 'round') return 'Clarify round'
  if (request.kind === 'proposal') return 'Split proposal'
  if (request.kind === 'permission')
    return request.purpose === 'simulator' ? 'Simulator slot' : 'Permission'
  return questionKinds[request.purpose ?? ''] ?? 'Question'
}

const order: readonly string[] = builtInStageOrder.filter((id) => !isHoldingStage(id))
const rank = (stage: string) => {
  const index = order.indexOf(stage)
  return index < 0 ? order.length : index
}

type Span = [number, number]

function union(spans: Span[]): Span[] {
  const result: Span[] = []
  for (const [a, b] of spans.toSorted((x, y) => x[0] - y[0])) {
    const last = result.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else result.push([a, b])
  }
  return result
}

const length = (spans: readonly Span[]) => spans.reduce((n, [a, b]) => n + b - a, 0)

function median(values: number[]): number | null {
  const sorted = values.toSorted((a, b) => a - b)
  const lower = sorted[Math.floor((sorted.length - 1) / 2)]
  const upper = sorted[Math.floor(sorted.length / 2)]
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2
}

export function dashboardWaiting(
  facts: readonly DashboardTaskFacts[],
  completedIds: readonly string[],
  factoryIds: readonly string[],
  asOf: number,
): DashboardWaiting {
  const completed = new Set(completedIds)
  const stages = new Map<string, DashboardWaitStage>()
  const waits: DashboardWait[] = []
  const samples: DashboardWaiting['samples'] = []
  const factoryTotals = new Map(
    factoryIds.map((id) => [id, { totalMs: 0, taskIds: [] as string[] }]),
  )
  for (const task of facts) {
    if (task.setup || !completed.has(task.id) || !task.activity) continue
    const windows = stageTiming(task, asOf).intervals
    const requests = new Map((task.activity.requests ?? []).map((r) => [r.id, r]))
    const spans = new Map<string, Span[]>()
    for (const interval of task.activity.history.intervals) {
      if (interval.reason !== 'user-request') continue
      for (const c of interval.contributors) {
        const span: Span = [Date.parse(c.start), Date.parse(c.end)]
        if (!(span[1] > span[0])) continue
        spans.set(c.id, [...(spans.get(c.id) ?? []), span])
      }
    }
    const perStage = new Map<string, Span[]>()
    for (const [id, own] of spans) {
      const request = requests.get(id)
      const first = Math.min(...own.map(([a]) => a))
      const stage =
        request?.stage ?? windows.find((w) => w.from <= first && first < w.to)?.stage ?? null
      const kind = waitKind(request ?? { kind: 'question', purpose: null }, stage)
      let waitedMs = 0
      for (const window of windows) {
        const clipped = union(
          own.flatMap(([a, b]): Span[] => {
            const from = Math.max(a, window.from)
            const to = Math.min(b, window.to)
            return to > from ? [[from, to]] : []
          }),
        )
        if (!clipped.length) continue
        waitedMs += length(clipped)
        perStage.set(window.stage, [...(perStage.get(window.stage) ?? []), ...clipped])
        const entry = stages.get(window.stage) ?? {
          stage: window.stage,
          totalMs: 0,
          kinds: [],
          samples: [],
        }
        if (!entry.kinds.includes(kind)) entry.kinds.push(kind)
        stages.set(window.stage, entry)
      }
      if (waitedMs > 0) waits.push({ taskId: task.id, requestId: id, kind, stage, waitedMs })
    }
    let taskMs = 0
    for (const [stage, own] of perStage) {
      const ms = length(union(own))
      const entry = stages.get(stage)
      if (!entry || ms === 0) continue
      entry.totalMs += ms
      entry.samples.push({ taskId: task.id, waitedMs: ms })
      taskMs += ms
    }
    if (taskMs === 0) continue
    samples.push({ taskId: task.id, waitedMs: taskMs })
    const factory = factoryTotals.get(task.factoryId)
    if (factory) {
      factory.totalMs += taskMs
      factory.taskIds.push(task.id)
    }
  }
  const longest = <T extends { waitedMs: number }>(list: T[]) =>
    list.sort((a, b) => b.waitedMs - a.waitedMs)
  for (const stage of stages.values()) longest(stage.samples)
  return {
    totalMs: samples.reduce((n, s) => n + s.waitedMs, 0),
    medianMs: median(waits.map((w) => w.waitedMs)),
    samples: longest(samples),
    stages: [...stages.values()]
      .filter((s) => s.totalMs > 0)
      .sort((a, b) => b.totalMs - a.totalMs || rank(a.stage) - rank(b.stage)),
    waits: longest(waits),
    byFactory: [...factoryTotals].map(([factoryId, t]) => ({ factoryId, ...t })),
  }
}
