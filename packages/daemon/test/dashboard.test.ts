import { expect, test } from 'vitest'
import { type DashboardTaskFacts, factoryDashboard } from '../src/dashboard.ts'

const hour = 3_600_000
const now = Date.parse('2026-11-10T12:00:00Z')
const iso = (n: number) => new Date(n).toISOString()
function completed(
  id: string,
  ago: number,
  created: number,
  intake: number | null,
): DashboardTaskFacts {
  const done = now - ago * hour
  return {
    id,
    displayId: `NB-${id}`,
    title: `Task ${id}`,
    stage: 'done',
    setup: false,
    archived: false,
    createdAt: iso(done - created * hour),
    entries: [
      ...(intake === null ? [] : [{ stage: 'intake', at: iso(done - intake * hour) }]),
      { stage: 'done', at: iso(done) },
    ],
  }
}

test('compares completion cohorts using raw elapsed times and exposes the exact median samples', () => {
  const a = completed('1', 10, 20, 6)
  const b = { ...completed('2', 20, 40, 10), archived: true }
  const c = completed('3', 30, 60, null)
  const previous = completed('4', 180, 80, 16)
  const setup = { ...completed('5', 40, 1, 1), setup: true }
  const open = { ...completed('6', 20, 2, 1), stage: 'work', entries: [] }
  const result = factoryDashboard([a, b, c, previous, setup, open], '7d', now)
  expect(result.current.taskIds).toEqual(['1', '2', '3'])
  expect(result.current.created).toMatchObject({
    value: 40 * hour,
    taskIds: ['1', '2', '3'],
    missingIds: [],
  })
  expect(result.current.intake).toMatchObject({
    value: 8 * hour,
    taskIds: ['1', '2'],
    missingIds: ['3'],
  })
  expect(result.previous?.created.value).toBe(80 * hour)
  expect(result.comparison).toMatchObject({
    completed: { absolute: 2, percent: 200 },
    created: { absolute: -40 * hour, percent: -50 },
    intake: { absolute: -8 * hour, percent: -50 },
  })
  expect(result.tasks.map((t) => t.id)).toEqual(['1', '2', '3', '4'])
  expect(result.current.buckets).toHaveLength(7)
  expect(result.current.buckets.flatMap((b) => b.taskIds).sort()).toEqual(['1', '2', '3'])
  expect(result.current.buckets[0]?.intake.value).toBeNull()
})

test('uses latest Done and first Intake, keeps timestamp boundaries half-open and discloses unrecorded history', () => {
  const first = completed('1', 1, 20, 6)
  first.entries = [
    { stage: 'intake', at: iso(now - 11 * hour) },
    ...first.entries,
    { stage: 'done', at: iso(now - 2 * hour) },
  ]
  const boundary = completed('2', 168, 8, 4)
  const oldBoundary = completed('3', 336, 12, 2)
  const excluded = completed('4', 0, 20, 8)
  const tooOld = completed('5', 337, 12, 2)
  const missing = { ...completed('6', 1, 2, 1), entries: [] }
  const negative = { ...completed('7', 2, 5, null), createdAt: iso(now) }
  const result = factoryDashboard(
    [first, boundary, oldBoundary, excluded, tooOld, missing, negative],
    '7d',
    now,
  )
  expect(result.current.taskIds).toEqual(['1', '2', '7'])
  expect(result.previous?.taskIds).toEqual(['3'])
  expect(result.tasks.find((t) => t.id === '1')).toMatchObject({
    doneAt: iso(now - hour),
    intakeMs: 10 * hour,
  })
  expect(result.current.created.missingIds).toEqual(['7'])
  expect(result.unavailableIds).toEqual(['6'])
  expect(result.tasks.map((t) => t.id)).not.toContain('4')
  expect(result.tasks.map((t) => t.id)).not.toContain('5')
})

test('empty and zero baselines have no invented percent and all retained history has no comparison', () => {
  const result = factoryDashboard([completed('1', 1, 4, 0)], '7d', now)
  expect(result.comparison?.completed).toEqual({ absolute: 1, percent: null })
  expect(result.comparison?.created).toEqual({ absolute: null, percent: null })
  expect(result.current.intake.value).toBe(0)
  const all = factoryDashboard([completed('1', 1000, 4, null)], 'all', now)
  expect(all.previous).toBeNull()
  expect(all.comparison).toBeNull()
  expect(all.current.taskIds).toEqual(['1'])
  expect(all.current.buckets).toHaveLength(30)
  const empty = factoryDashboard([], 'all', now)
  expect(empty.current).toMatchObject({
    from: null,
    taskIds: [],
    created: { value: null },
    buckets: [],
  })
})

test('all-history graph samples match the serialized millisecond boundaries', () => {
  const first = {
    ...completed('1', 1, 1, null),
    createdAt: iso(-hour),
    entries: [{ stage: 'done', at: iso(0) }],
  }
  const second = {
    ...completed('2', 1, 1, null),
    createdAt: iso(0),
    entries: [{ stage: 'done', at: iso(43_200_000) }],
  }
  const result = factoryDashboard([first, second], 'all', 86_400_001)
  expect(result.current.buckets.map((b) => b.taskIds)).toEqual([['1'], ['2']])
  expect(result.current.buckets[0]?.to).toBe('1970-01-01T12:00:00.000Z')
  expect(result.current.buckets[1]?.from).toBe('1970-01-01T12:00:00.000Z')
})
