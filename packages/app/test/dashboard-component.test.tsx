// @vitest-environment jsdom

import type { FactoryLayout } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { noStageParts } from '@ted/protocol/stage-parts'
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

function DashboardView({
  open,
  factories = [],
  layout,
}: {
  open: (id: string) => void
  factories?: ReturnType<typeof factory>[]
  layout?: FactoryLayout
}) {
  const [state, setState] = useState<DashboardViewState>({ range: '7d' })
  return (
    <Dashboard
      factories={factories}
      {...(layout && { layout })}
      state={state}
      onChange={setState}
      onOpenTask={open}
    />
  )
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
  localStorage.setItem('ted.dashboard', JSON.stringify({ range: '7d', panel: 'flow' }))
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  const completed = await screen.findByRole('region', { name: 'Tasks completed' })
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
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
  await u.click(within(stageTime).getByRole('button', { name: 'All 2 Tasks' }))
  sample = screen.getByRole('dialog')
  first = within(sample).getByRole('button', { name: /NB-1.*Fix login/ })
  const openStageTask = within(sample).getByRole('button', { name: /NB-3.*Open Task/ })
  first.focus()
  await u.keyboard('k')
  expect(document.activeElement).toBe(openStageTask)
  await u.keyboard('j')
  expect(document.activeElement).toBe(first)
  await u.keyboard('{Enter}')
  await u.click(await screen.findByRole('button', { name: '← Dashboard' }))
  sample = await screen.findByRole('dialog')
  expect(within(sample).getByRole('heading', { name: 'Work · Per-Task elapsed time' })).toBeTruthy()
  expect(within(sample).getByRole('button', { name: /NB-3.*Open Task/ })).toBeTruthy()
  await u.click(within(sample).getByRole('button', { name: 'Close Stage sample' }))
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
  await close()

  const waits = screen.getByRole('region', { name: 'Waiting on you' })
  expect(waits.textContent).toContain('-25%')
  expect(waits.textContent).toContain('previous: 40h')
  expect(waits.textContent).toContain('median answer time · 3 requests')
  const stageRows = within(waits).getAllByRole('button', { name: /^Waiting on you in/ })
  expect(stageRows.map((row) => row.getAttribute('aria-label'))).toEqual([
    'Waiting on you in Review 24h',
    'Waiting on you in Clarify 6h',
  ])
  expect(stageRows[1]?.textContent).toContain('Clarify round, Question')
  await user().click(within(waits).getByRole('button', { name: 'Waiting on you 30h' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe('Waiting on you · Selected period')
  expect(
    within(sample)
      .getAllByRole('button', { name: /NB-/ })
      .map((row) => row.textContent?.slice(0, 4)),
  ).toEqual(['NB-1', 'NB-2'])
  expect(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }).textContent).toContain(
    'Waited 1d 2h · Review Sign-Off, Question',
  )
  await close()
  await user().click(within(waits).getByRole('button', { name: 'Median answer time 6h' }))
  expect(within(screen.getByRole('dialog')).getAllByRole('button', { name: /NB-/ })).toHaveLength(2)
  await close()
  await user().click(stageRows[1] as HTMLElement)
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe('Waiting on you · In Clarify')
  expect(
    within(sample).getByRole('button', { name: /NB-2.*Improve search/ }).textContent,
  ).toContain('Waited 4h · Clarify round')
  expect(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }).textContent).toContain(
    'Waited 2h · Question',
  )
  await close()
  const longest = screen.getByRole('region', { name: 'Longest waits on you' })
  const longestRows = within(longest).getAllByRole('button')
  expect(longestRows.map((row) => row.textContent)).toEqual([
    'NB-1 Review Sign-Off1d',
    'NB-2 Clarify round4h',
    'NB-1 Question2h',
  ])
  expect(longest.textContent).toContain('Snoozed time counts as waiting.')
  await user().click(longestRows[0] as HTMLElement)
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe(
    'Waiting on you · Review Sign-Off in Review',
  )
  expect(within(sample).getAllByRole('button', { name: /NB-/ })).toHaveLength(1)
  await user().click(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }))
  expect(open).toHaveBeenCalledWith('t1')
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
  for (const column of [
    'Pull requests merged',
    'Waiting in Backlog',
    'Waiting on you',
    'Cost per pull request',
  ])
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

test('Stages keeps its open-Task sample separate, shows distributions and opens exact clipped intervals', async () => {
  const data = dashboardFixture()
  data.flow.current.stages.push({
    stage: 'review',
    factoryIds: ['nb'],
    totalMs: 3_600_000,
    medianMs: 3_600_000,
    p25Ms: 3_600_000,
    p75Ms: 3_600_000,
    parts: { ...noStageParts(), blocked: 3_600_000 },
    samples: [
      {
        taskId: 't2',
        elapsedMs: 3_600_000,
        intervals: [{ from: '2026-11-05T00:00:00.000Z', to: '2026-11-05T01:00:00.000Z' }],
        parts: { ...noStageParts(), blocked: 3_600_000 },
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
  expect(within(region).getByRole('button', { name: '0 of 2 Tasks' })).toBeTruthy()
  expect(screen.getByText(/without the time Tasks spent waiting for you/)).toBeTruthy()
  expect(region.textContent).toContain('Tasks without a complete record of those requests')
  await user().click(within(region).getByRole('button', { name: 'All 2 Tasks' }))
  let sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('Without time waiting for you.')
  expect(sample.textContent).toContain('6h · 1 measured visit · 3h waiting for you left out')
  expect(sample.textContent).toContain('4.5h')
  expect(sample.textContent).toContain('3.75h – 5.25h')
  await user().click(within(sample).getByRole('button', { name: 'Close Stage sample' }))
  await user().click(within(region).getByRole('button', { name: '1 Task is left out' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('button', { name: /NB-2.*Improve search/ })).toBeTruthy()
  expect(sample.textContent).toContain('No record of requests to you for this Task.')
  await user().click(within(sample).getByRole('button', { name: 'Close Stage sample' }))
  await user().click(waits())
  expect(within(region).queryByRole('button', { name: /left out/ })).toBeNull()
  expect(within(region).getByRole('button', { name: '1 of 2 Tasks' })).toBeTruthy()
  expect(screen.getByText(/including time waiting for you and repeat visits/)).toBeTruthy()
  view.unmount()
  render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Stages' }))
  expect(waits().checked).toBe(true)
  const region2 = screen.getByRole('region', { name: 'Elapsed time by Stage' })
  expect(within(region2).getByText('14h')).toBeTruthy()
  const opener = within(region2).getByRole('button', { name: 'All 2 Tasks' })
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
  await user().click(within(sample).getByRole('button', { name: 'Close Stage sample' }))
  expect(document.activeElement).toBe(opener)
  const row = (name: string) =>
    within(region2).getByRole('button', { name }).closest('li') as HTMLElement
  expect(within(row('Work')).getByText('Most time')).toBeTruthy()
  expect(within(row('Review')).queryByText('Most time')).toBeNull()
  expect(within(region2).getByText('Blocked or paused')).toBeTruthy()
  expect(within(region2).getByTestId('stage-bar-work').style.width).toBe('100%')
  expect(
    Number.parseFloat(within(region2).getByTestId('stage-bar-review').style.width),
  ).toBeCloseTo(100 / 14)
  const shares = within(region2).getByRole('button', { name: 'Share of each Stage' })
  await user().click(shares)
  expect(shares.getAttribute('aria-pressed')).toBe('true')
  expect(within(region2).getByTestId('stage-bar-review').style.width).toBe('100%')
  const working = within(region2).getByRole('button', { name: 'Work · Agent working: 5h' })
  expect(working.getAttribute('title')).toBe('Work · Agent working: 5h')
  await user().click(working)
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading', { name: 'Work · Agent working' })).toBeTruthy()
  expect(sample.textContent).toContain('Agent working: 5h of this Stage’s 14h.')
  expect(
    within(sample)
      .getAllByRole('button', { name: /Open history/ })
      .map((b) => b.textContent?.slice(0, 4)),
  ).toEqual(['NB-3', 'NB-1'])
  expect(sample.textContent).toContain('Agent working: 3h of 9h')
  await user().click(within(sample).getByRole('button', { name: 'Close Stage sample' }))
  await user().click(screen.getByRole('button', { name: /1 Task has incomplete/ }))
  sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('First Intake timestamp is missing.')
})

test('Stages shares the range selector and shows an empty period as unavailable', async () => {
  const data = dashboardFixture(true)
  data.flow.previous = null
  const api = bridge({ dashboard: () => data })
  const change = vi.fn()
  render(
    <Dashboard
      factories={[]}
      state={{ range: 'all', panel: 'stages' }}
      onChange={change}
      onOpenTask={vi.fn()}
    />,
  )
  const region = await screen.findByRole('region', { name: 'Elapsed time by Stage' })
  expect(region.textContent).toContain('Total and distribution unavailable')
  expect(within(region).queryByText('vs previous')).toBeNull()
  expect(api.request).toHaveBeenCalledWith('dashboard', 'all', [])
  const select = screen.getByRole('combobox', { name: 'Historical period' })
  await user().selectOptions(select, '30d')
  expect(change).toHaveBeenCalledWith({ range: '30d', panel: 'stages' })
})

test('previous-period Stage samples retain their own period and restore focus after closing', async () => {
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
      parts: { ...noStageParts(), other: 3_600_000 },
      samples: [
        {
          taskId: 't1',
          elapsedMs: 3_600_000,
          intervals: [{ from: '2026-10-26T00:00:00.000Z', to: '2026-10-26T01:00:00.000Z' }],
          parts: { ...noStageParts(), other: 3_600_000 },
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
  await user().click(within(sample).getByRole('button', { name: 'Close Stage sample' }))
  expect(document.activeElement).toBe(within(region).getByRole('button', { name: 'Work' }))
})

test('the Dashboard Filter picks one Factory or a group from all, toggles after and clears', async () => {
  bridge({ dashboard: () => dashboardFixture() })
  const factories = [
    factory({ id: 'f1', name: 'Widgets' }),
    factory({ id: 'f2', name: 'Site' }),
    factory({ id: 'f3', name: 'Docs' }),
  ]
  const layout: FactoryLayout = {
    items: [
      { group: { id: 'g1', name: 'Clients', factoryIds: ['f1', 'f2'] } },
      { factoryId: 'f3' },
    ],
  }
  render(<DashboardView open={vi.fn()} factories={factories} layout={layout} />)
  const u = user()
  const title = () => screen.getByRole('heading', { level: 1 }).textContent
  const item = (name: string) =>
    screen.getByRole('menuitemcheckbox', { name: new RegExp(`${name}$`) })
  const checked = (name: string) => item(name).getAttribute('aria-checked')
  await u.click(screen.getByRole('button', { name: 'Filter' }))
  expect(screen.queryByRole('menuitem', { name: 'Clear filter' })).toBeNull()
  await u.click(item('Site'))
  expect(title()).toBe('Site › Dashboard')
  expect(checked('Clients')).toBe('false')
  await u.click(item('Clients'))
  expect(title()).toBe('Widgets, Site › Dashboard')
  expect(checked('Clients')).toBe('true')
  await u.click(item('Docs'))
  expect(title()).toBe('All Factories › Dashboard')
  await u.click(item('Clients'))
  expect(title()).toBe('Widgets, Site › Dashboard')
  await u.click(item('Clients'))
  expect(title()).toBe('All Factories › Dashboard')
  await u.click(item('Docs'))
  expect(title()).toBe('Docs › Dashboard')
  await u.click(screen.getByRole('menuitem', { name: 'Clear filter' }))
  expect(title()).toBe('All Factories › Dashboard')
  expect(checked('All Factories')).toBe('true')
})

test('three Dashboard tabs preserve Overview, share the period and close samples when switching', async () => {
  bridge({ dashboard: () => dashboardFixture() })
  render(<DashboardView open={vi.fn()} />)
  await screen.findByRole('region', { name: 'Tasks completed' })
  expect(screen.getAllByRole('tab').map((tab) => tab.id)).toEqual([
    'dashboard-overview',
    'dashboard-stages',
    'dashboard-cost',
  ])
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  await user().click(screen.getByRole('tab', { name: 'Stages' }))
  expect(screen.queryByRole('region', { name: 'Tasks completed' })).toBeNull()
  await user().click(screen.getByRole('button', { name: /^Work$/ }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  await user().click(screen.getByRole('tab', { name: 'Overview' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await user().click(screen.getByRole('tab', { name: 'Stages' }))
  const select = screen.getByRole('combobox', { name: 'Historical period' })
  await user().selectOptions(select, '30d')
  expect(screen.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('true')
  screen.getByRole('tab', { name: 'Stages' }).focus()
  await user().keyboard('{ArrowRight}')
  expect(screen.getByRole('tab', { name: 'Cost' }).getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Cost' }))
  await user().keyboard('{ArrowRight}')
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  expect((select as HTMLSelectElement).value).toBe('30d')
})

test('Stage detail totals show unavailable history as Unavailable', async () => {
  const data = dashboardFixture()
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
  await user().click(await screen.findByRole('tab', { name: 'Stages' }))
  expect(screen.getByText(/Total and distribution unavailable/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: /^Work$/ }))
  const dialog = screen.getByRole('dialog')
  expect(
    within(dialog).getByText('Total Task-hours').parentElement?.querySelector('strong')
      ?.textContent,
  ).toBe('Unavailable')
  await user().click(within(dialog).getByText('Comparison evidence'))
  expect(dialog.textContent).toContain('Previous total: Unavailable')
})

test('Stages discloses unknown-boundary Tasks in mixed and unknown-only periods', async () => {
  let data = dashboardFixture()
  const missing = data.flow.current.incomplete
  const records = data.flow.tasks.filter((t) => t.id === 't2')
  bridge({ dashboard: () => data })
  const open = vi.fn()
  render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Stages' }))
  expect(screen.getByText(/2 Tasks with a recorded Intake boundary/)).toBeTruthy()
  expect(screen.getByText(/Reason coverage counts apply only/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: /^1 Task has incomplete timing history$/ }))
  let dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('First Intake timestamp is missing.')
  await user().click(within(dialog).getByRole('button', { name: /NB-2.*Improve search/ }))
  expect(open).toHaveBeenCalledWith('t2')
  await user().click(within(dialog).getByRole('button', { name: 'Close Stage sample' }))
  data = dashboardFixture(true)
  data.flow.current.incomplete = missing
  data.flow.tasks = records
  await user().selectOptions(screen.getByRole('combobox', { name: 'Historical period' }), '30d')
  expect(await screen.findByText(/Total and distribution unavailable/)).toBeTruthy()
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
  view.rerender(<TimingChange current={1} previous={0} />)
  expect(screen.getByText('No baseline')).toBeTruthy()
  view.rerender(<TimingChange current={1} previous={null} />)
  expect(screen.getByText('Unavailable')).toBeTruthy()
  view.rerender(
    <TimingChange current={3_600_000} previous={7_200_000} versus="vs last month to this day" />,
  )
  expect(screen.getByText('−50%').parentElement?.title).toContain(
    'Selected: 1h; vs last month to this day: 2h.',
  )
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
  const view = render(
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
  expect(
    within(select)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual([
    'Today',
    'Last 7 days',
    'Last 30 days',
    'Last 90 days',
    'Last 12 months',
    'This week',
    'This month',
    'Year to date',
    'All time',
  ])
  await user().selectOptions(select, '7d')
  expect(change).toHaveBeenCalledWith({ range: '7d' })
  view.rerender(
    <Dashboard
      factories={[]}
      state={{ range: 'today', panel: 'stages' }}
      onChange={change}
      onOpenTask={vi.fn()}
    />,
  )
  const stages = await screen.findByRole('region', { name: 'Elapsed time by Stage' })
  expect(within(stages).getByText('vs yesterday')).toBeTruthy()
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
      range: '7d',
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
      range: 'today',
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
      range: '7d',
    }),
  ).toMatchObject({ change: 'No previous sample' })
  expect(
    pointTip({
      metric: 'completed',
      period: 'current',
      bucket: then,
      other: undefined,
      label,
      range: '7d',
    }),
  ).toMatchObject({ rows: [{ value: '1 Task' }], change: null })
  expect(
    pointTip({
      metric: 'completed',
      period: 'previous',
      bucket: then,
      other: now,
      label,
      range: '7d',
    }),
  ).toMatchObject({ heading: 'Previous · then', aligned: 'Aligned to now', change: null })
  expect(
    pointTip({
      metric: 'completed',
      period: 'current',
      bucket: now,
      other: then,
      label,
      range: 'month',
    }),
  ).toMatchObject({
    rows: [{ value: '4 Tasks' }, { label: 'Last month · then', value: '1' }],
    change: '+3 vs last month (+300%)',
  })
})

test('the completed chart’s scale and Factory split', async () => {
  const { byFactoryCount, countScale } = await import('../src/renderer/views/Dashboard.tsx')
  const { moneyScale } = await import('../src/renderer/views/DashboardCost.tsx')
  expect(moneyScale(0)).toEqual([0, 1])
  expect(moneyScale(0.3)).toEqual([0, 0.1, 0.2, 0.3])
  expect(moneyScale(12)).toEqual([0, 5, 10, 15])
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

test('the Cost tab shows cost per merged pull request, spend by kind of work and by model, and opens what is behind each figure', async () => {
  bridge({ dashboard: () => dashboardFixture() })
  const open = vi.fn()
  render(<DashboardView open={open} />)
  await screen.findByRole('region', { name: 'Tasks completed' })
  await user().click(screen.getByRole('tab', { name: 'Cost' }))
  expect(screen.getByRole('heading', { name: 'API-equivalent cost' })).toBeTruthy()
  expect(
    screen.getByText(/whatever your billing\. Runs still going aren’t counted yet\./),
  ).toBeTruthy()
  expect(screen.getByText(/1 Run in this period has no known price/)).toBeTruthy()
  const close = () =>
    user().click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close sample' }))

  const perPr = screen.getByRole('region', { name: 'Cost per merged pull request' })
  expect(within(perPr).getByText('−20%')).toBeTruthy()
  expect(within(perPr).getByText(/Middle half \$3\.50 – \$4\.00 · 3 pull requests/)).toBeTruthy()
  const spend = screen.getByRole('region', { name: 'Spend in this period' })
  expect(within(spend).getByText('+20%')).toBeTruthy()
  expect(within(spend).getByText(/^92% went to Task work/)).toBeTruthy()
  const tokens = screen.getByRole('region', { name: 'Tokens' })
  expect(within(tokens).getByRole('button').textContent).toBe('1.5M in · 40K out')
  expect(within(tokens).getByText('across 5 Runs')).toBeTruthy()

  const chart = screen.getByRole('region', { name: 'Spend over time' })
  expect(within(chart).getByText('Task Leads $9.00')).toBeTruthy()
  expect(within(chart).getByText('Coordinator $1.00')).toBeTruthy()
  await user().click(within(chart).getByRole('button', { name: 'By agent and model' }))
  expect(within(chart).getByText('Claude · opus $9.00')).toBeTruthy()
  expect(within(chart).getByText('Codex · gpt-5.5 $3.00')).toBeTruthy()
  await user().click(
    within(chart).getAllByRole('button', { name: /· \$12\.00$/ })[0] as HTMLElement,
  )
  expect(
    within(screen.getByRole('dialog')).getByRole('button', { name: /NB-1.*Fix login/ }),
  ).toBeTruthy()
  await close()

  await user().click(within(spend).getByRole('button', { name: 'Spend in this period $12.00' }))
  let sample = screen.getByRole('dialog')
  const items = within(sample)
    .getAllByRole('listitem')
    .map((item) => item.textContent)
  expect(items).toHaveLength(3)
  expect(items[0]).toMatch(/NB-1.*Fix login.*\$8\.00 · 3 Runs · 1 send-back/)
  expect(items[1]).toMatch(/NB-2.*Improve search.*\$3\.00/)
  expect(items[2]).toBe('Coordinator$1.00 not tied to a Task')
  expect(within(sample).getByText(/^\$12\.00 API-equivalent cost\./)).toBeTruthy()
  await close()
  await user().click(within(spend).getByRole('button', { name: 'Coordinator $1.00' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe('Coordinator · Selected period')
  expect(within(sample).queryAllByRole('button', { name: /NB-/ })).toHaveLength(0)
  await close()

  const expensive = screen.getByRole('region', { name: 'Most expensive pull requests' })
  const [, first] = within(expensive).getAllByRole('row')
  expect(
    within(first as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['3', '1', '$4.00'])
  expect(first?.textContent).toContain('$8.00 over 2 pull requests')
  await user().click(within(expensive).getByRole('button', { name: 'NB-1 Fix login' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe(
    'Cost per merged pull request · NB-1',
  )
  await user().click(within(sample).getByRole('button', { name: /NB-1.*\$4\.00 per pull request/ }))
  expect(open).toHaveBeenCalledWith('t1')

  const byFactory = screen.getByRole('region', { name: 'Spend by Factory' })
  const [, nb] = within(byFactory).getAllByRole('row')
  expect(nb?.textContent).toContain('$12.00')
  expect(nb?.textContent).toContain('$4.00')
  expect(byFactory.textContent).toContain('Codex cost comes from TED’s own price table')
})

test('every By Factory table figure opens the Tasks behind it for that Factory', async () => {
  const data = dashboardFixture()
  data.current.byFactory.push({
    factoryId: 'gar',
    taskIds: ['t2'],
    merged: { count: 2, taskIds: ['t2'] },
    created: { value: null, taskIds: [], missingIds: [] },
    backlog: { value: null, taskIds: [], missingIds: [] },
    intake: { value: null, taskIds: [], missingIds: [] },
  })
  data.cost.current.byFactory.push({
    factoryId: 'gar',
    cost: 0,
    runs: 1,
    kinds: [],
    tasks: [{ taskId: 't2', cost: 0 }],
    perPullRequest: { median: null, p25: null, p75: null, pullRequests: 0, samples: [] },
  })
  bridge({
    dashboard: () => data,
    getSettings: () => ({
      ...defaultMachineSettings,
      billing: { claude: 'api-key', codex: 'api-key', antigravity: 'api-key' },
    }),
  })
  const factories = [factory({ id: 'nb', name: 'Nabla' }), factory({ id: 'gar', name: 'Garden' })]
  render(<DashboardView open={vi.fn()} factories={factories} />)
  const close = (name = 'Close sample') =>
    user().click(within(screen.getByRole('dialog')).getByRole('button', { name }))
  const row = (region: HTMLElement, name: string) =>
    within(region).getByRole('row', { name: new RegExp(`^${name}`) })

  const overview = await screen.findByRole('region', { name: 'By Factory' })
  await user().click(within(row(overview, 'Garden')).getByRole('button', { name: '2' }))
  let sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe(
    'Pull requests merged · Selected period · Garden',
  )
  expect(
    within(sample)
      .getAllByRole('button', { name: /NB-/ })
      .map((b) => b.textContent),
  ).toEqual([expect.stringMatching(/NB-2.*Improve search/)])
  await close()
  await user().click(within(row(overview, 'Nabla')).getByRole('button', { name: '$4.00' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe(
    'Cost per merged pull request · Nabla',
  )
  await close()

  await user().click(screen.getByRole('tab', { name: 'Cost' }))
  expect(await screen.findByRole('heading', { name: 'Cost' })).toBeTruthy()
  expect(
    screen.getByText('What these Runs cost on your API keys. Runs still going aren’t counted yet.'),
  ).toBeTruthy()
  await user().click(
    within(screen.getByRole('region', { name: 'Spend in this period' })).getByRole('button', {
      name: 'Spend in this period $12.00',
    }),
  )
  expect(await within(screen.getByRole('dialog')).findByText(/^\$12\.00 cost\./)).toBeTruthy()
  await close()
  const cost = screen.getByRole('region', { name: 'Spend by Factory' })
  await user().click(within(row(cost, 'Nabla')).getByRole('button', { name: '$4.00' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toBe(
    'Cost per merged pull request · Nabla',
  )
  expect(
    within(sample).getByRole('button', { name: /NB-1.*\$4\.00 per pull request/ }),
  ).toBeTruthy()
  await close()
  await user().click(within(row(cost, 'Garden')).getByRole('button', { name: '$0.00' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('heading').textContent).toContain('Garden')
  expect(within(sample).getByRole('button', { name: /NB-2/ })).toBeTruthy()
  await close()
})
