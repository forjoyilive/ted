import type { DashboardRange } from '@ted/protocol'
import { expect, test } from 'vitest'
import { type DashboardTaskFacts, dashboardReport } from '../src/dashboard.ts'

type Facts = Omit<DashboardTaskFacts, 'factoryId'> & { factoryId?: string }
const factoryDashboard = (facts: readonly Facts[], range: DashboardRange, asOf: number) =>
  dashboardReport(
    facts.map((task) => ({ factoryId: 'nb', ...task })),
    ['nb'],
    range,
    asOf,
  )

const hour = 3_600_000
const now = new Date(2026, 5, 10).getTime()
const iso = (n: number) => new Date(n).toISOString()
function completed(id: string, ago: number, created: number, intake: number | null): Facts {
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
  expect(all.current.buckets.length).toBeLessThanOrEqual(30)
  expect(all.current.buckets.flatMap((b) => b.taskIds)).toEqual(['1'])
  const empty = factoryDashboard([], 'all', now)
  expect(empty.current).toMatchObject({
    from: null,
    taskIds: [],
    created: { value: null },
    buckets: [],
  })
})

test('7 and 30 days are whole local days before today, and All groups whole days ending today', () => {
  const zone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const at = (month: number, day: number, hours = 0, minutes = 0) =>
      new Date(2026, month, day, hours, minutes).getTime()
    const asOf = at(10, 12, 14, 26)
    const done = (id: string, time: number): Facts => ({
      ...completed(id, 0, 1, null),
      createdAt: iso(time - hour),
      entries: [{ stage: 'done', at: iso(time) }],
    })
    const tasks = [
      done('today', at(10, 12, 0, 1)),
      done('late', at(10, 11, 23, 59)),
      done('first', at(10, 5)),
      done('before', at(10, 4, 23, 59)),
      done('dst', at(10, 1, 12)),
      done('oldest', at(9, 29)),
    ]
    const week = factoryDashboard(tasks, '7d', asOf)
    expect(week.current).toMatchObject({
      from: iso(at(10, 5)),
      to: iso(at(10, 12)),
      taskIds: ['late', 'first'],
    })
    expect(week.current.buckets.map((b) => b.from)).toEqual(
      [5, 6, 7, 8, 9, 10, 11].map((d) => iso(at(10, d))),
    )
    expect(week.current.buckets[6]?.taskIds).toEqual(['late'])
    expect(week.current.buckets.flatMap((b) => b.taskIds).sort()).toEqual(
      [...week.current.taskIds].sort(),
    )
    expect(week.previous).toMatchObject({
      from: iso(at(9, 29)),
      to: iso(at(10, 5)),
      taskIds: ['before', 'dst', 'oldest'],
    })
    expect(week.previous?.buckets.map((b) => b.from)).toEqual(
      [
        [9, 29],
        [9, 30],
        [9, 31],
        [10, 1],
        [10, 2],
        [10, 3],
        [10, 4],
      ].map(([m, d]) => iso(at(m as number, d as number))),
    )
    expect(week.previous?.buckets[3]).toMatchObject({ to: iso(at(10, 2)), taskIds: ['dst'] })
    expect(week.flow.current.to).toBe(iso(at(10, 12)))
    expect(week.flow.previous?.to).toBe(iso(at(10, 5)))
    const month = factoryDashboard(tasks, '30d', asOf)
    expect(month.current.buckets).toHaveLength(30)
    expect(month.current).toMatchObject({ from: iso(at(9, 13)), to: iso(at(10, 12)) })
    const all = factoryDashboard([...tasks, done('history', at(6, 20, 9))], 'all', asOf)
    expect(all.current.buckets).toHaveLength(29)
    expect(all.current).toMatchObject({ from: iso(at(6, 20)), to: iso(asOf) })
    expect(all.current.buckets.at(-1)).toMatchObject({
      from: iso(at(10, 9)),
      to: iso(asOf),
      taskIds: ['today', 'late'],
    })
    expect(all.current.buckets.flatMap((b) => b.taskIds).sort()).toEqual(
      [...all.current.taskIds].sort(),
    )
    const short = factoryDashboard([done('late', at(10, 11, 23, 59))], 'all', asOf)
    expect(short.current.buckets.map((b) => [b.from, b.to])).toEqual([
      [iso(at(10, 11)), iso(at(10, 12))],
      [iso(at(10, 12)), iso(asOf)],
    ])
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})

function flowTask(
  id: string,
  entries: [string, number][],
  stage = entries.at(-1)?.[0] ?? 'backlog',
): Facts {
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

test('a combined Dashboard pools Tasks from several Factories and keeps each Factory’s figures', () => {
  const a = {
    ...flowTask('a', [
      ['intake', 40],
      ['design', 30],
      ['work', 20],
      ['done', 10],
    ]),
    factoryId: 'one',
  }
  const b = {
    ...flowTask('b', [
      ['intake', 30],
      ['work', 25],
      ['done', 5],
    ]),
    factoryId: 'two',
    displayId: 'GD-1',
  }
  const c = {
    ...flowTask('c', [
      ['intake', 90],
      ['work', 80],
      ['done', 60],
    ]),
    factoryId: 'two',
    displayId: 'GD-2',
  }
  const result = dashboardReport([a, b, c], ['one', 'two'], '7d', now)
  expect(result.factoryIds).toEqual(['one', 'two'])
  expect(result.current.taskIds).toEqual(['a', 'b', 'c'])
  expect(result.current.intake.value).toBe(30 * hour)
  expect(result.current.byFactory).toMatchObject([
    { factoryId: 'one', taskIds: ['a'], intake: { value: 30 * hour } },
    { factoryId: 'two', taskIds: ['b', 'c'], intake: { value: 27.5 * hour } },
  ])
  expect(result.tasks.map((task) => [task.id, task.factoryId])).toEqual([
    ['a', 'one'],
    ['b', 'two'],
    ['c', 'two'],
  ])
  const stages = result.flow.current.stages
  expect(stages.find((s) => s.stage === 'work')).toMatchObject({ factoryIds: ['one', 'two'] })
  expect(stages.find((s) => s.stage === 'design')).toMatchObject({
    factoryIds: ['one'],
    samples: [{ taskId: 'a' }],
  })
  expect(stages.find((s) => s.stage === 'review')).toMatchObject({ factoryIds: [], samples: [] })
  expect(result.flow.tasks.find((task) => task.id === 'b')).toMatchObject({ factoryId: 'two' })
})

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
  const intake = flowTask('intake', [
    ['intake', 8],
    ['intake', 7],
    ['backlog', 6],
    ['intake', 6],
    ['intake', 5],
    ['work', 4],
  ])
  expect(
    factoryDashboard([intake], '7d', now).flow.current.stages.find((s) => s.stage === 'intake')
      ?.samples[0],
  ).toMatchObject({
    elapsedMs: 4 * hour,
    intervals: [
      { from: iso(now - 8 * hour), to: iso(now - 6 * hour) },
      { from: iso(now - 6 * hour), to: iso(now - 4 * hour) },
    ],
  })
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

function verified(id: string): Facts {
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
  expect(result).toMatchObject({ passed: 1, denominator: 3 })
  expect(result.percent).toBeCloseTo(100 / 3)
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

function observedTask(id = 'observed'): Facts {
  const start = now - 10 * hour
  const at = (h: number) => iso(start + h * hour)
  const spans = [
    ['run-working', 0, 3],
    ['run-working', 2, 5],
    ['user-request', 1, 5],
    ['user-request', 3, 6],
    ['run-slot', 2, 4],
    ['github', 3, 6],
    ['agent-paused', 4, 7],
    ['blocker', 0, 4],
    ['stopped', 8, 10],
  ] as const
  return {
    id,
    displayId: `NB-${id}`,
    title: 'Observed intervals',
    stage: 'work',
    setup: false,
    archived: false,
    createdAt: at(0),
    entries: [
      { stage: 'intake', at: at(0) },
      { stage: 'work', at: at(0) },
    ],
    activity: {
      history: {
        taskId: id,
        asOf: iso(now),
        lifecycle: [],
        intervals: spans.map(([reason, a, b], i) => ({
          reason,
          start: at(a),
          end: at(b),
          contributors: [
            {
              id: `source-${i}`,
              start: at(a),
              end: at(b),
              startSource: 'recorded start',
              endSource: 'recorded end',
            },
          ],
        })),
        coverage: (
          [
            'run-working',
            'user-request',
            'run-slot',
            'github',
            'agent-paused',
            'blocker',
            'stopped',
          ] as const
        ).map((reason) => ({
          reason,
          start: at(0),
          end: at(10),
          state: 'known',
          source: 'durable-history',
        })),
      },
      checks: [0, 1].map((index) => ({
        id: `check-${index}`,
        taskId: id,
        stage: 'work',
        trigger: 'agent',
        startedAt: at(1),
        finishedAt: at(9),
        checks: [{ name: 'Tests', command: 'vitest', timeout: '10m', state: 'passed' }],
        timing: {
          checkRunId: `check-${index}`,
          taskId: id,
          stage: 'work',
          trigger: 'agent',
          queue: {
            status: 'complete',
            startedAt: at(1 + index * 0.5),
            endedAt: at(2 + index * 0.5),
            durationMs: hour,
          },
          execution: [
            {
              position: 0,
              status: 'complete',
              startedAt: at(index === 0 ? 2 : 6),
              endedAt: at(index === 0 ? 8 : 9),
              durationMs: (index === 0 ? 6 : 3) * hour,
            },
          ],
        },
      })),
      invocations: [0, 1].map((i) => ({
        id: `invocation-${i}`,
        taskId: id,
        supported: true,
        registeredAt: Date.parse(at(2)),
        ...(i === 0 ? { runId: 'direct' } : { checkRunId: 'check-0', position: 0 }),
        reports: [
          { sequence: 0, kind: 'wait-start', at: Date.parse(at(3 + i)) },
          { sequence: 1, kind: 'wait-end', at: Date.parse(at(5 + i)) },
          { sequence: 2, kind: 'finished', at: Date.parse(at(7)) },
        ],
      })),
    },
  }
}

test('unions every observed reason independently and preserves direct/Check test containment evidence', () => {
  const flow = factoryDashboard([observedTask()], '7d', now).flow
  const totals = Object.fromEntries(flow.current.reasons.map((r) => [r.reason, r.totalMs / hour]))
  expect(totals).toEqual({
    'run-working': 5,
    'running-check': 7,
    'user-request': 5,
    'run-slot': 2,
    'check-slot': 1.5,
    'test-lock': 3,
    github: 3,
    'agent-paused': 3,
    blocker: 4,
    stopped: 2,
  })
  for (const r of flow.current.reasons) {
    const s = required(r.samples[0])
    expect(s.intervals.reduce((n, i) => n + Date.parse(i.to) - Date.parse(i.from), 0)).toBe(
      r.totalMs,
    )
    expect(s.elapsedMs).toBe(r.totalMs)
    expect(r.medianMs).toBe(r.totalMs)
    expect(s.coverage).toBe(r.reason === 'test-lock' ? 'partial' : 'full')
  }
  const test = required(flow.current.reasons.find((r) => r.reason === 'test-lock'))
  expect(test.samples[0]?.intervals[0]?.contributors).toHaveLength(2)
  expect(test.samples[0]?.invocations[1]?.checkCommand?.overlapMs).toBe(2 * hour)
  expect(test.samples[0]?.invocations).toMatchObject([
    { runId: 'direct' },
    { checkRunId: 'check-0', position: 0 },
  ])
  expect(test.samples[0]?.intervals[0]?.contributors[1]?.detail).toContain(
    'Associated Check check-0',
  )
  expect(flow.previous?.reasons.every((r) => r.samples.length === 0 && r.medianMs === null)).toBe(
    true,
  )
})

test('clips all reasons to active Stage windows, excludes Backlog, and uses one as-of for both periods', () => {
  const task = observedTask()
  const at = (h: number) => iso(now - (200 - h) * hour)
  task.createdAt = at(0)
  task.entries = [
    { stage: 'intake', at: at(0) },
    { stage: 'work', at: at(0) },
    { stage: 'backlog', at: at(30) },
    { stage: 'work', at: at(40) },
  ]
  required(task.activity).history.intervals = [
    {
      reason: 'user-request',
      start: at(0),
      end: iso(now + hour),
      contributors: [
        {
          id: 'request',
          start: at(0),
          end: iso(now + hour),
          startSource: 'posted',
          endSource: 'query',
        },
      ],
    },
  ]
  required(task.activity).history.coverage = [
    {
      reason: 'user-request',
      start: at(0),
      end: iso(now),
      state: 'known',
      source: 'durable-history',
    },
  ]
  const flow = factoryDashboard([task], '7d', now).flow
  expect(flow.current.reasons.find((r) => r.reason === 'user-request')?.totalMs).toBe(160 * hour)
  expect(flow.previous?.reasons.find((r) => r.reason === 'user-request')?.totalMs).toBe(30 * hour)
  expect(
    flow.current.reasons.find((r) => r.reason === 'user-request')?.samples[0]?.intervals.at(-1)?.to,
  ).toBe(iso(now))
})

test('partial/old/recovered/unsupported and empty histories never become invented zero-duration samples', () => {
  const task = observedTask()
  const activity = required(task.activity)
  activity.history.coverage = activity.history.coverage.map((c) => ({
    ...c,
    state: 'unknown',
    source: 'daemon-gap',
  }))
  activity.history.intervals = activity.history.intervals.filter((i) => i.reason !== 'github')
  required(required(activity.checks[0]).timing).queue = {
    status: 'interrupted',
    startedAt: iso(now - 9 * hour),
    detectedAt: iso(now - hour),
  }
  activity.checks = activity.checks.slice(0, 1)
  activity.invocations = [
    {
      id: 'unsupported',
      taskId: task.id,
      supported: false,
      registeredAt: now - 5 * hour,
      reports: [],
    },
    {
      id: 'open',
      taskId: task.id,
      runId: 'direct',
      supported: true,
      ownerEnded: true,
      registeredAt: now - 5 * hour,
      reports: [{ sequence: 0, kind: 'wait-start', at: now - 4 * hour }],
    },
  ]
  const flow = factoryDashboard([task], 'all', now).flow
  expect(flow.previous).toBeNull()
  const get = (reason: string) => required(flow.current.reasons.find((r) => r.reason === reason))
  expect(get('run-working').samples[0]).toMatchObject({
    elapsedMs: 5 * hour,
    coverage: 'partial',
    coveredMs: 0,
  })
  expect(get('github')).toMatchObject({
    totalMs: 0,
    medianMs: null,
    samples: [{ elapsedMs: null, coverage: 'unavailable' }],
  })
  expect(get('check-slot').samples[0]).toMatchObject({ elapsedMs: null, coverage: 'unavailable' })
  expect(get('check-slot').samples[0]?.notices.join(' ')).toContain('end unavailable')
  expect(get('test-lock')).toMatchObject({ totalMs: 0, medianMs: null })
  expect(get('test-lock').samples[0]?.invocations).toMatchObject([
    { coverage: 'unsupported' },
    { coverage: 'incomplete', openWaitStartedAt: iso(now - 4 * hour) },
  ])
  expect(get('test-lock').samples[0]?.notices.join(' ')).toContain('no closing report')
  expect(
    factoryDashboard([], '7d', now).flow.current.reasons.every(
      (r) => r.samples.length === 0 && r.medianMs === null,
    ),
  ).toBe(true)
})

test('known immediate Check admission and supported zero-wait reporting remain measured zero, with invocation-only coverage', () => {
  const task = observedTask(),
    activity = required(task.activity)
  activity.checks = activity.checks.slice(0, 1)
  required(required(activity.checks[0]).timing).queue = {
    status: 'complete',
    startedAt: iso(now - hour),
    endedAt: iso(now - hour),
    durationMs: 0,
  }
  activity.invocations = [
    {
      id: 'zero',
      taskId: task.id,
      runId: 'direct',
      supported: true,
      registeredAt: now - hour,
      reports: [{ sequence: 0, kind: 'finished', at: now - hour }],
    },
  ]
  const reasons = factoryDashboard([task], '7d', now).flow.current.reasons
  expect(reasons.find((r) => r.reason === 'check-slot')).toMatchObject({
    totalMs: 0,
    medianMs: 0,
    samples: [{ coverage: 'full' }],
  })
  expect(reasons.find((r) => r.reason === 'test-lock')).toMatchObject({
    totalMs: 0,
    medianMs: 0,
    samples: [{ coverage: 'partial', coveredMs: null }],
  })
})

test('large retained cohort aggregates interval evidence without dropping samples', () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => observedTask(String(i)))
  const started = performance.now()
  const result = factoryDashboard(tasks, '30d', now)
  const elapsed = performance.now() - started
  const bytes = JSON.stringify(result).length
  expect(result.flow.current.reasons.find((r) => r.reason === 'test-lock')).toMatchObject({
    totalMs: 3000 * hour,
  })
  expect(result.flow.current.reasons.every((r) => r.samples.length === 1000)).toBe(true)
  console.info(
    `Flow retained fixture: 1000 Tasks, ${elapsed.toFixed(1)}ms calculation, ${bytes} response bytes`,
  )
})

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Required fixture evidence is missing')
  return value
}

test('Today runs from local midnight by the hour and compares with yesterday up to the same time', () => {
  const at = (day: number, hours: number, minutes = 0) =>
    new Date(2026, 10, day, hours, minutes).getTime()
  const asOf = at(12, 14, 40)
  const done = (id: string, time: number): Facts => ({
    ...completed(id, 0, 1, null),
    createdAt: iso(time - hour),
    entries: [{ stage: 'done', at: iso(time) }],
  })
  const result = factoryDashboard(
    [
      done('midnight', at(12, 0)),
      done('morning', at(12, 9, 30)),
      done('latest', at(12, 14, 10)),
      done('yesterday', at(11, 9)),
      done('same-time', at(11, 14, 40)),
      done('evening', at(11, 23, 59)),
      done('older', at(10, 23, 59)),
    ],
    'today',
    asOf,
  )
  expect(result.current).toMatchObject({
    from: iso(at(12, 0)),
    to: iso(asOf),
    taskIds: ['midnight', 'morning', 'latest'],
  })
  expect(result.current.buckets).toHaveLength(15)
  expect(result.current.buckets[9]?.taskIds).toEqual(['morning'])
  expect(result.current.buckets[14]).toMatchObject({ to: iso(asOf), taskIds: ['latest'] })
  expect(result.previous).toMatchObject({
    from: iso(at(11, 0)),
    to: iso(at(11, 14, 40)),
    taskIds: ['yesterday'],
  })
  expect(result.previous?.buckets).toHaveLength(24)
  expect(result.previous?.buckets[14]?.taskIds).toEqual(['same-time'])
  expect(result.previous?.buckets[23]).toMatchObject({
    to: iso(at(12, 0)),
    taskIds: ['evening'],
  })
  expect(result.comparison?.completed).toEqual({ absolute: 2, percent: 200 })
  const ids = result.tasks.map((t) => t.id)
  expect(ids).toEqual(expect.arrayContaining(['same-time', 'evening']))
  expect(ids).not.toContain('older')
  expect(result.flow.previous).toMatchObject({
    from: iso(at(11, 0)),
    to: iso(at(11, 14, 40)),
  })
})

test('Today compares with the same clock time yesterday on a day the clocks change', () => {
  const zone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const at = (month: number, day: number, hours: number, minutes = 0) =>
      new Date(2026, month, day, hours, minutes).getTime()
    const asOf = at(10, 1, 12)
    const done = (id: string, time: number): Facts => ({
      ...completed(id, 0, 1, null),
      createdAt: iso(time - hour),
      entries: [{ stage: 'done', at: iso(time) }],
    })
    const result = factoryDashboard(
      [done('before', at(9, 31, 11, 30)), done('after', at(9, 31, 12, 30))],
      'today',
      asOf,
    )
    expect(asOf - at(10, 1, 0)).toBe(13 * hour)
    expect(result.current.buckets).toHaveLength(13)
    expect(result.previous).toMatchObject({
      from: iso(at(9, 31, 0)),
      to: iso(at(9, 31, 12)),
      taskIds: ['before'],
    })
    expect(result.previous?.buckets).toHaveLength(24)
    expect(result.flow.previous?.to).toBe(iso(at(9, 31, 12)))
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})
