// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ArchiveDialog, DeleteDialog } from '../src/renderer/components/ArchiveDialogs.tsx'
import { DataScreen } from '../src/renderer/views/DataScreen.tsx'
import { EditTaskDialog } from '../src/renderer/views/EditTaskDialog.tsx'
import { bridge, user } from './support/component.ts'
import { task } from './support/fixtures.ts'

const blocked = task({
  id: 'NB-2',
  displayId: 'NB-2',
  title: 'Highlight search matches',
  blockedBy: ['NB-1'],
})

test('Archive defaults to unblock, allows Keep blocked, and sends the choice', async () => {
  const api = bridge({ listTasks: () => [task(), blocked], archiveTask: vi.fn() })
  const close = vi.fn()
  render(<ArchiveDialog task={task()} onClose={close} />)
  await screen.findByText('1 Task is blocked by NB-1')
  expect(screen.getByText('Highlight search matches')).toBeTruthy()
  expect((screen.getByRole('radio', { name: /^Unblock it/ }) as HTMLInputElement).checked).toBe(
    true,
  )
  await user().click(screen.getByRole('radio', { name: /^Keep it blocked/ }))
  await user().click(screen.getByRole('button', { name: 'Archive' }))
  expect(api.request).toHaveBeenCalledWith('archiveTask', 'NB-1', {
    closePullRequests: false,
    blocked: 'keep',
  })
  expect(close).toHaveBeenCalledOnce()
})

test('Delete offers Archive instead and sends its unblock choice', async () => {
  const archive = vi.fn()
  const close = vi.fn()
  const api = bridge({
    listTasks: () => [task(), blocked],
    listTaskRuns: () => [],
    deleteTask: vi.fn(),
  })
  render(<DeleteDialog task={task()} onClose={close} onArchiveInstead={archive} />)
  await screen.findByText('1 Task is blocked by NB-1')
  expect(screen.getByText(/This can’t be undone/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Archive instead' }))
  expect(archive).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Delete NB-1' }))
  expect(api.request).toHaveBeenCalledWith('deleteTask', 'NB-1', { blocked: 'unblock' })
  expect(close).toHaveBeenCalledOnce()
})

test('Edit Task focuses description, sends only changed fields and supports command Enter', async () => {
  const close = vi.fn()
  const api = bridge({ editTask: vi.fn() })
  render(<EditTaskDialog task={task()} onClose={close} />)
  expect(document.activeElement).toBe(screen.getByLabelText('Description'))
  expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'In titles and bodies.' },
  })
  fireEvent.keyDown(screen.getByLabelText('Description'), { key: 'Enter', metaKey: true })
  await vi.waitFor(() =>
    expect(api.request).toHaveBeenCalledWith('editTask', 'NB-1', {
      description: 'In titles and bodies.',
    }),
  )
  expect(close).toHaveBeenCalledOnce()
})

test('failed data rebuild shows its stopping event and error with Copy report and Quit', async () => {
  const api = bridge({ copyText: vi.fn(), quit: vi.fn() })
  render(
    <DataScreen
      status={{ state: 'failed', version: '9.0.0', done: 41, total: 100, error: 'Bad event' }}
    />,
  )
  expect(screen.getByRole('heading', { name: 'TED couldn’t update its data' })).toBeTruthy()
  expect(screen.getByText('Rebuild stopped at event 42 of 100')).toBeTruthy()
  expect(screen.getByText('Error: Bad event')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Copy report' }))
  expect(api.request).toHaveBeenCalledWith('copyText', expect.stringContaining('Bad event'))
  await user().click(screen.getByRole('button', { name: 'Quit TED' }))
  expect(api.request).toHaveBeenCalledWith('quit')
})

test('unfinished setup offers Open setup Task or Start anyway without starting on inspection', async () => {
  const { SetupNoticeDialog } = await import('../src/renderer/components/SetupNoticeDialog.tsx')
  const start = vi.fn()
  const cancel = vi.fn()
  const open = vi.fn()
  const setup = task({ id: 'NB-0', displayId: 'NB-0', setup: true, title: 'Set up widgets' })
  render(
    <SetupNoticeDialog
      task={task()}
      notice={{ kind: 'open', task: setup }}
      onStart={start}
      onCancel={cancel}
      onOpenTask={open}
    />,
  )
  expect(screen.getByText('Setup isn’t finished. This Task will use TED’s defaults.')).toBeTruthy()
  expect(start).not.toHaveBeenCalled()
  await user().click(screen.getByRole('button', { name: 'Open setup Task' }))
  expect(open).toHaveBeenCalledWith(setup)
  expect(cancel).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Start anyway' }))
  expect(start).toHaveBeenCalledOnce()
})
