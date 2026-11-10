// @vitest-environment jsdom
import type { RunChat, RunSummary } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunChat as Conversation } from '../src/renderer/components/RunChat.tsx'
import { RunsSection } from '../src/renderer/components/RunsSection.tsx'
import { appState } from './support/app.tsx'
import { bridge, required, user } from './support/component.ts'
import { createdAt, task } from './support/fixtures.ts'

const lead: RunSummary = {
  id: 'r1',
  taskId: 'NB-1',
  name: 'Task Lead',
  agent: 'claude',
  role: 'lead',
  state: 'working',
  current: true,
  startedAt: createdAt,
}

test('Run chat queues ordinary messages, deletes a queued message and interrupts on command Enter', async () => {
  let chat: RunChat = {
    run: lead,
    items: [{ kind: 'agent', id: 'a1', text: 'Working on the sync layer.' }],
  }
  const api = bridge({
    getRunChat: () => chat,
    sendRunMessage: (_id, text, interrupt) => {
      chat = {
        ...chat,
        items: [
          ...chat.items,
          { kind: 'human', id: 'm1', text: String(text), at: createdAt, sent: false, queued: true },
        ],
      }
      api.emit({ type: 'run-output', runId: 'r1' })
      return { id: 'm1', runId: 'r1', text, at: createdAt, queued: !interrupt }
    },
    deleteQueuedMessage: () => {
      chat = { ...chat, items: chat.items.filter((i) => i.id !== 'm1') }
      api.emit({ type: 'run-output', runId: 'r1' })
    },
  })
  render(<Conversation runId="r1" />)
  await screen.findByText('Working on the sync layer.')
  const box = screen.getByRole('textbox', { name: 'Message to this Run' })
  fireEvent.change(box, { target: { value: 'Leave archived notes alone.' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await screen.findByText('Queued')
  expect(api.request).toHaveBeenCalledWith(
    'sendRunMessage',
    'r1',
    'Leave archived notes alone.',
    false,
  )
  await user().click(screen.getByRole('button', { name: 'Delete' }))
  expect(screen.queryByText('Leave archived notes alone.')).toBeNull()
  expect(api.request).toHaveBeenCalledWith('deleteQueuedMessage', 'r1', 'm1')
  fireEvent.change(box, { target: { value: 'Keep the fix in the swipe handler.' } })
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
  await vi.waitFor(() =>
    expect(api.request).toHaveBeenCalledWith(
      'sendRunMessage',
      'r1',
      'Keep the fix in the swipe handler.',
      true,
    ),
  )
  await act(async () => {
    chat = {
      run: { ...lead, state: 'idle' },
      items: [
        { kind: 'interrupted', id: 'i1', at: createdAt },
        { kind: 'agent', id: 'a2', text: 'Redirected.' },
      ],
    }
    api.emit({ type: 'run-output', runId: 'r1' })
  })
  expect(screen.getByText('Redirected.')).toBeTruthy()
  expect(screen.getByText(/Interrupted by you/)).toBeTruthy()
})

test('Runs nests sub-agents, opens their chat, stops the sub-agent and collapses to its summary', async () => {
  const open = vi.fn()
  const api = bridge({ stopRun: vi.fn() })
  const view = render(
    <RunsSection
      runs={[
        { ...lead, onSubAgents: true },
        {
          ...lead,
          id: 'r2',
          parentRunId: 'r1',
          role: 'sub-agent',
          name: 'Reviewer',
          agent: 'codex',
          model: 'gpt-6-mini',
        },
      ]}
      onOpenRun={open}
    />,
  )
  const rows = screen.getAllByRole('listitem')
  expect(rows.map((r) => r.getAttribute('data-run'))).toEqual(['r1', 'r2'])
  await user().click(within(required(rows[1])).getByRole('button', { name: /Reviewer/ }))
  expect(open).toHaveBeenCalledWith('r2')
  await user().click(within(required(rows[1])).getByRole('button', { name: 'Stop Run' }))
  expect(api.request).toHaveBeenCalledWith('stopRun', 'r2')
  expect(screen.getByText('on sub-agents')).toBeTruthy()
  expect(screen.getByText('Codex · gpt-6-mini · default effort')).toBeTruthy()
  view.rerender(
    <RunsSection
      runs={[
        lead,
        {
          ...lead,
          id: 'r2',
          parentRunId: 'r1',
          role: 'sub-agent',
          name: 'Reviewer',
          state: 'finished',
          current: false,
        },
      ]}
      onOpenRun={open}
    />,
  )
  await user().click(screen.getByRole('button', { name: /stopped Run/ }))
  expect(document.querySelector('[data-run="r2"]')?.textContent).toContain('Reviewer')
  await user().click(screen.getByRole('button', { name: /^Runs/ }))
  expect(screen.queryByRole('list')).toBeNull()
})

test('Comment composer sends Enter and command Enter, while Shift Enter keeps a newline', async () => {
  const { CommentBox } = await import('../src/renderer/components/CommentBox.tsx')
  const { task } = await import('./support/fixtures.ts')
  const api = bridge({ postComment: vi.fn() })
  render(<CommentBox task={task({ commentBox: 'live' })} />)
  const u = user()
  const box = screen.getByRole('textbox', { name: 'Comment' })
  await u.type(box, 'First{Enter}')
  expect(api.request).toHaveBeenCalledWith('postComment', 'NB-1', 'First', [])
  expect((box as HTMLTextAreaElement).value).toBe('')
  await u.type(box, 'First line{Shift>}{Enter}{/Shift}Second line')
  expect((box as HTMLTextAreaElement).value).toBe('First line\nSecond line')
  await u.keyboard('{Meta>}{Enter}{/Meta}')
  expect(api.request).toHaveBeenCalledWith('postComment', 'NB-1', 'First line\nSecond line', [])
})

test('opening a sub-agent from Task details selects its actual Conversation and tab', async () => {
  const a = appState()
  const sub: RunSummary = {
    ...lead,
    id: 'r2',
    role: 'sub-agent',
    parentRunId: 'r1',
    name: 'Reviewer',
    agent: 'codex',
    model: 'gpt-6-mini',
  }
  a.state.tasks = [task()]
  a.handle('listTaskRuns', () => [lead, sub])
  a.handle('getRunChat', (id) => {
    expect(id).toBe('r2')
    return { run: sub, items: [{ kind: 'agent', id: 'a2', text: 'I reviewed the offline queue.' }] }
  })
  a.handle('openRunTab', (taskId, runId) => {
    expect(taskId).toBe('NB-1')
    expect(runId).toBe('r2')
    const updated = task({
      tabs: [{ runId: 'r2', name: 'Reviewer', agent: 'codex', state: 'working' }],
    })
    a.state.tasks = [updated]
    a.emit({ type: 'task-updated', task: updated })
  })
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  const details = await screen.findByRole('complementary', { name: 'Task details' })
  await user().click(await within(details).findByRole('button', { name: /Reviewer/ }))
  await screen.findByText('I reviewed the offline queue.')
  expect(screen.getByRole('tab', { name: /Reviewer/ }).getAttribute('aria-selected')).toBe('true')
  expect(a.request).toHaveBeenCalledWith('getRunChat', 'r2')
})
