import type {
  DashboardBucket,
  DashboardChange,
  DashboardDuration,
  DashboardFactoryPeriod,
  DashboardMerged,
  DashboardOpenState,
  DashboardOpenTask,
  DashboardPeriod,
  DashboardRange,
  DashboardReport,
  DashboardSample,
  DashboardTask,
  TaskStatusKind,
} from '@ted/protocol'
import { isEntryStage } from '@ted/protocol/stage'
import { type CostInput, type CostWindow, dashboardCost } from './dashboard-cost.ts'
import { dashboardFlow, type FlowFacts } from './dashboard-flow.ts'
import { dashboardWaiting } from './dashboard-waiting.ts'

export interface DashboardTaskFacts extends FlowFacts {
  id: string
  factoryId: string
  displayId: string
  title: string
  createdAt: string
  archived: boolean
  setup: boolean
  stage: string
  entries: readonly { stage: string; at: string; sequence?: number; name?: string }[]
  merges?: readonly string[]
  status?: TaskStatusKind
}

const dayMs = 86_400_000
const hourMs = 3_600_000
const iso = (time: number) => new Date(time).toISOString()

function elapsed(start: number, end: number): number | null {
  return Number.isFinite(start) && start <= end ? end - start : null
}

const durationField = {
  created: 'createdMs',
  backlog: 'backlogMs',
  intake: 'intakeMs',
} as const satisfies Record<DashboardDuration, keyof DashboardTask>

function sample(tasks: readonly DashboardTask[], duration: DashboardDuration): DashboardSample {
  const field = durationField[duration]
  const values: number[] = []
  const taskIds: string[] = []
  const missingIds: string[] = []
  for (const task of tasks) {
    const value = task[field]
    if (value === null) missingIds.push(task.id)
    else {
      taskIds.push(task.id)
      values.push(value)
    }
  }
  values.sort((a, b) => a - b)
  const lower = values[Math.floor((values.length - 1) / 2)]
  const upper = values[Math.floor(values.length / 2)]
  const value = lower === undefined || upper === undefined ? null : (lower + upper) / 2
  return { value, taskIds, missingIds }
}

type Merges = ReadonlyMap<string, readonly number[]>

function merged(
  tasks: readonly DashboardTask[],
  merges: Merges,
  from: number,
  to: number,
): DashboardMerged {
  let count = 0
  const taskIds: string[] = []
  for (const task of tasks) {
    const inPeriod = (merges.get(task.id) ?? []).filter((at) => at >= from && at < to).length
    if (inPeriod === 0) continue
    count += inPeriod
    taskIds.push(task.id)
  }
  return { count, taskIds }
}

function samples(selected: readonly DashboardTask[]) {
  return {
    taskIds: selected.map((task) => task.id),
    created: sample(selected, 'created'),
    backlog: sample(selected, 'backlog'),
    intake: sample(selected, 'intake'),
  }
}

function bucket(
  tasks: readonly DashboardTask[],
  merges: Merges,
  from: number,
  to: number,
): DashboardBucket {
  const selected = tasks.filter((task) => {
    const at = Date.parse(task.doneAt ?? '')
    return at >= from && at < to
  })
  return {
    from: iso(from),
    to: iso(to),
    merged: merged(tasks, merges, from, to),
    ...samples(selected),
  }
}

type Edges = readonly (readonly [number, number])[]

function hours(from: number, to: number): Edges {
  const edges: [number, number][] = []
  for (let at = from; at < to; at += hourMs) edges.push([at, Math.min(at + hourMs, to)])
  return edges
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function addDays(time: number, days: number): number {
  const date = new Date(time)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

function days(from: number, to: number, perPoint: number): Edges {
  const edges: [number, number][] = []
  for (let at = from; at < to; at = addDays(at, perPoint))
    edges.push([at, Math.min(addDays(at, perPoint), to)])
  return edges
}

function allHistory(first: number, asOf: number): { from: number; perPoint: number } {
  const today = startOfDay(asOf)
  const total = Math.round((today - startOfDay(first)) / dayMs) + 1
  const perPoint = Math.ceil(total / 30)
  return { from: addDays(today, 1 - Math.ceil(total / perPoint) * perPoint), perPoint }
}

function sameDayIn(time: number, year: number, month: number): number {
  const date = new Date(time)
  const last = new Date(year, month + 1, 0).getDate()
  date.setFullYear(year, month, Math.min(date.getDate(), last))
  return date.getTime()
}

function monthsBack(time: number, months: number): number {
  const date = new Date(time)
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1)
  return sameDayIn(time, target.getFullYear(), target.getMonth())
}

function startOfWeek(time: number): number {
  const today = startOfDay(time)
  return addDays(today, -((new Date(today).getDay() + 6) % 7))
}

function dailyEdges(from: number, to: number): { edges: Edges; perPoint: number } {
  const total = days(from, to, 1).length
  const perPoint = total <= 31 ? 1 : Math.ceil(total / 30)
  return { edges: days(from, to, perPoint), perPoint }
}

function periodBounds(range: Exclude<DashboardRange, 'all'>, asOf: number) {
  const today = startOfDay(asOf)
  const year = new Date(asOf).getFullYear()
  switch (range) {
    case 'today':
      return {
        from: today,
        to: asOf,
        previousFrom: addDays(today, -1),
        previousTo: addDays(asOf, -1),
      }
    case '7d':
    case '30d':
    case '90d': {
      const length = range === '7d' ? 7 : range === '30d' ? 30 : 90
      const from = addDays(today, -length)
      return { from, to: today, previousFrom: addDays(from, -length), previousTo: from }
    }
    case '12m': {
      const from = monthsBack(today, 12)
      return { from, to: today, previousFrom: monthsBack(from, 12), previousTo: from }
    }
    case 'week': {
      const from = startOfWeek(asOf)
      return { from, to: asOf, previousFrom: addDays(from, -7), previousTo: addDays(asOf, -7) }
    }
    case 'month': {
      const from = new Date(year, new Date(asOf).getMonth(), 1).getTime()
      return { from, to: asOf, previousFrom: monthsBack(from, 1), previousTo: monthsBack(asOf, 1) }
    }
    case 'year': {
      const from = new Date(year, 0, 1).getTime()
      return {
        from,
        to: asOf,
        previousFrom: new Date(year - 1, 0, 1).getTime(),
        previousTo: monthsBack(asOf, 12),
      }
    }
  }
}

export function rangeWindows(range: Exclude<DashboardRange, 'all'>, asOf: number) {
  const { from, to, previousFrom, previousTo } = periodBounds(range, asOf)
  const previous = { from: previousFrom, to: Math.min(from, previousTo) }
  if (range === 'today')
    return { from, to, previous, edges: hours(from, to), previousEdges: hours(previousFrom, from) }
  const { edges, perPoint } = dailyEdges(from, to)
  const before = days(previous.from, previous.to, perPoint)
  const last = before[edges.length - 1]
  const previousEdges =
    before.length > edges.length && last
      ? [...before.slice(0, edges.length - 1), [last[0], previous.to] as const]
      : before
  return { from, to, previous, edges, previousEdges }
}

function byFactory(
  tasks: readonly DashboardTask[],
  merges: Merges,
  window: readonly [number, number] | null,
  taskIds: readonly string[],
  factoryIds: readonly string[],
): DashboardFactoryPeriod[] {
  const inPeriod = new Set(taskIds)
  return factoryIds.map((factoryId) => {
    const own = tasks.filter((task) => task.factoryId === factoryId)
    return {
      factoryId,
      merged: window ? merged(own, merges, ...window) : { count: 0, taskIds: [] },
      ...samples(own.filter((task) => inPeriod.has(task.id))),
    }
  })
}

function period(
  tasks: readonly DashboardTask[],
  merges: Merges,
  from: number | null,
  to: number,
  edges: Edges,
  factoryIds: readonly string[],
): DashboardPeriod {
  const whole =
    from === null
      ? { merged: { count: 0, taskIds: [] }, ...samples([]) }
      : bucket(tasks, merges, from, to)
  const buckets = edges.map(([start, end]) => bucket(tasks, merges, start, end))
  return {
    ...whole,
    from: from === null ? null : iso(from),
    to: iso(to),
    buckets,
    byFactory: byFactory(
      tasks,
      merges,
      from === null ? null : [from, to],
      whole.taskIds,
      factoryIds,
    ),
  }
}

function openState(task: DashboardTaskFacts): DashboardOpenState {
  if (task.status === 'waiting-on-you') return 'waiting-on-you'
  if (task.status === 'working') return 'working'
  if (task.status === 'blocked') return 'blocked'
  if (task.stage === 'backlog') return 'backlog'
  return 'other'
}

function change(value: number | null, previous: number | null): DashboardChange {
  const absolute = value === null || previous === null ? null : value - previous
  return {
    absolute,
    percent:
      absolute === null || previous === null || previous === 0 ? null : (absolute / previous) * 100,
  }
}

export function dashboardReport(
  facts: readonly DashboardTaskFacts[],
  factoryIds: readonly string[],
  range: DashboardRange,
  asOf: number,
  spend: Pick<CostInput, 'usage' | 'tasks' | 'allFactories'> = {
    usage: [],
    tasks: [],
    allFactories: false,
  },
): DashboardReport {
  const tasks: DashboardTask[] = []
  const unavailableIds: string[] = []
  const open: DashboardOpenTask[] = []
  const merges = new Map<string, number[]>()
  for (const task of facts) {
    if (task.setup) continue
    if (!task.archived && task.stage !== 'done')
      open.push({
        id: task.id,
        factoryId: task.factoryId,
        displayId: task.displayId,
        title: task.title,
        stage: task.stage,
        state: openState(task),
      })
    const ends = task.entries
      .filter((entry) => entry.stage === 'done')
      .map((entry) => Date.parse(entry.at))
      .filter(Number.isFinite)
    const done = ends.length === 0 ? null : Math.max(...ends)
    if (done === null) {
      if (task.stage === 'done') {
        unavailableIds.push(task.id)
        tasks.push({
          id: task.id,
          factoryId: task.factoryId,
          displayId: task.displayId,
          title: task.title,
          archived: task.archived,
          doneAt: null,
          createdMs: null,
          backlogMs: null,
          intakeMs: null,
          merges: 0,
        })
      }
      continue
    }
    if (done >= asOf) continue
    const starts = task.entries
      .filter((entry) => isEntryStage(entry.stage))
      .map((entry) => Date.parse(entry.at))
      .filter(Number.isFinite)
    const first = starts.length === 0 ? null : Math.min(...starts)
    const mergedAt = (task.merges ?? []).map(Date.parse).filter((at) => at < asOf)
    merges.set(task.id, mergedAt)
    tasks.push({
      id: task.id,
      factoryId: task.factoryId,
      displayId: task.displayId,
      title: task.title,
      archived: task.archived,
      doneAt: iso(done),
      createdMs: elapsed(Date.parse(task.createdAt), done),
      backlogMs: first === null ? null : elapsed(Date.parse(task.createdAt), first),
      intakeMs: first === null ? null : elapsed(first, done),
      merges: mergedAt.length,
    })
  }
  const times = tasks.flatMap((task) => (task.doneAt === null ? [] : [Date.parse(task.doneAt)]))
  const windows = range === 'all' ? null : rangeWindows(range, asOf)
  const history = windows || times.length === 0 ? null : allHistory(Math.min(...times), asOf)
  const from = windows ? windows.from : history ? history.from : null
  const to = windows ? windows.to : asOf
  const current = period(
    tasks,
    merges,
    from,
    to,
    windows ? windows.edges : history ? days(history.from, to, history.perPoint) : [],
    factoryIds,
  )
  const previous = windows
    ? period(
        tasks,
        merges,
        windows.previous.from,
        windows.previous.to,
        windows.previousEdges,
        factoryIds,
      )
    : null
  const waiting = dashboardWaiting(facts, current.taskIds, factoryIds, asOf)
  const waitedBefore = previous ? dashboardWaiting(facts, previous.taskIds, factoryIds, asOf) : null
  const pullRequests = new Map(tasks.map((task) => [task.id, task.merges]))
  const costWindow = (p: DashboardPeriod): CostWindow => ({
    from: p.from,
    to: p.to,
    buckets: p.buckets.map((b) => ({ from: b.from, to: b.to })),
    completed: p.taskIds.map((taskId) => ({ taskId, pullRequests: pullRequests.get(taskId) ?? 0 })),
  })
  const selected = new Set([
    ...current.taskIds,
    ...current.merged.taskIds,
    ...(previous?.taskIds ?? []),
    ...(previous?.merged.taskIds ?? []),
    ...(previous?.buckets.flatMap((b) => b.taskIds) ?? []),
    ...unavailableIds,
  ])
  return {
    asOf: iso(asOf),
    range,
    factoryIds: [...factoryIds],
    tasks: tasks.filter((task) => selected.has(task.id)),
    unavailableIds,
    open,
    current,
    previous,
    comparison:
      previous === null
        ? null
        : {
            completed: change(current.taskIds.length, previous.taskIds.length),
            merged: change(current.merged.count, previous.merged.count),
            created: change(current.created.value, previous.created.value),
            backlog: change(current.backlog.value, previous.backlog.value),
            intake: change(current.intake.value, previous.intake.value),
          },
    flow: dashboardFlow(
      facts,
      windows ? windows.from : null,
      to,
      windows ? windows.previous : null,
      asOf,
    ),
    waiting: {
      current: waiting,
      previous: waitedBefore,
      change: waitedBefore ? change(waiting.totalMs, waitedBefore.totalMs) : null,
    },
    cost: dashboardCost({
      ...spend,
      factoryIds,
      current: costWindow(current),
      previous: previous ? costWindow(previous) : null,
    }),
  }
}
