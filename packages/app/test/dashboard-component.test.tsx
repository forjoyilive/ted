// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import type { DashboardViewState } from '../src/renderer/dashboard.ts'
import { setTimePreferences, timePreferences } from '../src/renderer/time.ts'
import { Dashboard } from '../src/renderer/views/Dashboard.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { dashboardFixture } from './support/dashboard.ts'
import { factory, task } from './support/fixtures.ts'

function DashboardView({ open }: { open: (id: string) => void }) {
  const [state, setState] = useState<DashboardViewState>({ range: '7d' })
  return <Dashboard factories={[]} state={state} onChange={setState} onOpenTask={open} />
}

test('the shared App shortcuts navigate only the top sample dialog and preserve Task return', async () => {
  const a = appState()
  a.handle('dashboard', () => dashboardFixture())
  a.state.tasks = [task({ id: 't1', title: 'Fix login', stage: 'done' })]
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.parentElement
  })
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  const completed = await screen.findByRole('region', { name: 'Tasks completed' })
  const opener = within(completed).getByRole('button', { name: '2 tasks' })
  await u.click(opener)
  let sample = screen.getByRole('dialog')
  let first = within(sample).getByRole('button', { name: /NB-1.*Fix login/ })
  const second = within(sample).getByRole('button', { name: /NB-2.*Improve search/ })
  first.focus()
  await u.keyboard('k')
  expect(document.activeElement).toBe(first)
  await u.keyboard('j')
  expect(document.activeElement).toBe(second)
  await u.keyboard('j')
  expect(document.activeElement).toBe(second)
  await u.keyboard('k')
  expect(document.activeElement).toBe(first)

  const ordinary = document.createElement('dialog')
  const ordinaryItem = document.createElement('button')
  ordinaryItem.setAttribute('data-nav-item', '')
  ordinary.append(ordinaryItem, ordinaryItem.cloneNode())
  document.body.append(ordinary)
  try {
    ordinary.showModal()
    ordinaryItem.focus()
    await u.keyboard('j')
    expect(document.activeElement).toBe(ordinaryItem)
  } finally {
    ordinary.close()
    ordinary.remove()
  }

  await u.click(within(sample).getByRole('button', { name: 'Close sample' }))
  expect(document.activeElement).toBe(opener)
  await u.click(opener)
  sample = screen.getByRole('dialog')
  first = within(sample).getByRole('button', { name: /NB-1.*Fix login/ })
  first.focus()
  await u.keyboard('{Enter}')
  await u.click(await screen.findByRole('button', { name: '← Dashboard' }))
  sample = await screen.findByRole('dialog')
  expect(within(sample).getByRole('button', { name: /NB-2.*Improve search/ })).toBeTruthy()
  fireEvent(sample, new Event('cancel', { bubbles: true, cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()

  await u.click(screen.getByRole('tab', { name: 'Stages' }))
  const stageTime = screen.getByRole('region', { name: 'Elapsed time by Stage' })
  await u.click(within(stageTime).getByRole('button', { name: '2 Tasks' }))
  sample = screen.getByRole('dialog')
  first = within(sample).getByRole('button', { name: /NB-1.*Fix login/ })
  const openFlowTask = within(sample).getByRole('button', { name: /NB-3.*Open Task/ })
  first.focus()
  await u.keyboard('k')
  expect(document.activeElement).toBe(openFlowTask)
  await u.keyboard('j')
  expect(document.activeElement).toBe(first)
  await u.keyboard('{Enter}')
  await u.click(await screen.findByRole('button', { name: '← Dashboard' }))
  sample = await screen.findByRole('dialog')
  expect(within(sample).getByRole('heading', { name: 'Work · Per-Task elapsed time' })).toBeTruthy()
  expect(within(sample).getByRole('button', { name: /NB-3.*Open Task/ })).toBeTruthy()
  await u.click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
})

test('graph points and their samples name the calendar days they cover', async () => {
  const preferences = timePreferences()
  const zone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  setTimePreferences({ timeZone: 'UTC', timeFormat: '24-hour' })
  try {
    const day = dashboardFixture()
    day.asOf = '2026-11-12T22:26:00.000Z'
    day.current.from = '2026-11-11T08:00:00.000Z'
    day.current.to = '2026-11-12T08:00:00.000Z'
    day.current.buckets = day.current.buckets.map((bucket) => ({
      ...bucket,
      from: '2026-11-11T08:00:00.000Z',
      to: '2026-11-12T08:00:00.000Z',
    }))
    const all = structuredClone(day)
    all.range = 'all'
    all.previous = null
    all.comparison = null
    all.current.from = '2026-11-09T08:00:00.000Z'
    all.current.to = all.asOf
    all.current.buckets = all.current.buckets.map((bucket) => ({
      ...bucket,
      from: '2026-11-09T08:00:00.000Z',
      to: all.asOf,
    }))
    const early = structuredClone(all)
    early.asOf = '2026-11-12T14:00:00.000Z'
    early.current.from = '2026-11-12T08:00:00.000Z'
    early.current.to = early.asOf
    early.current.buckets = early.current.buckets.map((bucket) => ({
      ...bucket,
      from: '2026-11-12T08:00:00.000Z',
      to: early.asOf,
    }))
    const today = structuredClone(day)
    today.range = 'today'
    today.asOf = '2026-11-12T14:26:45.500Z'
    today.current.buckets = today.current.buckets.map((bucket) => ({
      ...bucket,
      from: '2026-11-12T14:00:30.125Z',
      to: today.asOf,
    }))
    for (const [data, label, heading, bounds, caption] of [
      [
        day,
        'Wed 11 Nov',
        'Tasks completed · Wed 11 Nov',
        'Midnight to midnight',
        'One bar per calendar day, midnight to midnight. Today is not included.',
      ],
      [
        all,
        '9–12 Nov (today so far)',
        'Tasks completed · 9–12 Nov (today so far)',
        '22:26:00 UTC (end excluded)',
        'Each bar covers 4 calendar days',
      ],
      [
        early,
        'Thu 12 Nov (today so far)',
        'Tasks completed · Thu 12 Nov (today so far)',
        '14:00:00 UTC (end excluded)',
        'One bar per calendar day, midnight to midnight. The last bar runs to now.',
      ],
      [
        today,
        '14:00:30.125 UTC',
        'Tasks completed · Selected period',
        '14:26:45.500 UTC (end excluded)',
        'One bar per hour since midnight.',
      ],
    ] as const) {
      bridge({ dashboard: () => data })
      const view = render(<DashboardView open={vi.fn()} />)
      const completed = await screen.findByRole('region', { name: 'Tasks completed' })
      expect(completed.textContent).toContain(caption)
      const point = within(completed).getByRole('button', { name: /^Selected.*2 tasks/ })
      expect(point.getAttribute('aria-label')).toContain(label)
      expect(point.getAttribute('title')).toBeNull()
      fireEvent.mouseEnter(point)
      const tooltip = within(completed).getByRole('tooltip')
      expect(point.getAttribute('aria-describedby')).toBe(tooltip.id)
      expect(tooltip.textContent).toContain('Completed2 Tasks')
      fireEvent.mouseLeave(point)
      expect(within(completed).queryByRole('tooltip')).toBeNull()
      await user().click(point)
      const sample = screen.getByRole('dialog')
      expect(within(sample).getByRole('heading', { name: heading })).toBeTruthy()
      expect(sample.textContent).toContain(bounds)
      view.unmount()
    }
  } finally {
    setTimePreferences(preferences)
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
})

test('Overview figures open the Tasks behind them, durations slowest first', async () => {
  bridge({ dashboard: () => dashboardFixture() })
  const open = vi.fn()
  render(<DashboardView open={open} />)
  const completed = await screen.findByRole('region', { name: 'Tasks completed' })
  expect(within(completed).getByRole('button', { name: '2 tasks' })).toBeTruthy()
  expect(screen.queryByText('Factory right now')).toBeNull()
  expect(within(completed).getByText(/Percentage unavailable/)).toBeTruthy()
  const graphPoint = within(completed).getByRole('button', { name: /^Selected.*2 tasks/ })
  graphPoint.focus()
  await user().keyboard('{Enter}')
  const graphSample = screen.getByRole('dialog')
  expect(within(graphSample).getByRole('button', { name: /NB-2.*Improve search/ })).toBeTruthy()
  await user().click(within(graphSample).getByRole('button', { name: 'Close sample' }))
  const close = () =>
    user().click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close sample' }))
  const time = screen.getByRole('region', { name: 'How long a Task takes' })
  await user().click(within(time).getByRole('button', { name: 'First Intake → Done 5h' }))
  let sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }).textContent).toContain(
    'Archived',
  )
  expect(within(sample).queryByText(/Improve search/)).toBeNull()
  await user().click(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }))
  expect(open).toHaveBeenCalledWith('t1')
  await close()
  await user().click(within(time).getByRole('button', { name: '1 missing starts' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByText(/Improve search/)).toBeTruthy()
  expect(within(sample).getByText(/Start unavailable/)).toBeTruthy()
  await close()
  await user().click(within(time).getByRole('button', { name: 'Created → Done 20h' }))
  sample = screen.getByRole('dialog')
  expect(
    within(sample)
      .getAllByRole('button', { name: /NB-/ })
      .map((row) => row.textContent?.slice(0, 4)),
  ).toEqual(['NB-2', 'NB-1'])
  await close()
  await user().click(within(time).getByRole('button', { name: /5h\s*Waiting in Backlog/ }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe(
    'Waiting in Backlog · Selected period',
  )
  expect(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }).textContent).toContain(
    '5h',
  )
  await close()

  const merged = screen.getByRole('region', { name: 'Pull requests merged' })
  await user().click(within(merged).getByRole('button', { name: '3 pull requests merged' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }).textContent).toContain(
    '2 pull requests merged',
  )
  await close()
  const openTasks = screen.getByRole('region', { name: 'Open Tasks right now' })
  expect(openTasks.textContent).toContain('1 Working · 1 waiting on you')
  await user().click(within(openTasks).getByRole('button', { name: '2 open Tasks' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe('Open Tasks right now')
  const waiting = within(sample).getByRole('button', { name: /NB-4.*Answer me/ })
  expect(waiting.textContent).toContain('Review · Waiting on you')
  await user().click(waiting)
  expect(open).toHaveBeenCalledWith('t4')
})

test('Factory and range changes discard late responses instead of mixing samples', async () => {
  const { deferred } = await import('./support/component.ts')
  const pending = deferred<ReturnType<typeof dashboardFixture>>()
  const api = bridge({
    dashboard: (range, ids) =>
      (ids as string[])[0] === 'f1' && range === '7d' ? pending.promise : dashboardFixture(true),
  })
  const change = vi.fn()
  const factories = [factory({ id: 'f1', name: 'Widgets' }), factory({ id: 'f2', name: 'Site' })]
  const props = { factories, onChange: change, onOpenTask: vi.fn() }
  const view = render(<Dashboard {...props} state={{ range: '7d', factoryIds: ['f1'] }} />)
  expect(screen.getByRole('status', { name: 'Loading Dashboard…' })).toBeTruthy()
  view.rerender(<Dashboard {...props} state={{ range: '30d', factoryIds: ['f2'] }} />)
  const region = await screen.findByRole('region', { name: 'Tasks completed' })
  expect(within(region).getByRole('button', { name: '0 tasks' })).toBeTruthy()
  const { act } = await import('@testing-library/react')
  await act(async () => pending.resolve(dashboardFixture()))
  expect(within(region).queryByRole('button', { name: '2 tasks' })).toBeNull()
  expect(api.request).toHaveBeenCalledWith('dashboard', '30d', ['f2'])
  view.rerender(<Dashboard {...props} state={{ range: '30d' }} />)
  const byFactory = await screen.findByRole('region', { name: 'By Factory' })
  for (const column of ['Pull requests merged', 'Waiting in Backlog'])
    expect(within(byFactory).getByRole('columnheader', { name: column })).toBeTruthy()
})

test('load failures retry, events refresh completed metrics and clock/focus advance rolling boundaries', async () => {
  const { act, fireEvent } = await import('@testing-library/react')
  let fail = true
  let empty = true
  const api = bridge({
    dashboard: () => {
      if (fail) throw new Error('History unavailable')
      return dashboardFixture(empty)
    },
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    render(
      <Dashboard factories={[]} state={{ range: '7d' }} onChange={vi.fn()} onOpenTask={vi.fn()} />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('History unavailable')
    fail = false
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    const region = await screen.findByRole('region', { name: 'Tasks completed' })
    expect(within(region).getByRole('button', { name: '0 tasks' })).toBeTruthy()
    empty = false
    await act(async () => api.emit({ type: 'task-deleted', taskId: 't9' }))
    await within(region).findByRole('button', { name: '2 tasks' })
    empty = true
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    await within(region).findByRole('button', { name: '0 tasks' })
    empty = false
    await act(async () => fireEvent.focus(window))
    await within(region).findByRole('button', { name: '2 tasks' })
  } finally {
    vi.useRealTimers()
  }
})

test('unavailable completion history never assigns an unrecorded completion to the selected period', async () => {
  const data = dashboardFixture()
  data.unavailableIds = ['unknown']
  data.tasks.push({
    id: 'unknown',
    factoryId: 'nb',
    displayId: 'NB-3',
    title: 'Old Task',
    archived: true,
    doneAt: null,
    createdMs: null,
    backlogMs: null,
    intakeMs: null,
    merges: 0,
  })
  bridge({ dashboard: () => data })
  render(
    <Dashboard
      factories={[]}
      state={{ range: '7d', sample: { metric: 'unavailable', period: 'current' } }}
      onChange={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  )
  const dialog = await screen.findByRole('dialog')
  expect(
    within(dialog).getByRole('heading', { name: 'Unavailable completion history' }),
  ).toBeTruthy()
  expect(within(dialog).getByText(/Done timestamp unavailable/)).toBeTruthy()
  expect(within(dialog).queryByText(/end excluded/)).toBeNull()
})

test('Flow keeps its open-Task sample separate, shows distributions and opens exact clipped intervals', async () => {
  const data = dashboardFixture()
  data.flow.current.stages.push({
    stage: 'review',
    factoryIds: ['nb'],
    totalMs: 3_600_000,
    medianMs: 3_600_000,
    p25Ms: 3_600_000,
    p75Ms: 3_600_000,
    samples: [
      {
        taskId: 't2',
        elapsedMs: 3_600_000,
        intervals: [{ from: '2026-11-05T00:00:00.000Z', to: '2026-11-05T01:00:00.000Z' }],
      },
    ],
  })
  bridge({ dashboard: () => data })
  const open = vi.fn()
  const view = render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Stages' }))
  const region = await screen.findByRole('region', { name: 'Elapsed time by Stage' })
  const waits = () =>
    within(screen.getByRole('region', { name: 'Elapsed time by Stage' })).getByRole('checkbox', {
      name: 'Include time waiting for me',
    }) as HTMLInputElement
  expect(waits().checked).toBe(false)
  expect(within(region).getByText('9h')).toBeTruthy()
  expect(within(region).queryByText('14h')).toBeNull()
  expect(within(region).getByText('100%')).toBeTruthy()
  expect(within(region).getByText('Share')).toBeTruthy()
  expect(within(region).getByRole('button', { name: '0 Tasks' })).toBeTruthy()
  expect(screen.getByText(/without the time Tasks spent waiting for you/)).toBeTruthy()
  expect(region.textContent).toContain('Tasks without a complete record of those requests')
  await user().click(within(region).getByRole('button', { name: '2 Tasks' }))
  let sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('Without time waiting for you.')
  expect(sample.textContent).toContain('6h · 1 measured visit · 3h waiting for you left out')
  expect(sample.textContent).toContain('4.5h')
  expect(sample.textContent).toContain('3.75h – 5.25h')
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
  await user().click(within(region).getByRole('button', { name: '1 Task is left out' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('button', { name: /NB-2.*Improve search/ })).toBeTruthy()
  expect(sample.textContent).toContain('No record of requests to you for this Task.')
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
  await user().click(waits())
  expect(within(region).queryByRole('button', { name: /left out/ })).toBeNull()
  expect(within(region).getByRole('button', { name: '1 Task' })).toBeTruthy()
  expect(screen.getByText(/including time waiting for you and repeat visits/)).toBeTruthy()
  view.unmount()
  render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Stages' }))
  expect(waits().checked).toBe(true)
  const region2 = screen.getByRole('region', { name: 'Elapsed time by Stage' })
  expect(within(region2).getByText('14h')).toBeTruthy()
  const opener = within(region2).getByRole('button', { name: '2 Tasks' })
  await user().click(opener)
  sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('Includes time waiting for you.')
  expect(sample.textContent).toContain('9h · 1 measured visit')
  expect(sample.textContent).not.toContain('left out')
  expect(sample.textContent).toContain('7h')
  expect(sample.textContent).toContain('6h – 8h')
  expect(sample.textContent).toContain('Open at the as-of instant')
  const openTask = within(sample).getByRole('button', { name: /NB-3.*Open Task/ })
  expect(within(sample).queryByRole('button', { name: /Improve search/ })).toBeNull()
  await user().click(openTask)
  expect(open).toHaveBeenCalledWith('t3')
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
  expect(document.activeElement).toBe(opener)
  await user().click(screen.getByRole('button', { name: /1 Task has incomplete/ }))
  sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('First Intake timestamp is missing.')
})

test('Flow distinguishes counted transitions and unknown verification from completed first-pass results', async () => {
  bridge({ dashboard: () => dashboardFixture() })
  render(<DashboardView open={vi.fn()} />)
  await user().click(await screen.findByRole('tab', { name: 'Flow' }))
  const sendBack = await screen.findByRole('region', { name: 'Actual send-backs' })
  expect(within(sendBack).getByText('1 count toward limits · 1 do not')).toBeTruthy()
  await user().click(within(sendBack).getByRole('button', { name: 'Validate → Work' }))
  let sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('Does not count toward limit · Cause: base-conflict')
  expect(within(sample).getAllByRole('button', { name: /NB-3.*Open Task/ })).toHaveLength(2)
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
  const validate = screen.getByRole('region', { name: 'First-pass Validate' })
  expect(validate.textContent).toContain('1 of 1 recorded first visits passed')
  expect(validate.textContent).toContain('Accepted failures remain failures')
  const unknown = within(validate).getByRole('row', { name: 'Unknown verification 1 Tasks' })
  await user().click(within(unknown).getByRole('button', { name: '1 Tasks' }))
  sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('Visual verification or its applicability was not recorded.')
  expect(within(sample).getByRole('button', { name: /NB-2.*Improve search/ })).toBeTruthy()
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))

  const causes = screen.getByRole('region', { name: 'Why Tasks were sent back' })
  expect(causes.textContent).toContain(
    '1 send-back across 1 Task · Validate → Work is the most common',
  )
  expect(within(causes).queryByRole('button', { name: /Base conflict/ })).toBeNull()
  const [reviewSegment] = within(causes).getAllByRole('button', { name: 'Review Findings 1' })
  if (!reviewSegment) throw new Error('Missing review segment')
  await user().click(reviewSegment)
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading', { name: 'Sent back: Review Findings' })).toBeTruthy()
  expect(sample.textContent).toContain('Cause: Review Findings · Severity: P1')
  expect(within(sample).getAllByRole('button', { name: /NB-3.*Open Task/ })).toHaveLength(1)
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
  expect(within(causes).getByRole('row', { name: /Unfixed.*0/ })).toBeTruthy()
  await user().click(within(causes).getByRole('button', { name: /P1 Must fix/ }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading', { name: 'Send-backs · Severity: P1' })).toBeTruthy()
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))

  const failures = screen.getByRole('region', { name: 'Failures and how they ended' })
  expect(failures.textContent).toContain(
    '3 failure cases on 2 Tasks · 1 fixed · 1 accepted by you · 1 still open',
  )
  await user().click(within(failures).getByRole('button', { name: 'CI at Merge · Still open 1' }))
  sample = screen.getByRole('dialog')
  expect(
    within(sample).getByRole('heading', { name: 'Failure cases · CI at Merge · Still open' }),
  ).toBeTruthy()
  expect(within(sample).getAllByRole('button', { name: /NB-3.*Open Task/ })).toHaveLength(1)
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
  const accepted = screen.getByRole('region', { name: 'Failures you accepted' })
  expect(accepted.textContent).toContain('Out of scope for this Task')
  await user().click(
    within(accepted).getByRole('button', { name: /NB-3.*Reviewer or Task Lead Finding/ }),
  )
  sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('Your reason: Out of scope for this Task')
})

test('Flow shares the range selector, suppresses all-history comparisons and shows empty denominators as unavailable', async () => {
  const data = dashboardFixture(true)
  data.flow.previous = null
  const api = bridge({ dashboard: () => data })
  const change = vi.fn()
  render(
    <Dashboard
      factories={[]}
      state={{ range: 'all', panel: 'flow' }}
      onChange={change}
      onOpenTask={vi.fn()}
    />,
  )
  const validate = await screen.findByRole('region', { name: 'First-pass Validate' })
  expect(validate.textContent).toContain('Unavailable')
  expect(validate.textContent).toContain('0 of 0 recorded first visits passed')
  expect(screen.queryByText('Previous period · all Stage measures')).toBeNull()
  expect(screen.getByText(/No started Tasks in this period/)).toBeTruthy()
  expect(api.request).toHaveBeenCalledWith('dashboard', 'all', [])
  const select = screen.getByRole('combobox', { name: 'Historical period' })
  await user().selectOptions(select, '30d')
  expect(change).toHaveBeenCalledWith({ range: '30d', panel: 'flow' })
})

test('previous-period Flow samples retain their own period and restore focus after closing', async () => {
  const data = dashboardFixture()
  if (!data.flow.previous) throw new Error('Missing previous fixture period')
  data.flow.previous.stages = [
    {
      stage: 'work',
      factoryIds: ['nb'],
      totalMs: 3_600_000,
      medianMs: 3_600_000,
      p25Ms: 3_600_000,
      p75Ms: 3_600_000,
      samples: [
        {
          taskId: 't1',
          elapsedMs: 3_600_000,
          intervals: [{ from: '2026-10-26T00:00:00.000Z', to: '2026-10-26T01:00:00.000Z' }],
        },
      ],
    },
  ]
  localStorage.setItem('ted.dashboard.stage-waits', 'true')
  bridge({ dashboard: () => data })
  render(<DashboardView open={vi.fn()} />)
  await user().click(await screen.findByRole('tab', { name: 'Stages' }))
  const region = await screen.findByRole('region', { name: 'Elapsed time by Stage' })
  await user().click(within(region).getByRole('button', { name: 'Work' }))
  const current = screen.getByRole('dialog')
  await user().click(within(current).getByText('Comparison evidence'))
  const opener = within(current).getByRole('button', { name: 'Inspect previous-period Tasks' })
  await user().click(opener)
  const sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('Previous period')
  expect(sample.textContent).toContain('1h · 1 measured visit')
  await user().click(within(sample).getByRole('button', { name: 'Close Flow sample' }))
  expect(document.activeElement).toBe(within(region).getByRole('button', { name: 'Work' }))
})

test('three Dashboard tabs preserve Overview, share the period and close samples when switching', async () => {
  bridge({ dashboard: () => dashboardFixture() })
  render(<DashboardView open={vi.fn()} />)
  await screen.findByRole('region', { name: 'Tasks completed' })
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  expect(
    screen.queryByRole('region', { name: 'Observed working time and wait reasons' }),
  ).toBeNull()
  await user().click(screen.getByRole('tab', { name: 'Flow' }))
  expect(screen.queryByRole('region', { name: 'Tasks completed' })).toBeNull()
  expect(screen.getByText('See where Tasks spend time and what holds them up.')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Quick guide ↗' }))
  expect(screen.getByRole('dialog').textContent).toContain('Follow the time to the Task')
  await user().click(screen.getByRole('tab', { name: 'Stages' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  const select = screen.getByRole('combobox', { name: 'Historical period' })
  await user().selectOptions(select, '30d')
  expect(screen.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('true')
  screen.getByRole('tab', { name: 'Stages' }).focus()
  await user().keyboard('{ArrowRight}')
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  expect((select as HTMLSelectElement).value).toBe('30d')
})

test('reason drawers expose measured distributions, partial coverage, Check containment and previous samples', async () => {
  const data = dashboardFixture()
  const previous = data.flow.previous
  if (!previous) throw new Error('Missing previous fixture period')
  previous.reasons = structuredClone(data.flow.current.reasons)
  for (const r of previous.reasons) {
    r.totalMs *= 2
    if (r.medianMs !== null) r.medianMs *= 2
    if (r.p25Ms !== null) r.p25Ms *= 2
    if (r.p75Ms !== null) r.p75Ms *= 2
    for (const s of r.samples) if (s.elapsedMs !== null) s.elapsedMs *= 2
  }
  bridge({ dashboard: () => data })
  const open = vi.fn()
  render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Flow' }))
  const panel = screen.getByRole('region', { name: 'Observed working time and wait reasons' })
  expect(panel.textContent).toContain('durations and percentages cannot be added')
  await user().click(within(panel).getByText(/more wait reasons/))
  const request = within(panel).getByRole('button', { name: 'Open user requests' }).closest('li')
  if (!request) throw new Error('Missing reason row')
  expect(request.textContent).toContain('−50%')
  expect(request.querySelector('strong')?.textContent).toBe('5h')
  await user().click(within(panel).getByRole('button', { name: 'Test-lock waits' }))
  let dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('1.5h')
  expect(dialog.textContent).toContain('1.25h – 1.75h')
  expect(dialog.textContent).toContain('partial coverage')
  const details = within(dialog).getAllByText('Interval evidence')
  const firstDetail = details[0]
  if (!firstDetail) throw new Error('Missing interval disclosure')
  await user().click(firstDetail)
  expect(dialog.textContent).toContain('overlapping command time is also counted in Running Checks')
  expect(dialog.textContent).toContain('Invocation invocation-1: reported')
  await user().click(within(dialog).getByRole('button', { name: /NB-3.*Open Task/ }))
  expect(open).toHaveBeenCalledWith('t3')
  await user().click(within(dialog).getByText('Comparison evidence'))
  await user().click(within(dialog).getByRole('button', { name: 'Inspect previous-period Tasks' }))
  dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('Previous period')
})

test('detail totals distinguish unavailable prior and Stage history from measured zero', async () => {
  const data = dashboardFixture()
  const previous = data.flow.previous
  const source = data.flow.current.reasons.find((r) => r.reason === 'user-request')
  const unknown = previous?.reasons.find((r) => r.reason === 'user-request')
  const zero = previous?.reasons.find((r) => r.reason === 'run-slot')
  if (!source || !unknown || !zero) throw new Error('Missing reason fixture')
  unknown.samples = structuredClone(source.samples)
  for (const sample of unknown.samples) {
    sample.elapsedMs = null
    sample.coveredMs = null
    sample.coverage = 'unavailable'
    sample.intervals = []
  }
  zero.samples = structuredClone(source.samples)
  zero.medianMs = zero.p25Ms = zero.p75Ms = 0
  for (const sample of zero.samples) {
    sample.elapsedMs = 0
    sample.intervals = []
  }
  data.flow.current.stages = data.flow.current.stages.map((s) => ({
    ...s,
    totalMs: 0,
    medianMs: null,
    p25Ms: null,
    p75Ms: null,
    samples: [],
  }))
  bridge({ dashboard: () => data })
  render(<DashboardView open={vi.fn()} />)
  await user().click(await screen.findByRole('tab', { name: 'Flow' }))
  const panel = screen.getByRole('region', { name: 'Observed working time and wait reasons' })
  await user().click(within(panel).getByText(/more wait reasons/))
  await user().click(within(panel).getByRole('button', { name: 'Open user requests' }))
  let dialog = screen.getByRole('dialog')
  await user().click(within(dialog).getByText('Comparison evidence'))
  expect(dialog.textContent).toContain('Previous total: Unavailable')
  expect(dialog.textContent).toContain('0 measured of 2 Tasks · 2 unavailable')
  await user().click(within(dialog).getByRole('button', { name: 'Close Flow sample' }))
  await user().click(within(panel).getByRole('button', { name: 'Run-slot waits' }))
  dialog = screen.getByRole('dialog')
  await user().click(within(dialog).getByText('Comparison evidence'))
  expect(dialog.textContent).toContain('Previous total: 0h')
  await user().click(within(dialog).getByRole('button', { name: 'Close Flow sample' }))
  await user().click(screen.getByRole('tab', { name: 'Stages' }))
  expect(screen.getByText(/Total and distribution unavailable/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: /^Work$/ }))
  dialog = screen.getByRole('dialog')
  expect(
    within(dialog).getByText('Total Task-hours').parentElement?.querySelector('strong')
      ?.textContent,
  ).toBe('Unavailable')
  await user().click(within(dialog).getByText('Comparison evidence'))
  expect(dialog.textContent).toContain('Previous total: Unavailable')
})

test('Flow discloses unknown-boundary Tasks in mixed and unknown-only periods', async () => {
  let data = dashboardFixture()
  const missing = data.flow.current.incomplete
  const records = data.flow.tasks.filter((t) => t.id === 't2')
  if (data.flow.previous) data.flow.previous.incomplete = missing
  bridge({ dashboard: () => data })
  const open = vi.fn()
  render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Flow' }))
  expect(screen.getByText(/2 Tasks with a recorded Intake boundary/)).toBeTruthy()
  expect(screen.getByText(/Reason coverage counts apply only/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: /^1 Task has incomplete timing history$/ }))
  let dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('First Intake timestamp is missing.')
  await user().click(within(dialog).getByRole('button', { name: /NB-2.*Improve search/ }))
  expect(open).toHaveBeenCalledWith('t2')
  await user().click(within(dialog).getByRole('button', { name: 'Close Flow sample' }))
  await user().click(screen.getByText('Coverage and recording gaps'))
  await user().click(
    screen.getByRole('button', { name: /Previous period · 1 Task has incomplete timing history/ }),
  )
  dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('Previous period')
  expect(dialog.textContent).toContain('First Intake timestamp is missing.')
  await user().click(within(dialog).getByRole('button', { name: 'Close Flow sample' }))
  data = dashboardFixture(true)
  data.flow.current.incomplete = missing
  data.flow.tasks = records
  await user().selectOptions(screen.getByRole('combobox', { name: 'Historical period' }), '30d')
  expect(
    await screen.findByText(/Incomplete history may hide started Tasks and delays/),
  ).toBeTruthy()
  expect(screen.queryByText(/No started Tasks in this period/)).toBeNull()
  await user().click(screen.getByRole('button', { name: /^1 Task has incomplete timing history$/ }))
  dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('First Intake timestamp is missing.')
  expect(within(dialog).getByRole('button', { name: /NB-2.*Improve search/ })).toBeTruthy()
})

test('percentage changes preserve sign/color and zero/missing baselines without inventing comparisons', async () => {
  const { TimingChange } = await import('../src/renderer/views/DashboardMeasures.tsx')
  const view = render(<TimingChange current={3_600_000} previous={7_200_000} />)
  let badge = screen.getByText('−50%')
  expect(badge.parentElement?.className).toContain('good')
  view.rerender(<TimingChange current={7_200_000} previous={3_600_000} />)
  badge = screen.getByText('+100%')
  expect(badge.parentElement?.className).toContain('bad')
  view.rerender(<TimingChange current={7_200_000} previous={3_600_000} neutral />)
  expect(screen.getByText('+100%').parentElement?.className).not.toContain('bad')
  view.rerender(<TimingChange current={1} previous={0} />)
  expect(screen.getByText('No baseline')).toBeTruthy()
  view.rerender(<TimingChange current={1} previous={null} />)
  expect(screen.getByText('Unavailable')).toBeTruthy()
})

test('Today draws hours against all of yesterday and compares with yesterday to this time', async () => {
  const data = dashboardFixture()
  const at = (day: number, hours: number, minutes = 0) =>
    new Date(2026, 10, day, hours, minutes).toISOString()
  const hours = (day: number, count: number, end: string) =>
    Array.from({ length: count }, (_, index) => ({
      from: at(day, index),
      to: index === count - 1 ? end : at(day, index + 1),
      taskIds: index === 1 ? ['t1'] : [],
      merged: { count: 0, taskIds: [] },
      created: { value: null, taskIds: [], missingIds: [] },
      backlog: { value: null, taskIds: [], missingIds: [] },
      intake: { value: null, taskIds: [], missingIds: [] },
    }))
  data.range = 'today'
  data.asOf = at(12, 2, 30)
  data.current = { ...data.current, from: at(12, 0), to: data.asOf }
  data.current.buckets = hours(12, 3, data.asOf)
  if (!data.previous || !data.comparison) throw new Error('The fixture has no previous period')
  data.previous = { ...data.previous, from: at(11, 0), to: at(11, 2, 30), taskIds: ['t1'] }
  data.previous.buckets = hours(11, 24, at(12, 0))
  data.comparison.completed = { absolute: 1, percent: 100 }
  const api = bridge({ dashboard: () => data })
  const change = vi.fn()
  render(
    <Dashboard factories={[]} state={{ range: 'today' }} onChange={change} onOpenTask={vi.fn()} />,
  )
  const completed = await screen.findByRole('region', { name: 'Tasks completed' })
  expect(api.request).toHaveBeenCalledWith('dashboard', 'today', [])
  expect(completed.textContent).toContain('vs yesterday to this time')
  expect(completed.textContent).toContain('Yesterday · aligned by hour')
  expect(completed.textContent).toContain('Now')
  expect(completed.querySelectorAll('tbody tr')).toHaveLength(24)
  expect(within(completed).getAllByText('Not reached yet today')).toHaveLength(21)
  const select = screen.getByRole('combobox', { name: 'Historical period' })
  expect(within(select).getByRole('option', { name: 'Today' })).toBeTruthy()
  await user().selectOptions(select, '7d')
  expect(change).toHaveBeenCalledWith({ range: '7d' })
})

test('a Stage share is a whole-number percentage of all Stage time', async () => {
  const { share } = await import('../src/renderer/views/DashboardMeasures.tsx')
  expect(share(489.75, 1387.34)).toBe('35%')
  expect(share(3, 1000)).toBe('<1%')
  expect(share(0, 1000)).toBe('0%')
  expect(share(null, 1000)).toBe('—')
  expect(share(0, 0)).toBe('—')
})

test('a graph point’s tooltip compares it with the aligned previous point', async () => {
  const { pointTip } = await import('../src/renderer/views/Dashboard.tsx')
  const bucket = (from: string, ids: string[], median: number | null) => ({
    from,
    to: from,
    taskIds: ids,
    merged: { count: 0, taskIds: [] },
    created: { value: median, taskIds: median === null ? [] : ids, missingIds: [] },
    backlog: { value: null, taskIds: [], missingIds: [] },
    intake: { value: null, taskIds: [], missingIds: [] },
  })
  const now = bucket('now', ['a', 'b', 'c', 'd'], 3_600_000)
  const then = bucket('then', ['a'], 5_400_000)
  const label = (b: { from: string }) => b.from
  expect(
    pointTip({
      metric: 'completed',
      period: 'current',
      bucket: now,
      other: then,
      label,
      today: false,
    }),
  ).toEqual({
    heading: 'now',
    aligned: null,
    rows: [
      { period: 'current', label: 'Completed', value: '4 Tasks' },
      { period: 'previous', label: 'Previous · then', value: '1' },
    ],
    change: '+3 vs previous (+300%)',
  })
  expect(
    pointTip({
      metric: 'created',
      period: 'current',
      bucket: now,
      other: then,
      label,
      today: true,
    }),
  ).toMatchObject({
    rows: [
      { label: 'Median', value: '1h', note: 'from 4 Tasks' },
      { label: 'Yesterday · then', value: '1h 30m' },
    ],
    change: '−30m vs yesterday',
  })
  expect(
    pointTip({
      metric: 'created',
      period: 'current',
      bucket: now,
      other: bucket('then', [], null),
      label,
      today: false,
    }),
  ).toMatchObject({ change: 'No previous sample' })
  expect(
    pointTip({
      metric: 'completed',
      period: 'current',
      bucket: then,
      other: undefined,
      label,
      today: false,
    }),
  ).toMatchObject({ rows: [{ value: '1 Task' }], change: null })
  expect(
    pointTip({
      metric: 'completed',
      period: 'previous',
      bucket: then,
      other: now,
      label,
      today: false,
    }),
  ).toMatchObject({ heading: 'Previous · then', aligned: 'Aligned to now', change: null })
})

test('the completed chart’s scale and Factory split', async () => {
  const { byFactoryCount, countScale } = await import('../src/renderer/views/Dashboard.tsx')
  expect(countScale(1)).toEqual([0, 1])
  expect(countScale(7)).toEqual([0, 2, 4, 6, 8])
  expect(countScale(13)).toEqual([0, 4, 8, 12, 16])
  const tasks = [
    { id: 'a', factoryId: 'one' },
    { id: 'b', factoryId: 'two' },
    { id: 'c', factoryId: 'two' },
  ]
  expect(byFactoryCount(['a', 'b', 'c'], tasks, ['two', 'one', 'three'])).toEqual([
    { factoryId: 'two', count: 2 },
    { factoryId: 'one', count: 1 },
  ])
})
