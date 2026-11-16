// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { App } from '../src/renderer/App.tsx'
import { ConversationSearchView } from '../src/renderer/components/ConversationSearchView.tsx'
import { ConnectionContext } from '../src/renderer/data.ts'
import { appState } from './support/app.tsx'
import { bridge } from './support/component.ts'
import { comment, createdAt, task } from './support/fixtures.ts'

function connected(epoch: number) {
  return (
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch }}>
      <App />
    </ConnectionContext>
  )
}

test('a reconnect epoch reloads slots changed while the renderer was away', async () => {
  const a = appState()
  const view = render(connected(0))
  await screen.findByRole('button', { name: '0 of 3 slots in use' })
  const slotLoads = () => a.request.mock.calls.filter(([name]) => name === 'getSlots').length
  const loaders = slotLoads()
  a.state.slots = { ...a.state.slots, limit: 7, working: 1 }
  view.rerender(connected(1))
  await screen.findByRole('button', { name: '1 of 7 slots in use' })
  expect(slotLoads()).toBe(loaders * 2)
})

test('a reconnect epoch reloads an Inbox request missed while disconnected', async () => {
  const a = appState()
  const view = render(connected(0))
  await screen.findByText('Nothing waiting on you')
  a.state.inbox = [{ task: task(), request: comment({ body: 'Review the offline design' }) }]
  view.rerender(connected(1))
  await screen.findByText('Review the offline design')
  expect(a.request.mock.calls.filter(([name]) => name === 'listInbox')).toHaveLength(2)
})

test('a historical Conversation search viewer recovers without a Run event and keeps its match position', async () => {
  let available = false
  let text = 'Recovered historical message'
  const api = bridge({
    getRunChat: () => {
      if (!available) throw new Error('Daemon is reconnecting')
      return {
        run: {
          id: 'old-run',
          name: 'Old Lead',
          role: 'lead',
          agent: 'claude',
          state: 'finished',
          current: false,
          startedAt: createdAt,
        },
        items: [{ kind: 'agent', id: 'match', text }],
      }
    },
  })
  const viewer = (epoch: number) => (
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch }}>
      <ConversationSearchView
        hit={{
          runId: 'old-run',
          itemId: 'match',
          factoryId: 'f1',
          source: 'task',
          ref: 'NB-1',
          title: 'History',
          runName: 'Old Lead',
          kind: 'agent',
          at: createdAt,
          snippet: 'historical',
        }}
        onBack={() => {}}
      />
    </ConnectionContext>
  )
  const view = render(viewer(0))
  expect((await screen.findByRole('alert')).textContent).toContain('Daemon is reconnecting')
  available = true
  view.rerender(viewer(1))
  await screen.findByText('Recovered historical message')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement?.getAttribute('data-chat-item')).toBe('match')
  const jumps = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length
  text = 'Refreshed after data recovery'
  view.rerender(viewer(2))
  await screen.findByText('Refreshed after data recovery')
  expect(api.request.mock.calls.filter(([name]) => name === 'getRunChat')).toHaveLength(3)
  expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls.length).toBe(jumps)
})
