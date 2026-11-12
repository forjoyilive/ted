// @vitest-environment jsdom
import { defaultMachineSettings, type FactorySettingsView } from '@ted/protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RemoveFactoryDialog } from '../src/renderer/components/RemoveFactoryDialog.tsx'
import { FactorySettings } from '../src/renderer/views/FactorySettings.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { factory, settingsView, task } from './support/fixtures.ts'

function props() {
  return {
    factory: factory(),
    banners: null,
    onOpenFactory: vi.fn(),
    onOpenGitHubSettings: vi.fn(),
    onRemoveFactory: vi.fn(),
    onOpenTask: vi.fn(),
  }
}

function open(extra: Record<string, (...args: unknown[]) => unknown> = {}) {
  const api = bridge({
    getSettings: () => defaultMachineSettings,
    getLinear: () => ({ state: 'no-key' }),
    factorySettings: settingsView,
    homeFolder: () => '/test',
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
    ...extra,
  })
  render(<FactorySettings {...props()} />)
  return api
}

test('pending repo settings follow available General and Linear intake sections', async () => {
  const pending = deferred<FactorySettingsView>()
  const api = open({ factorySettings: () => pending.promise })
  const loading = screen.getByRole('status', { name: 'Loading Factory settings…' })
  for (const name of ['General', 'Linear intake']) {
    const section = screen.getByRole('region', { name })
    expect(section.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
  expect(screen.queryByRole('region', { name: 'Repos' })).toBeNull()
  await act(async () => pending.resolve(settingsView()))
  expect(screen.queryByRole('status', { name: 'Loading Factory settings…' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Repos' })).toBeTruthy()
  const refresh = deferred<FactorySettingsView>()
  api.handle('factorySettings', () => refresh.promise)
  act(() => api.emit({ type: 'factory-settings-changed', factoryId: 'f1' }))
  expect(screen.getByRole('region', { name: 'Repos' })).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Loading Factory settings…' })).toBeNull()
  await act(async () => refresh.resolve(settingsView()))
})

test('automatic Backlog starting saves immediately without the repository Save dialog', async () => {
  const save = vi.fn(() => factory({ autoStartBacklog: true }))
  const api = open({ setFactoryAutoStartBacklog: save })
  const toggle = await screen.findByRole('switch', { name: 'Start Backlog Tasks automatically' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  await user().click(toggle)
  expect(api.request).toHaveBeenCalledWith('setFactoryAutoStartBacklog', 'f1', true)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Review and save…' })).toBeNull()
})

test('automatic Backlog starting disables during save and keeps its value on error', async () => {
  const pending = deferred<never>()
  open({ setFactoryAutoStartBacklog: () => pending.promise })
  const toggle = (await screen.findByRole('switch', {
    name: 'Start Backlog Tasks automatically',
  })) as HTMLButtonElement
  await user().click(toggle)
  expect(toggle.disabled).toBe(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  await act(async () => pending.reject(new Error('Couldn’t save the Factory option')))
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t save the Factory option')
  expect(toggle.disabled).toBe(false)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

test('Workflow and notes stay staged while confirmed permissions save locally', async () => {
  let permissions: 'auto' | 'bypass' = 'auto'
  const save = vi.fn(() => ({
    merged: true,
    pullRequest: { number: 1, url: 'https://github.com/acme/widgets/pull/1' },
  }))
  const api = open({
    factorySettings: () => ({ ...settingsView(), permissions }),
    setFactoryPermissions: (_id, mode) => {
      if (mode !== 'auto' && mode !== 'bypass') throw new Error('Unexpected permission mode')
      permissions = mode
      return { mode }
    },
    previewFactorySettings: () => ({
      valid: true,
      sideEffects: [],
      turnsOnBypass: false,
      problems: [],
      files: [
        { path: '.ted/notes.md', before: '', after: '# Notebook\n', lines: [] },
        {
          path: '.ted/workflow.yaml',
          before: '',
          after: 'stages: {design: {gate: false}}',
          lines: [],
        },
      ],
    }),
    saveFactorySettings: save,
  })
  const u = user()
  const gate = await screen.findByRole('switch', { name: 'Design sign-off' })
  expect(gate.getAttribute('aria-checked')).toBe('true')
  expect((screen.getByRole('switch', { name: 'Work on' }) as HTMLButtonElement).disabled).toBe(true)
  await u.click(gate)
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  expect(
    (screen.getByRole('textbox', { name: 'Typecheck command' }) as HTMLInputElement).value,
  ).toBe('npm run typecheck')
  await u.click(screen.getByRole('button', { name: 'Enable Bypass…' }))
  const confirmation = screen.getByRole('dialog', { name: 'Enable Bypass on this computer?' })
  const enable = within(confirmation).getByRole('button', { name: 'Enable Bypass' })
  expect(enable.hasAttribute('disabled')).toBe(true)
  await u.click(within(confirmation).getByRole('checkbox'))
  await u.click(enable)
  expect(api.request).toHaveBeenCalledWith('setFactoryPermissions', 'f1', 'bypass', true)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByText('Bypass is on.')).toBeTruthy()
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  await u.type(screen.getByRole('textbox', { name: 'Factory notes' }), '# Notebook')
  expect(screen.getByText('2 unsaved changes to 2 files in .ted/')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Review and save…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Save TED settings' })
  for (const name of ['Changes to .ted/notes.md', 'Changes to .ted/workflow.yaml'])
    expect(within(dialog).getByRole('region', { name })).toBeTruthy()
  const button = within(dialog).getByRole('button', { name: 'Save and merge' }) as HTMLButtonElement
  expect(within(dialog).queryByRole('checkbox', { name: /Bypass/ })).toBeNull()
  expect(button.disabled).toBe(false)
  await u.click(button)
  const changes = {
    repos: [{ was: 'widgets', repo: 'acme/widgets', name: 'widgets', env: [], copy: [], apps: [] }],
    stages: { design: { gate: false } },
    notes: '# Notebook',
  }
  expect(api.request).toHaveBeenCalledWith('previewFactorySettings', 'f1', changes)
  expect(api.request).toHaveBeenCalledWith('saveFactorySettings', 'f1', {
    changes,
    version: 'v1',
    mode: 'merge',
  })
})

test('repo settings explain saving and let the user retry merging without losing new edits', async () => {
  const result = {
    pullRequest: { number: 42, url: 'https://github.com/acme/widgets/pull/42' },
    merged: false,
    receipt: 'a'.repeat(32),
  }
  const merging = deferred<import('@ted/protocol').SaveSettingsResult>()
  const merge = vi.fn(() => merging.promise)
  const loaded = settingsView()
  loaded.repos.push(
    { was: 'api', repo: 'acme/api', name: 'api', primary: false, env: [], copy: [], apps: [] },
    { was: 'web', repo: 'acme/web', name: 'web', primary: false, env: [], copy: [], apps: [] },
  )
  const api = open({
    factorySettings: () => loaded,
    previewFactorySettings: () => ({ valid: true, sideEffects: [], problems: [], files: [] }),
    saveFactorySettings: () => result,
    mergeFactorySettings: merge,
    openOnGitHub: vi.fn(),
  })
  const u = user()
  const gate = await screen.findByRole('switch', { name: 'Design sign-off' })
  expect(screen.getByText('How repo settings are saved')).toBeTruthy()
  expect(screen.queryByText('Saved to the repo · pull request')).toBeNull()
  const repos = within(screen.getByRole('region', { name: 'Repos' }))
  const order = () => repos.getAllByRole('article').map((row) => row.getAttribute('aria-label'))
  const drag = () => {
    fireEvent.dragStart(
      within(repos.getByRole('article', { name: 'acme/api' })).getByRole('img', {
        name: 'Drag to reorder',
      }),
      { dataTransfer: { effectAllowed: '' } },
    )
    fireEvent.drop(repos.getByRole('article', { name: 'acme/web' }))
  }
  drag()
  expect(order()).toEqual(['acme/widgets', 'acme/web', 'acme/api'])
  await u.click(screen.getByRole('button', { name: 'Discard' }))
  expect(order()).toEqual(['acme/widgets', 'acme/api', 'acme/web'])

  await u.click(gate)
  await u.click(screen.getByRole('button', { name: 'Review and save…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Save TED settings' })
  expect(
    within(dialog).getByText(/leaves it open for you to review and merge on GitHub/),
  ).toBeTruthy()
  await u.click(within(dialog).getByRole('radio', { name: 'Save as pull request' }))
  await u.click(within(dialog).getByRole('button', { name: 'Save as pull request' }))
  const button = await screen.findByRole('button', { name: 'Merge pull request' })
  expect(api.request).toHaveBeenCalledWith(
    'saveFactorySettings',
    'f1',
    expect.objectContaining({ mode: 'pull-request' }),
  )
  await u.click(gate)
  expect(button.hasAttribute('disabled')).toBe(true)
  expect(
    screen.getByText('Save or discard your new edits before merging this pull request.'),
  ).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Discard' }))
  await u.click(screen.getByRole('button', { name: 'Open on GitHub' }))
  expect(api.request).toHaveBeenCalledWith('openOnGitHub', result.pullRequest.url)
  await u.click(button)
  expect(screen.getByRole('button', { name: 'Merging…' }).hasAttribute('disabled')).toBe(true)
  expect(gate.closest('fieldset')?.disabled).toBe(true)
  drag()
  expect(order()).toEqual(['acme/widgets', 'acme/api', 'acme/web'])
  const command = screen.getByRole('textbox', { name: 'Typecheck command' })
  const savedCommand = (command as HTMLInputElement).value
  fireEvent.change(command, { target: { value: 'must not become a draft' } })
  expect(command).toHaveProperty('value', savedCommand)
  expect(screen.queryByRole('button', { name: 'Review and save…' })).toBeNull()
  for (const handle of repos.getAllByRole('img', { name: 'Drag to reorder' })) {
    expect(handle.getAttribute('draggable')).toBe('false')
  }

  expect(api.request).toHaveBeenCalledWith('mergeFactorySettings', 'f1', {
    receipt: result.receipt,
  })
  await act(async () => merging.resolve({ ...result, reason: 'GitHub needs an approving review.' }))
  expect(await screen.findByText('GitHub needs an approving review.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Merge pull request' }).hasAttribute('disabled')).toBe(
    false,
  )
  api.handle('mergeFactorySettings', () => {
    throw new Error('Couldn’t reach GitHub')
  })
  await u.click(screen.getByRole('button', { name: 'Merge pull request' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Couldn’t reach GitHub')
  api.handle('mergeFactorySettings', () => ({ ...result, merged: true }))
  await u.click(screen.getByRole('button', { name: 'Merge pull request' }))
  expect(
    await screen.findByText('Pull request #42 merged. Settings saved to the repo.'),
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Merge pull request' })).toBeNull()
})

test('Remove Factory requires the exact key and sends the pull-request choice', async () => {
  const removed = vi.fn()
  const api = bridge({
    factoryRemoval: () => ({
      factoryId: 'f1',
      key: 'NB',
      name: 'widgets',
      tasks: 2,
      runs: 1,
      worktrees: 1,
      openPullRequests: 1,
      clones: ['acme/widgets'],
      sharedClones: [],
    }),
    removeFactory: vi.fn(),
  })
  render(<RemoveFactoryDialog factory={factory()} onClose={vi.fn()} onRemoved={removed} />)
  await screen.findByText('Stops 1 Run.')
  const button = screen.getByRole('button', { name: 'Remove Factory' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  const u = user()
  await u.type(screen.getByLabelText('Type NB to confirm'), 'nb')
  expect(button.disabled).toBe(true)
  await u.clear(screen.getByLabelText('Type NB to confirm'))
  await u.type(screen.getByLabelText('Type NB to confirm'), 'NB')
  await u.click(screen.getByRole('checkbox', { name: /Close 1 open pull request/ }))
  await u.click(button)
  expect(api.request).toHaveBeenCalledWith('removeFactory', 'f1', {
    key: 'NB',
    closePullRequests: false,
  })
  expect(removed).toHaveBeenCalledOnce()
})

test('broken Workflow shows the error and last valid revision', async () => {
  const { InvalidNotice } = await import('../src/renderer/views/FactorySettingsSections.tsx')
  render(
    <InvalidNotice
      invalid={{
        file: '.ted/workflow.yaml',
        line: 2,
        column: 1,
        message: '`order` must start with `intake`',
        lastValid: { version: 'abcdef0', at: new Date().toISOString() },
      }}
    />,
  )
  expect(screen.getByRole('alert').textContent).toContain('`order` must start with `intake`')
  expect(screen.getByRole('alert').textContent).toContain('abcdef0')
})

test('Factory drift offers merge and inherited choices; Library drift offers default choices', async () => {
  const { DriftNotice } = await import('../src/renderer/views/FactorySettingsSections.tsx')
  const keep = vi.fn()
  const use = vi.fn()
  const drift = {
    basedOn: 'abcdef0',
    current: '1234567',
    layer: 'library' as const,
    diffOf: 'yours' as const,
    diff: [{ kind: 'added' as const, text: 'Check the Decisions.' }],
  }
  const view = render(
    <DriftNotice
      stage="review"
      drift={drift}
      label="Inherited"
      useLabel="Use inherited"
      factoryId="f1"
      onKeep={keep}
      onUse={use}
    />,
  )
  expect(screen.getByText('Check the Decisions.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Merge with an agent' })).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Keep mine' }))
  expect(keep).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Use inherited' }))
  expect(use).toHaveBeenCalledOnce()
  view.rerender(
    <DriftNotice
      stage="review"
      drift={drift}
      label="Default"
      useLabel="Use default"
      onKeep={keep}
      onUse={use}
    />,
  )
  expect(screen.getByRole('button', { name: 'Use default' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Merge with an agent' })).toBeNull()
})

test('Agent defaults save a Library override and reset it to the TED default', async () => {
  const { AgentDefaults } = await import('../src/renderer/settings/AgentDefaults.tsx')
  let library: import('@ted/protocol').LibraryView = {
    path: '/test/library',
    version: 'v1',
    stages: [],
    problems: [],
    agents: [{ role: 'reviewer', default: { agent: 'codex' }, from: 'ted' }],
  }
  const api = bridge({
    library: () => library,
    saveLibrary: (request) => {
      const change = request as import('@ted/protocol').SaveLibraryRequest
      const own = change.changes.agents?.reviewer
      library = {
        ...library,
        version: 'v2',
        agents: [
          {
            role: 'reviewer',
            default: { agent: 'codex' },
            from: own ? 'library' : 'ted',
            ...(own && { own }),
          },
        ],
      }
      return library
    },
  })
  render(<AgentDefaults />)
  await user().selectOptions(
    await screen.findByRole('combobox', { name: 'Reviewer effort' }),
    'high',
  )
  expect(api.request).toHaveBeenCalledWith('saveLibrary', {
    changes: { agents: { reviewer: { agent: 'codex', effort: 'high' } } },
    version: 'v1',
  })
  expect(screen.getByText('Library', { exact: true })).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Reset to TED default' }))
  expect(api.request).toHaveBeenLastCalledWith('saveLibrary', {
    changes: { agents: { reviewer: null } },
    version: 'v2',
  })
  expect(screen.queryByRole('button', { name: 'Reset to TED default' })).toBeNull()
})

test('repo setup edits show Edited and unsaved counts, and Discard restores loaded values', async () => {
  open()
  const command = (await screen.findByRole('textbox', {
    name: /^Setup command/,
  })) as HTMLInputElement
  await user().type(command, 'npm ci')
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  expect(screen.getByText('Edited', { exact: true })).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Discard' }))
  expect(command.value).toBe('')
  expect(screen.queryByText(/unsaved change/)).toBeNull()
})

test('repo removal refuses open Tasks and stages an unused repo removal until Save', async () => {
  const loaded = settingsView()
  loaded.repos.push({
    was: 'api',
    name: 'api',
    repo: 'acme/api',
    primary: false,
    env: [],
    copy: [],
    apps: [],
  })
  let openTasks = [{ id: 'NB-1', displayId: 'NB-1', title: 'Offline editing' }]
  const api = bridge({
    getSettings: () => defaultMachineSettings,
    getLinear: () => ({ state: 'no-key' }),
    factorySettings: () => loaded,
    homeFolder: () => '/test',
    repoRemoval: () => ({ repo: 'acme/api', name: 'api', openTasks }),
  })
  render(<FactorySettings {...props()} />)
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'More for acme/api' }))
  await u.click(screen.getByRole('menuitem', { name: /^Remove from Factory/ }))
  const refused = screen.getByRole('dialog', { name: 'acme/api can’t be removed yet' })
  expect(within(refused).getByText('Offline editing')).toBeTruthy()
  await u.click(within(refused).getByRole('button', { name: 'OK' }))
  openTasks = []
  await u.click(screen.getByRole('button', { name: 'More for acme/api' }))
  await u.click(screen.getByRole('menuitem', { name: /^Remove from Factory/ }))
  expect(api.request).toHaveBeenCalledWith('repoRemoval', 'f1', 'api')
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  expect(screen.getByText('Removed when you save')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Undo' }))
  expect(screen.queryByText('Removed when you save')).toBeNull()
  expect(screen.queryByText(/unsaved change/)).toBeNull()
  await u.click(screen.getByRole('button', { name: 'More for acme/api' }))
  expect(screen.getByRole('menuitem', { name: /^Remove from Factory/ })).toBeTruthy()
})

const changedStage = {
  basedOn: 'abcdef0',
  current: '1234567',
  layer: 'library' as const,
  diffOf: 'yours' as const,
  diff: [{ kind: 'added' as const, text: 'Check the Decisions.' }],
}

test('Factory drift counts lead to Keep mine staging the actual parent draft', async () => {
  const a = appState()
  const loaded = settingsView()
  const review = loaded.stages.find((row) => row.id === 'review')
  if (!review) throw new Error('Missing Review')
  Object.assign(review, {
    factoryFile: '# My review',
    from: 'factory',
    basedOn: 'abcdef0',
    drift: changedStage,
  })
  a.handle('drift', () => ({ library: 0, factories: { f1: 1 } }))
  a.handle('factorySettings', () => loaded)
  a.handle('homeFolder', () => '/test')
  a.handle('tedFolder', () => ({ path: '/test/', platform: 'darwin' }))
  a.handle('previewFactorySettings', () => ({
    valid: true,
    sideEffects: [],
    turnsOnBypass: false,
    problems: [],
    files: [],
  }))
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  const settings = await screen.findByRole('button', { name: /^Settings\s*1$/ })
  await u.click(settings)
  expect((await screen.findByRole('button', { name: /^Workflow\s*1$/ })).textContent).toContain('1')
  await u.click(
    within(await screen.findByRole('region', { name: 'Review drift' })).getByRole('button', {
      name: 'Keep mine',
    }),
  )
  expect(screen.queryByRole('region', { name: 'Review drift' })).toBeNull()
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Review and save…' }))
  expect(a.request).toHaveBeenCalledWith('previewFactorySettings', 'f1', {
    keepStageFiles: ['review'],
    repos: [{ was: 'widgets', repo: 'acme/widgets', name: 'widgets', env: [], copy: [], apps: [] }],
  })
})

test('Library drift counts and the TED-default explanation lead to a saved Keep mine draft', async () => {
  const a = appState()
  const library: import('@ted/protocol').LibraryView = {
    path: '/test/library',
    version: 'v1',
    problems: [],
    agents: [],
    stages: [
      {
        id: 'review',
        inOrder: true,
        enabled: true,
        gate: true,
        from: 'library',
        libraryFile: '# My review',
        defaultText: '# TED review',
        basedOn: 'abcdef0',
        drift: { ...changedStage, layer: 'ted', changedIn: '0.1.5' },
      },
    ],
  }
  a.handle('drift', () => ({ library: 1, factories: {} }))
  a.handle('library', () => library)
  a.handle('saveLibrary', () => ({
    ...library,
    version: 'v2',
    stages: library.stages.map(({ drift: _drift, ...row }) => row),
  }))
  a.mount()
  await a.settings()
  await user().click(await screen.findByRole('button', { name: /^Library\s*1$/ }))
  const notice = await screen.findByRole('region', { name: 'Review drift' })
  expect(notice.textContent).toContain('TED 0.1.5')
  expect(notice.textContent).toContain('compares your copy with the default')
  await user().click(within(notice).getByRole('button', { name: 'Keep mine' }))
  expect(screen.queryByRole('region', { name: 'Review drift' })).toBeNull()
  expect(screen.getByText('1 unsaved change to the Library')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Save' }))
  expect(a.request).toHaveBeenCalledWith('saveLibrary', {
    changes: { keepStageFiles: ['review'] },
    version: 'v1',
  })
  expect(screen.queryByText('1 unsaved change to the Library')).toBeNull()
})

test('App’s Factory row menu removes that Factory and its Tasks from the sidebar and List', async () => {
  const a = appState()
  a.state.factories.push(factory({ id: 'f2', key: 'MS', name: 'site', position: 1 }))
  a.state.tasks = [
    task(),
    task({ id: 'MS-1', displayId: 'MS-1', factoryId: 'f2', title: 'Keep this Task' }),
  ]
  a.handle('factoryRemoval', () => ({
    factoryId: 'f1',
    key: 'NB',
    name: 'widgets',
    tasks: 1,
    runs: 0,
    worktrees: 0,
    openPullRequests: 0,
    clones: ['acme/widgets'],
    sharedClones: [],
  }))
  a.handle('removeFactory', async (id) => {
    expect(id).toBe('f1')
    a.state.factories = a.state.factories.filter((f) => f.id !== id)
    a.state.tasks = a.state.tasks.filter((t) => t.factoryId !== id)
    act(() => {
      a.emit({ type: 'task-deleted', taskId: 'NB-1' })
      a.emit({ type: 'factory-removed', factoryId: 'f1' })
    })
  })
  a.mount()
  const row = await screen.findByRole('article', { name: 'widgets' })
  fireEvent.contextMenu(within(row).getByRole('button', { name: 'widgets' }))
  expect((screen.getByRole('menuitem', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  await user().click(screen.getByRole('menuitem', { name: 'Remove Factory…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Remove Factory widgets?' })
  await within(dialog).findByText(/Deletes 1 Task/)
  await user().type(within(dialog).getByLabelText('Type NB to confirm'), 'NB')
  await user().click(within(dialog).getByRole('button', { name: 'Remove Factory' }))
  await vi.waitFor(() => expect(screen.queryByRole('article', { name: 'widgets' })).toBeNull())
  expect(screen.getByRole('article', { name: 'site' })).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'All Tasks' }))
  expect(document.querySelector('tr[data-task="NB-1"]')).toBeNull()
  expect(document.querySelector('tr[data-task="MS-1"]')?.textContent).toContain('Keep this Task')
  expect(a.request).toHaveBeenCalledWith('removeFactory', 'f1', {
    key: 'NB',
    closePullRequests: true,
  })
})

test('permission mode survives Check updates after enabling Bypass', async () => {
  const api = open({ setFactoryPermissions: (_id, mode) => ({ mode }) })
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Enable Bypass…' }))
  const confirmation = screen.getByRole('dialog', { name: 'Enable Bypass on this computer?' })
  await u.click(within(confirmation).getByRole('checkbox'))
  await u.click(within(confirmation).getByRole('button', { name: 'Enable Bypass' }))
  expect(screen.getByText('Bypass is on.')).toBeTruthy()
  await act(async () =>
    api.emit({
      type: 'check-try-updated',
      checkTry: {
        factoryId: 'f1',
        name: 'Typecheck',
        repo: 'widgets',
        state: 'passed',
        startedAt: '2026-11-10T00:00:00Z',
      },
    }),
  )
  expect(screen.getByText('Bypass is on.')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Use Auto' }))
  expect(api.request).toHaveBeenLastCalledWith('setFactoryPermissions', 'f1', 'auto', true)
  expect(screen.getByText('Auto is on.')).toBeTruthy()
})

test('failed agent-default saves keep their error after refreshing the controls', async () => {
  const { AgentDefaults } = await import('../src/renderer/settings/AgentDefaults.tsx')
  let reads = 0
  bridge({
    library: () => ({
      path: '/test/library',
      version: `v${++reads}`,
      stages: [],
      problems: [],
      agents: [
        {
          role: 'reviewer',
          default: { agent: 'codex', model: reads === 1 ? 'original' : 'fresh' },
          from: 'ted',
        },
      ],
    }),
    saveLibrary: () => {
      throw new Error('The Library changed on disk. Try again.')
    },
  })
  render(<AgentDefaults />)
  await user().selectOptions(
    await screen.findByRole('combobox', { name: 'Reviewer effort' }),
    'high',
  )
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: 'Reviewer model' }) as HTMLInputElement).value,
    ).toBe('fresh'),
  )
  expect(screen.getByText('The Library changed on disk. Try again.')).toBeTruthy()
})

test('a drift reload during save completion still resets the saved draft', async () => {
  const saved = settingsView()
  saved.version = 'v2'
  saved.stages = saved.stages.map((stage) =>
    stage.id === 'design' ? { ...stage, gate: false } : stage,
  )
  const afterSave = deferred<typeof saved>()
  const drift = deferred<typeof saved>()
  let reads = 0
  const api = open({
    factorySettings: () => {
      reads++
      if (reads === 1) return settingsView()
      if (reads === 2) return afterSave.promise
      if (reads === 3) return drift.promise
      return saved
    },
    previewFactorySettings: () => ({ valid: true, sideEffects: [], problems: [], files: [] }),
    saveFactorySettings: () => ({
      merged: true,
      pullRequest: { number: 42, url: 'https://github.com/acme/widgets/pull/42' },
    }),
  })
  const u = user()
  await u.click(await screen.findByRole('switch', { name: 'Design sign-off' }))
  await u.click(screen.getByRole('button', { name: 'Review and save…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Save TED settings' })
  await u.click(within(dialog).getByRole('button', { name: 'Save and merge' }))
  await waitFor(() => expect(reads).toBe(2))
  act(() => api.emit({ type: 'drift-changed', drift: { factories: { f1: 1 }, library: 0 } }))
  expect(reads).toBe(2)
  await act(async () => afterSave.resolve(saved))
  await waitFor(() => expect(reads).toBe(3))
  await act(async () => drift.resolve(saved))
  await screen.findByText('Pull request #42 merged. Settings saved to the repo.')
  await waitFor(() =>
    expect(screen.queryByText('1 unsaved change to .ted/workflow.yaml')).toBeNull(),
  )
  expect(screen.queryByRole('button', { name: 'Review and save…' })).toBeNull()
  expect(screen.getByRole('switch', { name: 'Design sign-off' }).getAttribute('aria-checked')).toBe(
    'false',
  )
})

test('the page loads once on open, shows a remote change when it has no edits and keeps a draft that has', async () => {
  const first = deferred<ReturnType<typeof settingsView>>()
  const remote = settingsView()
  remote.version = 'v2'
  remote.notes = 'From GitHub'
  const merged = settingsView()
  merged.version = 'v3'
  merged.notes = 'Mine'
  let reads = 0
  const save = vi.fn((..._args: unknown[]) => ({
    merged: true,
    pullRequest: { number: 7, url: 'https://github.com/acme/widgets/pull/7' },
  }))
  const api = open({
    factorySettings: () => {
      reads++
      if (reads === 1) return first.promise
      return reads < 4 ? remote : merged
    },
    previewFactorySettings: () => ({ valid: true, sideEffects: [], problems: [], files: [] }),
    saveFactorySettings: save,
  })
  act(() => api.emit({ type: 'drift-changed', drift: { factories: { f1: 0 }, library: 0 } }))
  await act(async () => first.resolve(settingsView()))
  const notes = (await screen.findByRole('textbox', {
    name: 'Factory notes',
  })) as HTMLTextAreaElement
  expect(reads).toBe(1)
  expect(api.request).toHaveBeenCalledWith('factorySettings', 'f1', { refresh: 'background' })

  act(() => api.emit({ type: 'factory-settings-changed', factoryId: 'other' }))
  expect(reads).toBe(1)
  act(() => api.emit({ type: 'factory-settings-changed', factoryId: 'f1' }))
  await waitFor(() => expect(notes.value).toBe('From GitHub'))
  expect(reads).toBe(2)
  expect(screen.queryByText(/unsaved change/)).toBeNull()

  const u = user()
  await u.clear(notes)
  await u.type(notes, 'Mine')
  act(() => api.emit({ type: 'factory-settings-changed', factoryId: 'f1' }))
  await waitFor(() => expect(reads).toBe(3))
  expect(notes.value).toBe('Mine')
  expect(screen.getByText('1 unsaved change to .ted/notes.md')).toBeTruthy()

  await u.click(screen.getByRole('button', { name: 'Review and save…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Save TED settings' })
  await u.click(within(dialog).getByRole('button', { name: 'Save and merge' }))
  await screen.findByText('Pull request #7 merged. Settings saved to the repo.')
  expect(save.mock.calls[0]?.[1]).toMatchObject({ version: 'v2', changes: { notes: 'Mine' } })
  expect(reads).toBe(4)
  expect(api.request).toHaveBeenLastCalledWith('factorySettings', 'f1', { refresh: 'never' })
  expect(screen.queryByText(/unsaved change/)).toBeNull()
})
