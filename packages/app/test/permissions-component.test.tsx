// @vitest-environment jsdom
import type { FactorySettingsView } from '@ted/protocol'
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { settingsChanges, settingsDraft } from '../src/renderer/factory-settings.ts'
import { PermissionsSection } from '../src/renderer/views/FactorySettingsSections.tsx'
import { bridge, user } from './support/component.ts'

const view: FactorySettingsView = {
  factoryId: 'factory',
  repo: 'acme/widgets',
  defaultBranch: 'main',
  source: 'file',
  version: '1',
  repos: [],
  problems: [],
  github: { ready: true },
  stages: [],
  ignoredStageFiles: [],
  checks: [],
  tries: [],
  agents: [],
  permissions: 'auto',
  repoPermissions: 'bypass',
  machineMaxWorkingRuns: 6,
  notes: '',
}

test('Bypass is local, requires explicit confirmation, and Auto saves without a repo draft', async () => {
  const api = bridge({ setFactoryPermissions: (_id, mode) => ({ mode }) })
  const draft = settingsDraft(view)
  const onDraft = vi.fn()
  render(<PermissionsSection view={view} draft={draft} loaded={draft} onDraft={onDraft} />)
  expect(screen.getByText(/The repo requests Bypass/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Enable Bypass…' }))
  const dialog = screen.getByRole('dialog')
  const enable = within(dialog).getByRole('button', { name: 'Enable Bypass' })
  expect(enable.hasAttribute('disabled')).toBe(true)
  await user().click(within(dialog).getByRole('checkbox'))
  await user().click(enable)
  expect(api.request).toHaveBeenCalledWith('setFactoryPermissions', 'factory', 'bypass', true)
  expect(screen.getByText('Bypass is on.')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Use Auto' }))
  expect(api.request).toHaveBeenCalledWith('setFactoryPermissions', 'factory', 'auto', true)
  expect(onDraft).not.toHaveBeenCalled()
  expect(settingsChanges({ ...draft, permissions: 'bypass' }, draft)).not.toHaveProperty(
    'permissions',
  )
})

test('canceling Bypass does not save; failed saves keep Auto and show the error', async () => {
  const api = bridge({ setFactoryPermissions: () => Promise.reject(new Error('Save failed')) })
  const draft = settingsDraft(view)
  render(<PermissionsSection view={view} draft={draft} loaded={draft} onDraft={vi.fn()} />)
  await user().click(screen.getByRole('button', { name: 'Enable Bypass…' }))
  await user().click(screen.getByRole('button', { name: 'Cancel' }))
  expect(api.request).not.toHaveBeenCalled()
  await user().click(screen.getByRole('button', { name: 'Enable Bypass…' }))
  await user().click(screen.getByRole('checkbox'))
  await user().click(screen.getByRole('button', { name: /^Enable Bypass$/ }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByText('Auto is on.')).toBeTruthy()
})
