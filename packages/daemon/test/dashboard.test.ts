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

function flowTask(
  id: string,
  entries: [string, number][],
  stage = entries.at(-1)?.[0] ?? 'backlog',
): DashboardTaskFacts {
  return {
    id,
    displayId: `NB-${id}`,
    title: `Task ${id}`,
    createdAt: iso(now - 500 * hour),
    setup: false,
    archived: false,
    stage,
    entries: entries.map(([stage, ago], index) => ({
      stage,
      at: iso(now - ago * hour),
      sequence: index * 10,
    })),
  }
}

test('Flow clips overlapping started Tasks, sums repeated visits, and stops at the first Done or archive', () => {
  const open = flowTask('open', [
    ['intake', 200],
    ['work', 180],
    ['validate', 160],
    ['work', 150],
  ])
  const done = flowTask('done', [
    ['intake', 190],
    ['work', 170],
    ['done', 10],
    ['intake', 8],
    ['work', 6],
    ['done', 2],
  ])
  const archived = {
    ...flowTask('archived', [
      ['intake', 100],
      ['work', 80],
    ]),
    archived: true,
    archivedAt: iso(now - 40 * hour),
  }
  const backlog = flowTask('backlog', [
    ['intake', 20],
    ['backlog', 18],
    ['work', 10],
  ])
  const missing = { ...flowTask('missing', []), stage: 'work' }
  const setup = { ...open, id: 'setup', setup: true }
  const result = factoryDashboard([open, done, archived, backlog, missing, setup], '7d', now)
  const flow = result.flow.current
  expect(flow.taskIds).toEqual(['open', 'done', 'archived', 'backlog'])
  const work = flow.stages.find((s) => s.stage === 'work')
  expect(work?.samples.map((s) => [s.taskId, s.elapsedMs / hour])).toEqual([
    ['open', 158],
    ['done', 158],
    ['archived', 40],
    ['backlog', 10],
  ])
  expect(work).toMatchObject({
    totalMs: 366 * hour,
    medianMs: 99 * hour,
    p25Ms: 32.5 * hour,
    p75Ms: 158 * hour,
  })
  expect(work?.samples[0]?.intervals).toHaveLength(2)
  expect(flow.stages.some((s) => s.stage === 'backlog')).toBe(false)
  expect(flow.incomplete).toMatchObject([{ taskId: 'missing' }])
  expect(result.flow.previous?.stages.find((s) => s.stage === 'work')?.totalMs).toBe(14 * hour)
  expect(result.current.taskIds).toEqual(['done'])
  expect(result.current.intake.value).toBe(188 * hour)
})

test('Flow handles boundaries, zero samples, historical archive after unarchive and absent or malformed records', () => {
  const archived = {
    ...flowTask('unarchived', [
      ['intake', 200],
      ['work', 180],
      ['work', 5],
    ]),
    archives: [iso(now - 170 * hour)],
  }
  const boundary = flowTask('boundary', [
    ['intake', 168],
    ['work', 1],
  ])
  const future = flowTask('future', [['intake', 0]])
  const broken = {
    ...flowTask('broken', [
      ['intake', 20],
      ['work', 10],
    ]),
    entries: [
      { stage: 'intake', at: iso(now - 20 * hour) },
      { stage: 'work', at: 'invalid' },
    ],
  }
  const disorder = flowTask('disorder', [
    ['intake', 20],
    ['work', 5],
    ['validate', 10],
  ])
  const result = factoryDashboard([archived, boundary, future, broken, disorder], '7d', now).flow
  expect(result.current.taskIds).toEqual(['boundary', 'broken', 'disorder'])
  expect(
    result.current.stages.find((s) => s.stage === 'work')?.samples.map((s) => s.taskId),
  ).toEqual(['boundary'])
  expect(result.current.incomplete.map((s) => s.taskId)).toEqual(['broken', 'disorder'])
  expect(result.previous?.stages.find((s) => s.stage === 'work')?.totalMs).toBe(10 * hour)
  const empty = factoryDashboard([], 'all', now).flow
  expect(
    empty.current.stages.every(
      (s) => s.totalMs === 0 && s.medianMs === null && s.samples.length === 0,
    ),
  ).toBe(true)
  expect(empty.current.firstPass).toMatchObject({ denominator: 0, percent: null })
  expect(empty.previous).toBeNull()
})

function first<T>(values: readonly T[] | undefined): T {
  const value = values?.[0]
  if (value === undefined) throw new Error('Expected a fixture record')
  return value
}

function verified(id: string): DashboardTaskFacts {
  const task = flowTask(id, [
    ['intake', 60],
    ['work', 50],
    ['validate', 20],
    ['review', 10],
    ['done', 1],
  ])
  task.checks = [
    {
      id: `${id}-check`,
      startedAt: iso(now - 21 * hour),
      finishedAt: iso(now - 20 * hour),
      outcome: 'passed',
      states: ['passed'],
    },
  ]
  task.judgments = [
    {
      at: iso(now - 10 * hour),
      sequence: 29,
      outcome: 'passed',
      checkRunId: `${id}-check`,
      review: true,
      visual: true,
    },
  ]
  return task
}

test('first-pass Validate exposes complete first-visit outcomes and excludes skipped, unknown and absent verification', () => {
  const pass = verified('pass')
  const accepted = verified('accepted')
  accepted.checks = [
    { ...first(pass.checks), id: 'accepted-check', states: ['failed'], outcome: 'failed' },
  ]
  const reviewFail = verified('review-fail')
  reviewFail.judgments = [{ ...first(reviewFail.judgments), review: false }]
  const unknown = verified('unknown')
  unknown.judgments = [{ ...first(unknown.judgments), visual: null }]
  const skipped = verified('skipped')
  skipped.checks = [{ ...first(skipped.checks), states: ['skipped'] }]
  const noVisit = flowTask('no-visit', [
    ['intake', 20],
    ['done', 1],
  ])
  const noJudgment = { ...verified('no-judgment'), judgments: [] }
  const result = factoryDashboard(
    [pass, accepted, reviewFail, unknown, skipped, noVisit, noJudgment],
    '7d',
    now,
  ).flow.current.firstPass
  expect(result).toMatchObject({ passed: 1, denominator: 3, percent: 100 / 3 })
  expect(result.samples.map((s) => [s.taskId, s.outcome])).toEqual([
    ['pass', 'passed'],
    ['accepted', 'failed'],
    ['review-fail', 'failed'],
    ['unknown', 'unknown'],
    ['skipped', 'skipped'],
    ['no-visit', 'no-visit'],
    ['no-judgment', 'unknown'],
  ])
  expect(result.samples[1]?.checkRunIds).toEqual(['accepted-check'])
})

test('actual transitions include uncounted send-backs and period boundaries, and later visits cannot repair first-pass results', () => {
  const task = verified('rework')
  task.entries = flowTask('rework', [
    ['intake', 60],
    ['work', 50],
    ['validate', 20],
    ['work', 15],
    ['validate', 12],
    ['review', 10],
    ['done', 1],
  ]).entries
  task.judgments = [
    {
      ...first(task.judgments),
      at: iso(now - 15 * hour),
      sequence: 29,
      review: false,
      outcome: 'sent-back',
    },
    { ...first(task.judgments), sequence: 49 },
  ]
  task.sendBacks = [
    {
      id: 'a',
      taskId: task.id,
      from: 'validate',
      to: 'work',
      at: iso(now - 15 * hour),
      sequence: 28,
      counted: false,
      cause: 'base-conflict',
    },
    {
      id: 'b',
      taskId: task.id,
      from: 'review',
      to: 'work',
      at: iso(now - 168 * hour),
      counted: true,
      cause: null,
    },
    {
      id: 'c',
      taskId: task.id,
      from: 'review',
      to: 'work',
      at: iso(now),
      counted: true,
      cause: null,
    },
  ]
  const result = factoryDashboard([task], '7d', now).flow.current
  expect(result.sendBacks.map((g) => [g.from, g.counted, g.transitions.length, g.taskIds])).toEqual(
    [
      ['review', 1, 1, ['rework']],
      ['validate', 0, 1, ['rework']],
    ],
  )
  expect(result.firstPass.samples[0]).toMatchObject({
    outcome: 'failed',
    enteredAt: iso(now - 20 * hour),
    exitedAt: iso(now - 15 * hour),
  })
})

test('measured zero-length visits are samples, and missing visits never become zero samples', () => {
  const task = flowTask('zero', [
    ['intake', 10],
    ['work', 10],
    ['done', 10],
  ])
  const flow = factoryDashboard([task], '7d', now).flow.current
  expect(flow.stages.find((s) => s.stage === 'work')).toMatchObject({
    totalMs: 0,
    medianMs: 0,
    p25Ms: 0,
    p75Ms: 0,
    samples: [{ taskId: 'zero', elapsedMs: 0 }],
  })
  expect(flow.stages.find((s) => s.stage === 'validate')).toMatchObject({
    totalMs: 0,
    medianMs: null,
    samples: [],
  })
})

test('event order binds same-timestamp judgments and send-backs to their own Validate visit', () => {
  const task = verified('ties')
  task.entries = flowTask('ties', [
    ['intake', 60],
    ['work', 50],
    ['validate', 20],
    ['review', 10],
    ['validate', 10],
    ['work', 10],
    ['done', 1],
  ]).entries
  task.sendBacks = [
    {
      id: 'later',
      taskId: task.id,
      from: 'validate',
      to: 'work',
      at: iso(now - 10 * hour),
      sequence: 49,
      counted: true,
      cause: 'review',
    },
  ]
  task.judgments = [
    first(task.judgments),
    { ...first(task.judgments), sequence: 48, review: false, outcome: 'sent-back' },
  ]
  expect(factoryDashboard([task], '7d', now).flow.current.firstPass).toMatchObject({
    passed: 1,
    denominator: 1,
    samples: [{ taskId: 'ties', outcome: 'passed' }],
  })
})

test('Flow does not include a zero visit at the end of a lifetime outside the selected cohort', () => {
  const task = flowTask('boundary-zero', [
    ['intake', 170],
    ['work', 168],
    ['done', 168],
  ])
  const result = factoryDashboard([task], '7d', now).flow
  expect(result.current.taskIds).toEqual([])
  expect(result.current.stages.every((s) => s.samples.length === 0)).toBe(true)
  expect(result.previous?.stages.find((s) => s.stage === 'work')?.samples).toEqual([])
})

test('unfinished Check results are unknown even if a review failure is recorded', () => {
  const task = verified('incomplete-checks')
  task.checks = [{ ...first(task.checks), states: ['failed', 'not-run'], outcome: 'failed' }]
  task.judgments = [{ ...first(task.judgments), review: false }]
  const result = factoryDashboard([task], '7d', now).flow.current.firstPass
  expect(result).toMatchObject({ denominator: 0, percent: null, samples: [{ outcome: 'unknown' }] })
  expect(result.samples[0]?.reasons).toContain(
    'The first visit has a recorded failure or actual send-back.',
  )
})
