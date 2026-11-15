import type { DashboardPeriod, DashboardReport, FlowPeriod, FlowReasonId } from '@ted/protocol'
import { noStageParts } from '@ted/protocol/stage-parts'

const hour = 3_600_000

export function dashboardFixture(empty = false): DashboardReport {
  const current: DashboardPeriod = {
    from: '2026-11-01T12:00:00.000Z',
    to: '2026-11-08T12:00:00.000Z',
    taskIds: empty ? [] : ['t1', 't2'],
    merged: { count: empty ? 0 : 3, taskIds: empty ? [] : ['t1', 't2'] },
    created: {
      value: empty ? null : 72_000_000,
      taskIds: empty ? [] : ['t1', 't2'],
      missingIds: [],
    },
    backlog: {
      value: empty ? null : 18_000_000,
      taskIds: empty ? [] : ['t1'],
      missingIds: empty ? [] : ['t2'],
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
    {
      factoryId: 'nb',
      taskIds: current.taskIds,
      merged: current.merged,
      created: current.created,
      backlog: current.backlog,
      intake: current.intake,
    },
  ]
  current.buckets = [
    {
      from: current.from ?? '',
      to: current.to,
      taskIds: current.taskIds,
      merged: current.merged,
      created: current.created,
      backlog: current.backlog,
      intake: current.intake,
    },
  ]
  const previous: DashboardPeriod = {
    from: '2026-10-25T12:00:00.000Z',
    to: '2026-11-01T12:00:00.000Z',
    taskIds: [],
    merged: { count: 0, taskIds: [] },
    created: { value: null, taskIds: [], missingIds: [] },
    backlog: { value: null, taskIds: [], missingIds: [] },
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
    waiting: {
      current: {
        totalMs: empty ? 0 : 30 * hour,
        medianMs: empty ? null : 6 * hour,
        samples: empty
          ? []
          : [
              { taskId: 't1', waitedMs: 26 * hour },
              { taskId: 't2', waitedMs: 4 * hour },
            ],
        stages: empty
          ? []
          : [
              {
                stage: 'review',
                totalMs: 24 * hour,
                kinds: ['Review sign-off'],
                samples: [{ taskId: 't1', waitedMs: 24 * hour }],
              },
              {
                stage: 'clarify',
                totalMs: 6 * hour,
                kinds: ['Clarify round', 'Question'],
                samples: [
                  { taskId: 't2', waitedMs: 4 * hour },
                  { taskId: 't1', waitedMs: 2 * hour },
                ],
              },
            ],
        waits: empty
          ? []
          : [
              {
                taskId: 't1',
                requestId: 'c1',
                kind: 'Review sign-off',
                stage: 'review',
                waitedMs: 24 * hour,
              },
              {
                taskId: 't2',
                requestId: 'c2',
                kind: 'Clarify round',
                stage: 'clarify',
                waitedMs: 4 * hour,
              },
              {
                taskId: 't1',
                requestId: 'c3',
                kind: 'Question',
                stage: 'clarify',
                waitedMs: 2 * hour,
              },
            ],
        byFactory: [
          { factoryId: 'nb', totalMs: empty ? 0 : 30 * hour, taskIds: empty ? [] : ['t1', 't2'] },
        ],
      },
      previous: {
        totalMs: 40 * hour,
        medianMs: 8 * hour,
        samples: [],
        stages: [],
        waits: [],
        byFactory: [{ factoryId: 'nb', totalMs: 40 * hour, taskIds: [] }],
      },
      change: { absolute: -10 * hour, percent: -25 },
    },
    asOf: current.to,
    range: '7d',
    factoryIds: ['nb'],
    current,
    previous,
    unavailableIds: [],
    open: empty
      ? []
      : [
          {
            id: 't3',
            factoryId: 'nb',
            displayId: 'NB-3',
            title: 'Open Task',
            stage: 'work',
            state: 'working',
          },
          {
            id: 't4',
            factoryId: 'nb',
            displayId: 'NB-4',
            title: 'Answer me',
            stage: 'review',
            state: 'waiting-on-you',
          },
        ],
    comparison: {
      completed: { absolute: empty ? 0 : 2, percent: null },
      merged: { absolute: empty ? 0 : 3, percent: null },
      created: { absolute: null, percent: null },
      backlog: { absolute: null, percent: null },
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
            backlogMs: 18_000_000,
            intakeMs: 18_000_000,
            merges: 2,
          },
          {
            id: 't2',
            factoryId: 'nb',
            displayId: 'NB-2',
            title: 'Improve search',
            archived: false,
            doneAt: '2026-11-06T12:00:00.000Z',
            createdMs: 108_000_000,
            backlogMs: null,
            intakeMs: null,
            merges: 1,
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
        parts: empty ? noStageParts() : { ...noStageParts(), working: 5 * hour, other: 9 * hour },
        samples: empty
          ? []
          : [
              {
                taskId: 't1',
                elapsedMs: 5 * 3_600_000,
                intervals: [{ from: '2026-11-04T00:00:00.000Z', to: '2026-11-04T05:00:00.000Z' }],
                parts: { ...noStageParts(), working: 2 * hour, other: 3 * hour },
              },
              {
                taskId: 't3',
                elapsedMs: 9 * 3_600_000,
                intervals: [{ from: '2026-11-04T03:00:00.000Z', to: period.to }],
                parts: { ...noStageParts(), working: 3 * hour, other: 6 * hour },
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
                severity: 'p1',
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
    failures: empty
      ? []
      : [
          {
            id: 'f1',
            taskId: 't1',
            kind: 'check',
            outcome: 'fixed',
            at: '2026-11-05T09:00:00.000Z',
          },
          {
            id: 'f2',
            taskId: 't3',
            kind: 'finding',
            outcome: 'accepted',
            at: '2026-11-06T08:00:00.000Z',
            reason: 'Out of scope for this Task',
          },
          {
            id: 'f3',
            taskId: 't3',
            kind: 'ci',
            outcome: 'open',
            at: '2026-11-07T10:00:00.000Z',
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
