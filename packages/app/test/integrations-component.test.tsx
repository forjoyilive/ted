// @vitest-environment jsdom
import {
  defaultMachineSettings,
  type IntegrationsHealth,
  integrationInstallPages,
} from '@ted/protocol'
import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { IntegrationsPage } from '../src/renderer/settings/IntegrationsPage.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

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
