// @vitest-environment jsdom
import type { Comment, DescriptionVersion, RunChat, ThreadEvent } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunChat as Conversation } from '../src/renderer/components/RunChat.tsx'
import { ConnectionContext } from '../src/renderer/data.ts'
import { Root } from '../src/renderer/Root.tsx'
import { SettingsShell } from '../src/renderer/settings/SettingsShell.tsx'
import { TaskDetails, TaskThread } from '../src/renderer/views/TaskThread.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { comment, createdAt, factory, task } from './support/fixtures.ts'

const callbacks = {
  onBack: vi.fn(),
  onOpenTask: vi.fn(),
  onOpenPlan: vi.fn(),
  onFollowedUp: vi.fn(),
  onShowRun: vi.fn(),
  onOpenRun: vi.fn(),
  onCloseRun: vi.fn(),
}

function history(t = task()) {
  return <TaskThread task={t} backLink={undefined} shownRun={undefined} {...callbacks} />
}

function details(t = task()) {
  return (
    <TaskDetails
      task={t}
      tasks={[t]}
      factories={[factory()]}
      onOpenRun={vi.fn()}
      onOpenShell={vi.fn()}
    />
  )
}

function detailHandlers() {
  return {
    listApps: () => [],
    simulators: () => ({ supported: false }),
    listTaskRuns: () => [],
    taskGates: () => ({ rows: [], overrides: {}, revision: 'v1' }),
    listComments: () => [],
    taskBrief: () => null,
  }
}

test('settings keeps its heading and navigation while machine settings load', () => {
  render(
    <SettingsShell
      section="integrations"
      settings={undefined}
      factories={[]}
      inboxCount={0}
      dispatch={vi.fn()}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Integrations' })).toBeTruthy()
  expect(screen.getByRole('navigation', { name: 'Settings' })).toBeTruthy()
  expect(screen.getByRole('status', { name: 'Loading settings…' })).toBeTruthy()
})

test('settings replaces its loading state with an error and retry action', async () => {
  const retry = vi.fn()
  const view = render(
    <SettingsShell
      section="integrations"
      settings={undefined}
      factories={[]}
      inboxCount={0}
      dispatch={vi.fn()}
    />,
  )
  view.rerender(
    <SettingsShell
      section="integrations"
      settings={undefined}
      factories={[]}
      inboxCount={0}
      dispatch={vi.fn()}
      error="Couldn’t load settings."
      retry={retry}
    />,
  )
  expect(screen.queryByRole('status')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  expect(retry).toHaveBeenCalledOnce()
})

test('History opens immediately, stays closable while pending, then displays versions', async () => {
  const pending = deferred<DescriptionVersion[]>()
  bridge({ ...detailHandlers(), taskDescriptions: () => pending.promise })
  render(details())
  await user().click(screen.getByRole('button', { name: 'History' }))
  let dialog = screen.getByRole('dialog', { name: 'NB-1 description history' })
  expect(within(dialog).getByRole('status', { name: 'Loading description history…' })).toBeTruthy()
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'History' }))
  await act(async () => pending.resolve([{ version: 1, text: 'Original scope', at: createdAt }]))
  dialog = screen.getByRole('dialog', { name: 'NB-1 description history' })
  expect(within(dialog).getByText('Original scope')).toBeTruthy()
  expect(within(dialog).queryByRole('status')).toBeNull()
})

test('a failed History load exits loading and can be retried', async () => {
  const pending = deferred<DescriptionVersion[]>()
  const api = bridge({ ...detailHandlers(), taskDescriptions: () => pending.promise })
  render(details())
  await user().click(screen.getByRole('button', { name: 'History' }))
  await act(async () => pending.reject(new Error('History unavailable')))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('alert').textContent).toContain('History unavailable')
  expect(within(dialog).queryByRole('status')).toBeNull()
  api.handle('taskDescriptions', () => [])
  await user().click(within(dialog).getByRole('button', { name: 'Try again' }))
  await within(dialog).findByText('No description history.')
})

test('Task history waits for comments, events and Checks, then keeps content on refresh', async () => {
  const comments = deferred<Comment[]>()
  const events = deferred<ThreadEvent[]>()
  const api = bridge({
    listComments: () => comments.promise,
    listThreadEvents: () => events.promise,
    listCheckRuns: () => [],
  })
  render(history())
  expect(screen.getByRole('status', { name: 'Loading Task history…' })).toBeTruthy()
  await act(async () =>
    comments.resolve([
      comment({ kind: 'note', author: { kind: 'human' }, body: 'History has arrived.' }),
    ]),
  )
  expect(screen.getByRole('status', { name: 'Loading Task history…' })).toBeTruthy()
  await act(async () => events.resolve([]))
  await screen.findByText('History has arrived.')
  const refresh = deferred<ThreadEvent[]>()
  api.handle('listThreadEvents', () => refresh.promise)
  act(() => api.emit({ type: 'task-updated', task: task() }))
  expect(screen.getByText('History has arrived.')).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Loading Task history…' })).toBeNull()
  await act(async () => refresh.resolve([]))
})

test('switching Tasks resets history loading and ignores a late response for the prior Task', async () => {
  const old = deferred<Comment[]>()
  const next = deferred<Comment[]>()
  bridge({
    listComments: (id) => (id === 'NB-1' ? old.promise : next.promise),
    listThreadEvents: () => [],
    listCheckRuns: () => [],
  })
  const view = render(history())
  view.rerender(history(task({ id: 'NB-2', displayId: 'NB-2' })))
  await act(async () => old.resolve([comment({ kind: 'note', body: 'Wrong Task' })]))
  expect(screen.queryByText('Wrong Task')).toBeNull()
  expect(screen.getByRole('status', { name: 'Loading Task history…' })).toBeTruthy()
  await act(async () => next.resolve([]))
  expect(screen.queryByRole('status', { name: 'Loading Task history…' })).toBeNull()
})

function chat(text: string, id = 'r1'): RunChat {
  return {
    run: {
      id,
      taskId: 'NB-1',
      name: 'Task Lead',
      agent: 'claude',
      role: 'lead',
      state: 'idle',
      current: true,
      startedAt: createdAt,
    },
    items: [{ kind: 'agent', id: 'a1', text }],
  }
}

test('Run chat keeps loaded content after reconnect and resets immediately on a different Run', async () => {
  const first = deferred<RunChat>()
  const refresh = deferred<RunChat>()
  const next = deferred<RunChat>()
  const api = bridge({ getRunChat: () => first.promise })
  const show = (id: string, epoch: number) => (
    <ConnectionContext.Provider value={{ connection: { state: 'connected' }, epoch }}>
      <Conversation runId={id} />
    </ConnectionContext.Provider>
  )
  const view = render(show('r1', 0))
  expect(screen.getByRole('status', { name: 'Loading the Run…' })).toBeTruthy()
  await act(async () => first.resolve(chat('First Run')))
  api.handle('getRunChat', () => refresh.promise)
  view.rerender(show('r1', 1))
  expect(screen.getByText('First Run')).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Loading the Run…' })).toBeNull()
  api.handle('getRunChat', () => next.promise)
  view.rerender(show('r2', 1))
  expect(screen.queryByText('First Run')).toBeNull()
  expect(screen.getByRole('status', { name: 'Loading the Run…' })).toBeTruthy()
  await act(async () => refresh.resolve(chat('Late first Run')))
  expect(screen.queryByText('Late first Run')).toBeNull()
  await act(async () => next.resolve(chat('Second Run', 'r2')))
  expect(screen.getByText('Second Run')).toBeTruthy()
})

test('Run chat exits its loading state on rejection and retries', async () => {
  const pending = deferred<RunChat>()
  const api = bridge({ getRunChat: () => pending.promise })
  render(<Conversation runId="r1" />)
  await act(async () => pending.reject(new Error('Run unavailable')))
  expect(screen.getByRole('alert').textContent).toContain('Run unavailable')
  expect(screen.queryByRole('status', { name: 'Loading the Run…' })).toBeNull()
  api.handle('getRunChat', () => chat('Loaded after retry'))
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByText('Loaded after retry')
})

test('startup shows a labelled spinner and lets a failed data-status read retry', async () => {
  const pending = deferred<never>()
  const api = bridge({ getDataStatus: () => pending.promise })
  render(<Root />)
  expect(screen.getByRole('status', { name: 'Loading TED…' })).toBeTruthy()
  await act(async () => pending.reject(new Error('Data unavailable')))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('Data unavailable')
  api.handle('getDataStatus', () => ({ state: 'opening' }))
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('status', { name: 'Loading TED…' })
})

test('an integration failure removes both pending rows and offers a retry', async () => {
  const { IntegrationsPage } = await import('../src/renderer/settings/IntegrationsPage.tsx')
  const { defaultMachineSettings } = await import('@ted/protocol/settings')
  const pending = deferred<never>()
  const linear = deferred<never>()
  const api = bridge({
    getIntegrations: () => pending.promise,
    getLinear: () => linear.promise,
    listFactories: () => [],
    tedFolder: () => ({ path: '/example/' }),
    checkIntegrations: () => ({
      github: { cli: { state: 'ready' }, hosts: [] },
      git: { state: 'not-installed' },
    }),
  })
  render(<IntegrationsPage settings={defaultMachineSettings} />)
  expect(screen.getAllByRole('status', { name: 'Loading integrations…' })).toHaveLength(2)
  await act(async () => pending.reject(new Error('Integrations unavailable')))
  expect(screen.queryByRole('status', { name: 'Loading integrations…' })).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByText('TED needs Git to clone repos and make worktrees.')
  expect(api.request).toHaveBeenCalledWith('checkIntegrations')
})

test('an empty successful agent read ends the initial loading state', async () => {
  const { AgentsPage } = await import('../src/renderer/settings/AgentsPage.tsx')
  const { defaultMachineSettings } = await import('@ted/protocol/settings')
  const pending = deferred<never[]>()
  bridge({ agentHealth: () => pending.promise, library: () => ({ agents: [], version: 'v1' }) })
  render(<AgentsPage settings={defaultMachineSettings} dispatch={vi.fn()} />)
  expect(screen.getByRole('status', { name: 'Checking your agents…' })).toBeTruthy()
  await act(async () => pending.resolve([]))
  expect(screen.queryByRole('status', { name: 'Checking your agents…' })).toBeNull()
})

test('Full brief preserves loaded sections through a failed refresh and pending retry', async () => {
  const a = appState()
  const current = task()
  const brief = {
    taskId: current.id,
    version: 1,
    stage: 'design',
    createdAt,
    text: '## Goal\n\nKeep this loaded goal visible.',
  }
  a.state.tasks = [current]
  a.handle('taskBrief', () => brief)
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  await user().click(await screen.findByRole('button', { name: 'Full brief' }))
  const full = screen.getByRole('region', { name: 'Full brief' })
  expect(within(full).getByText('Keep this loaded goal visible.')).toBeTruthy()
  a.handle('taskBrief', () => Promise.reject(new Error('Temporary refresh failure')))
  act(() => a.emit({ type: 'task-updated', task: current }))
  await within(full).findByRole('alert')
  expect(within(full).getByText('Keep this loaded goal visible.')).toBeTruthy()
  const retry = deferred<typeof brief>()
  a.handle('taskBrief', () => retry.promise)
  await user().click(within(full).getByRole('button', { name: 'Try again' }))
  expect(within(full).getByText('Keep this loaded goal visible.')).toBeTruthy()
  expect(within(full).queryByRole('status')).toBeNull()
  await act(async () =>
    retry.resolve({ ...brief, version: 2, text: '## Goal\n\nUpdated goal after retry.' }),
  )
  expect(within(full).getByText('Updated goal after retry.')).toBeTruthy()
  expect(within(full).queryByRole('alert')).toBeNull()
})

test('Original request stays visible when its refresh fails and recovers after retry', async () => {
  const version = { version: 1, at: createdAt, text: 'Keep the original request visible.' }
  const api = bridge({ ...detailHandlers(), taskDescriptions: () => [version] })
  render(details())
  await user().click(screen.getByRole('button', { name: 'Original request' }))
  await screen.findByText(version.text)
  api.handle('taskDescriptions', () => Promise.reject(new Error('Description refresh failed')))
  act(() => api.emit({ type: 'task-updated', task: task() }))
  await screen.findByRole('alert')
  expect(screen.getByText(version.text)).toBeTruthy()
  const retry = deferred<(typeof version)[]>()
  api.handle('taskDescriptions', () => retry.promise)
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  expect(screen.getByText(version.text)).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Loading original request…' })).toBeNull()
  await act(async () => retry.resolve([version]))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(version.text)).toBeTruthy()
})

test('Developer diagnostics retain their values after a rejected poll and during retry', async () => {
  const { DeveloperPage } = await import('../src/renderer/settings/DeveloperPage.tsx')
  const { defaultMachineSettings } = await import('@ted/protocol/settings')
  const diagnostics = { memory: { totalBytes: 1e9, availableBytes: 5e8 }, runs: [], processes: [] }
  const api = bridge({
    tedFolder: () => ({ path: '/test/', platform: 'darwin' }),
    getDiagnostics: () => diagnostics,
    readDaemonLog: () => ({ text: 'Log loaded.', truncated: false }),
  })
  vi.useFakeTimers()
  const view = render(
    <DeveloperPage
      settings={{ ...defaultMachineSettings, developerMode: true }}
      dispatch={vi.fn()}
    />,
  )
  try {
    await act(async () => {})
    expect(screen.getByRole('region', { name: 'Diagnostics' })).toBeTruthy()
    api.handle('getDiagnostics', () => Promise.reject(new Error('Diagnostics refresh failed')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByRole('alert').textContent).toContain('Diagnostics refresh failed')
    expect(screen.getByRole('region', { name: 'Diagnostics' })).toBeTruthy()
    expect(screen.getByText('50% in use · 0.5 GB available of 0.9 GB')).toBeTruthy()
    const retry = deferred<typeof diagnostics>()
    api.handle('getDiagnostics', () => retry.promise)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    expect(screen.getByRole('region', { name: 'Diagnostics' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading diagnostics…' })).toBeNull()
    await act(async () =>
      retry.resolve({ ...diagnostics, memory: { totalBytes: 1e9, availableBytes: 1e9 } }),
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('0% in use · 0.9 GB available of 0.9 GB')).toBeTruthy()
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})

test('Task brief summary exposes initial loading, failed loads and retry without hiding loaded content', async () => {
  const a = appState()
  const current = task()
  const brief = {
    taskId: current.id,
    version: 1,
    stage: 'design',
    createdAt,
    text: '## Goal\n\nShow this brief summary.',
  }
  const initial = deferred<typeof brief>()
  a.state.tasks = [current]
  a.handle('taskBrief', () => initial.promise)
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  const summary = screen.getByRole('region', { name: 'Task brief' })
  expect(within(summary).getByRole('status', { name: 'Loading Task brief…' })).toBeTruthy()
  expect(within(summary).queryByRole('button', { name: 'Full brief' })).toBeNull()
  await act(async () => initial.reject(new Error('Initial brief load failed')))
  expect(within(summary).getByRole('alert').textContent).toContain('Initial brief load failed')
  expect(within(summary).queryByRole('status')).toBeNull()
  const retry = deferred<typeof brief>()
  a.handle('taskBrief', () => retry.promise)
  await user().click(within(summary).getByRole('button', { name: 'Try again' }))
  expect(within(summary).getByRole('status', { name: 'Loading Task brief…' })).toBeTruthy()
  await act(async () => retry.resolve(brief))
  expect(within(summary).getByText('Goal: Show this brief summary.')).toBeTruthy()
  expect(within(summary).getByRole('button', { name: 'Full brief' })).toBeTruthy()
  expect(within(summary).queryByRole('status')).toBeNull()
  a.handle('taskBrief', () => Promise.reject(new Error('Brief summary refresh failed')))
  act(() => a.emit({ type: 'task-updated', task: current }))
  await within(summary).findByRole('alert')
  expect(within(summary).getByText('Goal: Show this brief summary.')).toBeTruthy()
  const refreshed = deferred<typeof brief>()
  a.handle('taskBrief', () => refreshed.promise)
  await user().click(within(summary).getByRole('button', { name: 'Try again' }))
  expect(within(summary).getByText('Goal: Show this brief summary.')).toBeTruthy()
  expect(within(summary).queryByRole('status')).toBeNull()
  await act(async () => refreshed.resolve({ ...brief, text: '## Goal\n\nRecovered summary.' }))
  expect(within(summary).getByText('Goal: Recovered summary.')).toBeTruthy()
  expect(within(summary).queryByRole('alert')).toBeNull()
})

test('pending Automation details keep their heading and back navigation available', async () => {
  const { AutomationView } = await import('../src/renderer/views/Automations.tsx')
  bridge({ getAutomation: () => new Promise(() => {}) })
  const back = vi.fn()
  render(
    <AutomationView
      automationId="automation-a"
      banners={null}
      settings={undefined}
      onBack={back}
      onOpenRun={vi.fn()}
      onEdit={vi.fn()}
      onOpenAutomation={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Automation' })).toBeTruthy()
  expect(screen.getByRole('status', { name: 'Loading Automation…' })).toBeTruthy()
  await user().click(screen.getByRole('button', { name: '← Automations' }))
  expect(back).toHaveBeenCalledOnce()
})

test('initial Gates loading is disabled and its failed request can be retried', async () => {
  const { TaskGatesField } = await import('../src/renderer/views/TaskGatesField.tsx')
  const initial = deferred<never>()
  const api = bridge({ taskGates: () => initial.promise })
  render(<TaskGatesField taskId="task-a" />)
  const loading = screen.getByRole('button', { name: 'Loading Gates…' })
  expect(loading.hasAttribute('disabled')).toBe(true)
  await user().click(loading)
  expect(api.request).toHaveBeenCalledTimes(1)
  await act(async () => initial.reject(new Error('Gates unavailable')))
  const retry = screen.getByRole('button', { name: 'Load Gates' })
  expect(retry.hasAttribute('disabled')).toBe(false)
  api.handle('taskGates', () => ({ rows: [], overrides: {}, revision: 'v1' }))
  await user().click(retry)
  expect(screen.getByRole('region', { name: 'Gates for this Task' })).toBeTruthy()
})

test('spinners keep accessible loading names without visible loading text', async () => {
  const { Loading } = await import('../src/renderer/components/Loading.tsx')
  const view = render(<Loading label="Loading diff…" />)
  expect(screen.getByRole('status', { name: 'Loading diff…' }).textContent).toBe('')
  view.rerender(
    <button type="button">
      <Loading compact label="Checking…" />
    </button>,
  )
  expect(screen.getByRole('button', { name: 'Checking…' })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('')
})
