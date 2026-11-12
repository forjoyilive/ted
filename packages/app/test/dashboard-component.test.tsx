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
import { task } from './support/fixtures.ts'

function DashboardView({ open }: { open: (id: string) => void }) {
  const [state, setState] = useState<DashboardViewState>({ range: '7d' })
  return (
    <Dashboard factoryId="f1" title="Widgets" state={state} onChange={setState} onOpenTask={open} />
  )
}

test('the shared App shortcuts navigate only the top sample dialog and preserve Task return', async () => {
  const a = appState()
  a.handle('factoryDashboard', () => dashboardFixture())
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

test.each([
  ['2026-11-08T12:00:45.500Z', '12:00:45.500 UTC'],
  ['2026-11-08T12:00:45.000Z', '12:00:45 UTC'],
])('bucket controls and sample bounds preserve exact time for %s', async (at, end) => {
  const preferences = timePreferences()
  setTimePreferences({ timeZone: 'UTC', timeFormat: '24-hour' })
  try {
    const data = dashboardFixture()
    data.asOf = at
    data.current.to = at
    data.current.buckets = data.current.buckets.map((bucket) => ({
      ...bucket,
      from: '2026-11-01T12:00:30.125Z',
      to: at,
    }))
    bridge({ factoryDashboard: () => data })
    render(<DashboardView open={vi.fn()} />)
    const completed = await screen.findByRole('region', { name: 'Tasks completed' })
    const point = within(completed).getByRole('button', { name: /^Selected.*2 tasks/ })
    expect(point.getAttribute('aria-label')).toContain('12:00:30.125 UTC')
    expect(point.getAttribute('aria-label')).toContain(end)
    expect(point.getAttribute('title')).toContain(end)
    await user().click(point)
    const sample = screen.getByRole('dialog')
    expect(sample.textContent).toContain('12:00:30.125 UTC')
    expect(sample.textContent).toContain(`${end} (end excluded)`)
  } finally {
    setTimePreferences(preferences)
  }
})

test('Dashboard preserves completion metrics and opens contributing and missing-start Tasks', async () => {
  bridge({ factoryDashboard: () => dashboardFixture() })
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
  const intake = screen.getByRole('region', { name: 'First Intake → Done' })
  await user().click(within(intake).getByRole('button', { name: 'View 1 Tasks' }))
  let sample = screen.getByRole('dialog')
  expect(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }).textContent).toContain(
    'Archived',
  )
  expect(within(sample).queryByText(/Improve search/)).toBeNull()
  await user().click(within(sample).getByRole('button', { name: /NB-1.*Fix login/ }))
  expect(open).toHaveBeenCalledWith('t1')
  await user().click(within(sample).getByRole('button', { name: 'Close sample' }))
  await user().click(within(intake).getByRole('button', { name: '1 missing starts' }))
  sample = screen.getByRole('dialog')
  expect(within(sample).getByText(/Improve search/)).toBeTruthy()
  expect(within(sample).getByText(/Start unavailable/)).toBeTruthy()
})

test('Factory and range changes discard late responses instead of mixing samples', async () => {
  const { deferred } = await import('./support/component.ts')
  const pending = deferred<ReturnType<typeof dashboardFixture>>()
  const api = bridge({
    factoryDashboard: (factory, range) =>
      factory === 'f1' && range === '7d' ? pending.promise : dashboardFixture(true),
  })
  const change = vi.fn()
  const props = { title: 'Widgets', onChange: change, onOpenTask: vi.fn() }
  const view = render(<Dashboard {...props} factoryId="f1" state={{ range: '7d' }} />)
  expect(screen.getByRole('status', { name: 'Loading Dashboard…' })).toBeTruthy()
  view.rerender(<Dashboard {...props} factoryId="f2" state={{ range: '30d' }} />)
  const region = await screen.findByRole('region', { name: 'Tasks completed' })
  expect(within(region).getByRole('button', { name: '0 tasks' })).toBeTruthy()
  const { act } = await import('@testing-library/react')
  await act(async () => pending.resolve(dashboardFixture()))
  expect(within(region).queryByRole('button', { name: '2 tasks' })).toBeNull()
  expect(api.request).toHaveBeenCalledWith('factoryDashboard', 'f2', '30d')
})

test('load failures retry, events refresh completed metrics and clock/focus advance rolling boundaries', async () => {
  const { act, fireEvent } = await import('@testing-library/react')
  let fail = true
  let empty = true
  const api = bridge({
    factoryDashboard: () => {
      if (fail) throw new Error('History unavailable')
      return dashboardFixture(empty)
    },
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    render(
      <Dashboard
        factoryId="f1"
        title="Widgets"
        state={{ range: '7d' }}
        onChange={vi.fn()}
        onOpenTask={vi.fn()}
      />,
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
    displayId: 'NB-3',
    title: 'Old Task',
    archived: true,
    doneAt: null,
    createdMs: null,
    intakeMs: null,
  })
  bridge({ factoryDashboard: () => data })
  render(
    <Dashboard
      factoryId="f1"
      title="Widgets"
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
  bridge({ factoryDashboard: () => dashboardFixture() })
  const open = vi.fn()
  render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Stages' }))
  const region = await screen.findByRole('region', { name: 'Elapsed time by Stage' })
  expect(within(region).getByText('14h')).toBeTruthy()
  const opener = within(region).getByRole('button', { name: '2 Tasks' })
  await user().click(opener)
  let sample = screen.getByRole('dialog')
  expect(sample.textContent).toContain('9h · 1 measured visit')
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
  bridge({ factoryDashboard: () => dashboardFixture() })
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
})

test('Flow shares the range selector, suppresses all-history comparisons and shows empty denominators as unavailable', async () => {
  const data = dashboardFixture(true)
  data.flow.previous = null
  const api = bridge({ factoryDashboard: () => data })
  const change = vi.fn()
  render(
    <Dashboard
      factoryId="f1"
      title="Widgets"
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
  expect(api.request).toHaveBeenCalledWith('factoryDashboard', 'f1', 'all')
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
  bridge({ factoryDashboard: () => data })
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
  bridge({ factoryDashboard: () => dashboardFixture() })
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
  bridge({ factoryDashboard: () => data })
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
  bridge({ factoryDashboard: () => data })
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
  await user().click(screen.getByRole('button', { name: 'Work', exact: true }))
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
  bridge({ factoryDashboard: () => data })
  const open = vi.fn()
  render(<DashboardView open={open} />)
  await user().click(await screen.findByRole('tab', { name: 'Flow' }))
  expect(screen.getByText(/2 Tasks with a recorded Intake boundary/)).toBeTruthy()
  expect(screen.getByText(/Reason coverage counts apply only/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: /1 Task has incomplete timing history/ }))
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
  await user().click(screen.getByRole('button', { name: /1 Task has incomplete timing history/ }))
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
