import { queryDb, type Store } from '@livestore/livestore'
import type {
  CostTask,
  DashboardRange,
  DashboardReport,
  FindingSeverity,
  TaskStatusKind,
} from '@ted/protocol'
import { type DashboardTaskFacts, dashboardReport, rangeWindows } from '../dashboard.ts'
import { type CostOwners, type CostUsage, costUsage } from '../dashboard-cost.ts'
import { readDashboardTiming } from './dashboard-timing.ts'
import { intervalBoundaries } from './interval-schema.ts'
import {
  automationFirings,
  automations,
  coordinatorChats,
  factories,
  plans,
  pullRequests,
  reviewers,
  runs,
  runUsage,
  type schema,
  sendBacks,
  sideChats,
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
  'v1.TaskMovedToBacklog',
  'v1.TaskNeedsPlanning',
  'v1.TaskQueued',
]

const sequence = (id: string) => {
  const [global = 0, client = 0] = id.split('.').map(Number)
  return global * 1_000_000 + client
}

export function sendBackSeverities(
  backs: readonly { from: string; counted: boolean; checkRunId?: string | null; at: string }[],
  declared: readonly { at: string; severity: string }[],
): (FindingSeverity | 'none' | undefined)[] {
  let after = ''
  return backs.map((sendBack) => {
    const since = after
    after = sendBack.at
    if (sendBack.from !== 'validate' || !sendBack.counted || sendBack.checkRunId) return undefined
    const found = declared.findLast((d) => d.at > since && d.at <= sendBack.at)
    return found ? (found.severity as FindingSeverity) : 'none'
  })
}

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = []
  for (let i = 0; i < values.length; i += 400) result.push(values.slice(i, i + 400))
  return result
}

export function readCostInput(
  store: Store<typeof schema>,
  factoryIds: readonly string[],
  asOf: number,
): { usage: CostUsage[]; tasks: CostTask[]; allFactories: boolean } {
  const known = store.query(queryDb(factories))
  const keys = new Map(known.map((factory) => [factory.id, factory.key]))
  const allFactories = known.every((factory) => factoryIds.includes(factory.id))
  const before = new Date(asOf).toISOString()
  const rows = store.query(queryDb(runUsage.where({ at: { op: '<', value: before } })))
  const automationFactory = new Map(
    store.query(queryDb(automations.select('id', 'factoryId'))).map((a) => [a.id, a.factoryId]),
  )
  const owners: CostOwners = {
    automations: new Map(),
    plans: new Map(),
    coordinators: new Map(),
    sideChats: new Map(),
    runs: new Map(),
    reviewers: new Set(),
    taskFactories: new Map(),
  }
  for (const ids of chunks(rows.map((row) => row.id))) {
    for (const firing of store.query(
      queryDb(
        automationFirings.select('id', 'automationId').where({ id: { op: 'IN', value: ids } }),
      ),
    ))
      owners.automations.set(firing.id, automationFactory.get(firing.automationId) ?? null)
    for (const plan of store.query(
      queryDb(plans.select('id', 'factoryId').where({ id: { op: 'IN', value: ids } })),
    ))
      owners.plans.set(plan.id, plan.factoryId)
    for (const run of store.query(
      queryDb(runs.select('id', 'taskId', 'parentRunId').where({ id: { op: 'IN', value: ids } })),
    ))
      owners.runs.set(run.id, run)
    for (const reviewer of store.query(
      queryDb(reviewers.select('runId', 'purpose').where({ runId: { op: 'IN', value: ids } })),
    ))
      if (reviewer.purpose === 'review') owners.reviewers.add(reviewer.runId)
  }
  const chats = store
    .query(queryDb(coordinatorChats))
    .map((row) => ({ ...JSON.parse(row.data), factoryId: row.factoryId })) as {
    factoryId: string
    runId?: string
    runIds?: string[]
  }[]
  for (const chat of chats)
    for (const runId of [chat.runId, ...(chat.runIds ?? [])])
      if (runId && !owners.coordinators.has(runId)) owners.coordinators.set(runId, chat.factoryId)
  for (const row of store.query(queryDb(sideChats))) {
    const chat = JSON.parse(row.data) as { id: string; taskId: string; factoryId: string }
    owners.sideChats.set(chat.id, { taskId: chat.taskId, factoryId: chat.factoryId })
  }
  const taskIds = new Set([
    ...[...owners.runs.values()].flatMap((run) => (run.taskId ? [run.taskId] : [])),
    ...[...owners.sideChats.values()].map((chat) => chat.taskId),
  ])
  const taskRows = chunks([...taskIds]).flatMap((ids) =>
    store.query(
      queryDb(
        tasks.select('id', 'factoryId', 'number', 'title').where({ id: { op: 'IN', value: ids } }),
      ),
    ),
  )
  for (const task of taskRows) owners.taskFactories.set(task.id, task.factoryId)
  const usage = costUsage(rows, owners)
  const spentOn = new Set(usage.flatMap((row) => (row.taskId ? [row.taskId] : [])))
  const runCounts = new Map<string, number>()
  const backCounts = new Map<string, number>()
  for (const ids of chunks([...spentOn])) {
    for (const run of store.query(
      queryDb(runs.select('id', 'taskId').where({ taskId: { op: 'IN', value: ids } })),
    ))
      if (run.taskId) runCounts.set(run.taskId, (runCounts.get(run.taskId) ?? 0) + 1)
    for (const back of store.query(
      queryDb(sendBacks.select('id', 'taskId').where({ taskId: { op: 'IN', value: ids } })),
    ))
      backCounts.set(back.taskId, (backCounts.get(back.taskId) ?? 0) + 1)
  }
  return {
    usage,
    tasks: taskRows
      .filter((task) => spentOn.has(task.id))
      .map((task) => ({
        id: task.id,
        factoryId: task.factoryId,
        displayId: `${keys.get(task.factoryId) ?? ''}-${task.number}`,
        title: task.title,
        runs: runCounts.get(task.id) ?? 0,
        sendBacks: backCounts.get(task.id) ?? 0,
      })),
    allFactories,
  }
}

export function readDashboard(
  store: Store<typeof schema>,
  factoryIds: readonly string[],
  range: DashboardRange,
  asOf: number,
  sessionId: string,
  statuses: ReadonlyMap<string, TaskStatusKind | undefined> = new Map(),
): DashboardReport {
  const keys = new Map(
    store
      .query(queryDb(factories.where({ id: { op: 'IN', value: [...factoryIds] } })))
      .map((factory) => [factory.id, factory.key]),
  )
  const order = new Map(factoryIds.map((id, index) => [id, index]))
  const rows = store
    .query(
      queryDb(
        tasks
          .where({ factoryId: { op: 'IN', value: [...factoryIds] }, setup: false })
          .orderBy('number', 'asc'),
      ),
    )
    .toSorted((a, b) => (order.get(a.factoryId) ?? 0) - (order.get(b.factoryId) ?? 0))
  const facts = new Map<
    string,
    DashboardTaskFacts & {
      entries: { stage: string; at: string; sequence: number }[]
      merges: string[]
      transitions: { stage: string; at: string; sequence: number }[]
      archives: string[]
      sendBacks: { at: string }[]
    }
  >()
  for (const row of rows) {
    const status = statuses.get(row.id)
    facts.set(row.id, {
      id: row.id,
      factoryId: row.factoryId,
      displayId: `${keys.get(row.factoryId) ?? ''}-${row.number}`,
      title: row.title,
      createdAt: row.createdAt,
      archived: row.archivedAt !== null,
      archivedAt: row.archivedAt,
      setup: row.setup,
      stage: row.stage,
      ...(status !== undefined && { status }),
      entries: [],
      merges: [],
      transitions: [],
      archives: [],
      sendBacks: [],
    })
  }
  for (const ids of chunks(rows.map((row) => row.id))) {
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
      } else if (row.name === 'v1.TaskQueued') {
        if (data.stage === 'intake')
          task.transitions.push({ stage: 'intake', at: row.at, sequence: sequence(row.id) })
      } else if (row.name.endsWith('TaskMovedToBacklog') || row.name === 'v1.TaskNeedsPlanning') {
        task.transitions.push({ stage: 'backlog', at: row.at, sequence: sequence(row.id) })
      } else {
        task.archives.push(row.at)
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
    for (const row of store.query(
      queryDb(sendBacks.select('taskId', 'at').where({ taskId: { op: 'IN', value: ids } })),
    )) {
      facts.get(row.taskId)?.sendBacks.push({ at: row.at })
    }
    for (const row of store.query(
      queryDb(pullRequests.where({ taskId: { op: 'IN', value: ids }, state: 'merged' })),
    )) {
      if (row.mergedAt !== null) facts.get(row.taskId)?.merges.push(row.mergedAt)
    }
  }
  const lower = range === 'all' ? -Infinity : rangeWindows(range, asOf).previous.from
  const selected = rows.filter((row) => {
    const task = facts.get(row.id)
    if (!task) return false
    const start = task.transitions.find((e) => e.stage === 'intake')
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
  return dashboardReport(
    [...facts.values()],
    factoryIds,
    range,
    asOf,
    readCostInput(store, factoryIds, asOf),
  )
}
