import type {
  DashboardBucket,
  DashboardChange,
  DashboardPeriod,
  DashboardRange,
  DashboardSample,
  DashboardTask,
  FactoryDashboard,
} from '@ted/protocol'
import { dashboardFlow, type FlowFacts } from './dashboard-flow.ts'

export interface DashboardTaskFacts extends FlowFacts {
  id: string
  displayId: string
  title: string
  createdAt: string
  archived: boolean
  setup: boolean
  stage: string
  entries: readonly { stage: string; at: string; sequence?: number }[]
}

const dayMs = 86_400_000
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

function period(
  tasks: readonly DashboardTask[],
  from: number | null,
  to: number,
  bins: number,
): DashboardPeriod {
  const whole =
    from === null
      ? { taskIds: [], created: sample([], 'createdMs'), intake: sample([], 'intakeMs') }
      : bucket(tasks, from, to)
  const buckets =
    from === null
      ? []
      : Array.from({ length: bins }, (_, index) =>
          bucket(
            tasks,
            Math.floor(from + ((to - from) * index) / bins),
            Math.floor(from + ((to - from) * (index + 1)) / bins),
          ),
        )
  return { ...whole, from: from === null ? null : iso(from), to: iso(to), buckets }
}

function change(value: number | null, previous: number | null): DashboardChange {
  const absolute = value === null || previous === null ? null : value - previous
  return {
    absolute,
    percent:
      absolute === null || previous === null || previous === 0 ? null : (absolute / previous) * 100,
  }
}

export function factoryDashboard(
  facts: readonly DashboardTaskFacts[],
  range: DashboardRange,
  asOf: number,
): FactoryDashboard {
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
      displayId: task.displayId,
      title: task.title,
      archived: task.archived,
      doneAt: iso(done),
      createdMs: elapsed(Date.parse(task.createdAt), done),
      intakeMs: starts.length === 0 ? null : elapsed(Math.min(...starts), done),
    })
  }
  const times = tasks.flatMap((task) => (task.doneAt === null ? [] : [Date.parse(task.doneAt)]))
  const from =
    range === 'all'
      ? times.length
        ? Math.min(...times)
        : null
      : asOf - (range === '7d' ? 7 : 30) * dayMs
  const bins =
    range === 'all'
      ? from === null
        ? 0
        : Math.min(30, Math.max(1, Math.ceil((asOf - from) / dayMs)))
      : range === '7d'
        ? 7
        : 30
  const current = period(tasks, from, asOf, bins)
  const previous =
    range === 'all' || from === null ? null : period(tasks, from - (asOf - from), from, bins)
  const selected = new Set([...current.taskIds, ...(previous?.taskIds ?? []), ...unavailableIds])
  return {
    asOf: iso(asOf),
    range,
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
    flow: dashboardFlow(facts, range, asOf, current.taskIds, previous?.taskIds ?? []),
  }
}
