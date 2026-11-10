// @vitest-environment jsdom
import type { Banner } from '@ted/protocol'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { BannerStack } from '../src/renderer/components/BannerStack.tsx'
import { AddFactoryDialog } from '../src/renderer/views/AddFactoryDialog.tsx'
import { SetupPanel } from '../src/renderer/views/TaskViews.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory } from './support/fixtures.ts'

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
      onOpenFactory={vi.fn()}
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
  await u.type(screen.getByLabelText('Key'), 'NB')
  expect(screen.getByText('NB is already the key of widgets.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Add Factory' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
})
