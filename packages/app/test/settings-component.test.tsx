// @vitest-environment jsdom
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AboutGroup, CommandLineGroup } from '../src/renderer/settings/CommandLineGroup.tsx'
import { GeneralPage } from '../src/renderer/settings/GeneralPage.tsx'
import { NotificationsPage } from '../src/renderer/settings/NotificationsPage.tsx'
import { StoragePage } from '../src/renderer/settings/StoragePage.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'

const _nav = () => screen.getByRole('navigation', { name: 'Settings' })

test('terminal font size saves and immediately applies the CSS variable', async () => {
  const a = appState()
  a.mount()
  await a.settings()
  await user().selectOptions(screen.getByRole('combobox', { name: 'Terminal font size' }), '16')
  expect(a.request).toHaveBeenCalledWith('updateSettings', { terminalFontSize: 16 })
  expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px')
})

test('source command row explains that installation requires an installed copy', async () => {
  bridge({ getCommandLine: () => ({ state: 'unavailable' }) })
  render(<CommandLineGroup />)
  await screen.findByText('Only an installed copy of TED can install it.')
  expect(screen.queryByRole('button', { name: 'Install the ted command' })).toBeNull()
})

test('About shows the version and loads and closes third-party licenses', async () => {
  const notice = 'https://github.com/OrchestratorInc/agent-orchestrator\nNOTICE\nMIT'
  const api = bridge({
    updateStatus: () => ({ state: 'unavailable' }),
    thirdPartyLicenses: () => notice,
  })
  render(<AboutGroup />)
  expect(screen.getByText(/^TED \d+\.\d+\.\d+$/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'View' }))
  const dialog = screen.getByRole('dialog', { name: 'Third-party licenses' })
  expect(within(dialog).getByText(/agent-orchestrator/).textContent).toBe(notice)
  expect(api.request).toHaveBeenCalledWith('thirdPartyLicenses')
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('quit choice, login and Stay Awake switches send machine settings', async () => {
  const update = vi.fn()
  bridge({
    getProfile: () => ({ name: 'Nabha' }),
    loginItem: () => 'unavailable',
    updateStatus: () => ({ state: 'unavailable' }),
    getCommandLine: () => ({ state: 'unavailable' }),
    listEditors: () => [],
    updateSettings: update,
  })
  render(<GeneralPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const u = user()
  await u.selectOptions(
    screen.getByRole('combobox', { name: 'When you quit with work running' }),
    'stop',
  )
  for (const name of [
    'Start TED in the background when you log in',
    'Stay Awake while Runs are working',
  ]) {
    const toggle = screen.getByRole('switch', { name })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await u.click(toggle)
  }
  expect(update.mock.calls).toEqual([
    [{ quitWithWorkRunning: 'stop' }],
    [{ startAtLogin: false }],
    [{ stayAwake: false }],
  ])
})

test('Storage sets how long Run output is kept after a Task is done', async () => {
  const update = vi.fn()
  bridge({
    getStorage: () => ({
      home: '~/.ted/',
      usedBytes: 2e9,
      freeBytes: 80e9,
      volume: 'Macintosh HD',
      categories: [{ id: 'conversations-and-logs', label: 'Conversations and logs', bytes: 1e9 }],
      largestWorktrees: [],
      removableClones: { count: 0, bytes: 0 },
      simulators: { count: 0, bytes: 0 },
      backups: [],
      backupsDir: '~/.ted/backups/',
    }),
    updateSettings: update,
  })
  const { rerender } = render(<StoragePage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const group = await screen.findByRole('group', { name: 'Run output' })
  const days = within(group).getByRole<HTMLSelectElement>('combobox', {
    name: 'Keep Run output after a Task is done',
  })
  expect(days.value).toBe('7')
  expect(
    within(days)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['1 day', '3 days', '7 days', '14 days', '30 days', '90 days', '365 days'])
  await user().selectOptions(days, '30')
  expect(update.mock.calls).toEqual([[{ runOutputDays: 30 }]])

  rerender(
    <StoragePage settings={{ ...defaultMachineSettings, runOutputDays: 45 }} dispatch={vi.fn()} />,
  )
  expect(days.value).toBe('45')
  expect(within(days).getByRole('option', { name: '45 days' })).toBeTruthy()
})

test('login approval opens the fixed system-settings bridge action', async () => {
  const open = vi.fn()
  bridge({
    getProfile: () => ({ name: 'Nabha' }),
    loginItem: () => 'requires-approval',
    updateStatus: () => ({ state: 'unavailable' }),
    getCommandLine: () => ({ state: 'unavailable' }),
    listEditors: () => [],
    openLoginItemsSettings: open,
  })
  render(<GeneralPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  await screen.findByText('Allow TED in System Settings → Login Items')
  await user().click(screen.getByRole('button', { name: 'Open System Settings' }))
  expect(open).toHaveBeenCalledOnce()
})

test('notification switches and an OS-disabled event show the settings action', async () => {
  const update = vi.fn()
  const open = vi.fn()
  const api = bridge({
    notificationsOff: () => false,
    updateSettings: update,
    openNotificationSettings: open,
  })
  render(<NotificationsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const u = user()
  for (const name of ['Inbox items', 'Problems that stop work', 'Task merged', 'Play a sound'])
    await u.click(screen.getByRole('switch', { name }))
  expect(update.mock.calls).toEqual([
    [{ notifyInboxItems: false }],
    [{ notifyProblems: false }],
    [{ notifyTaskMerged: true }],
    [{ notifySound: true }],
  ])
  await act(async () => api.emit({ type: 'notifications-off', off: true }))
  expect(screen.getByRole('alert').textContent).toContain('Notifications are off for TED')
  await u.click(screen.getByRole('button', { name: 'Open System Settings' }))
  expect(open).toHaveBeenCalledOnce()
})

test('Developer mode controls Diagnostics and logs, including Run raw output', async () => {
  const { DeveloperPage } = await import('../src/renderer/settings/DeveloperPage.tsx')
  const api = bridge({
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
    updateSettings: vi.fn(),
    getDiagnostics: () => ({
      memory: { totalBytes: 1e9, availableBytes: 5e8 },
      runs: [
        {
          runId: 'run-123456',
          agent: 'claude',
          state: 'idle',
          cpuPercent: 0,
          memoryBytes: 100,
          tokens: { input: 1, output: 2 },
        },
      ],
      processes: [],
    }),
    readDaemonLog: () => ({ text: 'TED daemon 123 listening', truncated: false }),
    readRunOutput: () => ({ text: 'from the stub', truncated: false }),
  })
  const view = render(<DeveloperPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  expect(screen.queryByRole('region', { name: 'Diagnostics' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Logs' })).toBeNull()
  await user().click(screen.getByRole('switch', { name: 'Developer mode' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', { developerMode: true })
  view.rerender(
    <DeveloperPage
      settings={{ ...defaultMachineSettings, developerMode: true }}
      dispatch={vi.fn()}
    />,
  )
  await screen.findByText('TED daemon 123 listening')
  expect(
    within(screen.getByRole('region', { name: 'Diagnostics' })).getByRole('cell', {
      name: 'run-1234',
    }),
  ).toBeTruthy()
  await user().selectOptions(screen.getByRole('combobox', { name: 'Log' }), 'run-123456')
  await screen.findByText('from the stub')
  expect(api.request).toHaveBeenCalledWith('readRunOutput', 'run-123456')
  await user().click(screen.getByRole('switch', { name: 'Developer mode' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', { developerMode: false })
  view.rerender(<DeveloperPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  expect(screen.queryByRole('region', { name: 'Logs' })).toBeNull()
})

test('Settings shell lists all sections and opens a Factory’s settings', async () => {
  const { SettingsShell } = await import('../src/renderer/settings/SettingsShell.tsx')
  const { factory } = await import('./support/fixtures.ts')
  const dispatch = vi.fn()
  render(
    <SettingsShell
      section="general"
      settings={undefined}
      factories={[factory()]}
      inboxCount={0}
      dispatch={dispatch}
    />,
  )
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  for (const [id, name] of [
    ['general', 'General'],
    ['notifications', 'Notifications'],
    ['agents', 'Agents'],
    ['limits', 'Limits'],
    ['integrations', 'Integrations'],
    ['library', 'Library'],
    ['storage', 'Storage'],
    ['developer', 'Developer'],
  ] as const) {
    await user().click(nav.getByRole('button', { name }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'open-settings', section: id })
  }
  expect(nav.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page')
  await user().click(nav.getByRole('button', { name: /widgets/ }))
  expect(dispatch).toHaveBeenCalledWith({
    type: 'open',
    screen: { kind: 'factory', factoryId: 'f1', view: 'settings' },
  })
})

test('App settings navigation selects real pages and Factory settings leaves the Settings shell', async () => {
  const a = appState()
  a.handle('library', () => ({
    path: '/test/library',
    version: 'v1',
    stages: [],
    agents: [],
    problems: [],
  }))
  a.handle('tedFolder', () => ({ path: '/test/', platform: 'darwin' }))
  a.handle('homeFolder', () => '/test')
  const { settingsView } = await import('./support/fixtures.ts')
  a.handle('factorySettings', settingsView)
  a.mount()
  await a.settings()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  for (const name of ['Notifications', 'Limits', 'Developer', 'Library', 'General']) {
    await user().click(within(nav).getByRole('button', { name }))
    expect(within(nav).getByRole('button', { name }).getAttribute('aria-current')).toBe('page')
    expect(
      within(screen.getByRole('main', { name })).getByRole('heading', { name, level: 1 }),
    ).toBeTruthy()
  }
  await user().click(within(nav).getByRole('button', { name: 'widgets' }))
  await screen.findByRole('heading', { name: /widgets.*Settings/, level: 1 })
  expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
  expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeTruthy()
})
