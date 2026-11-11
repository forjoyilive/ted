// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import type { DashboardViewState } from '../src/renderer/dashboard.ts'
import { Dashboard } from '../src/renderer/views/Dashboard.tsx'
import { bridge, user } from './support/component.ts'
import { dashboardFixture } from './support/dashboard.ts'

function DashboardView({ open }: { open: (id: string) => void }) {
  const [state, setState] = useState<DashboardViewState>({ range: '7d' })
  return (
    <Dashboard factoryId="f1" title="Widgets" state={state} onChange={setState} onOpenTask={open} />
  )
}

test('Dashboard shows completion metrics only and opens contributing and missing-start Tasks', async () => {
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
