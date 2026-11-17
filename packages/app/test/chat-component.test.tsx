// @vitest-environment jsdom
import type { PlanDetail, RunChat, RunSummary } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ChatBody, RunChat as Conversation } from '../src/renderer/components/RunChat.tsx'
import { RunsSection } from '../src/renderer/components/RunsSection.tsx'
import { TaskActionsMenu } from '../src/renderer/components/TaskActions.tsx'
import { PlanChatView } from '../src/renderer/views/PlanChat.tsx'
import { appState } from './support/app.tsx'
import { bridge, required, user } from './support/component.ts'
import { createdAt, factory, plannerAgent, task } from './support/fixtures.ts'

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
          text: 'Ted no longer keeps this Run’s output, so its messages and tool calls can’t be shown.',
        },
      ],
    }),
  })
  render(<Conversation runId="r1" />)
  await user().click(await screen.findByText('Output no longer kept'))
  expect(
    await screen.findByText(
      'Ted no longer keeps this Run’s output, so its messages and tool calls can’t be shown.',
    ),
  ).toBeTruthy()
  expect(screen.getByText('From Ted')).toBeTruthy()
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
  expect(within(required(rows[1])).queryByRole('button', { name: 'Restart' })).toBeNull()
  await user().click(within(required(rows[1])).getByRole('button', { name: 'Stop Run' }))
  expect(api.request).toHaveBeenCalledWith('stopRun', 'r2')
  expect(screen.getByText('on Sub-Agents')).toBeTruthy()
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
})

test('Task menu stops the Task and has no Restart for an idle Lead', async () => {
  const current = task({ stage: 'work', leadRunId: 'r1', runs: [{ ...lead, state: 'idle' }] })
  const api = bridge({ stopTask: vi.fn() })
  render(<TaskActionsMenu task={current} />)
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  expect(screen.queryByRole('menuitem', { name: /^History/ })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: /Side chat/ })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: /^Restart$/ })).toBeNull()
  await u.click(screen.getByRole('menuitem', { name: /Stop Task/ }))
  expect(api.request).toHaveBeenCalledWith('stopTask', current.id)
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
  a.handle('openRunTab', () => undefined)
  a.handle('getRunChat', (id) => ({
    run: id === 'r1' ? current : previous,
    items: [{ kind: 'agent', id: 'a1', text: id === 'r1' ? 'Current work.' : 'Earlier work.' }],
  }))
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await u.click(within(screen.getByRole('main')).getByText('Sync notes'))
  expect(screen.queryAllByRole('tab', { name: 'Task Lead' })).toHaveLength(0)
  const chat = within(await screen.findByRole('region', { name: 'Task thread' }))
  await chat.findByText('Current work.')
  expect(chat.queryByRole('button', { name: 'Restart' })).toBeNull()
  expect(chat.queryByRole('button', { name: 'Stop Task' })).toBeNull()
  expect(chat.getByRole('textbox', { name: 'Message the Task Lead' })).toBeTruthy()
  const details = within(screen.getByRole('complementary', { name: 'Task details' }))
  await u.click(details.getByRole('tab', { name: 'Runs' }))
  expect(await details.findByText('Claude · claude-test · default effort')).toBeTruthy()
  expect(details.getByText('12k tokens')).toBeTruthy()
  expect(chat.queryByRole('button', { name: /^History/ })).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  await u.click(screen.getByRole('menuitem', { name: 'History · 1' }))
  await u.click(
    within(screen.getByRole('menu', { name: /^History/ })).getByRole('menuitem', {
      name: /Earlier Conversation/,
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

test('Comment box opens with unsent text, keeps what is typed and empties after sending', async () => {
  const { CommentBox } = await import('../src/renderer/components/CommentBox.tsx')
  let kept: unknown = { text: 'Half a thought', attachments: [] }
  const api = bridge({
    postComment: vi.fn(),
    messageDraft: () => ({ draft: kept }),
    saveMessageDraft: (_box, draft) => {
      kept = (draft as { text: string }).text === '' ? null : draft
      return { draft: kept }
    },
  })
  const first = render(<CommentBox task={task({ commentBox: 'live' })} />)
  expect(await screen.findByDisplayValue('Half a thought')).toBeTruthy()
  expect(api.request).toHaveBeenCalledWith('messageDraft', { kind: 'comment', id: 'NB-1' })
  await user().type(screen.getByRole('textbox', { name: 'Comment' }), ', finished')
  first.unmount()
  await vi.waitFor(() => expect(kept).toMatchObject({ text: 'Half a thought, finished' }))

  render(<CommentBox task={task({ commentBox: 'live' })} />)
  const box = await screen.findByDisplayValue('Half a thought, finished')
  await user().type(box, '{Enter}')
  expect(api.request).toHaveBeenCalledWith('postComment', 'NB-1', {
    body: 'Half a thought, finished',
    attachments: [],
  })
  await vi.waitFor(() => expect(kept).toBeNull())
  expect((box as HTMLTextAreaElement).value).toBe('')
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
  await user().click(within(details).getByRole('tab', { name: 'Runs' }))
  await user().click(await within(details).findByRole('button', { name: /Reviewer/ }))
  await screen.findByText('I reviewed the offline queue.')
  expect(screen.getByRole('tab', { name: /Reviewer/ }).getAttribute('aria-selected')).toBe('true')
  expect(a.request).toHaveBeenCalledWith('getRunChat', 'r2')
})

test('Planning requests stay inline and keep drafts while the chat updates', async () => {
  const detail: PlanDetail = {
    plan: {
      id: 'p1',
      factoryId: 'f1',
      factoryKey: 'NB',
      title: 'Plan sync',
      message: 'Plan sync',
      agent: 'claude',
      status: 'waiting',
      runId: 'p1',
      createdAt,
      lastAt: createdAt,
      createdTasks: 0,

      chatAgent: plannerAgent,
    },
    requests: [
      {
        id: 'round1',
        planId: 'p1',
        runId: 'p1',
        kind: 'round',
        author: 'run',
        title: 'Retry behavior',
        body: '',
        createdAt,
        round: {
          number: 1,
          questions: [{ question: 'When should sync retry?', recommended: 'On reconnect' }],
        },
      },
      {
        id: 'proposal1',
        planId: 'p1',
        runId: 'p1',
        kind: 'proposal',
        author: 'run',
        title: 'Sync work',
        body: '',
        createdAt,
        proposal: {
          rows: [
            {
              title: 'Retry offline work',
              scope: 'Resume sync on reconnect.',
              priority: 'medium',
              blockedBy: [],
            },
          ],
        },
      },
    ],
    tasks: [],
  }
  let chat: RunChat = { run: { ...lead, id: 'p1' }, items: [] }
  const api = bridge({
    getPlan: () => detail,
    getRunChat: () => chat,
    answerPlanRequest: (id, answer) => {
      const request = required(detail.requests.find((r) => r.id === id))
      request.answer = {
        kind: 'answered',
        at: createdAt,
        answers: (answer as { answers: { answer: string }[] }).answers.map((answer) => ({
          ...answer,
          changed: true,
        })),
      }
      api.emit({ type: 'plan-updated', planId: 'p1' })
      return request
    },
  })
  render(
    <PlanChatView
      factory={factory()}
      planId="p1"
      revealRequest={{ id: 'proposal1' }}
      onBack={vi.fn()}
      onOpenTask={vi.fn()}
      onOpenPlan={vi.fn()}
      onPlanMore={vi.fn()}
      onDeleted={vi.fn()}
    />,
  )
  const round = await screen.findByRole('region', { name: 'Round 1 from the planner' })
  const proposal = screen.getByRole('region', { name: 'Proposal from the planner' })
  expect(document.activeElement?.contains(proposal)).toBe(true)
  const scroller = required(round.closest('[data-scroller]'))
  expect(scroller.contains(proposal)).toBe(true)
  const answer = within(round).getByRole('textbox', { name: 'Answer 1' }) as HTMLTextAreaElement
  await user().clear(answer)
  await user().type(answer, 'After I confirm')
  await user().click(screen.getByRole('button', { name: /Jump to Proposal/ }))
  await user().click(screen.getByRole('button', { name: /Jump to Round 1/ }))
  expect(document.activeElement?.contains(round)).toBe(true)
  await act(async () => {
    chat = {
      ...chat,
      items: [{ kind: 'agent', id: 'later', text: 'A later planner message.', at: createdAt }],
    }
    api.emit({ type: 'run-output', runId: 'p1' })
    api.emit({ type: 'plan-updated', planId: 'p1' })
  })
  await screen.findByText('A later planner message.')
  expect(answer.value).toBe('After I confirm')
  await user().click(within(round).getByRole('button', { name: 'Submit answers' }))
  expect(api.request).toHaveBeenCalledWith('answerPlanRequest', 'round1', {
    action: 'answer-round',
    answers: [{ answer: 'After I confirm' }],
  })
  await screen.findByText(/answered by you at/)
  expect(screen.queryByRole('button', { name: /Jump to Round 1/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Jump to Proposal/ })).toBeTruthy()
})

test('new chat output does not scroll away from a request being edited', async () => {
  bridge({})
  const extra = [
    {
      id: 'question',
      at: createdAt,
      node: <textarea aria-label="Request answer" defaultValue="Still deciding" />,
    },
  ]
  const chat: RunChat = { run: lead, items: [] }
  const view = render(
    <ChatBody chat={chat} onStopTask={undefined} options={{ bar: false, extra }} />,
  )
  const answer = screen.getByRole('textbox', { name: 'Request answer' })
  const scroller = required(answer.closest('[data-scroller]'))
  Object.defineProperties(scroller, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 300 },
  })
  scroller.scrollTop = 700
  fireEvent.scroll(scroller)
  await user().click(answer)
  Object.defineProperty(scroller, 'scrollHeight', { value: 1200 })
  view.rerender(
    <ChatBody
      chat={{ ...chat, items: [{ kind: 'agent', id: 'new', text: 'New output.', at: createdAt }] }}
      onStopTask={undefined}
      options={{ bar: false, extra }}
    />,
  )
  expect(scroller.scrollTop).toBe(700)
  expect(document.activeElement).toBe(answer)
  expect(screen.getByRole('button', { name: 'New messages ↓' })).toBeTruthy()
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
      {
        kind: 'command',
        id: 'c1',
        name: 'test',
        status: 'failed',
        exitCode: 1,
        output: '× parses **commands**',
        at: createdAt,
        endedAt: new Date(Date.parse(createdAt) + 41_000).toISOString(),
      },
    ],
  }
  bridge({ getRunChat: () => chat })
  const view = render(<Conversation runId="r1" />)
  const command = await screen.findByRole('button', { name: /TED ran.*test.*Exit code 1 · 41s/ })
  await user().click(command)
  expect(screen.getByText('× parses **commands**').tagName).toBe('PRE')
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

test('runs of tool calls fold into one row, the live run stays open and a search match opens its run', async () => {
  const items: RunChat['items'] = [
    { kind: 'agent', id: 'a1', text: 'Checking the lint first.' },
    { kind: 'tool', id: 't1', tool: 'Bash', title: 'pnpm lint', status: 'done' },
    {
      kind: 'tool',
      id: 't2',
      tool: 'Edit',
      title: 'sync.ts',
      status: 'done',
      diffs: [{ path: 'sync.ts', additions: 3, deletions: 1, lines: [] }],
    },
    {
      kind: 'tool',
      id: 't3',
      tool: 'Bash',
      title: 'pnpm typecheck',
      status: 'failed',
      output: 'sync.ts(4,2): type error',
    },
    { kind: 'agent', id: 'a2', text: 'Running the tests.' },
    { kind: 'tool', id: 't4', tool: 'Read', title: 'sync.test.ts', status: 'done' },
    { kind: 'tool', id: 't5', tool: 'Bash', title: 'pnpm vitest', status: 'running' },
  ]
  let chat: RunChat = { run: lead, items }
  const api = bridge({ getRunChat: () => chat })
  const view = render(<Conversation runId="r1" />)
  const done = await screen.findByRole('button', { name: /^3 tool calls/ })
  expect(done.textContent).toBe('3 tool calls2 commands, 1 edit+3−11 failed')
  expect(done.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('pnpm lint')).toBeNull()
  const live = screen.getByRole('button', { name: /^2 tool calls/ })
  expect(live.getAttribute('aria-expanded')).toBe('true')
  expect(within(live).getByText('1 running')).toBeTruthy()
  expect(screen.getByText('pnpm vitest')).toBeTruthy()

  await user().click(done)
  expect(done.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('pnpm lint')).toBeTruthy()

  await act(async () => {
    chat = {
      run: lead,
      items: [
        ...items.slice(0, -1),
        { kind: 'tool', id: 't5', tool: 'Bash', title: 'pnpm vitest', status: 'done' },
        { kind: 'agent', id: 'a3', text: 'Tests pass.' },
      ],
    }
    api.emit({ type: 'run-output', runId: 'r1' })
  })
  await screen.findByText('Tests pass.')
  expect(screen.getByRole('button', { name: /^2 tool calls/ }).getAttribute('aria-expanded')).toBe(
    'false',
  )
  expect(screen.queryByText('pnpm vitest')).toBeNull()
  expect(screen.getByRole('button', { name: /^3 tool calls/ }).getAttribute('aria-expanded')).toBe(
    'true',
  )

  view.unmount()
  render(<Conversation runId="r1" inspect matchItemId="t3" />)
  const match = required(
    (await screen.findByText('pnpm typecheck')).closest<HTMLElement>('[data-chat-item]'),
  )
  expect(match.dataset.chatItem).toBe('t3')
  expect(within(match).getByText('sync.ts(4,2): type error').tagName).toBe('PRE')
  expect(screen.getByRole('button', { name: /^3 tool calls/ }).getAttribute('aria-expanded')).toBe(
    'true',
  )
  expect(screen.getByRole('button', { name: /^2 tool calls/ }).getAttribute('aria-expanded')).toBe(
    'false',
  )
})
