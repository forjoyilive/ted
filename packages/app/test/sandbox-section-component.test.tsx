// @vitest-environment jsdom
import type { FactorySettingsView, MachineSettings } from '@ted/protocol'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { SandboxSection } from '../src/renderer/views/SandboxSection.tsx'
import { bridge, user } from './support/component.ts'

const view: Pick<
  FactorySettingsView,
  | 'factoryId'
  | 'permissions'
  | 'sandboxSockets'
  | 'sandboxSocketsFrom'
  | 'electronApps'
  | 'repos'
  | 'checks'
> = {
  factoryId: 'factory',
  permissions: 'auto',
  sandboxSockets: [],
  electronApps: [],
  repos: [],
  checks: [],
}

const links = {
  onOpenPermissions: vi.fn(),
  onOpenRepos: vi.fn(),
  onOpenChecks: vi.fn(),
  onOpenProviders: vi.fn(),
}

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
    appsOutsideSandbox: {
      factory: [{ repo: 'ted', app: 'Ted Dev', declaration: 'a'.repeat(64) }],
      other: [{ repo: 'web', app: 'Web', declaration: 'b'.repeat(64) }],
    },
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
    appsOutsideSandbox: { other: [{ repo: 'web', app: 'Web', declaration: 'b'.repeat(64) }] },
  })
  api.emit({ type: 'settings-changed', settings })
  expect(await screen.findByText('1 thing runs outside the sandbox.')).toBeTruthy()
})

test('a socket inherited from the Library says where to turn it off', async () => {
  bridge({})
  render(
    <SandboxSection
      view={{ ...view, sandboxSockets: ['/lib.sock'], sandboxSocketsFrom: 'library' }}
      {...links}
    />,
  )
  expect(await screen.findByText('Nothing runs outside the sandbox.')).toBeTruthy()
  const row = screen.getByRole('listitem')
  expect(row.textContent).toContain('From sandbox_sockets in the Library’s workflow.yaml.')
  expect(row.textContent).toContain('Settings → Library')
  expect(row.textContent).toContain('sandbox_sockets: []')
})

test('access groups on Apps, Checks and setup widen the sandbox and link to where they are set', async () => {
  bridge({})
  const repo = {
    was: 'mobile',
    repo: 'me/mobile',
    name: 'mobile',
    primary: true,
    setup: { run: 'pod install', sandboxAccess: ['ios-xcode' as const] },
    env: [],
    copy: [],
    apps: [
      {
        was: 0,
        name: 'iOS simulator',
        kind: 'ios-simulator' as const,
        run: 'run.sh',
        sandboxAccess: ['ios-xcode' as const],
      },
      { was: 1, name: 'Web', kind: 'web' as const, run: 'pnpm dev' },
    ],
  }
  render(
    <SandboxSection
      view={{
        ...view,
        repos: [repo],
        checks: [{ was: 0, name: 'iOS build', run: 'xcodebuild', sandboxAccess: ['ios-xcode'] }],
      }}
      {...links}
    />,
  )
  expect(
    await screen.findByText('3 settings widen what sandboxed commands can reach.'),
  ).toBeTruthy()
  const rows = within(screen.getByRole('list', { name: 'Sandbox openings' })).getAllByRole(
    'listitem',
  )
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('Worktree setup in mobile has ios-xcode'),
    expect.stringContaining('iOS simulator App in mobile has ios-xcode'),
    expect.stringContaining('iOS build Check has ios-xcode'),
  ])
  await user().click(within(rows[2] as HTMLElement).getByRole('button', { name: 'Open Checks' }))
  expect(links.onOpenChecks).toHaveBeenCalled()
  await user().click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Open Repos' }))
  expect(links.onOpenRepos).toHaveBeenCalled()
})

test('shared-tmp on a Check says its commands can reach the shared /tmp', async () => {
  bridge({})
  render(
    <SandboxSection
      view={{
        ...view,
        checks: [{ was: 0, name: 'Build', run: 'make', sandboxAccess: ['shared-tmp'] }],
      }}
      {...links}
    />,
  )
  const row = await screen.findByText(/Build Check has/)
  const item = row.closest('li') as HTMLElement
  expect(item.textContent).toContain('shared-tmp')
  expect(item.textContent).toContain('Its commands can read and write /tmp.')
})
