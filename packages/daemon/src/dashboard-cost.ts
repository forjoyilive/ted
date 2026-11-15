import type {
  CostBucket,
  CostFactory,
  CostKind,
  CostPeriod,
  CostPerPullRequest,
  CostShare,
  CostTask,
  CostTaskSpend,
  DashboardChange,
  DashboardCost,
} from '@ted/protocol'
import { quantile } from './dashboard-flow.ts'

export interface CostUsage {
  runId: string
  agent: string
  model: string | null
  input: number
  output: number
  cost: number | null
  at: string
  kind: CostKind
  factoryId: string | null
  taskId: string | null
}

export interface CostOwners {
  automations: Map<string, string | null>
  plans: Map<string, string>
  coordinators: Map<string, string>
  sideChats: Map<string, { taskId: string; factoryId: string }>
  runs: Map<string, { taskId: string | null; parentRunId: string | null }>
  reviewers: Set<string>
  taskFactories: Map<string, string>
}

type CostRow = Omit<CostUsage, 'runId' | 'kind' | 'factoryId' | 'taskId'> & { id: string }

function owner(
  runId: string,
  owners: CostOwners,
): Pick<CostUsage, 'kind' | 'factoryId' | 'taskId'> {
  if (owners.automations.has(runId))
    return { kind: 'automation', factoryId: owners.automations.get(runId) ?? null, taskId: null }
  const plan = owners.plans.get(runId)
  if (plan !== undefined) return { kind: 'planning', factoryId: plan, taskId: null }
  const coordinator = owners.coordinators.get(runId)
  if (coordinator !== undefined)
    return { kind: 'coordinator', factoryId: coordinator, taskId: null }
  const side = owners.sideChats.get(runId)
  const run = owners.runs.get(runId)
  const taskId = side?.taskId ?? run?.taskId ?? null
  if (taskId === null) return { kind: 'other', factoryId: null, taskId: null }
  const factoryId = owners.taskFactories.get(taskId) ?? side?.factoryId ?? null
  const known = owners.taskFactories.has(taskId)
  const kind: CostKind =
    side || run?.parentRunId ? (owners.reviewers.has(runId) ? 'reviewer' : 'sub-agent') : 'lead'
  return known ? { kind, factoryId, taskId } : { kind, factoryId, taskId: null }
}

export function costUsage(rows: readonly CostRow[], owners: CostOwners): CostUsage[] {
  return rows.map(({ id, ...row }) => ({ runId: id, ...row, ...owner(id, owners) }))
}

export interface CostWindow {
  from: string | null
  to: string
  buckets: readonly { from: string; to: string }[]
  completed: readonly { taskId: string; pullRequests: number }[]
}

export interface CostInput {
  usage: readonly CostUsage[]
  tasks: readonly CostTask[]
  factoryIds: readonly string[]
  allFactories: boolean
  current: CostWindow
  previous: CostWindow | null
}

export const costKinds: readonly CostKind[] = [
  'lead',
  'reviewer',
  'sub-agent',
  'coordinator',
  'automation',
  'planning',
  'other',
]

const modelKey = (row: CostUsage) => `${row.agent}·${row.model ?? ''}`

function taskSpend(rows: readonly CostUsage[]): CostTaskSpend[] {
  const sums = new Map<string, number>()
  for (const row of rows)
    if (row.taskId !== null) sums.set(row.taskId, (sums.get(row.taskId) ?? 0) + (row.cost ?? 0))
  return [...sums]
    .map(([taskId, cost]) => ({ taskId, cost }))
    .sort((a, b) => b.cost - a.cost || a.taskId.localeCompare(b.taskId))
}

const total = (rows: readonly CostUsage[]) => rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)

function shares(
  rows: readonly CostUsage[],
  keyOf: (row: CostUsage) => string,
  order?: readonly string[],
): CostShare[] {
  const groups = Map.groupBy(rows, keyOf)
  const result = [...groups].map(([key, own]) => {
    const first = own[0]
    return {
      key,
      ...(order === undefined && first && { agent: first.agent, model: first.model }),
      cost: total(own),
      runs: new Set(own.map((row) => row.runId)).size,
      tasks: taskSpend(own),
    }
  })
  return order
    ? result.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    : result.sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key))
}

const kindShares = (rows: readonly CostUsage[]) => shares(rows, (row) => row.kind, costKinds)

function perPullRequest(
  completed: CostWindow['completed'],
  taskCosts: ReadonlyMap<string, number>,
): CostPerPullRequest {
  const samples = completed.flatMap(({ taskId, pullRequests }) => {
    const cost = taskCosts.get(taskId)
    return cost === undefined || pullRequests <= 0
      ? []
      : [{ taskId, cost, pullRequests, perPullRequest: cost / pullRequests }]
  })
  samples.sort((a, b) => b.perPullRequest - a.perPullRequest || a.taskId.localeCompare(b.taskId))
  const values = samples
    .flatMap((s) => Array.from({ length: s.pullRequests }, () => s.perPullRequest))
    .sort((a, b) => a - b)
  return {
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    pullRequests: values.length,
    samples,
  }
}

function period(
  window: CostWindow,
  usage: readonly CostUsage[],
  taskCosts: ReadonlyMap<string, number>,
  factoryOf: ReadonlyMap<string, string>,
  factories: readonly (string | null)[],
): CostPeriod {
  const from = window.from === null ? -Infinity : Date.parse(window.from)
  const to = Date.parse(window.to)
  const within = (row: CostUsage, start: number, end: number) => {
    const at = Date.parse(row.at)
    return at >= start && at < end
  }
  const rows = usage.filter((row) => within(row, from, to))
  const buckets: CostBucket[] = window.buckets.map((bucket) => {
    const own = rows.filter((row) => within(row, Date.parse(bucket.from), Date.parse(bucket.to)))
    return {
      from: bucket.from,
      to: bucket.to,
      cost: total(own),
      kinds: kindShares(own),
      models: shares(own, modelKey),
      tasks: taskSpend(own),
    }
  })
  const byFactory: CostFactory[] = factories.flatMap((factoryId) => {
    const own = rows.filter((row) => row.factoryId === factoryId)
    if (factoryId === null && own.length === 0) return []
    return [
      {
        factoryId,
        cost: total(own),
        runs: new Set(own.map((row) => row.runId)).size,
        kinds: kindShares(own),
        tasks: taskSpend(own),
        perPullRequest: perPullRequest(
          factoryId === null
            ? []
            : window.completed.filter((c) => factoryOf.get(c.taskId) === factoryId),
          taskCosts,
        ),
      },
    ]
  })
  return {
    from: window.from,
    to: window.to,
    cost: total(rows),
    input: rows.reduce((sum, row) => sum + row.input, 0),
    output: rows.reduce((sum, row) => sum + row.output, 0),
    runs: new Set(rows.map((row) => row.runId)).size,
    unpricedRuns: new Set(rows.filter((row) => row.cost === null).map((row) => row.runId)).size,
    kinds: kindShares(rows),
    models: shares(rows, modelKey),
    tasks: taskSpend(rows),
    buckets,
    perPullRequest: perPullRequest(window.completed, taskCosts),
    byFactory,
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

export function dashboardCost(input: CostInput): DashboardCost {
  const shown = new Set(input.factoryIds)
  const usage = input.usage.filter((row) =>
    row.factoryId === null ? input.allFactories : shown.has(row.factoryId),
  )
  const taskCosts = new Map<string, number>()
  for (const row of usage)
    if (row.taskId !== null)
      taskCosts.set(row.taskId, (taskCosts.get(row.taskId) ?? 0) + (row.cost ?? 0))
  const factoryOf = new Map(input.tasks.map((task) => [task.id, task.factoryId]))
  const factories = [...input.factoryIds, ...(input.allFactories ? [null] : [])]
  const current = period(input.current, usage, taskCosts, factoryOf, factories)
  const previous = input.previous
    ? period(input.previous, usage, taskCosts, factoryOf, factories)
    : null
  const referenced = new Set<string>()
  for (const p of [current, previous]) {
    if (!p) continue
    for (const t of p.tasks) referenced.add(t.taskId)
    for (const s of p.perPullRequest.samples) referenced.add(s.taskId)
  }
  return {
    tasks: input.tasks.filter((task) => referenced.has(task.id)),
    current,
    previous,
    change: previous
      ? {
          spend: change(current.cost, previous.cost),
          perPullRequest: change(current.perPullRequest.median, previous.perPullRequest.median),
        }
      : null,
  }
}
