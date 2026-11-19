// @vitest-environment jsdom
import type { FactorySettingsView, MachineSettings } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { SandboxSection } from '../src/renderer/views/SandboxSection.tsx'
import { bridge, user } from './support/component.ts'

const view: Pick<
  FactorySettingsView,
  'factoryId' | 'permissions' | 'sandboxSockets' | 'electronApps'
> = {
  factoryId: 'factory',
  permissions: 'auto',
  sandboxSockets: [],
  electronApps: [],
}

const links = { onOpenPermissions: vi.fn(), onOpenRepos: vi.fn(), onOpenProviders: vi.fn() }

test('a Factory with nothing open says so and lists nothing', async () => {
  bridge({})
  render(<SandboxSection view={view} {...links} />)
  expect(await screen.findByText('Nothing widens the sandbox.')).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Sandbox openings' })).toBeNull()
})

test('unsandboxed items come first, and Stop allowing removes an App approved outside the sandbox', async () => {
  let settings: MachineSettings = {
    ...defaultMachineSettings,
    factoryPermissions: { factory: 'bypass' },
    appsOutsideSandbox: { factory: ['Ted Dev'], other: ['Web'] },
  }
  const api = bridge({
    getSettings: () => settings,
    updateSettings: (change) => {
      settings = { ...settings, ...(change as Partial<MachineSettings>) }
      return settings
    },
  })
  render(
    <SandboxSection
      view={{ ...view, sandboxSockets: ['/a.sock'], electronApps: [{ repo: 'ted', name: 'Desk' }] }}
      {...links}
    />,
  )
  expect(await screen.findByText('2 things run outside the sandbox.')).toBeTruthy()
  const rows = within(screen.getByRole('list', { name: 'Sandbox openings' })).getAllByRole(
    'listitem',
  )
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('Bypass'),
    expect.stringContaining('App “Ted Dev” runs outside the sandbox'),
    expect.stringContaining('Socket /a.sock'),
    expect.stringContaining('Electron App “Desk”'),
  ])
  await user().click(
    within(rows[0] as HTMLElement).getByRole('button', { name: 'Open Permission mode' }),
  )
  expect(links.onOpenPermissions).toHaveBeenCalled()
  await user().click(screen.getByRole('button', { name: 'Stop allowing' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', {
    appsOutsideSandbox: { other: ['Web'] },
  })
  api.emit({ type: 'settings-changed', settings })
  expect(await screen.findByText('1 thing runs outside the sandbox.')).toBeTruthy()
})
