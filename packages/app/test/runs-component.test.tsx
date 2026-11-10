// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { appState } from './support/app.tsx'
import { user } from './support/component.ts'

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
  }
}

test('live slot updates populate Working Runs and Open in List opens the queue', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('button', { name: 'Nothing running' })
  working(a)
  await act(async () => a.emit({ type: 'slots-changed', slots: a.state.slots }))
  await user().click(screen.getByRole('button', { name: '1 of 1 Runs working · 1 queued' }))
  const dialog = screen.getByRole('dialog', { name: 'Working Runs' })
  const d = within(dialog)
  expect(d.getByText(/1 of 1 slots on this/)).toBeTruthy()
  expect(
    within(d.getByRole('region', { name: 'Working' })).getByText('NB-1', { exact: true }),
  ).toBeTruthy()
  expect(d.getByText('widgets 1 of 1 · Task Lead')).toBeTruthy()
  expect(d.getByText('NB-2 · Second Task')).toBeTruthy()
  expect(d.getByText('1st')).toBeTruthy()
  expect(d.getByText('widgets · None')).toBeTruthy()
  await user().click(d.getByRole('button', { name: 'Open in List →' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('heading', { name: 'All Tasks' })).toBeTruthy()
})

test('empty Working Runs explains no work and Escape closes it', async () => {
  const a = appState()
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'Nothing running' }))
  const dialog = screen.getByRole('dialog', { name: 'Working Runs' })
  expect(within(dialog).getByText('No Runs working. Nothing queued.')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('Factory caps appear in Board and List headers only when working', async () => {
  const a = appState()
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'widgets' }))
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
  await screen.findByText('Now: 1 of 1 Runs working · 1 queued')
  await user().click(screen.getByRole('button', { name: 'More working Runs' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', { maxWorkingRuns: 2 })
  a.state.slots = { ...a.state.slots, limit: 2, working: 2, queued: 0, queue: [] }
  await act(async () => a.emit({ type: 'slots-changed', slots: a.state.slots }))
  expect(screen.getByText('Now: 2 of 2 Runs working')).toBeTruthy()
})
