// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { appState } from './support/app.tsx'
import { expandFactory, user } from './support/component.ts'

function working(a: ReturnType<typeof appState>) {
  a.state.slots = {
    limit: 1,
    working: 1,
    queued: 1,
    factories: [{ factoryId: 'f1', cap: 1, working: 1 }],
    holders: [
      {
        kind: 'task',
        taskId: 'NB-1',
        displayId: 'NB-1',
        title: 'Sync notes',
        factoryId: 'f1',
        runs: 1,
        subAgents: 0,
        settingUp: false,
      },
      { kind: 'coordinator', runId: 'c1', factoryId: 'f1', name: 'Coordinator', runs: 1 },
    ],
    queue: [
      {
        kind: 'task',
        taskId: 'NB-2',
        displayId: 'NB-2',
        title: 'Second Task',
        factoryId: 'f1',
        priority: 'none',
        place: 1,
      },
    ],
    checks: {
      running: 2,
      waiting: 1,
      tasks: [
        { taskId: 'NB-3', displayId: 'NB-3', title: 'Check notes', factoryId: 'f1' },
        { taskId: 'NB-4', displayId: 'NB-4', title: 'Wait for Checks', factoryId: 'f1', place: 1 },
      ],
      scheduled: { running: 1, waiting: 0 },
    },
  }
}

test('live slot updates populate Working Runs and Open in List opens the queue', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('button', { name: '0 of 3 slots in use' })
  working(a)
  await act(async () => a.emit({ type: 'slots-changed', slots: a.state.slots }))
  await user().click(
    screen.getByRole('button', {
      name: '1 of 1 slot in use · 2 Checks running, 1 waiting · 1 queued',
    }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Working Runs' })
  const d = within(dialog)
  expect(d.getByText(/1 of 1 slots on this/)).toBeTruthy()
  expect(
    within(d.getByRole('region', { name: 'Working' })).getByText('NB-1', { exact: true }),
  ).toBeTruthy()
  expect(d.getByText('widgets 1 of 1 · Task Lead')).toBeTruthy()
  const chats = within(d.getByRole('region', { name: 'Chats' }))
  expect(chats.getByText('Coordinator', { exact: true })).toBeTruthy()
  expect(chats.getByText('widgets · Coordinator Run')).toBeTruthy()
  expect(chats.getByText('No slot')).toBeTruthy()
  expect(within(d.getByRole('region', { name: 'Working' })).queryByText('Coord')).toBeNull()
  const checks = within(d.getByRole('region', { name: 'Checks' }))
  expect(checks.getByText('NB-3', { exact: true })).toBeTruthy()
  expect(checks.getByText('widgets · Running Checks')).toBeTruthy()
  expect(checks.getByText('NB-4 · Wait for Checks')).toBeTruthy()
  expect(checks.getByText('widgets · Waiting to run Checks')).toBeTruthy()
  expect(checks.getByText('Scheduled Checks')).toBeTruthy()
  expect(checks.getByText('1 running')).toBeTruthy()
  expect(checks.queryByText('No slot')).toBeNull()
  expect(d.getByText('NB-2 · Second Task')).toBeTruthy()
  expect(within(d.getByRole('region', { name: 'Queued' })).getByText('1st')).toBeTruthy()
  expect(checks.getByText('1st')).toBeTruthy()
  expect(d.getByText('widgets · None')).toBeTruthy()
  await user().click(d.getByRole('button', { name: 'Open in List →' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('heading', { name: 'All Tasks' })).toBeTruthy()
})

test('empty Working Runs explains no work and Escape closes it', async () => {
  const a = appState()
  a.mount()
  await user().click(await screen.findByRole('button', { name: '0 of 3 slots in use' }))
  const dialog = screen.getByRole('dialog', { name: 'Working Runs' })
  expect(within(dialog).getByText('No Runs working. No Checks. Nothing queued.')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('Factory caps appear in Board and List headers only when working', async () => {
  const a = appState()
  a.mount()
  await expandFactory()
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Task views',
    }),
  )
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Board',
    }),
  )
  expect(screen.queryByText('1 of 1 working')).toBeNull()
  working(a)
  await act(async () => a.emit({ type: 'slots-changed', slots: a.state.slots }))
  expect(screen.getByText('1 of 1 working')).toBeTruthy()
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  expect(screen.getByText('1 of 1 working')).toBeTruthy()
})

test('Limits updates the machine cap and follows live slot changes', async () => {
  const a = appState()
  working(a)
  a.state.settings.maxWorkingRuns = 1
  a.mount()
  await a.settings()
  await user().click(screen.getByRole('button', { name: 'Limits' }))
  await screen.findByText('Now: 1 of 1 slot in use · 2 Checks running, 1 waiting · 1 queued')
  await user().click(screen.getByRole('button', { name: 'More working Runs' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', { maxWorkingRuns: 2 })
  a.state.slots = { ...a.state.slots, limit: 2, working: 2, queued: 0, queue: [] }
  await act(async () => a.emit({ type: 'slots-changed', slots: a.state.slots }))
  expect(screen.getByText('Now: 2 of 2 slots in use · 2 Checks running, 1 waiting')).toBeTruthy()
})

test('Limits turns off waiting when busy and says when starts are held', async () => {
  const a = appState()
  working(a)
  a.mount()
  await a.settings()
  await user().click(screen.getByRole('button', { name: 'Limits' }))
  const control = screen.getByRole('switch', {
    name: 'Wait to start new work when this computer is busy',
  })
  expect(control.getAttribute('aria-checked')).toBe('true')
  const help = screen.getAllByRole('button', { name: 'Help' })[2] as HTMLElement
  await user().hover(help)
  expect(screen.getByRole('tooltip').textContent).toMatch(
    /Work already running carries on\. The limit above is still the most TED runs at once\.$/,
  )
  await user().unhover(help)
  await user().click(control)
  expect(a.request).toHaveBeenCalledWith('updateSettings', { waitWhenBusy: false })
  a.state.slots = { ...a.state.slots, busy: { memoryAvailable: 0.07 } }
  await act(async () => a.emit({ type: 'slots-changed', slots: a.state.slots }))
  expect(
    screen
      .getByText(
        /^Now: 1 of \d+ slots? in use · 2 Checks running, 1 waiting · 1 queued · this computer is busy$/,
      )
      .getAttribute('title'),
  ).toBe('Memory available: 7% · waits below 10%, starts again above 20%')
})
