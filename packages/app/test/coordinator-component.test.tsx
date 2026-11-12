// @vitest-environment jsdom
import type { Coordinator, CoordinatorStatus, RunChat } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { OvernightContext } from '../src/renderer/overnight.tsx'
import { LibraryPage } from '../src/renderer/settings/LibraryPage.tsx'
import { FactorySettings } from '../src/renderer/views/FactorySettings.tsx'
import { TaskGatesField } from '../src/renderer/views/TaskGatesField.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory, settingsView } from './support/fixtures.ts'

const nav = () => screen.getByRole('navigation', { name: 'Sidebar' })
const continuation =
  'Continue the interrupted response using fresh facts. Do not repeat completed actions.'

function coordinator(fields: Partial<Coordinator> = {}): Coordinator {
  return {
    factoryId: 'f1',
    runId: 'r2',
    runIds: ['r1', 'r2'],
    started: true,
    opening: 'What should we work on next?',
    lead: { agent: 'claude' },
    status: 'ready',
    unsentMessages: [],
    receipts: [
      {
        id: 'op1',
        operation: 'start',
        taskId: 'NB-1',
        text: 'Started NB-1 · Queued at Intake',
        at: createdAt,
        fingerprint: 'f',
      },
    ],
    tasks: [],
    ...fields,
  }
}

function conversation(): RunChat {
  return {
    run: {
      id: 'r2',
      name: 'Coordinator',
      role: 'run',
      agent: 'claude',
      model: 'opus',
      state: 'idle',
      startedAt: createdAt,
      current: true,
    },
    items: [
      {
        kind: 'human',
        id: 'prompt',
        text: 'What should we work on next?',
        at: createdAt,
        sent: true,
      },
      { kind: 'agent', id: 'a1', text: 'Start with NB-1.', at: createdAt },
      { kind: 'ted', id: 't1', title: continuation, text: continuation, at: createdAt },
      {
        kind: 'human',
        id: 'u1',
        text: 'Never mind that one.',
        at: createdAt,
        sent: false,
        unsent: true,
      },
    ],
  }
}

function withCoordinator() {
  const a = appState()
  const shown: {
    coordinator: Coordinator | null
    chat: RunChat | null
    statuses: CoordinatorStatus[]
  } = { coordinator: coordinator(), chat: conversation(), statuses: [] }
  a.handle('coordinator', () => shown.coordinator)
  a.handle('coordinatorChat', () => shown.chat)
  a.handle('coordinatorStatuses', () => shown.statuses)
  a.handle('taskDefaults', () => ({ lead: { agent: 'claude' }, planner: { agent: 'claude' } }))
  const open = async () => {
    await user().click(await screen.findByRole('button', { name: 'widgets' }))
    await user().click(within(nav()).getByRole('button', { name: /^Coordinator/ }))
    return screen.findByRole('region', { name: 'Coordinator' })
  }
  return { a, shown, open }
}

test('the Coordinator shows its conversation in the Run chat, with TED’s continuation as From TED', async () => {
  const { a, open } = withCoordinator()
  a.mount()
  const pane = await open()
  const chat = await within(pane).findByRole('region', { name: 'Run chat' })
  expect(within(chat).getByText('Start with NB-1.')).toBeTruthy()
  expect(within(chat).getByText('What should we work on next?')).toBeTruthy()
  const fromTed = within(chat).getByRole('button', { name: /From TED/ })
  expect(fromTed.textContent).toContain(continuation)
  expect(within(chat).getAllByText('Nabha Cosley')).toHaveLength(2)
  const unsent = within(chat).getByText('Never mind that one.').closest('div')
  expect(unsent?.textContent).toContain('Not sent')
  expect(within(chat).queryByRole('button', { name: 'Delete' })).toBeNull()
  expect(within(chat).getByRole('button', { name: 'Started NB-1 · Queued at Intake' })).toBeTruthy()
  expect(within(pane).queryByText('Earlier conversation')).toBeNull()
  expect(within(pane).queryByRole('button', { name: 'Stop response' })).toBeNull()
})

test('the Coordinator composer sends on Enter, queues while working and stops with the Run chat’s ■', async () => {
  const { a, shown, open } = withCoordinator()
  const send = vi.fn(() => shown.coordinator)
  const stop = vi.fn(() => shown.coordinator)
  a.handle('messageCoordinator', send)
  a.handle('stopCoordinator', stop)
  a.mount()
  const pane = await open()
  const box = await within(pane).findByRole('textbox', { name: 'Message to the Coordinator' })
  const stopButton = within(pane).getByRole('button', {
    name: 'Stop the turn',
  }) as HTMLButtonElement
  expect(stopButton.disabled).toBe(true)
  expect(within(pane).queryByRole('button', { name: /Interrupt and send/ })).toBeNull()
  fireEvent.change(box, { target: { value: 'Start NB-2 too.' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('f1', { text: 'Start NB-2 too.' }))
  await act(async () => {
    shown.coordinator = coordinator({ status: 'working' })
    shown.chat = {
      ...conversation(),
      items: [
        ...conversation().items,
        {
          kind: 'human',
          id: 'm9',
          text: 'Start NB-2 too.',
          at: createdAt,
          sent: false,
          queued: true,
        },
      ],
    }
    a.emit({ type: 'coordinator-changed', factoryId: 'f1' })
  })
  await within(pane).findByText('Queued')
  expect(within(pane).getByRole('button', { name: 'Delete' })).toBeTruthy()
  expect(within(pane).queryByRole('button', { name: 'Send now' })).toBeNull()
  expect(within(pane).getAllByText('Working').length).toBeGreaterThan(0)
  await user().click(within(pane).getByRole('button', { name: 'Stop the turn' }))
  expect(stop).toHaveBeenCalledWith('f1')
})

test('New conversation asks first, then resets the Coordinator and shows the empty composer', async () => {
  const { a, shown, open } = withCoordinator()
  const reset = vi.fn(() => {
    shown.coordinator = null
    shown.chat = null
    return null
  })
  a.handle('resetCoordinator', reset)
  a.mount()
  const pane = await open()
  await user().click(await within(pane).findByRole('button', { name: 'New conversation' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('Start a new Coordinator conversation?')
  await user().click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(reset).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()

  await user().click(within(pane).getByRole('button', { name: 'New conversation' }))
  await user().click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete and start new' }),
  )
  await vi.waitFor(() => expect(reset).toHaveBeenCalledWith('f1'))
  await act(async () => {
    a.emit({ type: 'coordinator-changed', factoryId: 'f1' })
  })
  await within(pane).findByText('What needs your attention in widgets?')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(within(pane).queryByRole('button', { name: 'New conversation' })).toBeNull()
})

test('leaving the Coordinator and coming back shows the same conversation', async () => {
  const { a, open } = withCoordinator()
  a.mount()
  const pane = await open()
  await within(pane).findByText('Start with NB-1.')
  await user().click(within(nav()).getByRole('button', { name: 'Board' }))
  expect(screen.queryByText('Start with NB-1.')).toBeNull()
  await user().click(within(nav()).getByRole('button', { name: /^Coordinator/ }))
  const back = await screen.findByRole('region', { name: 'Coordinator' })
  expect(await within(back).findByText('Start with NB-1.')).toBeTruthy()
  expect(within(back).getByText('What should we work on next?')).toBeTruthy()
})

test('a new Coordinator starts from the same composer', async () => {
  const { a, shown, open } = withCoordinator()
  shown.coordinator = null
  shown.chat = null
  const send = vi.fn(() => coordinator())
  a.handle('messageCoordinator', send)
  a.mount()
  const pane = await open()
  await within(pane).findByRole('heading', { name: /What needs your attention/ })
  await user().click(within(pane).getByRole('button', { name: 'What should we work on next?' }))
  const box = within(pane).getByRole('textbox', { name: 'Message to the Coordinator' })
  fireEvent.keyDown(box, { key: 'Enter' })
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith('f1', {
      text: 'What should we work on next?',
      agent: 'claude',
    }),
  )
})

test('the sidebar lists Coordinator above Board and shows Working only while it works', async () => {
  const { a, shown } = withCoordinator()
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'widgets' }))
  const names = within(nav())
    .getAllByRole('button')
    .map((button) => button.textContent)
  expect(names.indexOf('Coordinator')).toBeGreaterThan(-1)
  expect(names.indexOf('Dashboard')).toBe(names.indexOf('Coordinator') - 1)
  expect(names.indexOf('Coordinator')).toBe(names.indexOf('Board') - 1)
  const row = () => within(nav()).getByRole('button', { name: /^Coordinator/ })
  expect(within(row()).queryByRole('img')).toBeNull()
  await act(async () => {
    shown.statuses = [{ factoryId: 'f1', status: 'working' }]
    a.emit({ type: 'coordinator-changed', factoryId: 'f1' })
  })
  expect(await within(row()).findByRole('img', { name: 'Working' })).toBeTruthy()
  await act(async () => {
    shown.statuses = [{ factoryId: 'f1', status: 'failed' }]
    a.emit({ type: 'coordinator-changed', factoryId: 'f1' })
  })
  expect(await within(row()).findByRole('img', { name: 'The Coordinator failed' })).toBeTruthy()
  expect(within(row()).queryByRole('img', { name: 'Working' })).toBeNull()
  await act(async () => {
    shown.statuses = [{ factoryId: 'f1', status: 'ready' }]
    a.emit({ type: 'coordinator-changed', factoryId: 'f1' })
  })
  await vi.waitFor(() => expect(within(row()).queryByRole('img')).toBeNull())
})

test('overnight mode is switched in Settings → General, not in the sidebar', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  expect(within(nav()).queryByRole('button', { name: /overnight mode/i })).toBeNull()
  expect(within(nav()).queryByText('Overnight mode is on')).toBeNull()
  await a.settings()
  await user().click(
    await screen.findByRole('switch', { name: 'Overnight mode across all Factories' }),
  )
  expect(a.request).toHaveBeenCalledWith('updateSettings', { overnightMode: true })
  await user().keyboard('{Escape}')
  expect(await within(nav()).findByText('Overnight mode is on')).toBeTruthy()
  expect(within(nav()).queryByRole('button', { name: /overnight mode/i })).toBeNull()
})

const notice = () => screen.queryByRole('status', { name: 'Overnight mode is on' })
const noticeText =
  '▲ Overnight mode is on. Sign-offs set here are off until you turn it off in Settings → General. Setup Tasks, Tasks that change a Factory’s settings and Clarify at grilling depth still wait for you.'

function overnight(on: boolean, view: React.ReactNode) {
  const openGeneral = vi.fn()
  const result = render(<OvernightContext value={{ on, openGeneral }}>{view}</OvernightContext>)
  return { openGeneral, ...result }
}

async function checkNotice(view: () => React.ReactNode, ready: () => Promise<unknown>) {
  const off = overnight(false, view())
  await ready()
  expect(notice()).toBeNull()
  off.unmount()
  const on = overnight(true, view())
  await ready()
  expect(notice()?.textContent).toBe(noticeText)
  await user().click(screen.getByRole('button', { name: 'Settings → General' }))
  expect(on.openGeneral).toHaveBeenCalledOnce()
}

test('the Factory Workflow section shows the overnight notice only while overnight mode is on', async () => {
  bridge({
    factorySettings: settingsView,
    homeFolder: () => '/test',
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
    getSettings: () => defaultMachineSettings,
    getLinear: () => ({ state: 'no-key' }),
  })
  await checkNotice(
    () => (
      <FactorySettings
        factory={factory()}
        banners={null}
        onOpenFactory={vi.fn()}
        onOpenGitHubSettings={vi.fn()}
        onRemoveFactory={vi.fn()}
        onOpenTask={vi.fn()}
      />
    ),
    () => screen.findByRole('heading', { name: 'Workflow' }),
  )
  const workflow = screen.getByRole('region', { name: 'Workflow' })
  expect(within(workflow).getByRole('status', { name: 'Overnight mode is on' })).toBeTruthy()
})

test('the Library page shows the overnight notice only while overnight mode is on', async () => {
  const a = appState()
  bridge({ library: () => new Promise(() => {}) })
  await checkNotice(
    () => <LibraryPage settings={a.state.settings} dispatch={vi.fn()} />,
    () => screen.findByRole('heading', { name: 'Library' }),
  )
})

test('a Task’s sign-offs editor shows the overnight notice only while overnight mode is on', async () => {
  bridge({})
  await checkNotice(
    () => <TaskGatesField taskId="NB-1" factoryId="factory-1" />,
    async () => {
      await user().click(await screen.findByRole('button', { name: /Use Workflow/ }))
      await screen.findByRole('region', { name: 'Sign-offs for this Task' })
    },
  )
})

test('the notice follows the setting live and its link opens Settings → General', async () => {
  const a = appState()
  a.handle('library', () => new Promise(() => {}))
  a.mount()
  await a.settings()
  await user().click(
    within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('button', {
      name: 'Library',
    }),
  )
  await screen.findByRole('heading', { name: 'Library' })
  expect(notice()).toBeNull()
  await act(async () => {
    a.state.settings = { ...a.state.settings, overnightMode: true }
    a.emit({ type: 'settings-changed', settings: a.state.settings })
  })
  expect(notice()).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Settings → General' }))
  const control = await screen.findByRole('switch', { name: 'Overnight mode across all Factories' })
  await user().click(control)
  expect(a.state.settings.overnightMode).toBe(false)
  await user().click(
    within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('button', {
      name: 'Library',
    }),
  )
  await screen.findByRole('heading', { name: 'Library' })
  expect(notice()).toBeNull()
})

test('Coordinator loading failures can retry without losing the combined conversation', async () => {
  const { a, open } = withCoordinator()
  a.handle('coordinator', () => Promise.reject(new Error('Coordinator unavailable')))
  a.handle('coordinatorChat', () => Promise.reject(new Error('Conversation unavailable')))
  a.mount()
  const region = await open()
  expect((await within(region).findByRole('alert')).textContent).toContain(
    'Coordinator unavailable',
  )
  a.handle('coordinator', () => coordinator())
  await user().click(within(region).getByRole('button', { name: 'Try again' }))
  expect((await within(region).findByRole('alert')).textContent).toContain(
    'Conversation unavailable',
  )
  a.handle('coordinatorChat', () => conversation())
  await user().click(within(region).getByRole('button', { name: 'Try again' }))
  await within(region).findByText('Start with NB-1.')
  a.handle('coordinatorChat', () => Promise.reject(new Error('Refresh unavailable')))
  act(() => a.emit({ type: 'coordinator-changed', factoryId: 'f1' }))
  await within(region).findByRole('alert')
  expect(within(region).getByText('Start with NB-1.')).toBeTruthy()
})
