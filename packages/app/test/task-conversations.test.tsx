// @vitest-environment jsdom
import type { ChatItem, RunChat, RunSummary } from '@ted/protocol'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import {
  conversationInStage,
  conversationRows,
  taskConversationTabs,
} from '../src/renderer/task-conversations.ts'
import { appState } from './support/app.tsx'
import { deferred, required, user } from './support/component.ts'
import { comment, createdAt, task } from './support/fixtures.ts'

const lead: RunSummary & { role: 'lead' } = {
  id: 'lead',
  taskId: 'NB-1',
  role: 'lead',
  name: 'Task Lead',
  agent: 'codex',
  state: 'working',
  current: true,
  startedAt: createdAt,
}
const sub: RunSummary & { role: 'sub-agent' } = {
  ...lead,
  id: 'review',
  role: 'sub-agent',
  parentRunId: lead.id,
  name: 'Reviewer',
  agent: 'claude',
}
const old: RunSummary = {
  ...lead,
  id: 'earlier',
  state: 'finished',
  current: false,
  startedAt: '2026-11-08T12:00:00.000Z',
}

function discussion() {
  const a = appState()
  let current = task({ stage: 'work', commentBox: 'live', leadRunId: lead.id, runs: [lead, sub] })
  let runs: RunSummary[] = [lead, sub, old]
  const chats = new Map<string, RunChat>([
    [
      lead.id,
      { run: lead, items: [{ kind: 'agent', id: 'a1', text: 'Current exchange.', at: createdAt }] },
    ],
    [
      sub.id,
      {
        run: sub,
        items: [{ kind: 'agent', id: 'a1', text: 'Reviewing the change.', at: createdAt }],
      },
    ],
    [
      old.id,
      {
        run: old,
        items: [{ kind: 'agent', id: 'a1', text: 'Yesterday’s exchange.', at: old.startedAt }],
      },
    ],
  ])
  a.state.tasks = [current]
  a.handle('listTaskRuns', () => runs)
  a.handle('getRunChat', (id) => required(chats.get(String(id))))
  a.handle('openRunTab', (_id, id) => {
    const run = required(runs.find((run) => run.id === id))
    current = {
      ...current,
      tabs: [
        ...current.tabs.filter((tab) => tab.runId !== id),
        { runId: run.id, name: run.name, state: run.state, agent: run.agent },
      ],
    }
    a.state.tasks = [current]
    a.emit({ type: 'task-updated', task: current })
  })
  return {
    ...a,
    chats,
    async open() {
      a.mount()
      await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
      await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
      await screen.findByText('Current exchange.')
      return screen.getByRole('region', { name: 'Task thread' })
    },
    async finishSub() {
      runs = runs.map((run) => (run.id === sub.id ? { ...run, state: 'finished' } : run))
      chats.set(sub.id, { ...required(chats.get(sub.id)), run: { ...sub, state: 'finished' } })
      current = {
        ...current,
        runs: [lead],
        tabs: current.tabs.map((tab) =>
          tab.runId === sub.id ? { ...tab, state: 'finished' } : tab,
        ),
      }
      await a.emitTask(current)
    },
  }
}

test('Task Lead combines Comments and chat by time and keeps identical distinct messages', async () => {
  const a = discussion()
  a.handle('listComments', () => [
    comment({
      kind: 'note',
      author: { kind: 'human' },
      body: 'Current exchange.',
      readAt: createdAt,
    }),
  ])
  const view = await a.open()
  expect(within(view).getAllByText('Current exchange.')).toHaveLength(2)
  expect(within(view).getAllByRole('tab', { name: 'Task Lead' })).toHaveLength(1)
  expect(within(view).queryByRole('tab', { name: 'Thread' })).toBeNull()
  expect(within(view).getByRole('tab', { name: /Reviewer/ })).toBeTruthy()
  expect(a.request).not.toHaveBeenCalledWith('getRunChat', old.id)
})

test('History expands an earlier conversation inline and reports unavailable retained output', async () => {
  const a = discussion()
  required(a.chats.get(old.id)).items.push({
    kind: 'ted',
    id: 'output-not-kept',
    title: 'Earlier output no longer kept',
    text: 'TED kept only the newest part of this Run’s output.',
  })
  const view = within(await a.open())
  await user().click(view.getByRole('button', { name: /^History/ }))
  const history = within(screen.getByRole('region', { name: 'Conversation history' }))
  expect(history.getByText('Earlier conversations')).toBeTruthy()
  await user().click(history.getByRole('button', { name: /Earlier conversation/ }))
  await view.findByText('Yesterday’s exchange.')
  expect(view.getByText('Current exchange.')).toBeTruthy()
  expect(view.getByText('Earlier output no longer kept')).toBeTruthy()
  expect(view.getAllByRole('tab', { name: 'Task Lead' })).toHaveLength(1)
})

test('a selected sub-agent stays open when it finishes and reopens from History after leaving', async () => {
  const a = discussion()
  const view = within(await a.open())
  await user().click(view.getByRole('tab', { name: /Reviewer/ }))
  await view.findByText('Reviewing the change.')
  await a.finishSub()
  expect(view.getByRole('tab', { name: /Reviewer/ }).getAttribute('aria-selected')).toBe('true')
  await user().click(view.getByRole('tab', { name: 'Task Lead' }))
  expect(view.queryByRole('tab', { name: /Reviewer/ })).toBeNull()
  await user().click(view.getByRole('button', { name: /^History/ }))
  await user().click(
    await within(screen.getByRole('region', { name: 'Conversation history' })).findByRole(
      'button',
      { name: /Reviewer/ },
    ),
  )
  await view.findByText('Reviewing the change.')
  expect(view.getByRole('textbox', { name: 'Message to this Run' })).toHaveProperty(
    'disabled',
    true,
  )
})

test('main composer sends to the current Run and retains queued message controls', async () => {
  const a = discussion()
  a.handle('sendRunMessage', (id, text) => {
    const chat = required(a.chats.get(String(id)))
    chat.items.push({
      kind: 'human',
      id: 'queued',
      text: String(text),
      at: createdAt,
      sent: false,
      queued: true,
    })
    a.emit({ type: 'run-output', runId: lead.id })
    return { id: 'queued', runId: lead.id, text, at: createdAt, queued: true }
  })
  const view = within(await a.open())
  fireEvent.change(view.getByRole('textbox', { name: 'Message the Task Lead' }), {
    target: { value: 'Keep the history.' },
  })
  await user().click(view.getByRole('button', { name: 'Send' }))
  expect(a.request).toHaveBeenCalledWith('sendRunMessage', lead.id, 'Keep the history.', {
    interrupt: false,
  })
  await view.findByText('Queued')
  expect(view.getByRole('button', { name: 'Delete' })).toBeTruthy()
})

test('permissions shared by Task history and Run chat have one approval control', async () => {
  const a = discussion()
  const request = comment({
    kind: 'permission',
    body: 'Allow reading the source?',
    permission: { command: 'cat source.ts' },
    readAt: createdAt,
  })
  a.handle('listComments', () => [request])
  required(a.chats.get(lead.id)).items.push({
    kind: 'permission',
    id: request.id,
    request,
    at: createdAt,
  })
  const view = within(await a.open())
  expect(view.getAllByRole('button', { name: 'Approve' })).toHaveLength(1)
  await user().click(view.getByRole('tab', { name: /Reviewer/ }))
  await user().click(view.getByRole('button', { name: 'View in Task Lead' }))
  expect(view.getByRole('button', { name: 'Approve' })).toBeTruthy()
})

test('Comments stay visible if the live chat fails, and History has a retryable error', async () => {
  const a = discussion()
  a.handle('listComments', () => [
    comment({
      kind: 'note',
      author: { kind: 'human' },
      body: 'A saved Comment.',
      readAt: createdAt,
    }),
  ])
  const pending = deferred<RunChat>()
  a.handle('getRunChat', () => pending.promise)
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  await screen.findByText('A saved Comment.')
  await act(async () => pending.reject(new Error('Conversation unavailable')))
  expect(screen.getByText('A saved Comment.')).toBeTruthy()
  expect(await screen.findByText('Conversation unavailable')).toBeTruthy()
  a.handle('listTaskRuns', () => Promise.reject(new Error('History unavailable')))
  await act(async () => a.emit({ type: 'task-updated', task: a.state.tasks[0] ?? task() }))
  await user().click(
    within(screen.getByRole('region', { name: 'Task thread' })).getByRole('button', {
      name: /^History/,
    }),
  )
  await screen.findByText('History unavailable')
  expect(
    within(screen.getByRole('region', { name: 'Conversation history' })).getByRole('button', {
      name: 'Try again',
    }),
  ).toBeTruthy()
})

test('mixing Task rows preserves Run order, dated ties, undated context and queued tail', () => {
  const items: ChatItem[] = [
    { kind: 'agent', id: 'first', text: 'First', at: '2026-11-09T12:01:00Z' },
    { kind: 'tool', id: 'tool', tool: 'Read', title: 'file', status: 'done' },
    { kind: 'human', id: 'queue', text: 'Later', at: createdAt, sent: false, queued: true },
  ]
  const rows = conversationRows(
    items,
    [
      { id: 'before', at: '2026-11-09T12:00:30Z' },
      { id: 'tie', at: '2026-11-09T12:01:00Z' },
      { id: 'later', at: '2026-11-09T12:02:00Z' },
    ],
    createdAt,
  )
  expect(rows.map((row) => ('item' in row ? row.item.id : row.extra.id))).toEqual([
    'before',
    'first',
    'tool',
    'tie',
    'later',
    'queue',
  ])
  expect(
    conversationInStage(
      items,
      createdAt,
      [
        { stage: 'work', at: createdAt },
        { stage: 'validate', at: '2026-11-09T12:03:00Z' },
      ],
      'work',
    ),
  ).toEqual(items)
})

test('automatic tabs exclude the Task Lead, deduplicate opened live tabs and retire finished tabs', () => {
  const current = task({
    leadRunId: lead.id,
    runs: [lead, sub],
    tabs: [{ runId: sub.id, agent: sub.agent, state: sub.state, name: sub.name }],
  })
  expect(taskConversationTabs(current).map((tab) => tab.runId)).toEqual([sub.id])
  const finished = {
    ...current,
    runs: [lead],
    tabs: [{ runId: sub.id, name: sub.name, agent: sub.agent, state: 'finished' as const }],
  }
  expect(taskConversationTabs(finished)).toEqual([])
  expect(taskConversationTabs(finished, sub.id).map((tab) => tab.runId)).toEqual([sub.id])
})

test('tools are collapsed and expand through the shared chat renderer', async () => {
  const a = discussion()
  required(a.chats.get(lead.id)).items.push({
    kind: 'tool',
    id: 'tool',
    tool: 'Read',
    title: 'source.ts',
    status: 'done',
    output: 'Source content.',
    at: createdAt,
  })
  const view = within(await a.open())
  expect(view.queryByText('Source content.')).toBeNull()
  await user().click(view.getByRole('button', { name: /Read source.ts/ }))
  expect(view.getByText('Source content.')).toBeTruthy()
})

test('the Task Lead draft survives switching to a sub-agent and back', async () => {
  const a = discussion()
  const view = within(await a.open())
  fireEvent.change(view.getByRole('textbox', { name: 'Message the Task Lead' }), {
    target: { value: 'A draft for the lead.' },
  })
  await user().click(view.getByRole('tab', { name: /Reviewer/ }))
  await view.findByText('Reviewing the change.')
  await user().click(view.getByRole('tab', { name: 'Task Lead' }))
  expect(view.getByRole('textbox', { name: 'Message the Task Lead' })).toHaveProperty(
    'value',
    'A draft for the lead.',
  )
})

test('the Task Lead composer keeps attachments on the Task Comment path', async () => {
  const a = discussion()
  a.handle('uploadAttachment', () => ({
    hash: 'file-hash',
    name: 'note.txt',
    mediaType: 'text/plain',
    size: 5,
  }))
  a.handle('postComment', () => comment({ kind: 'note', body: 'Read this file.' }))
  const view = within(await a.open())
  await user().upload(
    view.getByLabelText('Choose files to attach'),
    new File(['hello'], 'note.txt', { type: 'text/plain' }),
  )
  await view.findByRole('button', { name: 'Remove note.txt' })
  fireEvent.change(view.getByRole('textbox', { name: 'Message the Task Lead' }), {
    target: { value: 'Read this file.' },
  })
  await user().click(view.getByRole('button', { name: 'Send' }))
  expect(a.request).toHaveBeenCalledWith('postComment', 'NB-1', {
    body: 'Read this file.',
    attachments: [{ hash: 'file-hash', name: 'note.txt', mediaType: 'text/plain' }],
  })
  expect(a.request).not.toHaveBeenCalledWith(
    'sendRunMessage',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  )
})

test('the combined Task Lead view preserves side-chat routing', async () => {
  const a = discussion()
  const side = {
    id: 'side',
    sourceRunId: lead.id,
    snapshotAt: createdAt,
    truncated: false,
    state: 'ready',
    available: true,
    chat: {
      run: {
        ...lead,
        id: 'side',
        name: 'Side chat',
        role: 'side-chat',
        state: 'idle',
        current: false,
      },
      items: [{ kind: 'agent', id: 'side-answer', text: 'A separate snapshot answer.' }],
    },
  }
  a.handle('openSideChat', () => side)
  a.handle('sendSideChat', () => side)
  const view = within(await a.open())
  await user().click(view.getByRole('button', { name: 'Side chat' }))
  const panel = within(await screen.findByRole('region', { name: 'Side chat' }))
  await panel.findByText('A separate snapshot answer.')
  fireEvent.change(panel.getByRole('textbox', { name: 'Question for this side chat' }), {
    target: { value: 'Why this approach?' },
  })
  await user().click(panel.getByRole('button', { name: 'Send' }))
  expect(a.request).toHaveBeenCalledWith('sendSideChat', lead.id, 'Why this approach?')
  expect(a.request).not.toHaveBeenCalledWith(
    'sendRunMessage',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  )
  await user().click(panel.getByRole('button', { name: 'Close side chat' }))
  expect(view.getByRole('textbox', { name: 'Message the Task Lead' })).toBeTruthy()
})
