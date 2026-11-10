// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RemoveFactoryDialog } from '../src/renderer/components/RemoveFactoryDialog.tsx'
import { FactorySettings } from '../src/renderer/views/FactorySettings.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { factory, settingsView } from './support/fixtures.ts'

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
    factorySettings: settingsView,
    homeFolder: () => '/test',
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
    ...extra,
  })
  render(<FactorySettings {...props()} />)
  return api
}

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

test('Workflow, Permissions and notes collect in one Save and require Bypass confirmation', async () => {
  const save = vi.fn(() => ({
    merged: true,
    pullRequest: { number: 1, url: 'https://github.com/acme/widgets/pull/1' },
  }))
  const api = open({
    previewFactorySettings: () => ({
      valid: true,
      sideEffects: [],
      turnsOnBypass: true,
      problems: [],
      files: [
        { path: '.ted/notes.md', before: '', after: '# Notebook\n', lines: [] },
        { path: '.ted/workflow.yaml', before: '', after: 'permissions: bypass', lines: [] },
      ],
    }),
    saveFactorySettings: save,
  })
  const u = user()
  const gate = await screen.findByRole('switch', { name: 'Design Gate' })
  expect(gate.getAttribute('aria-checked')).toBe('true')
  expect((screen.getByRole('switch', { name: 'Work on' }) as HTMLButtonElement).disabled).toBe(true)
  await u.click(gate)
  expect(screen.getByText('1 unsaved change to .ted/workflow.yaml')).toBeTruthy()
  expect(
    (screen.getByRole('textbox', { name: 'Typecheck command' }) as HTMLInputElement).value,
  ).toBe('npm run typecheck')
  await u.click(screen.getByRole('radio', { name: /^Bypass/ }))
  await u.type(screen.getByRole('textbox', { name: 'Factory notes' }), '# Notebook')
  expect(screen.getByText('3 unsaved changes to 2 files in .ted/')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Review and save…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Save TED settings' })
  for (const name of ['Changes to .ted/notes.md', 'Changes to .ted/workflow.yaml'])
    expect(within(dialog).getByRole('region', { name })).toBeTruthy()
  const button = within(dialog).getByRole('button', { name: 'Save and merge' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  await u.click(within(dialog).getByRole('checkbox', { name: 'Turn on Bypass for widgets' }))
  expect(button.disabled).toBe(false)
  await u.click(button)
  expect(api.request).toHaveBeenCalledWith(
    'saveFactorySettings',
    'f1',
    expect.objectContaining({ confirmBypass: true, version: 'v1', mode: 'merge' }),
  )
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
})
