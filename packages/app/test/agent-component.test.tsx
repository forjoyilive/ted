// @vitest-environment jsdom
import type { AgentHealth } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AgentsPage } from '../src/renderer/settings/AgentsPage.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

const signedOut: AgentHealth = {
  agent: 'claude',
  state: 'signed-out',
  reason: 'Not signed in.',
  minimumVersion: '2.0.0',
  version: '2.1.319',
  pausedRuns: 1,
  checkedAt: createdAt,
  fix: { label: 'Sign in', command: 'claude auth login' },
}

test('signed-out agent shows its Fix commands and follows Ready health events', async () => {
  const api = bridge({
    agentHealth: () => [signedOut],
    library: () => ({ version: 'v1', agents: [], stages: [], problems: [] }),
    checkAgentHealth: vi.fn(),
    copyText: vi.fn(),
  })
  render(<AgentsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const card = await screen.findByRole('region', { name: 'Claude Code' })
  const c = within(card)
  await c.findByText('Not signed in.')
  expect(c.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  expect(card.getAttribute('data-state')).toBe('signed-out')
  await user().click(c.getByRole('button', { name: 'Copy command' }))
  expect(api.request).toHaveBeenCalledWith('copyText', 'claude auth login')
  await user().click(c.getByRole('button', { name: 'Check again' }))
  expect(api.request).toHaveBeenCalledWith('checkAgentHealth')
  await act(async () =>
    api.emit({
      type: 'agent-health-changed',
      health: { ...signedOut, state: 'ready', checkedAt: '2026-11-10T12:00:00Z' },
    }),
  )
  expect(c.getByText('Ready')).toBeTruthy()
})
