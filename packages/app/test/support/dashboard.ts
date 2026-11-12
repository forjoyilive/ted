import type { DashboardPeriod, FactoryDashboard, FlowPeriod } from '@ted/protocol'

export function dashboardFixture(empty = false): FactoryDashboard {
  const current: DashboardPeriod = {
    from: '2026-11-01T12:00:00.000Z',
    to: '2026-11-08T12:00:00.000Z',
    taskIds: empty ? [] : ['t1', 't2'],
    created: {
      value: empty ? null : 72_000_000,
      taskIds: empty ? [] : ['t1', 't2'],
      missingIds: [],
    },
    intake: {
      value: empty ? null : 18_000_000,
      taskIds: empty ? [] : ['t1'],
      missingIds: empty ? [] : ['t2'],
    },
    buckets: [],
  }
  current.buckets = [
    {
      from: current.from ?? '',
      to: current.to,
      taskIds: current.taskIds,
      created: current.created,
      intake: current.intake,
    },
  ]
  const previous: DashboardPeriod = {
    from: '2026-10-25T12:00:00.000Z',
    to: '2026-11-01T12:00:00.000Z',
    taskIds: [],
    created: { value: null, taskIds: [], missingIds: [] },
    intake: { value: null, taskIds: [], missingIds: [] },
    buckets: [],
  }
  return {
    flow: {
      tasks: empty
        ? []
        : [
            {
              id: 't1',
              displayId: 'NB-1',
              title: 'Fix login',
              archived: true,
              endedAt: '2026-11-07T12:00:00.000Z',
              endReason: 'done',
            },
            {
              id: 't2',
              displayId: 'NB-2',
              title: 'Improve search',
              archived: false,
              endedAt: '2026-11-06T12:00:00.000Z',
              endReason: 'done',
            },
            {
              id: 't3',
              displayId: 'NB-3',
              title: 'Open Task',
              archived: false,
              endedAt: null,
              endReason: 'open',
            },
          ],
      current: flowPeriod(empty, current),
      previous: flowPeriod(true, previous),
    },
    asOf: current.to,
    range: '7d',
    current,
    previous,
    unavailableIds: [],
    comparison: {
      completed: { absolute: empty ? 0 : 2, percent: null },
      created: { absolute: null, percent: null },
      intake: { absolute: null, percent: null },
    },
    tasks: empty
      ? []
      : [
          {
            id: 't1',
            displayId: 'NB-1',
            title: 'Fix login',
            archived: true,
            doneAt: '2026-11-07T12:00:00.000Z',
            createdMs: 36_000_000,
            intakeMs: 18_000_000,
          },
          {
            id: 't2',
            displayId: 'NB-2',
            title: 'Improve search',
            archived: false,
            doneAt: '2026-11-06T12:00:00.000Z',
            createdMs: 108_000_000,
            intakeMs: null,
          },
        ],
  }
}

function flowPeriod(empty: boolean, period: DashboardPeriod): FlowPeriod {
  return {
    from: period.from,
    to: period.to,
    taskIds: empty ? [] : ['t1', 't3'],
    incomplete: empty ? [] : [{ taskId: 't2', reasons: ['First Intake timestamp is missing.'] }],
    stages: [
      {
        stage: 'work',
        totalMs: empty ? 0 : 14 * 3_600_000,
        medianMs: empty ? null : 7 * 3_600_000,
        p25Ms: empty ? null : 6 * 3_600_000,
        p75Ms: empty ? null : 8 * 3_600_000,
        samples: empty
          ? []
          : [
              {
                taskId: 't1',
                elapsedMs: 5 * 3_600_000,
                intervals: [{ from: '2026-11-04T00:00:00.000Z', to: '2026-11-04T05:00:00.000Z' }],
              },
              {
                taskId: 't3',
                elapsedMs: 9 * 3_600_000,
                intervals: [{ from: '2026-11-08T03:00:00.000Z', to: period.to }],
              },
            ],
      },
    ],
    sendBacks: empty
      ? []
      : [
          {
            from: 'validate',
            to: 'work',
            counted: 1,
            taskIds: ['t3'],
            transitions: [
              {
                id: 's1',
                taskId: 't3',
                from: 'validate',
                to: 'work',
                at: '2026-11-06T09:00:00.000Z',
                counted: true,
                cause: 'review',
              },
              {
                id: 's2',
                taskId: 't3',
                from: 'validate',
                to: 'work',
                at: '2026-11-07T09:00:00.000Z',
                counted: false,
                cause: 'base-conflict',
              },
            ],
          },
        ],
    firstPass: {
      passed: empty ? 0 : 1,
      denominator: empty ? 0 : 1,
      percent: empty ? null : 100,
      samples: empty
        ? []
        : [
            {
              taskId: 't1',
              outcome: 'passed',
              enteredAt: '2026-11-06T06:00:00.000Z',
              exitedAt: '2026-11-06T08:00:00.000Z',
              checkRunIds: ['check-1'],
              failureIds: [],
              reasons: ['Checks, review and visual passed; no actual first-visit send-back.'],
            },
            {
              taskId: 't2',
              outcome: 'unknown',
              enteredAt: '2026-11-06T06:00:00.000Z',
              exitedAt: '2026-11-06T08:00:00.000Z',
              checkRunIds: [],
              failureIds: [],
              reasons: ['Visual verification or its applicability was not recorded.'],
            },
          ],
    },
  }
}
