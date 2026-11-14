// @vitest-environment jsdom
import {
  defaultMachineSettings,
  type IntegrationsHealth,
  integrationInstallPages,
} from '@ted/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AsanaGroup } from '../src/renderer/settings/AsanaGroup.tsx'
import { IntegrationsPage } from '../src/renderer/settings/IntegrationsPage.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory } from './support/fixtures.ts'

test.each(['not-installed', 'too-old'] as const)(
  'Settings shows official instructions for Linux %s tools',
  async (state) => {
    const health: IntegrationsHealth = {
      github: {
        cli: {
          state,
          version: '2.40.1',
          fix: {
            label: state === 'too-old' ? 'Update instructions ↗' : 'Installation instructions ↗',
            url: integrationInstallPages.gh,
          },
        },
        hosts: [],
      },
      git: {
        state: 'not-installed',
        fix: { label: 'Installation instructions ↗', url: integrationInstallPages.git },
      },
      checkedAt: createdAt,
    }
    const a = bridge({
      getIntegrations: () => health,
      checkIntegrations: () => health,
      listFactories: () => [],
      getLinear: () => ({ state: 'no-key', keyring: 'macos-keychain' }),
      tedFolder: () => ({ path: '/test/' }),
      runFix: (request) => ({
        url:
          (request as { fix: string }).fix === 'git-install'
            ? integrationInstallPages.git
            : integrationInstallPages.gh,
      }),
    })
    render(<IntegrationsPage settings={defaultMachineSettings} />)
    const github = within(await screen.findByRole('group', { name: 'GitHub' }))
    const git = within(screen.getByRole('group', { name: 'Git' }))
    await github.findByText('GitHub CLI')
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull()
    expect(document.querySelector('code')).toBeNull()
    await user().click(github.getByRole('button', { name: /instructions ↗/ }))
    expect(a.request).toHaveBeenCalledWith('runFix', {
      fix: state === 'too-old' ? 'gh-update' : 'gh-install',
    })
    expect(github.getByText(/Opened instructions in your browser/)).toBeTruthy()
    await user().click(git.getByRole('button', { name: 'Installation instructions ↗' }))
    expect(a.request).toHaveBeenCalledWith('runFix', { fix: 'git-install' })
    expect(git.getByText(/Opened instructions in your browser/)).toBeTruthy()
    await user().click(git.getByRole('button', { name: 'Check again' }))
    expect(a.request).toHaveBeenCalledWith('checkIntegrations')
  },
)

test('Asana Settings lists each Factory’s projects by name, adds one from Asana’s list and asks again after another account connected', async () => {
  const notes = factory({ id: 'f1', name: 'Notebooks' })
  const settings = {
    ...defaultMachineSettings,
    trackerSyncGroups: { asana: { f1: ['9'] } },
    trackerSyncDeclined: { asana: { f1: ['7'] } },
    trackerSyncGroupAccounts: { asana: { f1: { '9': '200' } } },
  }
  const a = bridge({
    getSettings: () => settings,
    listFactories: () => [notes],
    getAsana: () => ({
      state: 'connected',
      configured: true,
      redirectUri: '',
      user: { gid: '100', name: 'Avery', email: 'avery@example.test' },
    }),
    asanaProjects: () => ({
      projects: [
        { gid: '9', name: 'Roadmap', workspace: 'Acme' },
        { gid: '8', name: 'Other', workspace: 'Acme' },
        { gid: '7', name: 'Ops', workspace: 'Acme' },
      ],
      complete: true,
    }),
    allowAsanaProject: () => settings,
    forgetAsanaProject: () => settings,
  })
  render(<AsanaGroup />)
  await screen.findByText('Asana projects for Automations in Notebooks')
  const picker = await screen.findByRole('combobox', {
    name: 'Asana projects for Automations in Notebooks',
  })
  await waitFor(() => expect((picker as HTMLSelectElement).disabled).toBe(false))
  expect(
    within(picker)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Add a project…', 'Other · Acme', 'Ops · Acme'])
  expect(screen.getByText('Allowed by another Asana account')).toBeTruthy()
  expect(screen.getByText(/You chose Not now for/).textContent).toContain('Ops')

  await user().click(
    screen.getByRole('button', { name: 'Allow Roadmap again for Automations in Notebooks' }),
  )
  expect(a.request).toHaveBeenCalledWith('allowAsanaProject', 'f1', '9')
  await user().selectOptions(picker, '8')
  expect(a.request).toHaveBeenCalledWith('allowAsanaProject', 'f1', '8')
  await user().click(screen.getByRole('button', { name: 'Remove Roadmap from Notebooks' }))
  expect(a.request).toHaveBeenCalledWith('forgetAsanaProject', 'f1', '9', 'allowed')
  await user().click(screen.getByRole('button', { name: 'Remove Ops from Not now in Notebooks' }))
  expect(a.request).toHaveBeenCalledWith('forgetAsanaProject', 'f1', '7', 'declined')
})
