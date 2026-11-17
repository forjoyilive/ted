// @vitest-environment jsdom
import { defaultMachineSettings } from '@ted/protocol/settings'
import { noChecks } from '@ted/protocol/slots'
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
  expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.1')
  await user().click(screen.getByRole('button', { name: 'Increase text size' }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', { textSize: 105 })
  expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.155')
  expect(screen.getByText('105%')).toBeTruthy()
  expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('13px')
  await user().click(screen.getByRole('button', { name: /^Default$/ }))
  expect(a.request).toHaveBeenCalledWith('updateSettings', { textSize: 100 })
  expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.1')
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
  await screen.findByText('Only an installed copy of Ted can install it.')
  expect(screen.queryByRole('button', { name: 'Install the ted command' })).toBeNull()
})

test('About shows the version and loads and closes third-party licenses', async () => {
  const notice = 'https://github.com/OrchestratorInc/agent-orchestrator\nNOTICE\nMIT'
  const api = bridge({
    updateStatus: () => ({ state: 'unavailable' }),
    thirdPartyLicenses: () => notice,
  })
  render(<AboutGroup />)
  expect(screen.getByText(/^Ted \d+\.\d+\.\d+$/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'View' }))
  const dialog = screen.getByRole('dialog', { name: 'Third-party licenses' })
  expect(within(dialog).getByText(/agent-orchestrator/).textContent).toBe(notice)
  expect(api.request).toHaveBeenCalledWith('thirdPartyLicenses')
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('quit choice, login, Stay Awake and reporting switches send machine settings', async () => {
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
    'Start Ted in the background when you log in',
    'Stay awake while Runs are working',
  ]) {
    const toggle = screen.getByRole('switch', { name })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await u.click(toggle)
  }
  const reporting = screen.getByRole('switch', {
    name: 'Send error reporting and usage data to the Ted team',
  })
  expect(reporting.getAttribute('aria-checked')).toBe('false')
  await u.click(reporting)
  expect(update.mock.calls).toEqual([
    [{ quitWithWorkRunning: 'stop' }],
    [{ startAtLogin: false }],
    [{ stayAwake: false }],
    [{ reporting: true, reportingAsked: true }],
  ])
})

test('Limits changes how many Checks run at once and turns low priority off', async () => {
  const update = vi.fn()
  bridge({
    getSlots: () => ({
      limit: 6,
      working: 0,
      queued: 0,
      holders: [],
      queue: [],
      factories: [],
      checks: noChecks,
    }),
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    updateSettings: update,
  })
  render(<LimitsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  await screen.findByText('Now: 0 of 6 slots in use')
  const toggle = screen.getByRole('switch', { name: 'Run agents and Checks at low priority' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText(/Applies to work started after you change it/)).toBeTruthy()
  await user().click(toggle)
  expect(screen.getByText('Checks running at once')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'More Checks at once' }))
  await user().click(screen.getByRole('button', { name: 'Fewer Checks at once' }))
  expect(screen.getByText('CPU a Check may use')).toBeTruthy()
  expect(screen.getByText('50%')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'More CPU for a Check' }))
  await user().click(screen.getByRole('button', { name: 'Less CPU for a Check' }))
  const scheduled = screen.getByRole('switch', { name: 'Limit the CPU Scheduled Checks use too' })
  expect(scheduled.getAttribute('aria-checked')).toBe('true')
  await user().click(scheduled)
  expect(screen.getByText('10 min')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'End idle agents later' }))
  await user().click(
    screen.getByRole('switch', { name: 'End idle Task Lead agents to free memory' }),
  )
  expect(update.mock.calls).toEqual([
    [{ lowPriorityWork: false }],
    [{ maxChecksAtOnce: 3 }],
    [{ maxChecksAtOnce: 1 }],
    [{ checkCpuPercent: 60 }],
    [{ checkCpuPercent: 40 }],
    [{ limitScheduledCheckCpus: false }],
    [{ sleepIdleRunsAfterMinutes: 15 }],
    [{ sleepIdleRunsAfterMinutes: null }],
  ])
})

test('Storage sets when chats and archived tasks are deleted and measures again only on Refresh', async () => {
  const update = vi.fn()
  const pending = deferred<{ due: number; kept: number }>()
  const viewed = vi.fn()
  const api = bridge({
    listFactories: () => [],
    storageViewed: viewed,
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
      storeFiles: { eventLogBytes: 150e6, stateBytes: 270e6, backupsBytes: 2.4e9 },
      measuredAt: new Date(Date.now() - 3.5 * 60_000).toISOString(),
    }),
    updateSettings: update,
    archiveExpiry: (days) =>
      Number(days) === 7
        ? pending.promise
        : Number(days) < 90
          ? { due: 2, kept: 1 }
          : { due: 0, kept: 0 },
  })
  const { rerender, unmount } = render(
    <StoragePage settings={defaultMachineSettings} dispatch={vi.fn()} />,
  )
  const group = await screen.findByRole('group', { name: 'Delete automatically' })
  const days = within(group).getByRole<HTMLSelectElement>('combobox', {
    name: 'Delete agent chats',
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

  const archived = within(group).getByRole<HTMLSelectElement>('combobox', {
    name: 'Delete archived Tasks',
  })
  expect(archived.value).toBe('0')
  expect(
    within(archived)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Never', '7 days', '14 days', '30 days', '90 days', '365 days'])
  update.mockClear()
  await user().selectOptions(archived, '90')
  await waitFor(() => expect(update.mock.calls).toEqual([[{ deleteArchivedAfterDays: 90 }]]))
  rerender(
    <StoragePage
      settings={{ ...defaultMachineSettings, deleteArchivedAfterDays: 90 }}
      dispatch={vi.fn()}
    />,
  )
  await user().selectOptions(archived, '30')
  const confirm = await screen.findByRole('dialog', { name: 'Delete 2 archived Tasks now?' })
  expect(update.mock.calls).toHaveLength(1)
  await user().click(within(confirm).getByRole('button', { name: 'Delete 2 Tasks' }))
  expect(update.mock.calls.at(-1)).toEqual([{ deleteArchivedAfterDays: 30 }])
  rerender(
    <StoragePage
      settings={{ ...defaultMachineSettings, deleteArchivedAfterDays: 30 }}
      dispatch={vi.fn()}
    />,
  )
  expect(await screen.findByText(/^Kept for now: 1 archived Task, because it has/)).toBeTruthy()
  await user().selectOptions(archived, '0')
  expect(update.mock.calls.at(-1)).toEqual([{ deleteArchivedAfterDays: null }])

  rerender(
    <StoragePage
      settings={{ ...defaultMachineSettings, deleteArchivedAfterDays: 30 }}
      dispatch={vi.fn()}
    />,
  )
  update.mockClear()
  await user().selectOptions(archived, '7')
  await user().selectOptions(archived, '0')
  await act(async () => pending.resolve({ due: 0, kept: 0 }))
  expect(update.mock.calls).toEqual([[{ deleteArchivedAfterDays: null }]])

  const store = screen.getByRole('group', { name: 'Store and backups' })
  expect(
    ['Event log', 'State database', 'Backups'].map(
      (name) => within(store).getByText(name).closest('[data-setting]')?.textContent,
    ),
  ).toEqual(['Event log150 MB', 'State database270 MB', 'Backups2.4 GB'])

  expect(screen.getByText(/· Measured 3m ago$/)).toBeTruthy()
  expect(api.request).toHaveBeenCalledWith('getStorage', { refresh: false })
  await user().click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('getStorage', { refresh: true }))
  expect(viewed).not.toHaveBeenCalled()
  unmount()
  expect(viewed).toHaveBeenCalledOnce()

  const summary = await api.request('getStorage', { refresh: false })
  const answer = deferred<unknown>()
  api.handle('getStorage', () => answer.promise)
  const again = render(<StoragePage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  expect(screen.getByText('Conversations and logs')).toBeTruthy()
  expect(screen.queryByText('Measuring…')).toBeNull()
  answer.resolve(summary)
  await screen.findByText(/· Measured 3m ago$/)
  again.unmount()

  const later = deferred<unknown>()
  api.handle('getStorage', () => later.promise)
  const leftAt = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(leftAt + 11 * 60_000)
  const stale = render(<StoragePage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  expect(screen.getByText('Measuring…')).toBeTruthy()
  expect(screen.queryByText('Conversations and logs')).toBeNull()
  later.resolve(summary)
  await screen.findByText('Conversations and logs')
  stale.unmount()
  clock.mockRestore()
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
  await screen.findByText('Allow Ted in System Settings → Login Items')
  await user().click(screen.getByRole('button', { name: 'Open System Settings' }))
  expect(open).toHaveBeenCalledOnce()
})

test('notification switches and an OS-disabled event show the settings action', async () => {
  const update = vi.fn()
  const open = vi.fn()
  const turnOn = vi.fn()
  const api = bridge({
    notificationsOff: () => false,
    notificationOffer: () => 'not-asked',
    turnOnNotifications: turnOn,
    listFactories: () => [{ id: 'nb', name: 'notebook' }],
    updateSettings: update,
    setFactoryNotifications: (...args) => update(...args),
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
  update.mockClear()
  const byFactory = await screen.findByRole('group', { name: 'By Factory' })
  const inboxItems = within(byFactory).getByRole<HTMLInputElement>('checkbox', {
    name: 'Inbox items for notebook',
  })
  expect(inboxItems.checked).toBe(true)
  await u.click(inboxItems)
  await u.click(within(byFactory).getByRole('checkbox', { name: 'Task merged for notebook' }))
  expect(update.mock.calls).toEqual([
    ['nb', { inboxItems: false }],
    ['nb', { taskMerged: true }],
  ])
  await screen.findByText('Ted doesn’t send notifications yet')
  await u.click(screen.getByRole('button', { name: 'Turn on' }))
  expect(turnOn).toHaveBeenCalledOnce()
  await act(async () => api.emit({ type: 'notification-offer', offer: 'done' }))
  expect(screen.queryByText('Ted doesn’t send notifications yet')).toBeNull()
  await act(async () => api.emit({ type: 'notifications-off', off: true }))
  expect(screen.getByRole('alert').textContent).toContain('Notifications are off for Ted')
  await u.click(screen.getByRole('button', { name: 'Open System Settings' }))
  expect(open).toHaveBeenCalledOnce()
})

test('the notifications offer asks before macOS does, and leaves once answered', async () => {
  const { NotificationOfferBanner } = await import(
    '../src/renderer/components/NotificationOffer.tsx'
  )
  const turnOn = vi.fn()
  const decline = vi.fn()
  const api = bridge({
    notificationOffer: () => 'offered',
    turnOnNotifications: turnOn,
    declineNotifications: decline,
  })
  render(<NotificationOfferBanner />)
  const offer = await screen.findByRole('region', { name: 'Notifications' })
  expect(offer.textContent).toContain('macOS will ask whether Ted may send notifications.')
  const u = user()
  await u.click(within(offer).getByRole('button', { name: 'Not now' }))
  await u.click(within(offer).getByRole('button', { name: 'Turn on' }))
  expect(decline).toHaveBeenCalledOnce()
  expect(turnOn).toHaveBeenCalledOnce()
  await act(async () => api.emit({ type: 'notification-offer', offer: 'done' }))
  expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull()
})

test('Developer mode controls Diagnostics, logs and Show onboarding again', async () => {
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
          owner: { runId: 'run-123456' },
          kind: 'agent-tool',
          run: { runId: 'run-123456', agent: 'claude', role: 'task-lead', task: 'TED-487' },
          cpuPercent: 2.4,
          memoryBytes: 64 * 1024 * 1024,
        },
      ],
    }),
    appProcesses: () => [
      {
        pid: 456,
        ppid: 1,
        command: 'Ted',
        owner: 'app',
        kind: 'ted-app',
        cpuPercent: 1,
        memoryBytes: 200 * 1024 * 1024,
      },
    ],
    readDaemonLog: () => ({ text: 'Ted daemon 123 listening', truncated: false }),
    readRunOutput: () => ({ text: 'from the stub', truncated: false }),
  })
  const view = render(<DeveloperPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  await screen.findByText('2.3 GB · Agents 700 MB · Daemon and Run hosts 1.0 GB · Ted app 590 MB')
  expect(screen.queryByRole('region', { name: 'Diagnostics' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Logs' })).toBeNull()
  expect(screen.queryByText('Show onboarding again')).toBeNull()
  expect(api.request).not.toHaveBeenCalledWith('getDiagnostics')
  await user().click(screen.getByRole('switch', { name: 'Developer mode' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', { developerMode: true })
  view.rerender(
    <DeveloperPage
      settings={{ ...defaultMachineSettings, developerMode: true }}
      dispatch={vi.fn()}
    />,
  )
  await screen.findByText('Ted daemon 123 listening')
  const processRows = () =>
    within(screen.getByRole('table', { name: 'Processes' }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent)
  await waitFor(() =>
    expect(processRows()).toEqual([
      '123nodeTool or MCP server of TED-487’s Task Lead2.4%64 MB',
      '456TedTed app1%200 MB',
    ]),
  )
  const processTable = within(screen.getByRole('table', { name: 'Processes' }))
  expect(processTable.getByRole('columnheader', { name: 'CPU' }).getAttribute('aria-sort')).toBe(
    'descending',
  )
  await user().click(processTable.getByRole('button', { name: 'Memory' }))
  await user().click(processTable.getByRole('button', { name: 'Memory' }))
  await user().click(
    within(screen.getByRole('table', { name: 'Runs' })).getByRole('button', { name: 'Tokens in' }),
  )
  const chosen = {
    runs: { column: 'tokensIn', direction: 'descending' },
    processes: { column: 'memory', direction: 'ascending' },
  } as const
  expect(api.request.mock.calls.filter(([name]) => name === 'updateSettings').slice(-3)).toEqual([
    [
      'updateSettings',
      {
        diagnosticsSort: {
          ...defaultMachineSettings.diagnosticsSort,
          processes: { column: 'memory', direction: 'descending' },
        },
      },
    ],
    [
      'updateSettings',
      {
        diagnosticsSort: { ...defaultMachineSettings.diagnosticsSort, processes: chosen.processes },
      },
    ],
    ['updateSettings', { diagnosticsSort: chosen }],
  ])
  expect(processRows()).toEqual([
    '123nodeTool or MCP server of TED-487’s Task Lead2.4%64 MB',
    '456TedTed app1%200 MB',
  ])
  view.rerender(
    <DeveloperPage
      settings={{
        ...defaultMachineSettings,
        developerMode: true,
        diagnosticsSort: {
          ...defaultMachineSettings.diagnosticsSort,
          processes: { column: 'memory', direction: 'descending' },
        },
      }}
      dispatch={vi.fn()}
    />,
  )
  await waitFor(() =>
    expect(processRows()).toEqual([
      '456TedTed app1%200 MB',
      '123nodeTool or MCP server of TED-487’s Task Lead2.4%64 MB',
    ]),
  )
  expect(
    within(screen.getByRole('table', { name: 'Processes' }))
      .getByRole('columnheader', { name: 'Memory' })
      .getAttribute('aria-sort'),
  ).toBe('descending')
  await user().click(screen.getByRole('button', { name: 'Show on next open' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', {
    onboardingOnNextOpen: true,
    guideNextFactory: true,
  })
  view.rerender(
    <DeveloperPage
      settings={{ ...defaultMachineSettings, developerMode: true, onboardingOnNextOpen: true }}
      dispatch={vi.fn()}
    />,
  )
  expect(screen.getByText('Onboarding will show the next time Ted opens.')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Undo' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', {
    onboardingOnNextOpen: false,
    guideNextFactory: false,
  })
  view.rerender(
    <DeveloperPage
      settings={{ ...defaultMachineSettings, developerMode: true, guideNextFactory: true }}
      dispatch={vi.fn()}
    />,
  )
  expect(screen.getByText('The next Factory you add gets the setup guide.')).toBeTruthy()
  api.request.mockClear()
  await user().click(screen.getByRole('button', { name: 'Undo' }))
  expect(api.request).toHaveBeenCalledWith('updateSettings', {
    onboardingOnNextOpen: false,
    guideNextFactory: false,
  })
  view.rerender(
    <DeveloperPage
      settings={{ ...defaultMachineSettings, developerMode: true }}
      dispatch={vi.fn()}
    />,
  )
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
  const recording = screen.getByRole('button', { name: 'Record 30 seconds' })
  expect(recording.hasAttribute('disabled')).toBe(true)
  expect(recording.getAttribute('aria-busy')).toBe('true')
  await act(async () =>
    result.resolve({ file: '~/.ted/logs/profiles/daemon-1.cpuprofile', seconds: 30, bytes: 10 }),
  )
  expect(screen.getByText('Saved to ~/.ted/logs/profiles/daemon-1.cpuprofile')).toBeTruthy()
  api.handle('recordProfile', () => {
    throw new Error(
      "Error invoking remote method 'ted:request': DaemonRequestError: Ted is already recording a CPU profile",
    )
  })
  await user().click(screen.getByRole('button', { name: 'Record 30 seconds' }))
  await screen.findByText('Couldn’t record a profile: Ted is already recording a CPU profile')
  expect(api.request.mock.calls.filter(([name]) => name === 'recordProfile')).toHaveLength(2)
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
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.getByText('37.8%')).toBeTruthy()
    expect(screen.queryByText('12.5%')).toBeNull()
    expect(diagnostics).toHaveBeenCalledTimes(2)

    view.rerender(<DeveloperPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
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
    ['agents', 'Providers'],
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
    stages: [
      { id: 'backlog', name: 'Backlog', inOrder: true, enabled: true, gate: false, from: 'ted' },
    ],
    agents: [],
    agentFiles: [],
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
    if (name === 'Library') {
      const library = within(screen.getByRole('main', { name }))
      expect((await library.findByText('Always on')).title).toBe('Backlog can’t be turned off')
      expect(library.queryByRole('switch', { name: 'Backlog on' })).toBeNull()
    }
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

  fireEvent.change(field, { target: { value: 'teardown' } })
  expect(nav.getAllByRole('option')[0]?.textContent).toBe(
    'Teardown commandwidgets › Settings › Repos',
  )

  fireEvent.change(field, { target: { value: 'run' } })
  await user().keyboard('{ArrowUp}')
  const last = nav.getAllByRole('option').at(-1)
  expect(last?.getAttribute('aria-selected')).toBe('true')
  expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(last)

  fireEvent.change(field, { target: { value: 'zzz' } })
  expect(nav.getByText('No settings match ‘zzz’')).toBeTruthy()
  await user().keyboard('{Escape}')
  expect(field.value).toBe('')
  expect(nav.getByRole('button', { name: 'General' })).toBeTruthy()
  expect(document.activeElement).toBe(field)
  await user().keyboard('{Escape}')
  expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
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
  fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'autopilot' } })
  const group = within(palette).getByRole('group', { name: 'Settings' })
  const options = within(group).getAllByRole('option')
  expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
    'Autopilot across all Factories, Settings › General',
    'Autopilot, Settings › General',
    'Review Tasks from Automations and public issues, Settings › General',
  ])
  await user().click(options[0] as HTMLElement)
  expect(screen.queryByRole('dialog', { name: 'Search and commands' })).toBeNull()
  await screen.findByRole('heading', { name: 'General' })
  await waitFor(() => expect(found('app.general.autopilot.mode')).toBe(true))
})

test('an asynchronous settings switch acknowledges activation and blocks repeat saves', async () => {
  const completion = deferred<unknown>()
  const update = vi.fn(() => completion.promise)
  bridge({
    updateSettings: update,
    getSlots: () => ({
      limit: 6,
      working: 0,
      queued: 0,
      holders: [],
      queue: [],
      factories: [],
      checks: noChecks,
    }),
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
  })
  render(<LimitsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  const toggle = screen.getByRole('switch', {
    name: 'Wait to start new work when this computer is busy',
  })
  await user().click(toggle)
  expect(toggle.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(toggle)
  expect(update).toHaveBeenCalledTimes(1)
  await user().click(screen.getByRole('button', { name: 'More working Runs' }))
  expect(update).toHaveBeenCalledWith({
    waitWhenBusy: !defaultMachineSettings.waitWhenBusy,
  })
  await act(async () => completion.resolve({}))
  expect(toggle.getAttribute('aria-busy')).toBeNull()
})

test('the reporting question asks once after setup and saves the answer', async () => {
  const a = appState()
  a.state.settings = { ...a.state.settings, reportingAsked: false }
  const view = a.mount()
  const dialog = await screen.findByRole('dialog', {
    name: 'Send error reporting and usage data to the Ted team?',
  })
  await user().click(within(dialog).getByRole('button', { name: 'Send reports' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(a.state.settings).toMatchObject({ reporting: true, reportingAsked: true })
  view.unmount()

  a.state.settings = { ...a.state.settings, reporting: false, reportingAsked: false }
  a.mount()
  fireEvent(
    await screen.findByRole('dialog', {
      name: 'Send error reporting and usage data to the Ted team?',
    }),
    new Event('cancel', { cancelable: true }),
  )
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(a.state.settings).toMatchObject({ reporting: false, reportingAsked: true })
})
