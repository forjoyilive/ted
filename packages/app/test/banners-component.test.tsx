// @vitest-environment jsdom
import type { Banner } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { BannerStack } from '../src/renderer/components/BannerStack.tsx'
import { AddFactoryDialog } from '../src/renderer/views/AddFactoryDialog.tsx'
import { SetupPanel } from '../src/renderer/views/TaskViews.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

const warning: Banner = {
  id: 'b1',
  problem: 'no-checks',
  factoryId: 'f1',
  severity: 'warning',
  text: 'No Checks set up · Validate relies on the agent alone',
  raisedAt: createdAt,
}

test('Factory warnings show only on their Factory pages and dismiss through the bridge', async () => {
  const a = appState()
  a.handle('listBanners', () => [warning])
  a.handle('dismissBanner', () => warning)
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  await screen.findByText(warning.text)
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  expect(screen.getByText(warning.text)).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'All Tasks' }))
  expect(screen.queryByText(warning.text)).toBeNull()
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Board',
    }),
  )
  await u.click(screen.getByRole('button', { name: 'Dismiss for 24 hours' }))
  expect(a.request).toHaveBeenCalledWith('dismissBanner', 'b1')
  await act(async () =>
    a.emit({
      type: 'banner-updated',
      banner: { ...warning, dismissedUntil: '2099-01-01T00:00:00Z' },
    }),
  )
  expect(screen.queryByText(warning.text)).toBeNull()
})

test('stops-work banners cannot dismiss and their action stays separate from warnings', async () => {
  const action = vi.fn()
  const dismiss = vi.fn()
  const stop: Banner = {
    ...warning,
    id: 'b2',
    severity: 'stops-work',
    text: 'Couldn’t clone acme/widgets',
    action: { label: 'Retry' },
  }
  render(
    <BannerStack
      label="widgets problems"
      banners={[stop, warning]}
      onAction={action}
      onDismiss={dismiss}
    />,
  )
  expect(
    within(screen.getByRole('alert')).queryByRole('button', { name: 'Dismiss for 24 hours' }),
  ).toBeNull()
  expect(screen.getByRole('status').textContent).toContain(warning.text)
  await user().click(screen.getByRole('button', { name: 'Retry' }))
  expect(action).toHaveBeenCalledWith(stop)
  expect(dismiss).not.toHaveBeenCalled()
})

test('clone failure shows Retry and the setup panel follows cloning progress', async () => {
  const api = bridge({ retryClone: () => factory() })
  const view = render(
    <SetupPanel
      factory={factory()}
      setup={[{ repo: 'acme/widgets', state: 'failed', error: 'No remote' }]}
    />,
  )
  expect(screen.getByText('✕ Clone failed: No remote')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Retry' }))
  expect(api.request).toHaveBeenCalledWith('retryClone', 'f1')
  view.rerender(
    <SetupPanel
      factory={factory()}
      setup={[{ repo: 'acme/widgets', state: 'cloning', percent: 45 }]}
    />,
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('45')
  view.rerender(
    <SetupPanel factory={factory()} setup={[{ repo: 'acme/widgets', state: 'cloned' }]} />,
  )
  expect(screen.getByText('✓ Cloned')).toBeTruthy()
})

test('Add Factory repo-access and key errors prevent submission', async () => {
  const openFactory = vi.fn()
  const api = bridge({
    homeFolder: () => '/test',
    getIntegrations: () => ({
      github: {
        cli: { state: 'ready' },
        hosts: [{ host: 'github.com', state: 'ready', scopes: ['workflow'], usedBy: [] }],
      },
      git: { state: 'ready' },
      checkedAt: createdAt,
    }),
    checkRepo: () => ({
      ok: false,
      notes: [],
      problem: {
        kind: 'not-found',
        text: 'Repository not found, or your GitHub account can’t see it.',
        fixes: [{ kind: 'check-again' }, { kind: 'github-settings' }],
      },
    }),
  })
  render(
    <AddFactoryDialog
      factories={[factory()]}
      onClose={vi.fn()}
      onAdded={vi.fn()}
      onOpenFactory={openFactory}
      onOpenGitHubSettings={vi.fn()}
    />,
  )
  const u = user()
  await u.type(screen.getByLabelText('GitHub URL or owner/repo'), 'acme/nope{Enter}')
  await screen.findByText('Repository not found, or your GitHub account can’t see it.')
  expect(api.request).toHaveBeenCalledWith('checkRepo', {
    source: { remote: 'acme/nope' },
    primary: true,
  })
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  api.handle('checkRepo', () => ({
    ok: false,
    repo: 'acme/widgets',
    notes: [],
    problem: {
      kind: 'primary-elsewhere',
      text: 'acme/widgets is the primary repo of Factory widgets.',
      fixes: [{ kind: 'open-factory', factoryId: 'f1', factoryName: 'widgets' }],
    },
  }))
  await u.click(screen.getByRole('button', { name: 'Clear the primary repo' }))
  await u.type(screen.getByLabelText('GitHub URL or owner/repo'), 'acme/widgets{Enter}')
  await screen.findByText('acme/widgets is the primary repo of Factory widgets.')
  expect(screen.getByRole('button', { name: 'Open widgets' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'NB' } })
  expect(screen.getByText('NB is already the key of widgets.')).toBeTruthy()
  expect(screen.getByText('Fix the 1 repo problem and the key to continue.')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Open widgets' }))
  expect(openFactory).toHaveBeenCalledWith('f1')
  expect((screen.getByRole('button', { name: 'Add Factory' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
})

test('App removes the initial setup panel after clone Retry recovers', async () => {
  const a = appState()
  a.state.factories = [
    factory({
      cloned: false,
      setup: [{ repo: 'acme/widgets', state: 'failed', error: 'No remote' }],
    }),
  ]
  a.handle('retryClone', () => {
    const recovered = factory()
    a.state.factories = [recovered]
    a.emit({ type: 'factory-updated', factory: recovered })
    return recovered
  })
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'widgets' }))
  const panel = await screen.findByRole('region', { name: 'Setting up widgets' })
  await user().click(within(panel).getByRole('button', { name: 'Retry' }))
  await vi.waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Setting up widgets' })).toBeNull(),
  )
  expect(a.request).toHaveBeenCalledWith('retryClone', 'f1')
})

test('App shows a global agent Fix banner, the paused Board status and clears the resolved banner', async () => {
  const a = appState()
  const banner: Banner = {
    id: 'agent',
    problem: 'agent-signed-out',
    severity: 'stops-work',
    text: 'Claude Code is signed out',
    action: { label: 'Fix', opens: { kind: 'settings', section: 'agents' } },
    raisedAt: createdAt,
  }
  a.handle('listBanners', () => [banner])
  a.state.tasks = [
    task({
      stage: 'work',
      statuses: ['paused'],
      status: { kind: 'paused', reason: 'Claude Code is signed out' },
    }),
  ]
  a.mount()
  const problems = await screen.findByRole('region', { name: 'Problems' })
  expect(within(problems).getByRole('button', { name: 'Fix' })).toBeTruthy()
  await user().click(await screen.findByRole('button', { name: 'widgets' }))
  expect(await screen.findByText('Paused · Claude Code is signed out')).toBeTruthy()
  await act(async () => a.emit({ type: 'banner-cleared', id: 'agent' }))
  expect(screen.queryByText('Claude Code is signed out')).toBeNull()
})
