// @vitest-environment jsdom

import { defaultMachineSettings } from '@ted/protocol/settings'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import { ConnectionContext } from '../src/renderer/data.ts'
import { GeneralPage } from '../src/renderer/settings/GeneralPage.tsx'
import { IntegrationsPage } from '../src/renderer/settings/IntegrationsPage.tsx'
import { NotificationsPage } from '../src/renderer/settings/NotificationsPage.tsx'
import { TaskLeadField } from '../src/renderer/views/TaskLeadField.tsx'
import { appState } from './support/app.tsx'
import { task } from './support/fixtures.ts'

const connected = (epoch: number, children: ReactNode) => (
  <ConnectionContext value={{ connection: { state: 'connected' }, epoch }}>
    {children}
  </ConnectionContext>
)

test('General reloads login approval after reconnect', async () => {
  const a = appState()
  const page = <GeneralPage settings={defaultMachineSettings} dispatch={vi.fn()} />
  const view = render(connected(0, page))
  await screen.findByText('Works only in an installed copy of Ted.')
  a.handle('loginItem', () => 'requires-approval')
  view.rerender(connected(1, page))
  await screen.findByText('Allow Ted in System Settings → Login Items')
  expect(a.request.mock.calls.filter(([name]) => name === 'loginItem')).toHaveLength(2)
})

test('Notifications reloads system permission after reconnect', async () => {
  const a = appState()
  const page = <NotificationsPage settings={defaultMachineSettings} dispatch={vi.fn()} />
  const view = render(connected(0, page))
  await waitFor(() => expect(a.request).toHaveBeenCalledWith('notificationsOff'))
  a.handle('notificationsOff', () => true)
  view.rerender(connected(1, page))
  await screen.findByText('Notifications are off for Ted in System Settings')
  expect(a.request.mock.calls.filter(([name]) => name === 'notificationsOff')).toHaveLength(2)
})

test('Integrations reloads health after reconnect', async () => {
  const a = appState()
  let state = 'not-installed'
  a.handle('getIntegrations', () => ({
    github: { cli: { state: 'ready', version: '2.99.0' }, hosts: [] },
    git: { state, version: '2.50.0' },
    checkedAt: '2026-11-10T00:00:00Z',
  }))
  a.handle('getLinear', () => ({ state: 'no-key', keyring: 'macos-keychain' }))
  a.handle('tedFolder', () => ({ path: '/test/' }))
  const page = <IntegrationsPage settings={defaultMachineSettings} />
  const view = render(connected(0, page))
  await screen.findByText('Ted needs Git to clone repos and make worktrees.')
  state = 'ready'
  view.rerender(connected(1, page))
  await waitFor(() =>
    expect(a.request.mock.calls.filter(([name]) => name === 'getIntegrations')).toHaveLength(2),
  )
  await waitFor(() =>
    expect(screen.queryByText('Ted needs Git to clone repos and make worktrees.')).toBeNull(),
  )
})

test('TaskLeadField reloads the lead Run after reconnect', async () => {
  const a = appState()
  let problem: string | undefined
  a.handle('getRun', () => ({ run: { id: 'r1', state: 'working', problem }, conversation: [] }))
  const page = <TaskLeadField task={task({ leadRunId: 'r1', lead: { agent: 'codex' } })} />
  const view = render(connected(0, page))
  await waitFor(() => expect(a.request).toHaveBeenCalledWith('getRun', 'r1'))
  problem = 'model-unavailable'
  view.rerender(connected(1, page))
  await screen.findByText('Model unavailable')
  expect(a.request.mock.calls.filter(([name]) => name === 'getRun')).toHaveLength(2)
})
