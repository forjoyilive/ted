// @vitest-environment jsdom
import type { BrowserResult, TaskApp } from '@ted/protocol'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ShownApp } from '../src/renderer/components/AppsSection.tsx'
import { TaskBrowserView } from '../src/renderer/components/TaskBrowserView.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { task } from './support/fixtures.ts'

const address = 'http://127.0.0.1:4100/'

const web = (fields: Partial<TaskApp> = {}): TaskApp => ({
  repo: 'widgets',
  name: 'Web',
  kind: 'web',
  state: 'running',
  url: address,
  startedAt: '2026-11-18T10:00:00.000Z',
  ...fields,
})

const stopped = (name: string): TaskApp => ({
  repo: 'widgets',
  name,
  kind: 'web',
  state: 'stopped',
})

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

function Pane({ taskId }: { taskId: string }) {
  const [shown, setShown] = useState<ShownApp>({ repo: 'widgets', name: 'Web' })
  return (
    <TaskBrowserView
      task={task({ id: taskId, displayId: taskId })}
      shown={shown}
      onBack={() => {}}
      onLog={() => {}}
      onSwitch={setShown}
    />
  )
}

test('an App picked from the App list that exits while starting shows why in the status line', async () => {
  const ended = new Map<string, Partial<TaskApp>>([
    ['Broken', { state: 'exited', exitCode: 3, startedAt: '2026-11-18T10:01:00.000Z' }],
    [
      'Taken',
      {
        state: 'failed',
        problem: 'Port 4101 is already in use',
        startedAt: '2026-11-18T10:02:00.000Z',
      },
    ],
  ])
  let apps = [web(), stopped('Broken'), stopped('Taken')]
  let starting = ''
  const api = bridge({
    listApps: () => apps,
    browserCommand: (): BrowserResult => ({ url: address, text: 'Ready' }),
    browserState: () => ({ url: address, text: 'Ready' }),
    presentBrowser: () => undefined,
    hideBrowser: () => undefined,
    startApp: () => {
      apps = apps.map((a) => (a.name === starting ? { ...a, ...ended.get(starting) } : a))
      return apps.find((a) => a.name === starting)
    },
  })
  render(<Pane taskId="NB-7" />)
  const pane = await screen.findByRole('region', { name: 'Task browser' })
  const status = within(pane).getByRole('status')
  await waitFor(() => expect(status.textContent).toBe('Ready'))
  const pick = async (name: string) => {
    starting = name
    await user().click(within(pane).getByRole('combobox', { name: 'Web App' }))
    await user().click(
      within(screen.getByRole('listbox', { name: 'Web App' })).getByRole('option', { name }),
    )
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('startApp', 'NB-7', { repo: 'widgets', name }),
    )
    await act(async () => api.emit({ type: 'apps-changed', taskId: 'NB-7' }))
  }

  await pick('Broken')
  await waitFor(() =>
    expect(status.textContent).toBe(
      'Broken stopped with code 3. Check the App log, then use ▶ in Apps.',
    ),
  )
  await pick('Taken')
  await waitFor(() => expect(status.textContent).toBe('Port 4101 is already in use'))
})

test('← and → follow the result of a back command without waiting for the next state read', async () => {
  let wentBack = false
  let stateReads = 0
  const held = deferred<never>()
  bridge({
    listApps: () => [web()],
    browserCommand: (): BrowserResult =>
      wentBack
        ? { url: address, text: 'Ready', canGoBack: false, canGoForward: true }
        : { url: `${address}next`, text: 'Ready' },
    browserState: () => {
      stateReads++
      return stateReads === 1
        ? { url: `${address}next`, text: 'Ready', canGoBack: true, canGoForward: false }
        : held.promise
    },
    presentBrowser: () => undefined,
    hideBrowser: () => undefined,
  })
  render(<Pane taskId="NB-8" />)
  const pane = await screen.findByRole('region', { name: 'Task browser' })
  const back = within(pane).getByRole('button', { name: 'Back' })
  const forward = within(pane).getByRole('button', { name: 'Forward' })
  await waitFor(() => expect(back.hasAttribute('disabled')).toBe(false))
  expect(forward.hasAttribute('disabled')).toBe(true)

  wentBack = true
  await user().click(back)
  await waitFor(() => expect(forward.hasAttribute('disabled')).toBe(false))
  expect(back.hasAttribute('disabled')).toBe(true)
})

test('← and → follow a page change that ends after its command has returned', async () => {
  let stateReads = 0
  const held = deferred<never>()
  const reply = deferred<BrowserResult>()
  let reloading = false
  const api = bridge({
    listApps: () => [web()],
    browserCommand: (): BrowserResult | Promise<BrowserResult> =>
      reloading ? reply.promise : { url: address, text: 'Ready' },
    browserState: () => {
      stateReads++
      return stateReads === 1 ? { url: address, text: 'Ready' } : held.promise
    },
    presentBrowser: () => undefined,
    hideBrowser: () => undefined,
  })
  render(<Pane taskId="NB-9" />)
  const pane = await screen.findByRole('region', { name: 'Task browser' })
  const back = within(pane).getByRole('button', { name: 'Back' })
  const forward = within(pane).getByRole('button', { name: 'Forward' })
  const reload = within(pane).getByRole('button', { name: 'Reload' })
  await waitFor(() => expect(reload.hasAttribute('disabled')).toBe(false))
  expect(back.hasAttribute('disabled')).toBe(true)
  const history = (app: string, canGoBack: boolean, canGoForward: boolean) =>
    act(async () =>
      api.emit({
        type: 'browser-history',
        taskId: 'NB-9',
        app: { repo: 'widgets', name: app },
        canGoBack,
        canGoForward,
      }),
    )

  await history('Other', true, true)
  expect(back.hasAttribute('disabled')).toBe(true)
  await history('Web', true, false)
  await waitFor(() => expect(back.hasAttribute('disabled')).toBe(false))

  reloading = true
  await user().click(reload)
  await history('Web', false, true)
  await act(async () =>
    reply.resolve({ url: address, text: 'Ready', canGoBack: true, canGoForward: false }),
  )
  await waitFor(() => expect(forward.hasAttribute('disabled')).toBe(false))
  expect(back.hasAttribute('disabled')).toBe(true)
})

test('only a web App that opts in offers the separate sign-in action', async () => {
  let apps = [web()]
  const api = bridge({
    listApps: () => apps,
    browserCommand: (): BrowserResult => ({ url: address, text: 'Ready' }),
    browserState: () => ({ url: address, text: 'Ready' }),
    presentBrowser: () => undefined,
    hideBrowser: () => undefined,
    openAppSignIn: () => undefined,
  })
  render(<Pane taskId="NB-33" />)
  const pane = within(await screen.findByRole('region', { name: 'Task browser' }))
  await waitFor(() => expect(pane.getByRole('status').textContent).toBe('Ready'))
  expect(pane.queryByRole('button', { name: 'Open with sign-in' })).toBeNull()

  apps = [web({ allowExternalSignIn: true })]
  await act(async () => api.emit({ type: 'apps-changed', taskId: 'NB-33' }))
  await user().click(await pane.findByRole('button', { name: 'Open with sign-in' }))
  expect(api.request).toHaveBeenCalledWith('openAppSignIn', 'NB-33', 'widgets', 'Web')
})
