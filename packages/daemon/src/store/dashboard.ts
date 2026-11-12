import { queryDb, type Store } from '@livestore/livestore'
import type {
  DashboardRange,
  FactoryDashboard,
  FlowSendBack,
  ValidationSnapshot,
} from '@ted/protocol'
import { type DashboardTaskFacts, factoryDashboard } from '../dashboard.ts'
import type { FlowCheck, FlowJudgment } from '../dashboard-flow.ts'
import { readDashboardTiming } from './dashboard-timing.ts'
import { intervalBoundaries } from './interval-schema.ts'
import {
  checkResults,
  checkRuns,
  factories,
  type schema,
  sendBacks,
  taskLog,
  tasks,
} from './schema.ts'

const historyNames = [
  'v1.TaskStageEntered',
  'v2.TaskStageEntered',
  'v3.TaskStageEntered',
  'v1.TaskArchived',
  'v2.TaskArchived',
  'v3.TaskArchived',
  'v1.ValidateJudged',
  'v2.ValidateJudged',
  'v1.TaskMovedToBacklog',
  'v1.TaskNeedsPlanning',
  'v1.TaskSentBack',
  'v2.TaskSentBack',
]

const sequence = (id: string) => {
  const [global = 0, client = 0] = id.split('.').map(Number)
  return global * 1_000_000 + client
}

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = []
  for (let i = 0; i < values.length; i += 400) result.push(values.slice(i, i + 400))
  return result
}

export function readFactoryDashboard(
  store: Store<typeof schema>,
  factoryId: string,
  range: DashboardRange,
  asOf: number,
  sessionId: string,
): FactoryDashboard {
  const factory = store.query(queryDb(factories.where({ id: factoryId })))[0]
  const rows = store.query(
    queryDb(tasks.where({ factoryId, setup: false }).orderBy('number', 'asc')),
  )
  const facts = new Map<
    string,
    DashboardTaskFacts & {
      entries: { stage: string; at: string; sequence: number }[]
      transitions: { stage: string; at: string; sequence: number }[]
      archives: string[]
      judgments: FlowJudgment[]
      sendBacks: FlowSendBack[]
      checks: FlowCheck[]
    }
  >()
  for (const row of rows) {
    facts.set(row.id, {
      id: row.id,
      displayId: `${factory?.key ?? ''}-${row.number}`,
      title: row.title,
      createdAt: row.createdAt,
      archived: row.archivedAt !== null,
      archivedAt: row.archivedAt,
      setup: row.setup,
      stage: row.stage,
      entries: [],
      transitions: [],
      archives: [],
      judgments: [],
      sendBacks: [],
      checks: [],
    })
  }
  for (const ids of chunks(rows.map((row) => row.id))) {
    const backOrders = new Map<string, { values: number[]; next: number }>()
    const backKey = (taskId: string, from: string, to: string, at: string) =>
      JSON.stringify([taskId, from, to, at])
    const history = store
      .query(
        queryDb(
          taskLog.where({
            taskId: { op: 'IN', value: ids },
            name: { op: 'IN', value: historyNames },
          }),
        ),
      )
      .toSorted((a, b) => sequence(a.id) - sequence(b.id))
    for (const row of history) {
      const task = facts.get(row.taskId)
      if (!task) continue
      const data = JSON.parse(row.data) as Record<string, unknown>
      if (row.name.endsWith('TaskStageEntered')) {
        task.entries.push({ stage: String(data.stage), at: row.at, sequence: sequence(row.id) })
      } else if (row.name.endsWith('TaskMovedToBacklog') || row.name === 'v1.TaskNeedsPlanning') {
        task.transitions.push({ stage: 'backlog', at: row.at, sequence: sequence(row.id) })
      } else if (row.name.endsWith('TaskSentBack')) {
        const key = backKey(row.taskId, String(data.from), String(data.to), row.at)
        const orders = backOrders.get(key) ?? { values: [], next: 0 }
        orders.values.push(sequence(row.id))
        backOrders.set(key, orders)
      } else if (row.name.endsWith('TaskArchived')) {
        task.archives.push(row.at)
      } else {
        const review = data.review as { passed?: boolean } | null
        const visual = data.visual as { passed?: boolean } | null
        task.judgments.push({
          at: row.at,
          sequence: sequence(row.id),
          outcome: String(data.outcome),
          checkRunId: typeof data.checkRunId === 'string' ? data.checkRunId : null,
          review: typeof review?.passed === 'boolean' ? review.passed : null,
          visual: typeof visual?.passed === 'boolean' ? visual.passed : null,
          ...(typeof data.validation === 'string' && {
            validation: JSON.parse(data.validation) as ValidationSnapshot,
          }),
        })
      }
    }
    const boundaries = store.query(
      queryDb(
        intervalBoundaries.where({
          subject: { op: 'IN', value: ids.map((id) => `task:${id}`) },
          name: 'v1.TaskStageChanged',
        }),
      ),
    )
    const entryKeys = new Set(
      ids.flatMap((id) =>
        (facts.get(id)?.entries ?? []).map((e) => JSON.stringify([id, e.stage, e.at])),
      ),
    )
    for (const row of boundaries) {
      const id = row.subject.slice(5)
      const data = JSON.parse(row.data) as { stage: string }
      if (!entryKeys.has(JSON.stringify([id, data.stage, row.at])))
        facts.get(id)?.transitions.push({ stage: data.stage, at: row.at, sequence: row.sequence })
    }
    for (const id of ids) {
      const task = facts.get(id)
      if (task)
        task.transitions = [...task.entries, ...task.transitions].sort(
          (a, b) => a.sequence - b.sequence,
        )
    }
    const backs = store.query(
      queryDb(sendBacks.where({ taskId: { op: 'IN', value: ids } }).orderBy('at', 'asc')),
    )
    for (const row of backs) {
      const task = facts.get(row.taskId)
      const orders = backOrders.get(backKey(row.taskId, row.fromStage, row.toStage, row.at))
      const order = orders?.values[orders.next++]
      if (task)
        task.sendBacks.push({
          id: row.id,
          taskId: row.taskId,
          from: row.fromStage,
          to: row.toStage,
          counted: row.counted,
          at: row.at,
          cause: row.cause,
          ...(order !== undefined && { sequence: order }),
        })
    }
    const runs = store.query(queryDb(checkRuns.where({ taskId: { op: 'IN', value: ids } })))
    const checks = new Map<string, FlowCheck>()
    for (const row of runs) {
      const value: FlowCheck = { ...row, states: [] }
      checks.set(row.id, value)
      const task = facts.get(row.taskId)
      if (task) task.checks.push(value)
    }
    for (const runIds of chunks(runs.map((row) => row.id))) {
      for (const row of store.query(
        queryDb(
          checkResults
            .where({ checkRunId: { op: 'IN', value: runIds } })
            .orderBy('position', 'asc'),
        ),
      )) {
        checks.get(row.checkRunId)?.states.push(row.state)
      }
    }
  }
  const lower = range === 'all' ? -Infinity : asOf - 2 * (range === '7d' ? 7 : 30) * 86_400_000
  const selected = rows.filter((row) => {
    const task = facts.get(row.id)
    if (!task) return false
    const start = task.entries.find((e) => e.stage === 'intake')
    if (!start || !(Date.parse(start.at) < asOf)) return false
    const ends = [
      ...task.entries.filter((e) => e.stage === 'done').map((e) => e.at),
      ...task.archives,
    ]
      .map(Date.parse)
      .filter((at) => Number.isFinite(at) && at >= Date.parse(start.at))
    const end = ends.reduce((a, b) => Math.min(a, b), asOf)
    return end > lower
  })
  const activity = readDashboardTiming(store, selected, new Date(asOf).toISOString(), sessionId)
  for (const [id, task] of facts) {
    const measured = activity.get(id)
    if (measured) task.activity = measured
  }
  return factoryDashboard([...facts.values()], range, asOf)
}
