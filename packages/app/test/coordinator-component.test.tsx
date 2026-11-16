// @vitest-environment jsdom
import type { Coordinator, CoordinatorChatSummary, CoordinatorStatus, RunChat } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { OvernightContext } from '../src/renderer/overnight.tsx'
import { LibraryPage } from '../src/renderer/settings/LibraryPage.tsx'
import { FactorySettings } from '../src/renderer/views/FactorySettings.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory, settingsView, task } from './support/fixtures.ts'

const nav = () => screen.getByRole('navigation', { name: 'Sidebar' })
const continuation =
  'Continue the interrupted response using fresh facts. Do not repeat completed actions.'

function coordinator(fields: Partial<Coordinator> = {}): Coordinator {
  return {
    id: 'k1',
    factoryId: 'f1',
    runId: 'r2',
    runIds: ['r1', 'r2'],
    started: true,
    opening: 'What should we work on next?',
    startedAt: createdAt,
    lead: { agent: 'claude' },
    status: 'ready',
    unsentMessages: [],
    confirmations: [],
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

function summary(fields: Partial<CoordinatorChatSummary> = {}): CoordinatorChatSummary {
  return {
    id: 'k1',
    factoryId: 'f1',
    title: 'What should we work on next?',
    status: 'ready',
    startedAt: createdAt,
    lastAt: createdAt,
    taskCount: 0,
    waiting: false,
    ...fields,
  }
}

const ended = summary({ id: 'k0', title: 'Archive what merged', endedAt: createdAt })

function withCoordinator() {
  const a = appState()
  const shown: {
    coordinator: Coordinator
    chats: CoordinatorChatSummary[]
    chat: RunChat
    statuses: CoordinatorStatus[]
  } = {
    coordinator: coordinator(),
    chats: [summary()],
    chat: conversation(),
    statuses: [],
  }
  a.handle('coordinatorChats', () => shown.chats)
  a.handle('coordinator', (id) =>
    id === ended.id
      ? coordinator({
          id: ended.id,
          opening: ended.title,
          endedAt: createdAt,
          runIds: ['r0'],
          tasks: [
            task({ id: 'NB-2', title: 'Added last' }),
            task({ id: 'NB-1', title: 'Added first' }),
          ],
        })
      : shown.coordinator,
  )
  a.handle('coordinatorChat', () => shown.chat)
  a.handle('coordinatorStatuses', () => shown.statuses)
  a.handle('taskDefaults', () => ({ lead: { agent: 'claude' }, planner: { agent: 'claude' } }))
  a.handle('tedStops', () => [])
  const open = async () => {
    await user().click(await screen.findByRole('button', { name: 'widgets' }))
    await user().click(within(nav()).getByRole('button', { name: /^Coordinator/ }))
    return screen.findByRole('region', { name: 'Coordinator' })
  }
  const changed = () => a.emit({ type: 'coordinator-changed', factoryId: 'f1', chatId: 'k1' })
  return { a, shown, open, changed }
}

test('the Coordinator draws its conversation like a Task thread: your messages to the Coordinator, TED’s continuation and receipts as event lines', async () => {
  const { a, open } = withCoordinator()
  a.mount()
  const pane = await open()
  const chat = await within(pane).findByRole('region', { name: 'Run chat' })
  expect(within(chat).getByText('Start with NB-1.')).toBeTruthy()
  expect(within(chat).getByText('What should we work on next?')).toBeTruthy()
  const fromTed = within(chat).getByText(`From TED · ${continuation}`)
  expect(fromTed.closest('li')).toBeTruthy()
  expect(within(chat).queryByRole('button', { name: /From TED/ })).toBeNull()
  expect(within(chat).getAllByText('Nabha Cosley')).toHaveLength(2)
  expect(within(chat).getAllByText(/to the Coordinator/)).toHaveLength(2)
  expect(within(chat).queryByText(/to this Run only/)).toBeNull()
  const unsent = within(chat).getByText('Never mind that one.').closest('[data-queued]')
  expect(unsent?.textContent).toContain('Not sent')
  expect(within(chat).queryByRole('button', { name: 'Delete' })).toBeNull()
  const receipt = within(chat)
    .getByText(/Started NB-1 · Queued at Intake/)
    .closest('li')
  expect(receipt).toBeTruthy()
  expect(within(receipt as HTMLElement).getByRole('button', { name: 'Open Task' })).toBeTruthy()
  expect(within(pane).queryByText('Earlier Conversation')).toBeNull()
  expect(within(pane).queryByRole('button', { name: 'Stop response' })).toBeNull()
})

test('the Coordinator composer sends on Enter, queues while working and stops with the Run chat’s ■', async () => {
  const { a, shown, open, changed } = withCoordinator()
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
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('k1', { text: 'Start NB-2 too.' }))
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
    changed()
  })
  await within(pane).findByText('Queued')
  expect(within(pane).getByRole('button', { name: 'Delete' })).toBeTruthy()
  expect(within(pane).queryByRole('button', { name: 'Send now' })).toBeNull()
  expect(within(pane).getAllByText('Working').length).toBeGreaterThan(0)
  await user().click(within(pane).getByRole('button', { name: 'Stop the turn' }))
  expect(stop).toHaveBeenCalledWith('k1')
})

test('New chat opens the start page and leaves the open chat running; an ended chat opens read only and can be continued or deleted', async () => {
  const { a, shown, open } = withCoordinator()
  shown.chats = [summary(), ended]
  const continued = vi.fn(() => coordinator({ id: ended.id }))
  const deleted = vi.fn(() => null)
  a.handle('continueCoordinatorChat', continued)
  a.handle('deleteCoordinatorChat', deleted)
  a.mount()
  await open()
  const list = screen.getByRole('region', { name: 'Coordinator chats' })
  await user().click(within(list).getByRole('button', { name: 'New chat' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  const start = screen.getByRole('region', { name: 'Coordinator' })
  expect(await within(start).findByText('What needs your attention in widgets?')).toBeTruthy()
  expect(a.request).not.toHaveBeenCalledWith('stopCoordinator', expect.anything())

  await user().click(within(list).getByRole('button', { name: /Archive what merged/ }))
  const pane = await screen.findByRole('region', { name: 'Coordinator' })
  expect(await within(pane).findByText('Start with NB-1.')).toBeTruthy()
  expect(
    await within(pane).findByText('Read only. Continue this chat to send a message.'),
  ).toBeTruthy()
  expect(within(pane).queryByRole('textbox')).toBeNull()
  const details = screen.getByRole('complementary', { name: 'Coordinator details' })
  const titles = within(details)
    .getAllByRole('button')
    .map((b) => b.textContent)
  expect(titles.findIndex((t) => t?.includes('Added last'))).toBeLessThan(
    titles.findIndex((t) => t?.includes('Added first')),
  )

  await user().click(within(pane).getByRole('button', { name: 'Delete…' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('Delete this chat?')
  expect(dialog.textContent).not.toContain('stops this chat’s reply')
  await user().click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(deleted).not.toHaveBeenCalled()

  await user().click(within(pane).getByRole('button', { name: 'Continue' }))
  await vi.waitFor(() => expect(continued).toHaveBeenCalledWith('k0'))

  await user().click(within(pane).getByRole('button', { name: 'Delete…' }))
  await user().click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
  )
  await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith('k0'))
})

test('the chat list shows no status, marks a chat that waits for you, and its right-click menu offers Delete, plus Continue on an ended chat', async () => {
  const { a, shown, open } = withCoordinator()
  shown.coordinator = coordinator({ status: 'working' })
  shown.chats = [summary({ status: 'working', waiting: true }), ended]
  const continued = vi.fn(() => coordinator({ id: ended.id }))
  const deleted = vi.fn(() => null)
  a.handle('continueCoordinatorChat', continued)
  a.handle('deleteCoordinatorChat', deleted)
  a.mount()
  await open()
  const list = screen.getByRole('region', { name: 'Coordinator chats' })
  const row = (name: RegExp) => within(list).getByRole('button', { name })
  await within(list).findByRole('button', { name: /What should we work on next\?/ })
  expect(within(list).queryByText('Working')).toBeNull()
  expect(
    within(row(/What should we work on next\?/)).getByRole('img', { name: 'Waiting for you' }),
  ).toBeTruthy()
  expect(within(row(/Archive what merged/)).queryByRole('img')).toBeNull()

  fireEvent.contextMenu(row(/What should we work on next\?/))
  const current = await screen.findByRole('menu', { name: 'Chat' })
  expect(
    within(current)
      .getAllByRole('menuitem')
      .map((i) => i.textContent),
  ).toEqual(['Delete…'])
  await user().click(within(current).getByRole('menuitem', { name: 'Delete…' }))
  const stop = await screen.findByRole('dialog')
  expect(stop.textContent).toContain('The Coordinator stops this chat’s reply')
  await user().click(within(stop).getByRole('button', { name: 'Delete' }))
  await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith('k1'))

  fireEvent.contextMenu(row(/Archive what merged/))
  const menu = await screen.findByRole('menu', { name: 'Ended chat' })
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent),
  ).toEqual(['Continue', 'Delete…'])
  await user().click(within(menu).getByRole('menuitem', { name: 'Continue' }))
  await vi.waitFor(() => expect(continued).toHaveBeenCalledWith('k0'))
})

test('leaving the Coordinator and coming back shows the same conversation', async () => {
  const { a, open } = withCoordinator()
  a.mount()
  const pane = await open()
  await within(pane).findByText('Start with NB-1.')
  await user().click(within(nav()).getByRole('button', { name: 'Task views' }))
  await user().click(within(nav()).getByRole('button', { name: 'Board' }))
  expect(screen.queryByText('Start with NB-1.')).toBeNull()
  await user().click(within(nav()).getByRole('button', { name: /^Coordinator/ }))
  const back = await screen.findByRole('region', { name: 'Coordinator' })
  expect(await within(back).findByText('Start with NB-1.')).toBeTruthy()
  expect(within(back).getByText('What should we work on next?')).toBeTruthy()
})

test('with no chats the Coordinator opens the start page, and sending starts a chat', async () => {
  const { a, shown, open } = withCoordinator()
  shown.chats = []
  const started = vi.fn(() => coordinator())
  a.handle('startCoordinatorChat', started)
  a.mount()
  const pane = await open()
  await within(pane).findByRole('heading', { name: /What needs your attention/ })
  await user().click(within(pane).getByRole('button', { name: 'What should we work on next?' }))
  const box = within(pane).getByRole('textbox', { name: 'Message to the Coordinator' })
  fireEvent.keyDown(box, { key: 'Enter' })
  await vi.waitFor(() =>
    expect(started).toHaveBeenCalledWith('f1', {
      text: 'What should we work on next?',
      agent: 'claude',
    }),
  )
  expect(
    await within(await screen.findByRole('region', { name: 'Coordinator' })).findByText(
      'Start with NB-1.',
    ),
  ).toBeTruthy()
})

test('the sidebar lists Coordinator above Tasks and shows Working only while it works', async () => {
  const { a, shown, changed } = withCoordinator()
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'widgets' }))
  const names = within(nav())
    .getAllByRole('button')
    .map((button) => button.textContent)
    .filter(Boolean)
  expect(names.indexOf('Coordinator')).toBeGreaterThan(-1)
  expect(names.indexOf('Dashboard')).toBeLessThan(names.indexOf('Coordinator'))
  expect(names.filter((name) => name === 'Dashboard')).toHaveLength(1)
  expect(names.indexOf('Coordinator')).toBe(names.indexOf('Tasks') - 1)
  const row = () => within(nav()).getByRole('button', { name: /^Coordinator/ })
  expect(within(row()).queryByRole('img')).toBeNull()
  await act(async () => {
    shown.statuses = [{ factoryId: 'f1', status: 'working' }]
    changed()
  })
  expect(await within(row()).findByRole('img', { name: 'Working' })).toBeTruthy()
  await act(async () => {
    shown.statuses = [{ factoryId: 'f1', status: 'failed' }]
    changed()
  })
  expect(await within(row()).findByRole('img', { name: 'The Coordinator failed' })).toBeTruthy()
  expect(within(row()).queryByRole('img', { name: 'Working' })).toBeNull()
  await act(async () => {
    shown.statuses = [{ factoryId: 'f1', status: 'ready' }]
    changed()
  })
  await vi.waitFor(() => expect(within(row()).queryByRole('img')).toBeNull())
})

test('Autopilot is switched in Settings → General, not in the sidebar', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  expect(within(nav()).queryByRole('button', { name: /Autopilot/i })).toBeNull()
  expect(within(nav()).queryByText('Autopilot is on')).toBeNull()
  await a.settings()
  await user().click(await screen.findByRole('switch', { name: 'Autopilot across all Factories' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', { overnightMode: true })
  await user().keyboard('{Escape}')
  expect(await within(nav()).findByText('Autopilot is on')).toBeTruthy()
  expect(within(nav()).queryByRole('button', { name: /Autopilot/i })).toBeNull()
})

const notice = () => screen.queryByRole('status', { name: 'Autopilot is on' })
const noticeText =
  '▲ Autopilot is on. Sign-Offs set here are off until you turn it off in Settings → General. Setup Tasks and Tasks that change a Factory’s settings still wait for you.'

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

test('the Factory Workflow section shows the overnight notice only while Autopilot is on', async () => {
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
        dispatch={vi.fn()}
        section="workflow"
      />
    ),
    () => screen.findByRole('heading', { name: 'Workflow' }),
  )
  const workflow = screen.getByRole('region', { name: 'Workflow' })
  expect(within(workflow).getByRole('status', { name: 'Autopilot is on' })).toBeTruthy()
})

test('the Library page shows the overnight notice only while Autopilot is on', async () => {
  const a = appState()
  bridge({ library: () => new Promise(() => {}) })
  await checkNotice(
    () => <LibraryPage settings={a.state.settings} dispatch={vi.fn()} />,
    () => screen.findByRole('heading', { name: 'Library' }),
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
  const control = await screen.findByRole('switch', { name: 'Autopilot across all Factories' })
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
  const { a, open, changed } = withCoordinator()
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
  act(() => changed())
  await within(region).findByRole('alert')
  expect(within(region).getByText('Start with NB-1.')).toBeTruthy()
})

test('a Coordinator confirmation card shows its warnings and sends the human’s choices on Confirm', async () => {
  const { a, shown, open } = withCoordinator()
  shown.coordinator = coordinator({
    confirmations: [
      {
        id: 'c1',
        kind: 'archive',
        operation: 'archive-1',
        fingerprint: 'f',
        askedAt: createdAt,
        tasks: [
          {
            id: 'NB-3',
            displayId: 'NB-3',
            title: 'Export to CSV',
            stage: 'review',
            descendants: [{ id: 'NB-11', displayId: 'NB-11', title: 'CSV headers' }],
            blockedTasks: [],
            pullRequests: [{ repo: 'ted', number: 212 }],
            working: true,
          },
        ],
      },
    ],
  })
  const answer = vi.fn(() => shown.coordinator)
  a.handle('answerCoordinatorConfirmation', answer)
  a.mount()
  const pane = await open()
  const card = await within(pane).findByRole('region', { name: 'Archive NB-3?' })
  expect(card.textContent).toContain('NB-3’s Task Lead is working')
  const close = within(card).getByRole('checkbox', { name: /Close the pull request/ })
  expect((close as HTMLInputElement).checked).toBe(false)
  await user().click(close)
  await user().click(within(card).getByRole('radio', { name: /Detach them and keep them/ }))
  await user().click(within(card).getByRole('button', { name: 'Archive NB-3' }))
  expect(answer).toHaveBeenCalledWith('k1', 'c1', {
    decision: 'confirm',
    choices: { 'NB-3': { closePullRequests: true, children: 'detach' } },
  })
})
