// @vitest-environment jsdom
import { defaultMachineSettings } from '@ted/protocol/settings'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SnoozeTaskDialog } from '../src/renderer/components/SnoozeTaskDialog.tsx'
import { TaskActionsMenu } from '../src/renderer/components/TaskActions.tsx'
import { TaskStatusChips } from '../src/renderer/components/TaskStatus.tsx'
import { setTimePreferences } from '../src/renderer/time.ts'
import { bridge, user } from './support/component.ts'
import { task } from './support/fixtures.ts'

const preferences = {
  ...defaultMachineSettings,
  timeZone: 'Asia/Kolkata',
  timeFormat: '24-hour' as const,
}
afterEach(() => setTimePreferences(defaultMachineSettings))

test('snooze dialog uses app timezone and sends a fixed instant; failures remain editable', async () => {
  setTimePreferences(preferences)
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('Task has already started'))
    .mockResolvedValue(task())
  const api = bridge({ getSettings: () => preferences, setTaskSnooze: save })
  const close = vi.fn()
  render(<SnoozeTaskDialog task={task({ stage: 'backlog' })} onClose={close} />)
  await screen.findByText(/Time zone: Asia\/Kolkata/)
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-11-11' } })
  fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '9' } })
  fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '15' } })
  await user().click(screen.getByRole('button', { name: 'Snooze Task' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Task has already started')
  expect(close).not.toHaveBeenCalled()
  await user().click(screen.getByRole('button', { name: 'Snooze Task' }))
  expect(api.request).toHaveBeenCalledWith('setTaskSnooze', 'NB-1', '2099-11-11T03:45:00.000Z')
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})

test('past dates cannot be saved', async () => {
  bridge({ getSettings: () => preferences })
  render(<SnoozeTaskDialog task={task({ stage: 'backlog' })} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2000-01-01' } })
  await user().click(screen.getByRole('button', { name: 'Snooze Task' }))
  expect((await screen.findByRole('alert')).textContent).toContain('future')
})

test('Backlog actions offer change and cancel; scheduled marker coexists with blockers', async () => {
  const value = task({
    stage: 'backlog',
    snoozedUntil: '2099-11-11T03:45:00.000Z',
    markers: [
      { kind: 'snoozed', until: '2099-11-11T03:45:00.000Z' },
      { kind: 'blocked-by', by: 'NB-2' },
    ],
  })
  const api = bridge({ setTaskSnooze: () => task() })
  render(
    <>
      <TaskActionsMenu task={value} />
      <TaskStatusChips task={value} onOpenTask={vi.fn()} />
    </>,
  )
  expect(screen.getByText(/Scheduled ·/)).toBeTruthy()
  expect(screen.getByText('NB-2')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Task actions' }))
  expect(screen.getByRole('menuitem', { name: 'Change snooze…' })).toBeTruthy()
  await user().click(screen.getByRole('menuitem', { name: 'Cancel snooze' }))
  expect(api.request).toHaveBeenCalledWith('setTaskSnooze', 'NB-1', null)
})

test('bulk snooze sends the same instant to every selected Task', async () => {
  setTimePreferences(preferences)
  const first = task()
  const second = task({ id: 'NB-2', displayId: 'NB-2' })
  const api = bridge({ getSettings: () => preferences, setTaskSnooze: () => first })
  const close = vi.fn()
  render(<SnoozeTaskDialog task={first} tasks={[first, second]} onClose={close} />)
  await screen.findByText(/Time zone: Asia\/Kolkata/)
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-11-11' } })
  fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '9' } })
  fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '15' } })
  await user().click(screen.getByRole('button', { name: 'Snooze 2 Tasks' }))
  for (const id of ['NB-1', 'NB-2'])
    expect(api.request).toHaveBeenCalledWith('setTaskSnooze', id, '2099-11-11T03:45:00.000Z')
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})
