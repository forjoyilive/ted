// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { App } from '../src/renderer/App.tsx'
import { ConnectionContext } from '../src/renderer/data.ts'
import { appState } from './support/app.tsx'
import { comment, task } from './support/fixtures.ts'

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
  await screen.findByRole('button', { name: 'Nothing running' })
  a.state.slots = { ...a.state.slots, limit: 7, working: 1 }
  view.rerender(connected(1))
  await screen.findByRole('button', { name: '1 of 7 Runs working' })
  expect(a.request.mock.calls.filter(([name]) => name === 'getSlots')).toHaveLength(2)
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
