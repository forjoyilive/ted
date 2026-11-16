// @vitest-environment jsdom
import { defaultMachineSettings, type FactorySettingsView } from '@ted/protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { RemoveFactoryDialog } from '../src/renderer/components/RemoveFactoryDialog.tsx'
import type { FactorySectionId } from '../src/renderer/settings-search.ts'
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
    dispatch: vi.fn(),
  }
}

function Paged({
  section: first,
  ...p
}: ReturnType<typeof props> & { section?: FactorySectionId }) {
  const [section, setSection] = useState(first)
  return (
    <FactorySettings
      {...p}
      section={section}
      dispatch={(action) => {
        p.dispatch(action)
        if (action.type === 'open' && action.screen.kind === 'factory') {
          setSection(action.screen.section)
        }
      }}
    />
  )
}

function pageList() {
  return within(screen.getByRole('navigation', { name: 'Factory settings' }))
}

function pageRow(name: string) {
  return pageList().getByRole('button', { name: new RegExp(`^${name}`) })
}

async function page(name: string) {
  await user().click(pageRow(name))
}

function unsavedOn(name: string) {
  return within(pageRow(name)).queryByRole('img', { name: 'Unsaved changes' }) !== null
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
  render(<Paged {...props()} />)
  return api
}

test('General shows at once and alone, and a repo page waits for the repo settings', async () => {
  const pending = deferred<FactorySettingsView>()
  const api = open({ factorySettings: () => pending.promise })
  expect(screen.getByRole('region', { name: 'General' })).toBeTruthy()
  expect(pageRow('General').getAttribute('aria-current')).toBe('page')
  expect(screen.queryByRole('region', { name: 'Intake' })).toBeNull()
  expect(screen.queryByRole('status', { name: 'Loading Factory settings…' })).toBeNull()
  expect(screen.queryByText('How repo settings are saved')).toBeNull()
  await page('Repos')
  expect(pageRow('Repos').getAttribute('aria-current')).toBe('page')
  expect(pageRow('General').hasAttribute('aria-current')).toBe(false)
  expect(screen.queryByRole('region', { name: 'General' })).toBeNull()
  expect(screen.getByRole('status', { name: 'Loading Factory settings…' })).toBeTruthy()
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

test('Intake shows GitHub, Linear and Asana on one page with only the fields that apply', async () => {
  open({ getAsana: () => ({ state: 'not-connected' }) })
  await page('Intake')
  const intake = screen.getByRole('region', { name: 'Intake' })
  expect(
    within(intake)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(['GitHub', 'Linear', 'Asana'])
  expect(within(intake).getAllByText(/^Saved on /)).toHaveLength(1)
  const linear = within(screen.getByRole('region', { name: 'Linear' }))
  await linear.findByText(/^Connect Linear in App Settings/)
  expect(linear.queryByLabelText('Scope')).toBeNull()
  expect(linear.queryByRole('button', { name: 'Try again' })).toBeNull()
  const asana = within(screen.getByRole('region', { name: 'Asana' }))
  await asana.findByText(/^Connect Asana in App Settings/)
  expect(asana.queryByRole('switch')).toBeNull()
  const github = within(screen.getByRole('region', { name: 'GitHub' }))
  expect(github.queryByLabelText('Label')).toBeNull()
  fireEvent.change(github.getByLabelText('Issues Automations can bring in'), {
    target: { value: 'label' },
  })
  expect(github.getByLabelText('Label')).toBeTruthy()
})

test('connected Linear and Asana show their pickers only when a choice needs them', async () => {
  open({
    getLinear: () => ({ state: 'connected' }),
    getLinearIntakeChoices: () => ({
      workspaceId: 'w1',
      workspace: 'Kriya',
      teams: [{ id: 't1', name: 'Design', key: 'KRI' }],
      projects: [],
    }),
    getAsana: () => ({ state: 'connected' }),
    checkFactoryAsanaIntake: () => ({ state: 'none' }),
    listAsanaWorkspaces: () => ({ items: [{ gid: 'a1', name: 'Kriya' }] }),
  })
  await page('Intake')
  const linear = within(screen.getByRole('region', { name: 'Linear' }))
  await waitFor(() => expect(linear.queryByText(/Loading Linear/)).toBeNull())
  expect(linear.getByLabelText('Scope')).toBeTruthy()
  expect(linear.queryByLabelText('Team')).toBeNull()
  expect(linear.queryByText(/^Saved scope/)).toBeNull()
  const asana = within(screen.getByRole('region', { name: 'Asana' }))
  const toggle = await asana.findByRole('switch', { name: 'Import Asana work into this Factory' })
  expect(asana.queryByLabelText('Workspace')).toBeNull()
  expect(asana.queryByRole('button', { name: 'Save' })).toBeNull()
  expect(asana.queryByText(/^Saved: /)).toBeNull()
  expect(asana.queryByText(/^When its Automation runs/)).toBeNull()
  await user().click(toggle)
  expect(await asana.findByLabelText('Workspace')).toBeTruthy()
  expect(asana.getByRole('button', { name: 'Save' })).toBeTruthy()
  expect(asana.getByText('Saved: Off')).toBeTruthy()
  expect(asana.getByText(/^When its Automation runs/)).toBeTruthy()
  await user().click(asana.getByRole('button', { name: 'Cancel' }))
  expect(asana.queryByLabelText('Workspace')).toBeNull()
  expect(asana.queryByRole('button', { name: 'Save' })).toBeNull()
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

test('the Icon picker saves a coloured symbol or an emoji at once and refuses an SVG upload', async () => {
  const api = open({ setFactoryIcon: () => factory() })
  const iconButton = () => screen.getByRole('button', { name: /^Icon/ })
  await user().click(iconButton())
  let picker = within(screen.getByRole('dialog', { name: /^Icon for / }))
  await user().click(picker.getByRole('button', { name: 'Teal colour' }))
  expect(api.request).not.toHaveBeenCalledWith(
    'setFactoryIcon',
    expect.anything(),
    expect.anything(),
  )
  await user().type(picker.getByRole('searchbox', { name: 'Search icons' }), 'git')
  expect(picker.queryByRole('button', { name: 'rocket' })).toBeNull()
  await user().click(picker.getByRole('button', { name: 'git branch' }))
  expect(api.request).toHaveBeenCalledWith('setFactoryIcon', 'f1', {
    kind: 'symbol',
    name: 'git-branch',
    color: 'teal',
  })
  expect(screen.queryByRole('dialog', { name: /^Icon for / })).toBeNull()

  await user().click(iconButton())
  picker = within(screen.getByRole('dialog', { name: /^Icon for / }))
  await user().click(picker.getByRole('tab', { name: 'Emoji' }))
  await user().type(picker.getByRole('searchbox', { name: 'Search emoji' }), 'octopus')
  await user().click(picker.getByRole('button', { name: 'octopus' }))
  expect(api.request).toHaveBeenCalledWith('setFactoryIcon', 'f1', { kind: 'emoji', emoji: '🐙' })

  await user().click(iconButton())
  picker = within(screen.getByRole('dialog', { name: /^Icon for / }))
  await user().click(picker.getByRole('tab', { name: 'Upload' }))
  const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
  fireEvent.change(picker.getByLabelText('Image file'), { target: { files: [svg] } })
  expect((await picker.findByRole('alert')).textContent).toBe('Choose a PNG, JPEG, WebP or GIF.')
  expect(api.request.mock.calls.filter(([name]) => name === 'setFactoryIcon')).toHaveLength(2)
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

test('Workflow and notes stay staged across pages while confirmed permissions save locally', async () => {
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
  await page('Workflow')
  const gate = await screen.findByRole('switch', { name: 'Design Sign-Off' })
  expect(gate.getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByRole('switch', { name: 'Work on' })).toBeNull()
  expect(screen.queryByRole('switch', { name: 'Intake on' })).toBeNull()
  expect(screen.getAllByText('Always on').map((on) => on.title)).toEqual([
    'Intake can’t be turned off',
    'Work can’t be turned off',
  ])
  await u.click(gate)
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  expect(unsavedOn('Workflow')).toBe(true)
  await page('Checks')
  expect(screen.queryByRole('switch', { name: 'Design Sign-Off' })).toBeNull()
  expect(screen.getByText('How repo settings are saved')).toBeTruthy()
  expect(
    (screen.getByRole('textbox', { name: 'Typecheck command' }) as HTMLInputElement).value,
  ).toBe('npm run typecheck')
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  await page('Permissions')
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
  expect(unsavedOn('Permissions')).toBe(false)
  await page('Factory notes')
  await u.type(screen.getByRole('textbox', { name: 'Factory notes' }), '# Notebook')
  expect(screen.getByText('2 unsaved changes to 2 files in .ted/')).toBeTruthy()
  expect(['Workflow', 'Checks', 'Factory notes'].map(unsavedOn)).toEqual([true, false, true])
  await page('Workflow')
  expect(screen.getByRole('switch', { name: 'Design Sign-Off' }).getAttribute('aria-checked')).toBe(
    'false',
  )
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
  await page('Repos')
  await screen.findByRole('region', { name: 'Repos' })
  expect(screen.getByText('How repo settings are saved')).toBeTruthy()
  expect(screen.queryByText('Saved to the repo · pull request')).toBeNull()
  const order = () =>
    within(screen.getByRole('region', { name: 'Repos' }))
      .getAllByRole('article')
      .map((row) => row.getAttribute('aria-label'))
  const drag = () => {
    const shown = within(screen.getByRole('region', { name: 'Repos' }))
    fireEvent.dragStart(
      within(shown.getByRole('article', { name: 'acme/api' })).getByRole('img', {
        name: 'Drag to reorder',
      }),
      { dataTransfer: { effectAllowed: '' } },
    )
    fireEvent.drop(shown.getByRole('article', { name: 'acme/web' }))
  }
  drag()
  expect(order()).toEqual(['acme/widgets', 'acme/web', 'acme/api'])
  expect(unsavedOn('Repos')).toBe(true)
  await u.click(screen.getByRole('button', { name: 'Discard' }))
  expect(order()).toEqual(['acme/widgets', 'acme/api', 'acme/web'])
  expect(unsavedOn('Repos')).toBe(false)

  await page('Workflow')
  const gate = screen.getByRole('switch', { name: 'Design Sign-Off' })
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
  expect(screen.getByRole('button', { name: 'Merge pull request' }).hasAttribute('disabled')).toBe(
    true,
  )
  expect(gate.closest('fieldset')?.disabled).toBe(true)
  await page('Repos')
  drag()
  expect(order()).toEqual(['acme/widgets', 'acme/api', 'acme/web'])
  for (const handle of within(screen.getByRole('region', { name: 'Repos' })).getAllByRole('img', {
    name: 'Drag to reorder',
  })) {
    expect(handle.getAttribute('draggable')).toBe('false')
  }
  await page('Checks')
  const command = screen.getByRole('textbox', { name: 'Typecheck command' })
  const savedCommand = (command as HTMLInputElement).value
  fireEvent.change(command, { target: { value: 'must not become a draft' } })
  expect(command).toHaveProperty('value', savedCommand)
  expect(screen.queryByRole('button', { name: 'Review and save…' })).toBeNull()

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
  await user().selectOptions(screen.getByRole('combobox', { name: 'Reviewer model' }), 'Other…')
  await user().type(screen.getByRole('textbox', { name: 'Reviewer model' }), 'gpt-5.5{Enter}')
  expect(api.request).toHaveBeenLastCalledWith('saveLibrary', {
    changes: { agents: { reviewer: { agent: 'codex', effort: 'high', model: 'gpt-5.5' } } },
    version: 'v2',
  })
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: 'Reviewer model' }) as HTMLSelectElement).value,
    ).toBe('gpt-5.5'),
  )
  await user().click(screen.getByRole('button', { name: 'Reset to TED default' }))
  expect(api.request).toHaveBeenLastCalledWith('saveLibrary', {
    changes: { agents: { reviewer: null } },
    version: 'v2',
  })
  expect(screen.queryByRole('button', { name: 'Reset to TED default' })).toBeNull()
})

test('repo setup edits show Edited and unsaved counts, and Discard restores loaded values', async () => {
  open()
  await page('Repos')
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
  render(<Paged {...props()} section="repos" />)
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
  expect((await screen.findByRole('region', { name: 'General' })).textContent).toBeTruthy()
  expect(pageRow('General').getAttribute('aria-current')).toBe('page')
  const workflow = await screen.findByRole('button', { name: /^Workflow\s*1$/ })
  expect(workflow.textContent).toContain('1')
  await u.click(workflow)
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
  expect(within(row).getByRole('button', { name: 'widgets' }).textContent).toBe('wwidgets')
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
  await page('Permissions')
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
      (screen.getByRole('combobox', { name: 'Reviewer model' }) as HTMLSelectElement).value,
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
  await page('Workflow')
  await u.click(await screen.findByRole('switch', { name: 'Design Sign-Off' }))
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
  expect(screen.getByRole('switch', { name: 'Design Sign-Off' }).getAttribute('aria-checked')).toBe(
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
  await page('Factory notes')
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

test('Factory settings search finds both kinds of setting and marks one on this screen', async () => {
  const p = props()
  bridge({
    getSettings: () => defaultMachineSettings,
    getLinear: () => ({ state: 'no-key' }),
    factorySettings: settingsView,
    homeFolder: () => '/test',
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
  })
  render(<Paged {...p} />)
  await screen.findByRole('region', { name: 'General' })
  const nav = pageList()
  const field = nav.getByRole<HTMLInputElement>('combobox', { name: 'Search settings' })

  fireEvent.change(field, { target: { value: 'awake' } })
  expect(nav.queryByRole('button', { name: 'Workflow' })).toBeNull()
  await user().click(nav.getByRole('option'))
  expect(p.dispatch).toHaveBeenCalledWith({ type: 'open-settings', section: 'general' })
  expect(nav.getByRole('button', { name: 'Workflow' })).toBeTruthy()

  fireEvent.change(field, { target: { value: 'teardown' } })
  const option = nav.getAllByRole('option')[0] as HTMLElement
  expect(option.textContent).toBe('Teardown commandwidgets › Settings › Repos')
  await user().click(option)
  expect(p.dispatch).toHaveBeenLastCalledWith({
    type: 'open',
    screen: { kind: 'factory', factoryId: 'f1', view: 'settings', section: 'repos' },
  })
  expect(pageRow('Repos').getAttribute('aria-current')).toBe('page')
  await waitFor(() =>
    expect(
      document
        .querySelector('[data-setting="factory.repos.worktree.teardown"]')
        ?.hasAttribute('data-found'),
    ).toBe(true),
  )

  field.focus()
  await user().keyboard('{Escape}')
  expect(document.activeElement).not.toBe(field)
})

test('Cleanup turns on, adds an instruction and a command step, reorders them and saves', async () => {
  const save = vi.fn(() => ({
    merged: true,
    pullRequest: { number: 1, url: 'https://github.com/acme/widgets/pull/1' },
  }))
  const api = open({
    previewFactorySettings: () => ({
      valid: true,
      sideEffects: [],
      turnsOnBypass: false,
      problems: [],
      files: [{ path: '.ted/workflow.yaml', before: '', after: 'stages: {}', lines: [] }],
    }),
    saveFactorySettings: save,
  })
  const u = user()
  await page('Cleanup')
  const region = await screen.findByRole('region', { name: 'Cleanup' })
  const inside = within(region)
  await u.click(inside.getByRole('switch', { name: 'Turn on Cleanup' }))
  expect(inside.getByText('Cleanup stays off until it has at least one step.')).toBeTruthy()
  expect(unsavedOn('Cleanup')).toBe(true)

  await u.click(inside.getByRole('button', { name: '+ Add step' }))
  expect(document.activeElement).toBe(inside.getByRole('textbox', { name: 'Step 1 name' }))
  await u.type(inside.getByRole('textbox', { name: 'Step 1 name' }), 'Stop stack')
  await u.selectOptions(inside.getByRole('combobox', { name: 'Stop stack kind' }), 'command')
  expect(inside.getByRole('alert').textContent).toBe('Write the command.')
  const review = screen.getByRole('button', { name: 'Review and save…' }) as HTMLButtonElement
  expect(review.disabled).toBe(true)
  expect(screen.getByText('A Cleanup step needs fixing before you can save.')).toBeTruthy()
  await u.type(inside.getByRole('textbox', { name: 'Stop stack command' }), 'docker compose down')
  await u.type(inside.getByRole('textbox', { name: 'Stop stack timeout' }), '2m')
  expect(inside.queryByRole('alert')).toBeNull()
  expect(review.disabled).toBe(false)

  await u.click(inside.getByRole('button', { name: '+ Add step' }))
  await u.type(inside.getByRole('textbox', { name: 'Step 2 name' }), 'Tell Asana')
  await u.type(
    inside.getByRole('textbox', { name: 'Tell Asana instruction' }),
    'Comment on the Asana task.',
  )
  await u.click(inside.getByRole('button', { name: 'Move Tell Asana up' }))
  expect((inside.getByRole('textbox', { name: 'Step 1 name' }) as HTMLInputElement).value).toBe(
    'Tell Asana',
  )

  await u.click(screen.getByRole('button', { name: 'Review and save…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Save TED settings' })
  await u.click(within(dialog).getByRole('button', { name: 'Save and merge' }))
  const cleanup = {
    enabled: true,
    steps: [
      { name: 'Tell Asana', instruction: 'Comment on the Asana task.' },
      { name: 'Stop stack', command: 'docker compose down', timeout: '2m' },
    ],
  }
  expect(api.request).toHaveBeenCalledWith(
    'saveFactorySettings',
    'f1',
    expect.objectContaining({ changes: expect.objectContaining({ cleanup }) }),
  )

  const field = pageList().getByRole<HTMLInputElement>('combobox', { name: 'Search settings' })
  fireEvent.change(field, { target: { value: 'turn on cleanup' } })
  expect((pageList().getAllByRole('option')[0] as HTMLElement).textContent).toBe(
    'Turn on Cleanupwidgets › Settings › Cleanup',
  )
})
