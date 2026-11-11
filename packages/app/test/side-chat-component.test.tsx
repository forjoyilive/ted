// @vitest-environment jsdom
import type { RunChat, SideChat } from '@ted/protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { RunWithSideChat } from '../src/renderer/components/SideChat.tsx'
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
