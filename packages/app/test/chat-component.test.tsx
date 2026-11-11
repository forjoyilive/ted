// @vitest-environment jsdom
import type { RunChat, RunSummary } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunChat as Conversation } from '../src/renderer/components/RunChat.tsx'
import { RunsSection } from '../src/renderer/components/RunsSection.tsx'
import { TaskActionsMenu } from '../src/renderer/components/TaskActions.tsx'
import { appState } from './support/app.tsx'
import { bridge, required, user } from './support/component.ts'
import { createdAt, task } from './support/fixtures.ts'

const lead: RunSummary & { role: 'lead' } = {
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
    items: [
      {
        kind: 'agent',
        id: 'a1',
        text: 'Working on the sync layer.',
        at: new Date().toISOString(),
        writing: true,
      },
    ],
  }
  const api = bridge({
    getRunChat: () => chat,
    sendRunMessage: (_id, text, options) => {
      chat = {
        ...chat,
        items: [
          ...chat.items,
          { kind: 'human', id: 'm1', text: String(text), at: createdAt, sent: false, queued: true },
        ],
      }
      api.emit({ type: 'run-output', runId: 'r1' })
      return {
        id: 'm1',
        runId: 'r1',
        text,
        at: createdAt,
        queued: !(options as { interrupt: boolean }).interrupt,
      }
    },
    deleteQueuedMessage: () => {
      chat = { ...chat, items: chat.items.filter((i) => i.id !== 'm1') }
      api.emit({ type: 'run-output', runId: 'r1' })
    },
  })
  render(<Conversation runId="r1" />)
  await screen.findByText('Working on the sync layer.')
  expect(screen.getByText('just now', { exact: true })).toBeTruthy()
  expect(screen.queryByText(/writing…/)).toBeNull()
  const box = screen.getByRole('textbox', { name: 'Message to this Run' })
  fireEvent.change(box, { target: { value: 'Leave archived notes alone.' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await screen.findByText('Queued')
  expect(api.request).toHaveBeenCalledWith('sendRunMessage', 'r1', 'Leave archived notes alone.', {
    interrupt: false,
  })
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
      { interrupt: true },
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

test('Run chat of a finished Run whose output was deleted shows the “Output no longer kept” note', async () => {
  bridge({
    getRunChat: (): RunChat => ({
      run: { ...lead, state: 'finished', current: false },
      items: [
        {
          kind: 'ted',
          id: 'output-not-kept',
          title: 'Output no longer kept',
          text: 'TED no longer keeps this Run’s output, so its messages and tool calls can’t be shown.',
        },
      ],
    }),
  })
  render(<Conversation runId="r1" />)
  await user().click(await screen.findByText('Output no longer kept'))
  expect(
    await screen.findByText(
      'TED no longer keeps this Run’s output, so its messages and tool calls can’t be shown.',
    ),
  ).toBeTruthy()
  expect(screen.getByText('From TED')).toBeTruthy()
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
  expect(within(required(rows[0])).queryByRole('button', { name: 'Restart' })).toBeNull()
  expect(within(required(rows[0])).queryByRole('button', { name: 'Stop Task' })).toBeNull()
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

test('Task menu restarts the current Lead, follows its state and reports restart failures', async () => {
  const current = task({ stage: 'work', leadRunId: 'r1', runs: [{ ...lead, state: 'idle' }] })
  const api = bridge({ restartRun: () => Promise.reject(new Error('The disk is full')) })
  const view = render(<TaskActionsMenu task={current} />)
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  expect(screen.getByRole('menuitem', { name: /Stop Task/ })).toBeTruthy()
  await u.click(screen.getByRole('menuitem', { name: /^Restart$/ }))
  expect(api.request).toHaveBeenCalledWith('restartRun', 'r1')
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The disk is full')

  view.rerender(<TaskActionsMenu task={{ ...current, runs: [lead] }} />)
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  const restart = screen.getByRole('menuitem', { name: /^Restart$/ })
  expect(restart).toHaveProperty('disabled', true)
  expect(restart.title).toBe('Restart works when the Run is idle')
  await u.click(restart)
  expect(api.request).toHaveBeenCalledTimes(1)

  view.rerender(<TaskActionsMenu task={{ ...current, runs: [{ ...lead, state: 'finished' }] }} />)
  expect(screen.queryByRole('menuitem', { name: /^Restart$/ })).toBeNull()
  view.rerender(<TaskActionsMenu task={task({ stage: 'work', runs: current.runs })} />)
  expect(screen.queryByRole('menuitem', { name: /^Restart$/ })).toBeNull()
  view.rerender(
    <TaskActionsMenu
      task={{ ...current, archived: { at: createdAt, ended: { kind: 'stopped', stage: 'work' } } }}
    />,
  )
  expect(screen.queryByRole('menuitem', { name: /^Restart$/ })).toBeNull()
})

test('Task Lead is the main chat and earlier conversations open inline', async () => {
  const a = appState()
  const current = { ...lead, state: 'idle' as const, model: 'claude-test', tokens: 12000 }
  const previous = { ...lead, id: 'old', current: false, state: 'finished' as const }
  a.state.tasks = [
    task({
      stage: 'work',
      commentBox: 'live',
      leadRunId: current.id,
      runs: [current, previous],
      tabs: [current, previous].map((run) => ({ ...run, runId: run.id })),
    }),
  ]
  a.handle('listTaskRuns', () => [current, previous])
  a.handle('getRun', () => ({ run: current, conversation: [] }))
  a.handle('getRunChat', (id) => ({
    run: id === 'r1' ? current : previous,
    items: [{ kind: 'agent', id: 'a1', text: id === 'r1' ? 'Current work.' : 'Earlier work.' }],
  }))
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await u.click(within(screen.getByRole('main')).getByText('Sync notes'))
  expect(screen.getAllByRole('tab', { name: 'Task Lead' })).toHaveLength(1)
  const chat = within(await screen.findByRole('region', { name: 'Task thread' }))
  await chat.findByText('Current work.')
  expect(chat.queryByRole('button', { name: 'Restart' })).toBeNull()
  expect(chat.queryByRole('button', { name: 'Stop Task' })).toBeNull()
  expect(chat.getByRole('textbox', { name: 'Message the Task Lead' })).toBeTruthy()
  const details = within(screen.getByRole('complementary', { name: 'Task details' }))
  expect(await details.findByText('Claude · claude-test · default effort')).toBeTruthy()
  expect(details.getByText('12k tokens')).toBeTruthy()
  await u.click(chat.getByRole('button', { name: /^History/ }))
  await u.click(
    within(screen.getByRole('region', { name: 'Conversation history' })).getByRole('button', {
      name: /Earlier conversation/,
    }),
  )
  await chat.findByText('Earlier work.')
  expect(chat.getByText('Current work.')).toBeTruthy()
  expect(screen.getAllByRole('tab', { name: 'Task Lead' })).toHaveLength(1)
})

test('Comment composer sends Enter and command Enter, while Shift Enter keeps a newline', async () => {
  const { CommentBox } = await import('../src/renderer/components/CommentBox.tsx')
  const { task } = await import('./support/fixtures.ts')
  const api = bridge({ postComment: vi.fn() })
  render(<CommentBox task={task({ commentBox: 'live' })} />)
  const u = user()
  const box = screen.getByRole('textbox', { name: 'Comment' })
  await u.type(box, 'First{Enter}')
  expect(api.request).toHaveBeenCalledWith('postComment', 'NB-1', {
    body: 'First',
    attachments: [],
  })
  expect((box as HTMLTextAreaElement).value).toBe('')
  await u.type(box, 'First line{Shift>}{Enter}{/Shift}Second line')
  expect((box as HTMLTextAreaElement).value).toBe('First line\nSecond line')
  await u.keyboard('{Meta>}{Enter}{/Meta}')
  expect(api.request).toHaveBeenCalledWith('postComment', 'NB-1', {
    body: 'First line\nSecond line',
    attachments: [],
  })
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
  a.handle('taskGates', () => ({ overrides: {}, rows: [], revision: 'r1' }))
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

test('live and saved conversations share Markdown while tool output stays literal', async () => {
  const chat: RunChat = {
    run: lead,
    items: [
      { kind: 'agent', id: 'a1', text: '## Progress\n\n**Ready**', writing: true },
      {
        kind: 'human',
        id: 'm1',
        text: 'Use *nested* lists\n\n- Parent\n  - Child',
        at: createdAt,
        sent: true,
      },
      {
        kind: 'tool',
        id: 't1',
        tool: 'Read',
        title: 'notes.md',
        status: 'done',
        output: '## Literal\n**raw**',
      },
    ],
  }
  bridge({ getRunChat: () => chat })
  const view = render(<Conversation runId="r1" />)
  await screen.findByRole('heading', { name: 'Progress' })
  expect(screen.getByText('Ready').tagName).toBe('STRONG')
  expect(screen.getByText('nested').tagName).toBe('EM')
  expect(screen.getByText('Child').closest('ul')?.parentElement?.tagName).toBe('LI')
  await user().click(screen.getByRole('button', { name: /Read/ }))
  expect(screen.getByText('## Literal **raw**').tagName).toBe('PRE')
  expect(screen.queryByRole('heading', { name: 'Literal' })).toBeNull()
  view.rerender(<Conversation runId="r1" inspect matchItemId="a1" />)
  expect(screen.getByRole('heading', { name: 'Progress' })).toBeTruthy()
  expect(screen.getByText('Ready').tagName).toBe('STRONG')
})
