// @vitest-environment jsdom
import type {
  ChatRequest,
  Coordinator,
  CoordinatorChatSummary,
  CoordinatorStatus,
  MessageBox,
  Plan,
  RunChat,
} from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { OvernightContext } from '../src/renderer/overnight.tsx'
import { LibraryPage } from '../src/renderer/settings/LibraryPage.tsx'
import { FactorySettings } from '../src/renderer/views/FactorySettings.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, expandFactory, user } from './support/component.ts'
import {
  coordinatorAgent,
  createdAt,
  factory,
  plannerAgent,
  settingsView,
  task,
} from './support/fixtures.ts'

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
    title: 'What should we work on next?',
    startedAt: createdAt,
    lead: { agent: 'claude' },
    status: 'ready',
    unsentMessages: [],
    confirmations: [],
    automationCards: [],
    requests: [],
    chatAgent: coordinatorAgent,
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
    chatAgent: coordinatorAgent,
    ...fields,
  }
}

const later = (minutes: number) => new Date(Date.parse(createdAt) + minutes * 60_000).toISOString()

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
  a.handle('factoryAgents', () => [
    coordinatorAgent,
    {
      id: 'triager',
      name: 'Triager',
      source: 'factory',
      powers: ['ask', 'read_code', 'run_commands'],
      commands: [{ name: 'test', command: 'pnpm vitest run' }],
    },
    plannerAgent,
  ])
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
  const open = async (region = 'Coordinator') => {
    await expandFactory()
    await user().click(within(nav()).getByRole('button', { name: /^Agents/ }))
    return screen.findByRole('region', { name: region })
  }
  const changed = () => a.emit({ type: 'coordinator-changed', factoryId: 'f1', chatId: 'k1' })
  return { a, shown, open, changed }
}

test('the Coordinator draws its conversation like a Task thread: your messages to the Coordinator, Ted’s continuation and receipts as event lines, and its questions as cards you answer', async () => {
  const { a, shown, open } = withCoordinator()
  const question: ChatRequest = {
    id: 'q1',
    chatId: 'k1',
    runId: 'r2',
    kind: 'question',
    body: 'Which repo first?',
    choices: ['widgets', 'gadgets'],
    createdAt,
  }
  shown.coordinator = coordinator({ requests: [question] })
  const answered = vi.fn(() => shown.coordinator)
  a.handle('answerChatRequest', answered)
  a.mount()
  const pane = await open()
  const chat = await within(pane).findByRole('region', { name: 'Run chat' })
  expect(within(chat).getByText('Start with NB-1.')).toBeTruthy()
  expect(within(chat).getByText('What should we work on next?')).toBeTruthy()
  const fromTed = within(chat).getByText(`From Ted · ${continuation}`)
  expect(fromTed.closest('li')).toBeTruthy()
  expect(within(chat).queryByRole('button', { name: /From Ted/ })).toBeNull()
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

  const card = within(chat).getByRole('region', { name: 'Question from Coordinator' })
  expect(within(card).getByText('Which repo first?')).toBeTruthy()
  await user().click(within(card).getByRole('radio', { name: 'gadgets' }))
  await user().click(within(card).getByRole('button', { name: /Send/ }))
  await vi.waitFor(() =>
    expect(answered).toHaveBeenCalledWith('k1', 'q1', { action: 'answer', choice: 'gadgets' }),
  )
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

test('a chat is renamed by clicking its title; New chat leaves the open chat running; an archived chat opens read only and can be unarchived or deleted', async () => {
  const { a, shown, open } = withCoordinator()
  shown.chats = [summary(), ended]
  const unarchived = vi.fn(() => coordinator({ id: ended.id }))
  const archived = vi.fn(() => coordinator({ endedAt: createdAt }))
  const deleted = vi.fn(() => null)
  const renamed = vi.fn(() => coordinator({ title: 'Release review' }))
  a.handle('unarchiveCoordinatorChat', unarchived)
  a.handle('archiveCoordinatorChat', archived)
  a.handle('deleteCoordinatorChat', deleted)
  a.handle('renameCoordinatorChat', renamed)
  a.mount()
  const chat = await open()
  await user().click(
    await within(chat).findByRole('button', { name: 'What should we work on next?' }),
  )
  const title = within(chat).getByRole('textbox', { name: 'Title' })
  await user().clear(title)
  await user().type(title, 'Release review{Enter}')
  await vi.waitFor(() => expect(renamed).toHaveBeenCalledWith('k1', 'Release review'))
  await user().click(within(chat).getByRole('button', { name: 'Archive' }))
  await vi.waitFor(() => expect(archived).toHaveBeenCalledWith('k1'))

  const list = screen.getByRole('region', { name: 'Agent chats' })
  await user().click(within(list).getByRole('button', { name: 'New chat' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  const start = await screen.findByRole('region', { name: 'Coordinator' })
  expect(await within(start).findByText('What needs your attention in widgets?')).toBeTruthy()
  expect(a.request).not.toHaveBeenCalledWith('stopCoordinator', expect.anything())

  expect(within(list).queryByRole('button', { name: /Archive what merged/ })).toBeNull()
  await user().click(within(list).getByRole('button', { name: /Archived · 1/ }))
  await user().click(within(list).getByRole('button', { name: /Archive what merged/ }))
  const pane = await screen.findByRole('region', { name: 'Coordinator' })
  expect(await within(pane).findByText('Start with NB-1.')).toBeTruthy()
  expect(
    await within(pane).findByText('Read only. Unarchive this chat to send a message.'),
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

  await user().click(within(pane).getByRole('button', { name: 'Unarchive' }))
  await vi.waitFor(() => expect(unarchived).toHaveBeenCalledWith('k0'))

  await user().click(within(pane).getByRole('button', { name: 'Delete…' }))
  await user().click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
  )
  await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith('k0'))
})

test('Agents lists two Coordinator chats and a planning chat in one list, newest first, and each row opens its own conversation', async () => {
  const { a, shown, open } = withCoordinator()
  const second = summary({ id: 'k2', title: 'Clear the Validate backlog', lastAt: later(2) })
  shown.chats = [summary({ lastAt: later(1) }), second]
  const plan: Plan = {
    id: 'p1',
    factoryId: 'f1',
    factoryKey: 'NB',
    title: 'Offline notes',
    message: 'Plan offline notes',
    agent: 'codex',
    model: 'gpt-5',
    status: 'idle',
    createdAt,
    lastAt: later(3),
    runId: 'p1',
    createdTasks: 0,
    chatAgent: plannerAgent,
  }
  a.handle('listPlans', () => [plan])
  a.handle('getPlan', () => ({ plan, requests: [], tasks: [] }))
  a.handle('coordinator', (id) =>
    id === 'k2'
      ? coordinator({ id: 'k2', opening: second.title, runIds: ['r3'] })
      : shown.coordinator,
  )
  a.handle('coordinatorChat', (id) => {
    const chat = conversation()
    if (id !== 'k2') return chat
    return {
      ...chat,
      items: [{ kind: 'agent', id: 'a2', text: 'Two Tasks wait in Validate.', at: createdAt }],
    }
  })
  a.handle('getRunChat', (id) => ({
    run: {
      id,
      name: 'Planner',
      role: 'run',
      agent: 'codex',
      state: 'idle',
      startedAt: createdAt,
      current: true,
    },
    items: [
      { kind: 'agent', id: 'pa', text: 'Two questions before I propose Tasks.', at: createdAt },
    ],
  }))
  a.mount()
  await open('Planning chat')
  const list = screen.getByRole('region', { name: 'Agent chats' })
  await within(list).findByRole('button', { name: /Offline notes/ })
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => /Offline notes|Clear the Validate|What should we work/.test(t))
      .map((t) => (t.includes('Offline') ? 'p1' : t.includes('Validate') ? 'k2' : 'k1')),
  ).toEqual(['p1', 'k2', 'k1'])
  expect(await screen.findByText('Two questions before I propose Tasks.')).toBeTruthy()
  expect(
    within(screen.getByRole('complementary', { name: 'Planning chat details' })).getByText(
      'Codex · gpt-5',
    ),
  ).toBeTruthy()

  await user().click(within(list).getByRole('button', { name: /Clear the Validate backlog/ }))
  const second_ = await screen.findByRole('region', { name: 'Coordinator' })
  expect(await within(second_).findByText('Two Tasks wait in Validate.')).toBeTruthy()
  expect(within(second_).queryByText('Start with NB-1.')).toBeNull()

  await user().click(within(list).getByRole('button', { name: /What should we work on next\?/ }))
  await vi.waitFor(() => expect(screen.queryByText('Two Tasks wait in Validate.')).toBeNull())
  expect(await screen.findByText('Start with NB-1.')).toBeTruthy()

  await user().click(within(list).getByRole('button', { name: 'Display' }))
  await user().click(screen.getByRole('menuitemradio', { name: 'Agent' }))
  expect(within(list).getByRole('heading', { name: 'Coordinator · 2' })).toBeTruthy()
  expect(within(list).getByRole('heading', { name: 'Planner · 1' })).toBeTruthy()
})

test('the chat list names the Agent and status, marks a chat that waits for you, lists archived chats in their own section, and its right-click menu offers Archive or Unarchive and Delete', async () => {
  const { a, shown, open } = withCoordinator()
  shown.coordinator = coordinator({ status: 'working' })
  shown.chats = [summary({ status: 'working', waiting: true }), ended]
  const unarchived = vi.fn(() => coordinator({ id: ended.id }))
  const archived = vi.fn(() => coordinator({ endedAt: createdAt }))
  const deleted = vi.fn(() => null)
  a.handle('unarchiveCoordinatorChat', unarchived)
  a.handle('archiveCoordinatorChat', archived)
  a.handle('deleteCoordinatorChat', deleted)
  a.mount()
  await open()
  const list = screen.getByRole('region', { name: 'Agent chats' })
  const row = (name: RegExp) => within(list).getByRole('button', { name })
  await within(list).findByRole('button', { name: /What should we work on next\?/ })
  await user().click(within(list).getByRole('button', { name: /Archived · 1/ }))
  expect(within(row(/What should we work on next\?/)).getByText('Coordinator')).toBeTruthy()
  expect(within(row(/What should we work on next\?/)).getByText('Waiting on you')).toBeTruthy()
  expect(within(row(/Archive what merged/)).getAllByText(/Archived/).length).toBeGreaterThan(0)
  expect(
    within(screen.getByRole('region', { name: 'Archived chats' })).getByRole('button', {
      name: /Archive what merged/,
    }),
  ).toBeTruthy()
  expect(
    within(row(/What should we work on next\?/)).getByRole('img', { name: 'Waiting for you' }),
  ).toBeTruthy()
  expect(
    within(row(/Archive what merged/)).queryByRole('img', { name: 'Waiting for you' }),
  ).toBeNull()

  fireEvent.contextMenu(row(/What should we work on next\?/))
  const current = await screen.findByRole('menu', { name: 'Chat' })
  expect(
    within(current)
      .getAllByRole('menuitem')
      .map((i) => i.textContent),
  ).toEqual(['Archive', 'Delete…'])
  await user().click(within(current).getByRole('menuitem', { name: 'Archive' }))
  await vi.waitFor(() => expect(archived).toHaveBeenCalledWith('k1'))

  fireEvent.contextMenu(row(/What should we work on next\?/))
  const again = await screen.findByRole('menu', { name: 'Chat' })
  await user().click(within(again).getByRole('menuitem', { name: 'Delete…' }))
  const stop = await screen.findByRole('dialog')
  expect(stop.textContent).toContain('The Coordinator stops this chat’s reply')
  await user().click(within(stop).getByRole('button', { name: 'Delete' }))
  await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith('k1'))

  fireEvent.contextMenu(row(/Archive what merged/))
  const menu = await screen.findByRole('menu', { name: 'Archived chat' })
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent),
  ).toEqual(['Unarchive', 'Delete…'])
  await user().click(within(menu).getByRole('menuitem', { name: 'Unarchive' }))
  await vi.waitFor(() => expect(unarchived).toHaveBeenCalledWith('k0'))
})

test('leaving the Coordinator and coming back shows the same conversation', async () => {
  const { a, open } = withCoordinator()
  a.mount()
  const pane = await open()
  await within(pane).findByText('Start with NB-1.')
  await user().click(within(nav()).getByRole('button', { name: 'Task views' }))
  await user().click(within(nav()).getByRole('button', { name: 'Board' }))
  expect(screen.queryByText('Start with NB-1.')).toBeNull()
  await user().click(within(nav()).getByRole('button', { name: /^Agents/ }))
  const back = await screen.findByRole('region', { name: 'Coordinator' })
  expect(await within(back).findByText('Start with NB-1.')).toBeTruthy()
  const chat = within(back).getByRole('region', { name: 'Run chat' })
  expect(within(chat).getByText('What should we work on next?')).toBeTruthy()
})

test('with no chats Agents opens New chat; the Agent menu lists every Agent with its powers and source, switching it keeps the message, and sending starts a chat with the chosen Agent', async () => {
  const { a, shown, open } = withCoordinator()
  shown.chats = []
  const started = vi.fn(() => coordinator())
  a.handle('startCoordinatorChat', started)
  a.handle('messageDraft', (box) => ({
    draft:
      (box as MessageBox).kind === 'new-plan' ? { text: 'An older plan', attachments: [] } : null,
  }))
  a.mount()
  const pane = await open('Coordinator')
  await within(pane).findByRole('heading', { name: /What needs your attention/ })
  const agent = within(pane).getByRole('combobox', { name: 'Agent' })
  expect(agent).toHaveProperty('value', 'coordinator')
  await vi.waitFor(() =>
    expect(
      within(agent)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Coordinator', 'Planner', 'Triager']),
  )
  const coordinatorDetails = screen.getByRole('complementary', { name: 'Coordinator details' })
  expect(
    within(within(coordinatorDetails).getByRole('region', { name: 'Powers' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['Ask the user', 'Manage Tasks', 'Manage Automations', 'Manage Agents'])
  expect(within(coordinatorDetails).queryByRole('region', { name: 'Commands' })).toBeNull()
  await user().click(within(pane).getByRole('button', { name: 'What should we work on next?' }))
  await user().selectOptions(agent, 'planner')
  const planning = await screen.findByRole('region', { name: 'New planning chat' })
  await vi.waitFor(() =>
    expect(
      within(planning).getByRole('textbox', { name: 'What do you want to plan?' }),
    ).toHaveProperty('value', 'What should we work on next?'),
  )
  await user().selectOptions(within(planning).getByRole('combobox', { name: 'Agent' }), 'triager')
  const back = await screen.findByRole('region', { name: 'Triager' })
  expect(within(back).getByRole('heading', { name: /New chat with Triager/ })).toBeTruthy()
  const details = screen.getByRole('complementary', { name: 'Triager details' })
  expect(
    within(within(details).getByRole('region', { name: 'Powers' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['Ask the user', 'Read the code', 'Run commands in the copy'])
  const commands = within(within(details).getByRole('region', { name: 'Commands' }))
  expect(commands.getByText('test')).toBeTruthy()
  expect(commands.getByText('pnpm vitest run')).toBeTruthy()
  expect(
    within(within(details).getByRole('region', { name: 'From' })).getByText('This repo'),
  ).toBeTruthy()
  expect(within(details).queryByRole('heading', { name: 'Tasks in this chat' })).toBeNull()
  const box = within(back).getByRole('textbox', { name: 'Message to Triager' })
  await vi.waitFor(() => expect(box).toHaveProperty('value', 'What should we work on next?'))
  fireEvent.keyDown(box, { key: 'Enter' })
  await vi.waitFor(() =>
    expect(started).toHaveBeenCalledWith('f1', {
      text: 'What should we work on next?',
      agent: 'claude',
      agentId: 'triager',
    }),
  )
  expect(await screen.findByText('Start with NB-1.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'New chat' })).toBeNull()
})

test('a start that answers after New chat was clicked leaves the new start page open', async () => {
  const { a, shown, open, changed } = withCoordinator()
  shown.chats = []
  const answer = deferred<Coordinator>()
  a.handle('startCoordinatorChat', () => answer.promise)
  a.mount()
  const pane = await open('Coordinator')
  await within(pane).findByRole('heading', { name: /What needs your attention/ })
  await user().click(within(pane).getByRole('button', { name: 'What should we work on next?' }))
  fireEvent.keyDown(within(pane).getByRole('textbox', { name: 'Message to the Coordinator' }), {
    key: 'Enter',
  })
  await act(async () => {
    shown.chats = [summary()]
    changed()
  })
  const list = screen.getByRole('region', { name: 'Agent chats' })
  await user().click(
    await within(list).findByRole('button', { name: /What should we work on next\?/ }),
  )
  expect(await screen.findByText('Start with NB-1.')).toBeTruthy()
  await user().click(within(list).getByRole('button', { name: 'New chat' }))
  expect(await screen.findByRole('heading', { name: 'New chat' })).toBeTruthy()
  await act(async () => answer.resolve(coordinator()))
  expect(screen.getByRole('heading', { name: 'New chat' })).toBeTruthy()
  expect(screen.queryByText('Start with NB-1.')).toBeNull()
})

test('the sidebar lists Agents above Tasks, with no Coordinator or Plans row, and shows Working only while a Coordinator works', async () => {
  const { a, shown, changed } = withCoordinator()
  a.mount()
  await expandFactory()
  const names = within(nav())
    .getAllByRole('button')
    .map((button) => button.textContent)
    .filter(Boolean)
  expect(names.indexOf('Agents')).toBeGreaterThan(-1)
  expect(names).not.toContain('Coordinator')
  expect(names).not.toContain('Plans')
  expect(names.indexOf('Dashboard')).toBeLessThan(names.indexOf('Agents'))
  expect(names.filter((name) => name === 'Dashboard')).toHaveLength(1)
  expect(names.indexOf('Agents')).toBe(names.indexOf('Tasks') - 1)
  const row = () => within(nav()).getByRole('button', { name: /^Agents/ })
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
  expect(await within(row()).findByRole('img', { name: 'A Coordinator chat failed' })).toBeTruthy()
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

test('an Automation card shows the draft, offers Start the Tasks it creates for a check, and sends the human’s choice on Create', async () => {
  const { a, shown, open } = withCoordinator()
  shown.coordinator = coordinator({
    automationCards: [
      {
        id: 'ac1',
        kind: 'create',
        operation: 'op-1',
        askedAt: createdAt,
        name: 'Nightly tests',
        requestHash: 'h',
        rows: [
          { label: 'Schedule', value: 'Every day at 3:00' },
          { label: 'Check command', value: 'pnpm check', long: true },
        ],
        nextFirings: [],
        offersStartTasks: true,
      },
      {
        id: 'ac2',
        kind: 'edit',
        operation: 'op-2',
        askedAt: createdAt,
        name: 'Morning intake',
        automationId: 'a1',
        requestHash: 'h2',
        rows: [{ label: 'Schedule', before: 'Weekdays at 8:00', value: 'Every day at 7:00' }],
        nextFirings: [],
        offersStartTasks: false,
        answer: {
          decision: 'confirm',
          at: createdAt,
          refused: '“Morning intake” changed after this card was shown',
        },
      },
    ],
  })
  const answer = vi.fn(() => shown.coordinator)
  a.handle('answerAutomationCard', answer)
  a.mount()
  const pane = await open()
  const card = await within(pane).findByRole('region', {
    name: 'Create Automation “Nightly tests”?',
  })
  expect(card.textContent).toContain('pnpm check')
  expect(card.textContent).toContain('Nothing is saved until you click Create.')
  const start = within(card).getByRole('checkbox', { name: /Start the Tasks it creates/ })
  expect((start as HTMLInputElement).checked).toBe(false)
  await user().click(start)
  await user().click(within(card).getByRole('button', { name: 'Create' }))
  expect(answer).toHaveBeenCalledWith('k1', 'ac1', { decision: 'confirm', startTasks: true })

  const refused = within(pane).getByRole('region', { name: 'Save changes to “Morning intake”?' })
  expect(within(refused).getByRole('row', { name: /Schedule/ }).textContent).toContain(
    'Weekdays at 8:00',
  )
  expect(refused.textContent).toContain(
    'Not done: “Morning intake” changed after this card was shown. Nothing changed.',
  )
  expect(within(refused).queryByRole('button', { name: 'Save' })).toBeNull()
})
