import type { DashboardPeriod, DashboardReport, FlowPeriod, FlowReasonId } from '@ted/protocol'

export function dashboardFixture(empty = false): DashboardReport {
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
    byFactory: [],
  }
  current.byFactory = [
    { factoryId: 'nb', taskIds: current.taskIds, created: current.created, intake: current.intake },
  ]
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
    byFactory: [],
  }
  return {
    flow: {
      tasks: empty
        ? []
        : [
            {
              id: 't1',
              factoryId: 'nb',
              displayId: 'NB-1',
              title: 'Fix login',
              archived: true,
              endedAt: '2026-11-07T12:00:00.000Z',
              endReason: 'done',
            },
            {
              id: 't2',
              factoryId: 'nb',
              displayId: 'NB-2',
              title: 'Improve search',
              archived: false,
              endedAt: '2026-11-06T12:00:00.000Z',
              endReason: 'done',
            },
            {
              id: 't3',
              factoryId: 'nb',
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
    factoryIds: ['nb'],
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
            factoryId: 'nb',
            displayId: 'NB-1',
            title: 'Fix login',
            archived: true,
            doneAt: '2026-11-07T12:00:00.000Z',
            createdMs: 36_000_000,
            intakeMs: 18_000_000,
          },
          {
            id: 't2',
            factoryId: 'nb',
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
    reasons: (
      [
        'run-working',
        'running-check',
        'user-request',
        'run-slot',
        'check-slot',
        'test-lock',
        'github',
        'agent-paused',
        'blocker',
        'stopped',
      ] as FlowReasonId[]
    ).map((reason) => ({
      reason,
      totalMs: empty ? 0 : (reason === 'test-lock' ? 3 : 5) * 3_600_000,
      medianMs: empty ? null : (reason === 'test-lock' ? 1.5 : 2.5) * 3_600_000,
      p25Ms: empty ? null : (reason === 'test-lock' ? 1.25 : 2.25) * 3_600_000,
      p75Ms: empty ? null : (reason === 'test-lock' ? 1.75 : 2.75) * 3_600_000,
      samples: empty
        ? []
        : ['t1', 't3'].map((taskId, index) => ({
            taskId,
            elapsedMs: (index + (reason === 'test-lock' ? 1 : 2)) * 3_600_000,
            eligibleMs: 10 * 3_600_000,
            coveredMs: reason === 'test-lock' ? null : 10 * 3_600_000,
            coverage: reason === 'test-lock' ? 'partial' : 'full',
            coverageIntervals: [],
            notices: reason === 'test-lock' ? ['Only registered invocations are measured.'] : [],
            intervals: [
              {
                from: '2026-11-04T03:00:00.000Z',
                to: new Date(
                  Date.parse('2026-11-04T03:00:00.000Z') +
                    (index + (reason === 'test-lock' ? 1 : 2)) * 3_600_000,
                ).toISOString(),
                contributors: [
                  {
                    id: `evidence-${index}`,
                    start: '2026-11-04T03:00:00.000Z',
                    end: new Date(
                      Date.parse('2026-11-04T03:00:00.000Z') +
                        (index + (reason === 'test-lock' ? 1 : 2)) * 3_600_000,
                    ).toISOString(),
                    startSource: 'reported wait-start',
                    endSource: 'reported wait-end',
                    detail:
                      reason === 'test-lock'
                        ? 'Associated Check check-1, position 0; overlapping command time is also counted in Running Checks'
                        : 'Recorded boundary',
                  },
                ],
              },
            ],
            invocations:
              reason === 'test-lock'
                ? [
                    {
                      id: `invocation-${index}`,
                      checkRunId: 'check-1',
                      position: 0,
                      registeredAt: '2026-11-04T03:00:00.000Z',
                      coverage: 'reported',
                    },
                  ]
                : [],
          })),
    })),
    stages: [
      {
        stage: 'work',
        factoryIds: empty ? [] : ['nb'],
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
                intervals: [{ from: '2026-11-04T03:00:00.000Z', to: period.to }],
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
