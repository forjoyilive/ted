import type { DashboardPeriod, FactoryDashboard } from '@ted/protocol'

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
