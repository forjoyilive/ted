// @vitest-environment jsdom
import { defaultMachineSettings } from '@ted/protocol/settings'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AboutGroup, CommandLineGroup } from '../src/renderer/settings/CommandLineGroup.tsx'
import { GeneralPage } from '../src/renderer/settings/GeneralPage.tsx'
import { LimitsPage } from '../src/renderer/settings/LimitsPage.tsx'
import { NotificationsPage } from '../src/renderer/settings/NotificationsPage.tsx'
import { StoragePage } from '../src/renderer/settings/StoragePage.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'

const _nav = () => screen.getByRole('navigation', { name: 'Settings' })

test('terminal font size saves and immediately applies the CSS variable', async () => {
  const a = appState()
  a.mount()
  await a.settings()
  await user().selectOptions(screen.getByRole('combobox', { name: 'Terminal font size' }), '16')
  expect(a.request).toHaveBeenCalledWith('updateSettings', { terminalFontSize: 16 })
  expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px')
})

test('text size steps by 5%, resets, and leaves terminal sizing independent', async () => {
  const a = appState()
  a.mount()
  await a.settings()
  expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1')
  await user().click(screen.getByRole('button', { name: 'Increase text size' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', { textSize: 105 })
  expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.05')
  expect(screen.getByText('105%')).toBeTruthy()
  expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('13px')
  await user().click(screen.getByRole('button', { name: /^Default$/ }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', { textSize: 100 })
  expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1')
})

test.each([80, 200])('text size disables the button at %s%%', async (textSize) => {
  const a = appState()
  a.state.settings.textSize = textSize
  a.mount()
  await a.settings()
  const name = textSize === 80 ? 'Decrease text size' : 'Increase text size'
  expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true)
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

test('Limits changes how many Checks run at once and turns low priority off', async () => {
  const update = vi.fn()
  bridge({
    getSlots: () => ({ limit: 6, working: 0, queued: 0, holders: [], queue: [], factories: [] }),
    simulators: () => ({ supported: false }),
    updateSettings: update,
  })
  render(<LimitsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  await screen.findByText('Now: 0 slots in use · limit 6')
  const toggle = screen.getByRole('switch', { name: 'Run agents and Checks at low priority' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText(/Applies to work started after you change it/)).toBeTruthy()
  await user().click(toggle)
  expect(screen.getByText('Checks running at once')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'More Checks at once' }))
  await user().click(screen.getByRole('button', { name: 'Fewer Checks at once' }))
  expect(update.mock.calls).toEqual([
    [{ lowPriorityWork: false }],
    [{ maxChecksAtOnce: 3 }],
    [{ maxChecksAtOnce: 1 }],
  ])
})

test('Storage sets how long Run output is kept after a Task is done', async () => {
  const update = vi.fn()
  bridge({
    listFactories: () => [],
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
          cpuPercent: 12.5,
          memoryBytes: 128 * 1024 * 1024,
          tokens: { input: 1, output: 2 },
        },
      ],
      processes: [
        {
          pid: 123,
          ppid: 1,
          command: 'node',
          owner: 'daemon',
          cpuPercent: 2.4,
          memoryBytes: 64 * 1024 * 1024,
        },
      ],
    }),
    readDaemonLog: () => ({ text: 'TED daemon 123 listening', truncated: false }),
    readRunOutput: () => ({ text: 'from the stub', truncated: false }),
  })
  const view = render(<DeveloperPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  expect(screen.queryByRole('region', { name: 'Diagnostics' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Logs' })).toBeNull()
  expect(api.request).not.toHaveBeenCalledWith('getDiagnostics')
  await user().click(screen.getByRole('switch', { name: 'Developer mode' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', { developerMode: true })
  view.rerender(
    <DeveloperPage
      settings={{ ...defaultMachineSettings, developerMode: true }}
      dispatch={vi.fn()}
    />,
  )
  await screen.findByText('TED daemon 123 listening')
  for (const reading of ['12.5%', '128 MB', '2.4%', '64 MB', 'System memory usage'])
    expect(screen.getByText(reading)).toBeTruthy()
  expect(
    within(screen.getByRole('region', { name: 'Diagnostics' })).getByRole('cell', {
      name: 'run-12',
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

test('Record a CPU profile asks for one profile at a time and shows where it was saved', async () => {
  const { DeveloperPage } = await import('../src/renderer/settings/DeveloperPage.tsx')
  const result = deferred<{ file: string; seconds: number; bytes: number }>()
  const api = bridge({
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
    recordProfile: () => result.promise,
  })
  render(<DeveloperPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  await user().click(screen.getByRole('button', { name: 'Record 30 seconds' }))
  expect(api.request).toHaveBeenCalledWith('recordProfile', 30)
  expect(screen.getByRole('button', { name: 'Recording…' }).hasAttribute('disabled')).toBe(true)
  await act(async () =>
    result.resolve({ file: '~/.ted/logs/profiles/daemon-1.cpuprofile', seconds: 30, bytes: 10 }),
  )
  expect(screen.getByText('Saved to ~/.ted/logs/profiles/daemon-1.cpuprofile')).toBeTruthy()
  api.handle('recordProfile', () => {
    throw new Error(
      "Error invoking remote method 'ted:request': DaemonRequestError: TED is already recording a CPU profile",
    )
  })
  await user().click(screen.getByRole('button', { name: 'Record 30 seconds' }))
  await screen.findByText('Couldn’t record a profile: TED is already recording a CPU profile')
  expect(api.request).toHaveBeenCalledTimes(3)
})

test('resource readings refresh while Developer mode is visible and stop when hidden', async () => {
  const { DeveloperPage } = await import('../src/renderer/settings/DeveloperPage.tsx')
  let cpuPercent = 12.5
  const diagnostics = vi.fn(() => ({
    memory: { totalBytes: 1024 ** 3, availableBytes: 512 * 1024 ** 2 },
    runs: [
      {
        runId: 'live-run',
        agent: 'codex',
        state: 'working',
        cpuPercent,
        memoryBytes: 128 * 1024 ** 2,
        tokens: { input: 0, output: 0 },
      },
    ],
    processes: [],
  }))
  bridge({
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
    getDiagnostics: diagnostics,
    readDaemonLog: () => ({ text: '', truncated: false }),
  })
  vi.useFakeTimers()
  try {
    const view = render(
      <DeveloperPage
        settings={{ ...defaultMachineSettings, developerMode: true }}
        dispatch={vi.fn()}
      />,
    )
    await act(async () => {})
    expect(screen.getByText('12.5%')).toBeTruthy()
    expect(screen.getByText('128 MB')).toBeTruthy()
    cpuPercent = 37.8
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByText('37.8%')).toBeTruthy()
    expect(screen.queryByText('12.5%')).toBeNull()
    expect(diagnostics).toHaveBeenCalledTimes(2)

    view.rerender(<DeveloperPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(screen.queryByRole('region', { name: 'Diagnostics' })).toBeNull()
    expect(diagnostics).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
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

const found = (setting: string) =>
  document.querySelector(`[data-setting="${setting}"]`)?.hasAttribute('data-found') === true

test('Settings search lists a setting with its page, opens that page and marks the row', async () => {
  const a = appState()
  a.mount()
  await a.settings()
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  const field = nav.getByRole<HTMLInputElement>('combobox', { name: 'Search settings' })

  fireEvent.change(field, { target: { value: 'checks running' } })
  const options = nav.getAllByRole('option')
  expect(options[0]?.textContent).toBe('Checks running at onceSettings › Limits')
  expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  expect(nav.queryByRole('button', { name: 'General' })).toBeNull()
  field.focus()
  await user().keyboard('{Enter}')
  await screen.findByRole('heading', { name: 'Limits' })
  await waitFor(() => expect(found('app.limits.checks')).toBe(true))
  expect(field.value).toBe('')
  expect(nav.getByRole('button', { name: 'Limits' }).getAttribute('aria-current')).toBe('page')

  fireEvent.change(field, { target: { value: 'zzz' } })
  expect(nav.getByText('No settings match ‘zzz’')).toBeTruthy()
  await user().keyboard('{Escape}')
  expect(field.value).toBe('')
  expect(nav.getByRole('button', { name: 'General' })).toBeTruthy()

  fireEvent.change(field, { target: { value: 'teardown' } })
  expect(nav.getAllByRole('option')[0]?.textContent).toBe(
    'Teardown commandwidgets › Settings › Repos',
  )
})

test('⌘K lists a matching setting with its page and opens it', async () => {
  const a = appState()
  a.handle('search', (query) => ({
    query,
    tasks: [],
    comments: [],
    plans: [],
    automations: [],
    factories: [],
  }))
  a.mount()
  await screen.findByRole('button', { name: 'widgets' })
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
  fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'overnight' } })
  const group = within(palette).getByRole('group', { name: 'Settings' })
  const options = within(group).getAllByRole('option')
  expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
    'Overnight mode across all Factories, Settings › General',
    'Overnight mode, Settings › General',
  ])
  await user().click(options[0] as HTMLElement)
  expect(screen.queryByRole('dialog', { name: 'Search and commands' })).toBeNull()
  await screen.findByRole('heading', { name: 'General' })
  await waitFor(() => expect(found('app.general.overnight.mode')).toBe(true))
})
