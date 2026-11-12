// @vitest-environment jsdom
import type { RunChat, SideChat } from '@ted/protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunWithSideChat } from '../src/renderer/components/SideChat.tsx'
import { AutomationPromptDraft } from '../src/renderer/views/AutomationPromptDraft.tsx'
import { bridge, user } from './support/component.ts'

const source: RunChat = {
  run: {
    id: 'source',
    name: 'Task Lead',
    role: 'lead',
    agent: 'claude',
    state: 'working',
    current: true,
    startedAt: '2026-11-10T15:00:00Z',
  },
  items: [{ kind: 'agent', id: 's', text: 'Original work continues.' }],
}
const side: SideChat = {
  id: 'side',
  sourceRunId: 'source',
  snapshotAt: '2026-11-10T15:00:00Z',
  state: 'ready',
  truncated: true,
  available: true,
  chat: {
    run: {
      ...source.run,
      id: 'side',
      name: 'Side chat',
      role: 'side-chat',
      state: 'idle',
      current: false,
    },
    items: [{ kind: 'agent', id: 'a', text: 'Snapshot answer.' }],
  },
}

test('opens and reopens a separate exchange and sends only to side-chat controls', async () => {
  let current: SideChat | null = null
  const api = bridge({
    getRunChat: () => source,
    getSideChat: () => current,
    openSideChat: () => {
      current = side
      return current
    },
    sendSideChat: () => {
      current = { ...side, state: 'queued' }
      return current
    },
    stopSideChat: () => {
      current = { ...side, state: 'failed', error: 'The reply was stopped.' }
      return current
    },
    retrySideChat: () => {
      current = side
      return current
    },
  })
  render(<RunWithSideChat runId="source" bar={false} />)
  await user().click(await screen.findByRole('button', { name: 'Side chat' }))
  expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Stop Task' })).toBeNull()
  const panel = await screen.findByRole('region', { name: 'Side chat' })
  expect(within(panel).getByText('Snapshot answer.')).toBeTruthy()
  expect(within(panel).getByText(/Earlier context omitted/)).toBeTruthy()
  expect(within(panel).queryByRole('button', { name: /Interrupt and send/ })).toBeNull()
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Question for this side chat' }), {
    target: { value: 'Why this approach?' },
  })
  await user().click(within(panel).getByRole('button', { name: 'Send' }))
  expect(await within(panel).findByText(/Waiting for a working slot/)).toBeTruthy()
  expect(api.request).toHaveBeenCalledWith('sendSideChat', 'source', 'Why this approach?')
  await user().click(within(panel).getByRole('button', { name: 'Stop reply' }))
  await user().click(await within(panel).findByRole('button', { name: 'Retry' }))
  await user().click(within(panel).getByRole('button', { name: 'Close side chat' }))
  await user().click(screen.getByRole('button', { name: 'Open side chat' }))
  expect(await screen.findByText('Snapshot answer.')).toBeTruthy()
  expect(
    api.request.mock.calls.some(
      ([name]) => name === 'sendRunMessage' || name === 'interruptRun' || name === 'stopTask',
    ),
  ).toBe(false)
})

test('does not offer side chats for sub-agents', async () => {
  const api = bridge({
    getRunChat: () => ({ ...source, run: { ...source.run, role: 'sub-agent' } }),
  })
  render(<RunWithSideChat runId="source" />)
  await screen.findByText('Original work continues.')
  expect(screen.queryByRole('button', { name: 'Side chat' })).toBeNull()
  expect(api.request).not.toHaveBeenCalledWith('getSideChat', 'source')
})

test('Antigravity shows the approved tool explanation only in its help bubble, including reopened chats', async () => {
  const antigravitySide: SideChat = {
    ...side,
    chat: { ...side.chat, run: { ...side.chat.run, agent: 'antigravity' } },
  }
  bridge({
    getRunChat: () => source,
    getSideChat: () => antigravitySide,
    openSideChat: () => antigravitySide,
  })
  render(<RunWithSideChat runId="source" bar={false} />)
  await user().click(await screen.findByRole('button', { name: 'Open side chat' }))
  const panel = within(await screen.findByRole('region', { name: 'Side chat' }))
  expect(panel.getByText('Antigravity can use tools in this chat.')).toBeTruthy()
  expect(panel.queryByText(/Its built-in tools may run without asking/)).toBeNull()
  const toolHelp = panel.getAllByRole('button', { name: 'Help' })[0]
  if (!toolHelp) throw new Error('Missing tool warning help')
  await user().click(toolHelp)
  expect(panel.getByRole('tooltip').textContent).toBe(
    'Its built-in tools may run without asking. TED uses an isolated workspace and keeps file, command, web and MCP permissions denied. Choose Claude Code or Codex if you need a tool-free chat.',
  )
  fireEvent.keyDown(toolHelp, { key: 'Escape' })
  expect(panel.queryByRole('tooltip')).toBeNull()
  await user().click(panel.getByRole('button', { name: 'Close side chat' }))
  await user().click(screen.getByRole('button', { name: 'Open side chat' }))
  expect(
    within(await screen.findByRole('region', { name: 'Side chat' })).getByText(
      'Antigravity can use tools in this chat.',
    ),
  ).toBeTruthy()
})

test.each(['antigravity', 'claude', 'codex'] as const)(
  'Automation drafting reflects the selected/default %s chat policy',
  async (agent) => {
    bridge({})
    render(
      <AutomationPromptDraft
        factory="factory"
        name="Daily triage"
        prompt=""
        lead={{ agent }}
        onApply={vi.fn()}
        onBusy={vi.fn()}
      />,
    )
    await user().click(screen.getByRole('button', { name: 'Draft with AI' }))
    const warning = screen.queryByText('Antigravity can use tools in this chat.')
    expect(Boolean(warning)).toBe(agent === 'antigravity')
    if (agent === 'antigravity') {
      await user().click(screen.getByRole('button', { name: 'Help' }))
      expect(screen.getByRole('tooltip').textContent).toContain(
        'Choose Claude Code or Codex if you need a tool-free chat.',
      )
    }
  },
)

test('Automation drafting shows native tool activity with the shared conversation renderer', async () => {
  bridge({
    draftAutomationPrompt: () => ({ id: 'draft', factoryId: 'factory', state: 'queued' }),
    getAutomationPromptDraft: () => ({
      id: 'draft',
      factoryId: 'factory',
      state: 'ready',
      prompt: 'Suggested instructions.',
      chat: {
        run: { ...side.chat.run, agent: 'antigravity' },
        items: [
          {
            kind: 'tool',
            id: 'native-task-list',
            tool: 'Tool',
            title: 'manage_task',
            status: 'done',
          },
        ],
      },
    }),
  })
  render(
    <AutomationPromptDraft
      factory="factory"
      name="Daily triage"
      prompt=""
      lead={{ agent: 'antigravity' }}
      onApply={vi.fn()}
      onBusy={vi.fn()}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'Draft with AI' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'What should this Automation do?' }), {
    target: { value: 'Write a triage prompt.' },
  })
  await user().click(screen.getByRole('button', { name: 'Generate draft' }))
  expect(await screen.findByText('manage_task')).toBeTruthy()
  expect(
    (screen.getByRole('textbox', { name: 'Suggested Prompt' }) as HTMLTextAreaElement).value,
  ).toBe('Suggested instructions.')
})
