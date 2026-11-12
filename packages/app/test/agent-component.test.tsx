// @vitest-environment jsdom
import type { AgentHealth } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AgentsPage } from '../src/renderer/settings/AgentsPage.tsx'
import { LeadSelects } from '../src/renderer/views/PlanChat.tsx'
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

test('restart idle Runs defaults on and sends the changed machine setting', async () => {
  const api = bridge({
    agentHealth: () => [],
    library: () => ({ version: 'v1', agents: [], stages: [], problems: [] }),
    updateSettings: vi.fn(),
  })
  const view = render(<AgentsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const toggle = screen.getByRole('switch', { name: 'Restart idle Runs onto new agent versions' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await user().click(toggle)
  expect(api.request).toHaveBeenCalledWith('updateSettings', { restartIdleRuns: false })
  expect(api.request.mock.calls.filter(([name]) => name === 'updateSettings')).toHaveLength(1)
  view.rerender(
    <AgentsPage
      settings={{ ...defaultMachineSettings, restartIdleRuns: false }}
      dispatch={vi.fn()}
    />,
  )
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

test('Antigravity shares agent health controls and saves its billing choice without replacing other agents', async () => {
  const api = bridge({
    agentHealth: () => [
      {
        ...signedOut,
        agent: 'antigravity',
        minimumVersion: '1.5.6',
        version: '1.5.6',
        pausedRuns: 0,
        fix: { label: 'Sign in', command: 'agy acp --login' },
      },
    ],
    library: () => ({ version: 'v1', agents: [], stages: [], problems: [] }),
    updateSettings: vi.fn(),
    copyText: vi.fn(),
  })
  render(<AgentsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const card = within(await screen.findByRole('region', { name: 'Antigravity' }))
  expect(card.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  await user().click(card.getByRole('button', { name: 'Copy command' }))
  expect(api.request).toHaveBeenCalledWith('copyText', 'agy acp --login')
  await user().click(card.getByRole('radio', { name: 'API key' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', {
    billing: { ...defaultMachineSettings.billing, antigravity: 'api-key' },
  })
  expect(
    card.getByText('Usage figures are unavailable unless reported by Antigravity.'),
  ).toBeTruthy()
})

test('off cards stay discoverable and the last enabled switch explains its restriction', async () => {
  const settings = { ...defaultMachineSettings, enabledAgents: ['codex'] as const }
  bridge({
    getSettings: () => settings,
    agentHealth: () => [signedOut, { ...signedOut, agent: 'codex', state: 'ready' }],
    library: () => ({ version: 'v1', agents: [], stages: [], problems: [] }),
    agentAvailability: () => [
      { agent: 'claude', enabled: false, runs: [{ id: 'one' }], additionalRuns: [] },
    ],
  })
  render(<AgentsPage settings={settings} dispatch={vi.fn()} />)
  const claude = within(await screen.findByRole('region', { name: 'Claude Code' }))
  expect(claude.getByText('Off')).toBeTruthy()
  expect(claude.queryByRole('button', { name: 'Sign in' })).toBeNull()
  await claude.findByText(/1 existing Runs kept going/)
  const codex = within(screen.getByRole('region', { name: 'Codex' }))
  expect(codex.getByRole<HTMLButtonElement>('switch', { name: 'Use Codex' }).disabled).toBe(true)
  expect(codex.getByText('Enable another agent before turning this one off.')).toBeTruthy()
})

test('turning off confirms the count and collateral Runs, supports Cancel and sends the confirmed decision', async () => {
  const availability = {
    agent: 'claude',
    enabled: true,
    runs: [{ id: 'lead', agent: 'claude', name: 'NB-1' }],
    additionalRuns: [{ id: 'child', agent: 'codex', name: 'Reviewer' }],
  }
  const change = vi.fn().mockResolvedValue({ availability, confirmationRequired: true })
  const api = bridge({
    agentHealth: () => [signedOut],
    library: () => ({ version: 'v1', agents: [], stages: [], problems: [] }),
    changeAgentAvailability: change,
  })
  render(<AgentsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const toggle = await screen.findByRole('switch', { name: 'Use Claude Code' })
  await user().click(toggle)
  let dialog = within(await screen.findByRole('dialog', { name: 'Turn off Claude Code?' }))
  expect(dialog.getByText('Reviewer · Codex')).toBeTruthy()
  await user().click(dialog.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(change).toHaveBeenCalledTimes(1)
  await user().click(toggle)
  dialog = within(await screen.findByRole('dialog', { name: 'Turn off Claude Code?' }))
  change.mockResolvedValueOnce({
    availability: { ...availability, enabled: false },
    confirmationRequired: false,
  })
  await user().click(dialog.getByRole('button', { name: 'Turn off & keep going' }))
  expect(api.request).toHaveBeenCalledWith('changeAgentAvailability', {
    agent: 'claude',
    enabled: false,
    existing: 'keep',
    confirmedRunIds: ['lead', 'child'],
  })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('the stop choice includes all affected Runs and refreshes the confirmation if its count changes', async () => {
  const availability = {
    agent: 'claude',
    enabled: true,
    runs: [{ id: 'lead', agent: 'claude', name: 'NB-1' }],
    additionalRuns: [],
  }
  const change = vi
    .fn()
    .mockResolvedValueOnce({ availability, confirmationRequired: true })
    .mockResolvedValueOnce({
      availability: {
        ...availability,
        runs: [...availability.runs, { id: 'new', agent: 'claude', name: 'NB-2' }],
      },
      confirmationRequired: true,
    })
  const api = bridge({
    agentHealth: () => [signedOut],
    library: () => ({ version: 'v1', agents: [], stages: [], problems: [] }),
    changeAgentAvailability: change,
  })
  render(<AgentsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  await user().click(await screen.findByRole('switch', { name: 'Use Claude Code' }))
  const dialog = within(await screen.findByRole('dialog'))
  await user().click(dialog.getByRole('button', { name: 'Turn off & stop 1 Runs' }))
  expect(api.request).toHaveBeenCalledWith('changeAgentAvailability', {
    agent: 'claude',
    enabled: false,
    existing: 'stop',
    confirmedRunIds: ['lead'],
  })
  expect(await dialog.findByRole('button', { name: 'Turn off & stop 2 Runs' })).toBeTruthy()
})

test('agent menus hide off kinds but preserve an explicit current choice with an explanation', async () => {
  bridge({ getSettings: () => ({ ...defaultMachineSettings, enabledAgents: ['antigravity'] }) })
  render(<LeadSelects lead={{ agent: 'claude' }} onChange={vi.fn()} />)
  const menu = within(screen.getByRole('combobox', { name: 'Agent' }))
  expect(await menu.findByRole('option', { name: 'Claude · Off — new Runs wait' })).toBeTruthy()
  expect(menu.queryByRole('option', { name: 'Codex' })).toBeNull()
  expect(menu.getByRole('option', { name: 'Antigravity' })).toBeTruthy()
})
