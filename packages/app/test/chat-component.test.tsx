// @vitest-environment jsdom
import type { RunChat, RunSummary } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunChat as Conversation } from '../src/renderer/components/RunChat.tsx'
import { RunsSection } from '../src/renderer/components/RunsSection.tsx'
import { bridge, required, user } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

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
  render(
    <RunsSection
      runs={[lead, { ...lead, id: 'r2', parentRunId: 'r1', role: 'sub-agent', name: 'Reviewer' }]}
      onOpenRun={open}
    />,
  )
  const rows = screen.getAllByRole('listitem')
  expect(rows.map((r) => r.getAttribute('data-run'))).toEqual(['r1', 'r2'])
  await user().click(within(required(rows[1])).getByRole('button', { name: /Reviewer/ }))
  expect(open).toHaveBeenCalledWith('r2')
  await user().click(within(required(rows[1])).getByRole('button', { name: 'Stop Run' }))
  expect(api.request).toHaveBeenCalledWith('stopRun', 'r2')
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
