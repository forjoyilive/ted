import type {
  DashboardBucket,
  DashboardChange,
  DashboardFactoryPeriod,
  DashboardPeriod,
  DashboardRange,
  DashboardReport,
  DashboardSample,
  DashboardTask,
} from '@ted/protocol'
import { dashboardFlow, type FlowFacts } from './dashboard-flow.ts'

export interface DashboardTaskFacts extends FlowFacts {
  id: string
  factoryId: string
  displayId: string
  title: string
  createdAt: string
  archived: boolean
  setup: boolean
  stage: string
  entries: readonly { stage: string; at: string; sequence?: number }[]
}

const dayMs = 86_400_000
const hourMs = 3_600_000
const iso = (time: number) => new Date(time).toISOString()

function elapsed(start: number, end: number): number | null {
  return Number.isFinite(start) && start <= end ? end - start : null
}

function sample(tasks: readonly DashboardTask[], field: 'createdMs' | 'intakeMs'): DashboardSample {
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

function bucket(tasks: readonly DashboardTask[], from: number, to: number): DashboardBucket {
  const selected = tasks.filter((task) => {
    const at = Date.parse(task.doneAt ?? '')
    return at >= from && at < to
  })
  return {
    from: iso(from),
    to: iso(to),
    taskIds: selected.map((task) => task.id),
    created: sample(selected, 'createdMs'),
    intake: sample(selected, 'intakeMs'),
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

export function rangeWindows(range: Exclude<DashboardRange, 'all'>, asOf: number) {
  const today = startOfDay(asOf)
  if (range === 'today') {
    const yesterday = addDays(today, -1)
    return {
      from: today,
      to: asOf,
      previous: { from: yesterday, to: Math.min(today, addDays(asOf, -1)) },
      previousDay: yesterday,
    }
  }
  const length = range === '7d' ? 7 : 30
  const from = addDays(today, -length)
  return {
    from,
    to: today,
    previous: { from: addDays(from, -length), to: from },
    previousDay: null,
  }
}

function byFactory(
  tasks: readonly DashboardTask[],
  taskIds: readonly string[],
  factoryIds: readonly string[],
): DashboardFactoryPeriod[] {
  const inPeriod = new Set(taskIds)
  return factoryIds.map((factoryId) => {
    const selected = tasks.filter((task) => task.factoryId === factoryId && inPeriod.has(task.id))
    return {
      factoryId,
      taskIds: selected.map((task) => task.id),
      created: sample(selected, 'createdMs'),
      intake: sample(selected, 'intakeMs'),
    }
  })
}

function period(
  tasks: readonly DashboardTask[],
  from: number | null,
  to: number,
  edges: Edges,
  factoryIds: readonly string[],
): DashboardPeriod {
  const whole =
    from === null
      ? { taskIds: [], created: sample([], 'createdMs'), intake: sample([], 'intakeMs') }
      : bucket(tasks, from, to)
  const buckets = edges.map(([start, end]) => bucket(tasks, start, end))
  return {
    ...whole,
    from: from === null ? null : iso(from),
    to: iso(to),
    buckets,
    byFactory: byFactory(tasks, whole.taskIds, factoryIds),
  }
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
): DashboardReport {
  const tasks: DashboardTask[] = []
  const unavailableIds: string[] = []
  for (const task of facts) {
    if (task.setup) continue
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
          intakeMs: null,
        })
      }
      continue
    }
    if (done >= asOf) continue
    const starts = task.entries
      .filter((entry) => entry.stage === 'intake')
      .map((entry) => Date.parse(entry.at))
      .filter(Number.isFinite)
    tasks.push({
      id: task.id,
      factoryId: task.factoryId,
      displayId: task.displayId,
      title: task.title,
      archived: task.archived,
      doneAt: iso(done),
      createdMs: elapsed(Date.parse(task.createdAt), done),
      intakeMs: starts.length === 0 ? null : elapsed(Math.min(...starts), done),
    })
  }
  const times = tasks.flatMap((task) => (task.doneAt === null ? [] : [Date.parse(task.doneAt)]))
  const windows = range === 'all' ? null : rangeWindows(range, asOf)
  const history = windows || times.length === 0 ? null : allHistory(Math.min(...times), asOf)
  const from = windows ? windows.from : history ? history.from : null
  const to = windows ? windows.to : asOf
  const current = period(
    tasks,
    from,
    to,
    from === null
      ? []
      : range === 'today'
        ? hours(from, to)
        : days(from, to, history ? history.perPoint : 1),
    factoryIds,
  )
  const previous = windows
    ? period(
        tasks,
        windows.previous.from,
        windows.previous.to,
        windows.previousDay === null
          ? days(windows.previous.from, windows.previous.to, 1)
          : hours(windows.previousDay, windows.from),
        factoryIds,
      )
    : null
  const selected = new Set([
    ...current.taskIds,
    ...(previous?.taskIds ?? []),
    ...(previous?.buckets.flatMap((b) => b.taskIds) ?? []),
    ...unavailableIds,
  ])
  return {
    asOf: iso(asOf),
    range,
    factoryIds: [...factoryIds],
    tasks: tasks.filter((task) => selected.has(task.id)),
    unavailableIds,
    current,
    previous,
    comparison:
      previous === null
        ? null
        : {
            completed: change(current.taskIds.length, previous.taskIds.length),
            created: change(current.created.value, previous.created.value),
            intake: change(current.intake.value, previous.intake.value),
          },
    flow: dashboardFlow(
      facts,
      windows ? windows.from : null,
      to,
      windows ? windows.previous : null,
      asOf,
      current.taskIds,
      previous?.taskIds ?? [],
    ),
  }
}
