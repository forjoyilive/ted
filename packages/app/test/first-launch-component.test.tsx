// @vitest-environment jsdom
import type { AgentHealth, IntegrationsHealth } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { FirstLaunch } from '../src/renderer/views/FirstLaunch.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

const health = (fields: Partial<AgentHealth> = {}): AgentHealth => ({
  agent: 'claude',
  state: 'ready',
  minimumVersion: '2.0.0',
  version: '2.1.319',
  path: '/test/claude',
  account: 'stub@example.com',
  pausedRuns: 0,
  checkedAt: createdAt,
  ...fields,
})
const integrations: IntegrationsHealth = {
  github: {
    cli: { state: 'ready', version: '2.90.0' },
    hosts: [
      {
        host: 'github.com',
        state: 'ready',
        login: 'forjoyilive',
        scopes: ['workflow'],
        usedBy: [],
      },
    ],
  },
  git: { state: 'ready', version: '2.50.0', name: 'Nabha Cosley', email: 'nabha@example.com' },
  checkedAt: createdAt,
}

function open(agents = [health(), health({ agent: 'codex' })]) {
  const finish = vi.fn()
  const api = bridge({
    agentHealth: () => agents,
    getIntegrations: () => integrations,
    updateSettings: vi.fn(),
    fixAgent: () => health({ fix: { label: 'Sign in', command: 'claude auth login' } }),
  })
  render(<FirstLaunch settings={defaultMachineSettings} onFinish={finish} />)
  return { finish, ...api }
}

test('ready checks show account and tool details; Skip saves the chosen login option', async () => {
  const a = open()
  const claude = within(await screen.findByRole('group', { name: 'Claude Code' }))
  await claude.findByText('Ready')
  expect(claude.getByText('/test/claude')).toBeTruthy()
  expect(claude.getByText(/stub@example.com/)).toBeTruthy()
  expect(
    within(screen.getByRole('group', { name: 'GitHub' })).getByText(
      'Signed in as forjoyilive · github.com',
    ),
  ).toBeTruthy()
  expect(
    within(screen.getByRole('group', { name: 'Git' })).getByText(
      '2.50 · Nabha Cosley <nabha@example.com>',
    ),
  ).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  await user().click(
    screen.getByRole('checkbox', { name: 'Start TED in the background when you log in' }),
  )
  expect(a.request.mock.calls.filter(([name]) => name === 'updateSettings')).toEqual([])
  await user().click(screen.getByRole('button', { name: 'Skip for now' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    firstLaunchDone: true,
    startAtLogin: false,
  })
  expect(a.finish).toHaveBeenCalledWith(false)
})

test('Continue waits for Git and an agent and then opens Add Factory', async () => {
  const a = open([
    health({ state: 'signed-out' }),
    health({ agent: 'codex', state: 'not-installed' }),
  ])
  await screen.findByText('Continue needs Git and at least one agent ready.')
  const next = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
  expect(next.disabled).toBe(true)
  await act(async () =>
    a.emit({
      type: 'integrations-checked',
      health: { ...integrations, git: { state: 'no-identity' } },
    }),
  )
  await act(async () => a.emit({ type: 'agent-health-changed', health: health() }))
  expect(next.disabled).toBe(true)
  await act(async () => a.emit({ type: 'integrations-checked', health: integrations }))
  expect(next.disabled).toBe(false)
  await user().click(next)
  expect(a.finish).toHaveBeenCalledWith(true)
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    firstLaunchDone: true,
    startAtLogin: true,
  })
})

test('wrong credential permits Continue and offers explicit billing choices', async () => {
  const a = open([health({ state: 'wrong-credential', reason: 'API key' })])
  const claude = within(screen.getByRole('group', { name: 'Claude Code' }))
  await claude.findByText('Signed in with an API key')
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  await user().click(claude.getByRole('button', { name: 'Sign in with a subscription instead' }))
  expect(a.request).toHaveBeenCalledWith('fixAgent', 'claude')
  await user().click(claude.getByRole('button', { name: 'Use API-key billing' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    billing: { ...defaultMachineSettings.billing, claude: 'api-key' },
  })
})

test('a Ready agent offers no API-key billing prompt', async () => {
  open()
  await screen.findAllByText('Ready')
  expect(screen.queryByRole('button', { name: 'Use API-key billing' })).toBeNull()
})
