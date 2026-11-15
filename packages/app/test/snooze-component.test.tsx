// @vitest-environment jsdom
import { defaultMachineSettings } from '@ted/protocol/settings'
import { requestSnoozePresets } from '@ted/protocol/time'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestCard } from '../src/renderer/components/RequestCard.tsx'
import { RequestSnoozeHost } from '../src/renderer/components/RequestSnooze.tsx'
import { SnoozeTaskDialog } from '../src/renderer/components/SnoozeTaskDialog.tsx'
import { TaskActionsMenu } from '../src/renderer/components/TaskActions.tsx'
import { TaskStatusChips } from '../src/renderer/components/TaskStatus.tsx'
import { SnoozedContext, snoozeTime } from '../src/renderer/request-snooze.ts'
import { setTimePreferences } from '../src/renderer/time.ts'
import { Inbox } from '../src/renderer/views/Inbox.tsx'
import { bridge, user } from './support/component.ts'
import { comment, factory, task } from './support/fixtures.ts'

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

test('an Inbox row snoozes from its button with the exact time shown; snoozed rows sit in a collapsed group', async () => {
  const utc = { ...defaultMachineSettings, timeZone: 'UTC', timeFormat: '24-hour' as const }
  setTimePreferences(utc)
  const api = bridge({ getSettings: () => utc, snoozeRequest: () => ({}) })
  const waiting = { task: task(), request: comment({ id: 'c1', body: 'Which page?' }) }
  const later = { task: task(), request: comment({ id: 'c2', body: 'Which button?' }) }
  const until = '2099-11-11T09:00:00.000Z'
  const onOpen = vi.fn()
  render(
    <SnoozedContext value={new Map([['c2', until]])}>
      <Inbox
        items={[waiting, later]}
        answered={[]}
        factories={[factory(), factory({ id: 'f2', name: 'gadgets' })]}
        factoryId={undefined}
        showAnswered={false}
        anyTasks
        selected={undefined}
        onOpen={onOpen}
        onClear={vi.fn()}
        onFilter={vi.fn()}
        onShowAnswered={vi.fn()}
        onNewTask={vi.fn()}
      />
      <RequestSnoozeHost />
    </SnoozedContext>,
  )
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('getSettings'))
  const u = user()
  expect(screen.getByText('Which page?')).toBeTruthy()
  expect(screen.queryByText('Which button?')).toBeNull()
  await u.click(screen.getByRole('button', { name: /^Filter/ }))
  expect(screen.getByRole('button', { name: /^All/ }).textContent).toBe('All 1')

  const group = screen.getByRole('button', { name: /Snoozed/ })
  expect(group.getAttribute('aria-expanded')).toBe('false')
  expect(group.textContent).toContain('1')
  await u.click(group)
  const row = screen.getByText('Which button?').closest('li') as HTMLElement
  expect(within(row).getByText('Returns Wed 11 Nov, 9:00')).toBeTruthy()
  await u.click(within(row).getByRole('button', { name: 'Unsnooze' }))
  expect(api.request).toHaveBeenCalledWith('snoozeRequest', 'c2', null)
  await u.click(within(row).getByRole('button', { name: 'Change snooze…' }))
  expect(screen.getAllByRole('menuitem').at(-1)?.textContent).toBe('Unsnooze')
  await u.keyboard('{Escape}')

  await u.click(screen.getByRole('button', { name: 'Snooze' }))
  const [, tomorrow, nextWeek, month] = requestSnoozePresets(new Date(), 'UTC')
  const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
  expect(items[0]).toMatch(/^An hour from now\w{3} \d{1,2} \w{3}, \d{1,2}:\d{2}$/)
  expect(items.slice(1)).toEqual([
    `Tomorrow${snoozeTime(tomorrow?.until ?? '')}`,
    `Next week${snoozeTime(nextWeek?.until ?? '')}`,
    `A month from now${snoozeTime(month?.until ?? '')}`,
    'Custom…Pick a date and time',
  ])
  expect(items[1]).toMatch(/, 9:00$/)
  await u.click(screen.getByRole('menuitem', { name: /^Tomorrow/ }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith('snoozeRequest', 'c1', tomorrow?.until),
  )
  expect(onOpen).not.toHaveBeenCalled()

  await u.click(screen.getByRole('button', { name: 'Snooze' }))
  await u.click(screen.getByRole('menuitem', { name: /^Custom…/ }))
  await screen.findByText('Hide this request from the Inbox until:')
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2000-01-01' } })
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Snooze' }))
  expect(screen.getByRole('alert').textContent).toBe('Choose a future date and time')
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-11-12' } })
  fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '9' } })
  fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '15' } })
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Snooze' }))
  await waitFor(() =>
    expect(api.request).toHaveBeenCalledWith('snoozeRequest', 'c1', '2099-11-12T09:15:00.000Z'),
  )
})

test('a snoozed request’s card says when it returns, and its Task reads Snoozed until', async () => {
  const utc = { ...defaultMachineSettings, timeZone: 'UTC', timeFormat: '24-hour' as const }
  setTimePreferences(utc)
  const api = bridge({
    snoozeRequest: () => ({}),
    listThreadEvents: () => [],
    listCheckRuns: () => [],
    listFailures: () => [],
    validationObligations: () => ({ satisfied: true, cases: [], checkRuns: [], blockers: [] }),
    listApps: () => [],
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
  })
  const until = '2099-11-11T09:00:00.000Z'
  const value = task({ status: { kind: 'waiting-on-you', snoozedUntil: until } })
  render(
    <SnoozedContext value={new Map([['c1', until]])}>
      <TaskStatusChips task={value} onOpenTask={vi.fn()} />
      <RequestCard task={value} request={comment({ id: 'c1' })} />
    </SnoozedContext>,
  )
  expect(screen.getByText('Snoozed until Wed 11 Nov, 9:00')).toBeTruthy()
  expect(screen.getByText(/Snoozed\. Returns to the Inbox Wed 11 Nov, 9:00/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Unsnooze' }))
  expect(api.request).toHaveBeenCalledWith('snoozeRequest', 'c1', null)
})
