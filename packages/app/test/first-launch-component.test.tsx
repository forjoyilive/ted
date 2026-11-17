// @vitest-environment jsdom
import {
  type AgentHealth,
  type Factory,
  type IntegrationsHealth,
  integrationInstallPages,
  type MachineSettings,
} from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { Onboarding } from '../src/renderer/views/Onboarding.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory } from './support/fixtures.ts'

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

function start(
  agents = [health(), health({ agent: 'codex' })],
  {
    factories = [],
    settings = defaultMachineSettings,
  }: { factories?: Factory[]; settings?: MachineSettings } = {},
) {
  const finish = vi.fn()
  const api = bridge({
    agentHealth: () => agents,
    getIntegrations: () => integrations,
    listFactories: () => factories,
    homeFolder: () => '/test',
    updateSettings: vi.fn(),
    fixAgent: () => health({ fix: { label: 'Sign in', command: 'claude auth login' } }),
  })
  render(<Onboarding settings={settings} onFinish={finish} />)
  return { finish, ...api }
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

async function toSetUp() {
  await screen.findByRole('heading', { name: 'Get ready to build faster' })
  await user().click(button('Next'))
  await screen.findByRole('heading', { name: 'How it works' })
  await user().click(button('Next'))
  await screen.findByRole('heading', { name: /^Set up TED/ })
}

async function open(agents?: AgentHealth[]) {
  const a = start(agents)
  await toSetUp()
  return a
}

test('the steps run in order, Back returns, and Skip saves Start at login and reporting', async () => {
  const a = start()
  await screen.findByRole('heading', { name: 'Get ready to build faster' })
  expect(screen.getByText('Step 1 of 4')).toBeTruthy()
  expect(button('Back').disabled).toBe(true)
  await user().click(button('Next'))
  await screen.findByRole('heading', { name: 'How it works' })
  expect(screen.getByText('Step 2 of 4')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Approve the work at each sign-off' })).toBeTruthy()
  await user().click(button('Back'))
  await screen.findByRole('heading', { name: 'Get ready to build faster' })
  await user().click(button('Next'))
  await user().click(button('Next'))
  await screen.findByText('Step 3 of 4')
  const login = screen.getByRole('checkbox', {
    name: 'Start TED in the background when you log in',
  }) as HTMLInputElement
  expect(login.checked).toBe(false)
  const reporting = screen.getByRole('checkbox', {
    name: /^Send error reporting and usage data to the TED team/,
  }) as HTMLInputElement
  expect(reporting.checked).toBe(true)
  await user().click(reporting)
  await user().click(button('Skip'))
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    firstLaunchDone: true,
    startAtLogin: false,
    onboardingOnNextOpen: false,
    reporting: false,
    reportingAsked: true,
  })
  expect(a.finish).toHaveBeenCalledWith(undefined)
})

test('Skip on the first step ends onboarding without answering reporting', async () => {
  const a = start()
  await screen.findByRole('heading', { name: 'Get ready to build faster' })
  await user().click(button('Skip'))
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    firstLaunchDone: true,
    startAtLogin: false,
    onboardingOnNextOpen: false,
  })
})

test('after a reset with a Factory, Set up TED is the last step and keeps Start at login and reporting', async () => {
  const a = start(undefined, {
    factories: [factory()],
    settings: {
      ...defaultMachineSettings,
      startAtLogin: true,
      onboardingOnNextOpen: true,
      reportingAsked: true,
    },
  })
  await toSetUp()
  expect(screen.getByText('Step 3 of 3')).toBeTruthy()
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Start TED in the background when you log in',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true)
  expect(
    (
      screen.getByRole('checkbox', {
        name: /^Send error reporting and usage data to the TED team/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(false)
  await user().click(button('Finish'))
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    firstLaunchDone: true,
    startAtLogin: true,
    onboardingOnNextOpen: false,
    reporting: false,
    reportingAsked: true,
  })
  expect(a.finish).toHaveBeenCalledWith(undefined)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('ready checks show account and tool details', async () => {
  await open()
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
  expect(button('Next').disabled).toBe(false)
})

test('Next waits for Git and an agent, then Add Factory is step 4 with Back and Skip', async () => {
  const a = await open([
    health({ state: 'signed-out' }),
    health({ agent: 'codex', state: 'not-installed' }),
  ])
  await screen.findByText('Next needs Git and at least one Provider ready.')
  const next = button('Next')
  expect(next.disabled).toBe(true)
  await act(async () =>
    a.emit({
      type: 'integrations-checked',
      health: { ...integrations, git: { state: 'no-identity' } },
    }),
  )
  await act(async () => a.emit({ type: 'agent-health-changed', health: health() }))
  a.handle('agentHealth', () => [health(), health({ agent: 'codex', state: 'not-installed' })])
  expect(next.disabled).toBe(true)
  await act(async () => a.emit({ type: 'integrations-checked', health: integrations }))
  expect(next.disabled).toBe(false)
  await user().click(
    screen.getByRole('checkbox', { name: 'Start TED in the background when you log in' }),
  )
  expect(a.request.mock.calls.filter(([name]) => name === 'updateSettings')).toEqual([])
  await user().click(next)
  let dialog = within(await screen.findByRole('dialog', { name: 'Add your first Factory' }))
  expect(dialog.getByText('Step 4 of 4')).toBeTruthy()
  await user().click(dialog.getByRole('button', { name: 'Back' }))
  await screen.findByRole('heading', { name: /^Set up TED/ })
  await vi.waitFor(() => expect(button('Next').disabled).toBe(false))
  await user().click(button('Next'))
  dialog = within(await screen.findByRole('dialog', { name: 'Add your first Factory' }))
  a.handle('updateSettings', () => Promise.reject(new Error('TED isn’t answering')))
  await user().click(dialog.getByRole('button', { name: 'Skip' }))
  expect((await dialog.findByRole('alert')).textContent).toBe('TED isn’t answering')
  expect((dialog.getByRole('button', { name: 'Skip' }) as HTMLButtonElement).disabled).toBe(false)
  a.handle('updateSettings', () => undefined)
  await user().click(dialog.getByRole('button', { name: 'Skip' }))
  expect(a.finish).toHaveBeenCalledWith(undefined)
  expect(a.request).toHaveBeenLastCalledWith('updateSettings', {
    firstLaunchDone: true,
    startAtLogin: true,
    onboardingOnNextOpen: false,
    reporting: true,
    reportingAsked: true,
  })
})

test('wrong credential permits Next and offers explicit billing choices', async () => {
  const a = await open([health({ state: 'wrong-credential', reason: 'API key' })])
  const claude = within(screen.getByRole('group', { name: 'Claude Code' }))
  await claude.findByText('Signed in with an API key')
  expect(button('Next').disabled).toBe(false)
  await user().click(claude.getByRole('button', { name: 'Sign in with a subscription instead' }))
  expect(a.request).toHaveBeenCalledWith('fixAgent', 'claude')
  expect(claude.getByText(/Opened claude auth login/)).toBeTruthy()
  a.handle('updateSettings', () => a.emit({ type: 'agent-health-changed', health: health() }))
  await user().click(claude.getByRole('button', { name: 'Use API-key billing' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    billing: { ...defaultMachineSettings.billing, claude: 'api-key' },
  })
  await claude.findByText('Ready')
  expect(claude.queryByRole('button', { name: 'Use API-key billing' })).toBeNull()
})

test('a Ready agent offers no API-key billing prompt', async () => {
  await open()
  await screen.findAllByText('Ready')
  expect(screen.queryByRole('button', { name: 'Use API-key billing' })).toBeNull()
})

test('signed-out GitHub does not block Next and Sign in opens its fix command', async () => {
  const a = await open()
  a.handle('runFix', () => ({ command: 'gh auth login --hostname github.com' }))
  await screen.findAllByText('Ready')
  await act(async () =>
    a.emit({
      type: 'integrations-checked',
      health: {
        ...integrations,
        github: {
          ...integrations.github,
          hosts: [
            {
              host: 'github.com',
              state: 'signed-out',
              scopes: [],
              usedBy: [],
              fix: { label: 'Sign in', command: 'gh auth login --hostname github.com' },
            },
          ],
        },
      },
    }),
  )
  const github = within(screen.getByRole('group', { name: 'GitHub' }))
  expect(button('Next').disabled).toBe(false)
  await user().click(github.getByRole('button', { name: 'Sign in' }))
  expect(a.request).toHaveBeenCalledWith('runFix', { fix: 'gh-login', host: 'github.com' })
  expect(github.getByText(/Opened gh auth login/)).toBeTruthy()
})

test.each(['not-installed', 'too-old'] as const)(
  'Linux %s tools offer browser instructions without command controls',
  async (state) => {
    const a = await open()
    a.handle('runFix', () => ({ url: integrationInstallPages.gh }))
    a.handle('checkIntegrations', () => integrations)
    await screen.findAllByText('Ready')
    await act(async () =>
      a.emit({
        type: 'integrations-checked',
        health: {
          ...integrations,
          github: {
            ...integrations.github,
            cli: {
              state,
              version: '2.40.1',
              fix: {
                label:
                  state === 'too-old' ? 'Update instructions ↗' : 'Installation instructions ↗',
                url: integrationInstallPages.gh,
              },
            },
          },
          git: {
            state: 'not-installed',
            fix: { label: 'Installation instructions ↗', url: integrationInstallPages.git },
          },
        },
      }),
    )
    const github = within(screen.getByRole('group', { name: 'GitHub' }))
    const git = within(screen.getByRole('group', { name: 'Git' }))
    for (const row of [github, git]) {
      expect(row.queryByRole('button', { name: 'Copy command' })).toBeNull()
      expect(row.queryByRole('button', { name: 'Open Terminal' })).toBeNull()
    }
    await user().click(github.getByRole('button', { name: /instructions ↗/ }))
    expect(a.request).toHaveBeenCalledWith('runFix', {
      fix: state === 'too-old' ? 'gh-update' : 'gh-install',
    })
    expect(github.getByText(/Opened instructions in your browser/)).toBeTruthy()
    a.handle('runFix', () => ({ url: integrationInstallPages.git }))
    await user().click(git.getByRole('button', { name: 'Installation instructions ↗' }))
    expect(a.request).toHaveBeenCalledWith('runFix', { fix: 'git-install' })
    expect(git.getByText(/Opened instructions in your browser/)).toBeTruthy()
  },
)
