// @vitest-environment jsdom
import type { AgentHealth } from '@ted/protocol'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { appState } from './support/app.tsx'
import { user } from './support/component.ts'

const usage = (changes: Partial<AgentHealth> = {}): AgentHealth => ({
  agent: 'claude',
  state: 'ready',
  minimumVersion: '2.0.0',
  pausedRuns: 0,
  checkedAt: new Date().toISOString(),
  planUsage: {
    at: new Date().toISOString(),
    from: 'run',
    windows: [
      {
        window: 'five-hour',
        percent: 4,
        resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      },
      {
        window: 'weekly',
        percent: 8,
        resetsAt: new Date(Date.now() + 49 * 3600_000).toISOString(),
      },
    ],
  },
  ...changes,
})
const tracker = () => screen.getByRole('button', { name: 'Usage' })
const panel = () => screen.getByRole('dialog', { name: 'Usage' })

test('usage below the warning threshold remains visible and follows live reports without a refresh', async () => {
  const a = appState()
  a.handle('agentHealth', () => [usage()])
  a.mount()
  await screen.findByText('8%')
  expect(tracker().textContent).toContain('8%')
  const u = user()
  await u.click(tracker())
  expect(document.activeElement).toBe(within(panel()).getByRole('button', { name: 'Close usage' }))
  expect(within(panel()).queryByRole('progressbar')).toBeNull()
  await u.click(within(panel()).getByRole('button', { name: 'Claude usage details' }))
  expect(within(panel()).getAllByRole('progressbar')).toHaveLength(2)
  await u.click(within(panel()).getByRole('button', { name: 'Detailed' }))
  expect(
    within(panel()).getByRole('button', { name: 'Detailed' }).getAttribute('aria-pressed'),
  ).toBe('true')
  await act(async () =>
    a.emit({
      type: 'agent-health-changed',
      health: usage({
        state: 'usage-limit',
        reason: 'Claude usage limit',
        pausedRuns: 2,
        planUsage: {
          at: new Date().toISOString(),
          from: 'run',
          windows: [
            {
              window: 'five-hour',
              percent: 100,
              resetsAt: new Date(Date.now() - 1000).toISOString(),
            },
          ],
        },
      }),
    }),
  )
  expect(tracker().textContent).toContain('100%')
  expect(
    within(panel()).getByText('Claude usage limit · 2 Runs paused · From last Run · just now'),
  ).toBeTruthy()
  expect(within(panel()).getByText(/100% · Awaiting update/)).toBeTruthy()
  expect(within(panel()).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull()
  expect(document.activeElement).toBe(tracker())
  expect(a.request.mock.calls.filter(([name]) => name === 'checkAgentHealth')).toHaveLength(0)
})

test('empty, API-key and offline states are explicit; settings navigation uses the existing Agents page', async () => {
  const a = appState()
  a.handle('library', () => ({ version: 'v1', agents: [], stages: [], problems: [] }))
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Usage' }))
  expect(within(panel()).getByText('Shows once a Run has made a request.')).toBeTruthy()
  expect(within(panel()).getByText('Shows once a Run has started.')).toBeTruthy()
  await act(async () =>
    a.emit({
      type: 'agent-health-changed',
      health: usage({ state: 'offline', reason: 'offline' }),
    }),
  )
  expect(within(panel()).getByText(/offline · Last known/)).toBeTruthy()
  await act(async () =>
    a.emit({
      type: 'settings-changed',
      settings: { ...a.state.settings, billing: { claude: 'api-key', codex: 'subscription' } },
    }),
  )
  expect(
    within(panel()).getByText('Subscription usage isn’t available with API key billing.'),
  ).toBeTruthy()
  expect(tracker().textContent).not.toContain('8%')
  await u.click(within(panel()).getByRole('button', { name: 'Agent settings' }))
  expect(await screen.findByRole('main', { name: 'Agents' })).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull()
})

test('outside click and navigation dismiss usage; sidebar pop-ups never overlap', async () => {
  const a = appState()
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Usage' }))
  await u.click(screen.getByRole('button', { name: 'All Tasks' }))
  expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull()
  await u.click(tracker())
  await u.click(screen.getByRole('button', { name: 'Nothing running' }))
  expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Working Runs' })).toBeTruthy()
  await u.click(tracker())
  expect(panel()).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'Working Runs' })).toBeNull()
  await u.click(tracker())
  expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull()
})
