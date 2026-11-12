import { queryDb, type Store } from '@livestore/livestore'
import type { CheckRun, CommentAnswer, CommentKind, TestInvocation } from '@ted/protocol'
import type { FlowTimingFacts } from '../dashboard-timing.ts'
import { checkRunTiming } from './check-timing.ts'
import type { LoggedEvent } from './index.ts'
import { intervalBoundaries } from './interval-schema.ts'
import {
  checkBoundaries,
  checkResults,
  checkRuns,
  comments,
  runs,
  type schema,
  taskLog,
  testInvocations,
} from './schema.ts'
import { blockerTransitions, taskIntervalHistory } from './task-intervals.ts'

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = []
  for (let i = 0; i < values.length; i += 300) result.push(values.slice(i, i + 300))
  return result
}
function group<T>(rows: readonly T[], key: (row: T) => string) {
  const result = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const own = result.get(id) ?? []
    own.push(row)
    result.set(id, own)
  }
  return result
}
const order = (id: string) => {
  const [global = 0, client = 0] = id.split('.').map(Number)
  return global * 1_000_000 + client
}
const logRow = (r: typeof taskLog.Type): LoggedEvent => ({
  id: r.id,
  name: r.name,
  at: r.at,
  data: JSON.parse(r.data) as Record<string, unknown>,
})

export function readDashboardTiming(
  store: Store<typeof schema>,
  tasks: readonly { id: string; createdAt: string }[],
  asOf: string,
  sessionId: string,
): Map<string, FlowTimingFacts> {
  const result = new Map<string, FlowTimingFacts>()
  if (!tasks.length) return result
  const observations = store.query(
    queryDb(intervalBoundaries.where({ subject: 'observation' }).orderBy('sequence', 'asc')),
  )
  const agents = store.query(queryDb(intervalBoundaries.where({ subject: 'agent' })))
  for (const batch of chunks(tasks)) {
    const ids = batch.map((t) => t.id)
    const logs = group(
      store
        .query(queryDb(taskLog.where({ taskId: { op: 'IN', value: ids } })))
        .map((r) => ({ ...logRow(r), taskId: r.taskId })),
      (r) => r.taskId,
    )
    const taskRows = store.query(
      queryDb(
        intervalBoundaries.where({ subject: { op: 'IN', value: ids.map((id) => `task:${id}`) } }),
      ),
    )
    const ownRuns = store.query(
      queryDb(runs.select('id', 'taskId', 'agent').where({ taskId: { op: 'IN', value: ids } })),
    )
    const queued = taskRows
      .filter((r) => r.name === 'v1.SubAgentRequested')
      .map((r) => `sub-agent:${String(JSON.parse(r.data).queuedRunId)}`)
    const extra = chunks([...ownRuns.map((r) => `run:${r.id}`), ...queued]).flatMap((subjects) =>
      store.query(queryDb(intervalBoundaries.where({ subject: { op: 'IN', value: subjects } }))),
    )
    const boundaries = group([...taskRows, ...extra], (r) => r.subject)
    const runGroups = group(ownRuns, (r) => r.taskId ?? '')
    const requestGroups = group(
      store
        .query(
          queryDb(
            comments
              .select('id', 'taskId', 'kind', 'createdAt', 'answer')
              .where({ taskId: { op: 'IN', value: ids } }),
          ),
        )
        .filter((r) => r.kind !== 'note'),
      (r) => r.taskId,
    )
    const blockerIds = [
      ...new Set(
        [...logs.values()].flatMap((events) =>
          events.flatMap((e) =>
            e.name.endsWith('TaskBlockerAdded') && typeof e.data.blockerId === 'string'
              ? [e.data.blockerId]
              : [],
          ),
        ),
      ),
    ]
    const blockerEvents = group(
      chunks(blockerIds)
        .flatMap((keys) =>
          store.query(queryDb(taskLog.where({ taskId: { op: 'IN', value: keys } }))),
        )
        .map((r) => ({ ...logRow(r), taskId: r.taskId })),
      (r) => r.taskId,
    )
    for (const rows of chunks(blockerIds.map((id) => `task:${id}`))) {
      for (const row of store.query(
        queryDb(intervalBoundaries.where({ subject: { op: 'IN', value: rows } })),
      )) {
        if (row.name === 'v1.TaskWaitObserved') continue
        const id = row.subject.slice(5)
        const events = blockerEvents.get(id) ?? []
        events.push({
          id: row.id,
          name: row.name,
          at: row.at,
          taskId: id,
          data: JSON.parse(row.data),
        })
        blockerEvents.set(id, events)
      }
    }
    const blockerChanges = new Map(
      blockerIds.map((id) => [id, blockerTransitions(id, blockerEvents.get(id) ?? [])]),
    )
    const checkRows = store.query(queryDb(checkRuns.where({ taskId: { op: 'IN', value: ids } })))
    const checkIds = checkRows.map((r) => r.id)
    const results = group(
      chunks(checkIds).flatMap((keys) =>
        store.query(
          queryDb(
            checkResults
              .where({ checkRunId: { op: 'IN', value: keys } })
              .orderBy('position', 'asc'),
          ),
        ),
      ),
      (r) => r.checkRunId,
    )
    const checkEvents = group(
      chunks(checkIds).flatMap((keys) =>
        store.query(queryDb(checkBoundaries.where({ checkRunId: { op: 'IN', value: keys } }))),
      ),
      (r) => r.checkRunId,
    )
    const checks = group(
      checkRows.map((row): CheckRun => {
        const run: CheckRun = {
          id: row.id,
          taskId: row.taskId,
          startedAt: row.startedAt,
          stage: row.stage as CheckRun['stage'],
          trigger: row.trigger as CheckRun['trigger'],
          ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
          ...(row.outcome !== null && { outcome: row.outcome as NonNullable<CheckRun['outcome']> }),
          checks: (results.get(row.id) ?? []).map((r) => ({
            name: r.name,
            command: '',
            timeout: '',
            state: r.state as CheckRun['checks'][number]['state'],
            ...(r.durationMs !== null && { durationMs: r.durationMs }),
          })),
        }
        run.timing = checkRunTiming(run, checkEvents.get(row.id) ?? [])
        return run
      }),
      (r) => r.taskId,
    )
    const invocations = group(
      store.query(queryDb(testInvocations.where({ taskId: { op: 'IN', value: ids } }))).map(
        (r): TestInvocation => ({
          ...(JSON.parse(r.data) as TestInvocation),
          ...(r.ownerEnded && { ownerEnded: true }),
        }),
      ),
      (r) => r.taskId,
    )
    for (const task of batch) {
      const own = boundaries.get(`task:${task.id}`) ?? []
      const taskRuns = runGroups.get(task.id) ?? []
      const log = (logs.get(task.id) ?? []).sort((a, b) => order(a.id) - order(b.id))
      result.set(task.id, {
        checks: checks.get(task.id) ?? [],
        invocations: invocations.get(task.id) ?? [],
        history: taskIntervalHistory({
          taskId: task.id,
          createdAt: task.createdAt,
          asOf,
          sessionId,
          observations: [...observations],
          agents: [...agents],
          log,
          boundaries: [
            ...own,
            ...taskRuns.flatMap((r) => boundaries.get(`run:${r.id}`) ?? []),
            ...own
              .filter((r) => r.name === 'v1.SubAgentRequested')
              .flatMap(
                (r) => boundaries.get(`sub-agent:${String(JSON.parse(r.data).queuedRunId)}`) ?? [],
              ),
          ],
          runAgents: new Map(taskRuns.map((r) => [r.id, r.agent])),
          blockerCompletions: [
            ...new Set(
              log.flatMap((e) =>
                e.name.endsWith('TaskBlockerAdded') && typeof e.data.blockerId === 'string'
                  ? [e.data.blockerId]
                  : [],
              ),
            ),
          ].flatMap((id) => blockerChanges.get(id) ?? []),
          comments: (requestGroups.get(task.id) ?? []).map((r) => ({
            id: r.id,
            kind: r.kind as CommentKind,
            createdAt: r.createdAt,
            ...(r.answer !== null && { answer: JSON.parse(r.answer) as CommentAnswer }),
          })),
        }),
      })
    }
  }
  return result
}
