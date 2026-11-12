// @vitest-environment jsdom
import type { Comment, DescriptionVersion, RunChat, ThreadEvent } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunChat as Conversation } from '../src/renderer/components/RunChat.tsx'
import { TaskDescription } from '../src/renderer/components/TaskDescription.tsx'
import { ConnectionContext } from '../src/renderer/data.ts'
import { Root } from '../src/renderer/Root.tsx'
import { SettingsShell } from '../src/renderer/settings/SettingsShell.tsx'
import { TaskThread } from '../src/renderer/views/TaskThread.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { comment, createdAt, task } from './support/fixtures.ts'

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
  render(<TaskDescription task={task()} />)
  await user().click(screen.getByRole('button', { name: 'Description history' }))
  let dialog = screen.getByRole('dialog', { name: 'NB-1 description history' })
  expect(within(dialog).getByRole('status', { name: 'Loading description history…' })).toBeTruthy()
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Description history' }))
  await act(async () => pending.resolve([{ version: 1, text: 'Original scope', at: createdAt }]))
  dialog = screen.getByRole('dialog', { name: 'NB-1 description history' })
  expect(within(dialog).getByText('Original scope')).toBeTruthy()
  expect(within(dialog).queryByRole('status')).toBeNull()
})

test('a failed History load exits loading and can be retried', async () => {
  const pending = deferred<DescriptionVersion[]>()
  const api = bridge({ ...detailHandlers(), taskDescriptions: () => pending.promise })
  render(<TaskDescription task={task()} />)
  await user().click(screen.getByRole('button', { name: 'Description history' }))
  await act(async () => pending.reject(new Error('History unavailable')))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('alert').textContent).toContain('History unavailable')
  expect(within(dialog).queryByRole('status')).toBeNull()
  api.handle('taskDescriptions', () => [])
  await user().click(within(dialog).getByRole('button', { name: 'Try again' }))
  await within(dialog).findByText('No description history.')
})

test('Task history loads Comments and collapsed peer messages, then keeps content on refresh', async () => {
  const comments = deferred<Comment[]>()
  const events = deferred<ThreadEvent[]>()
  const api = bridge({
    listComments: () => comments.promise,
    listThreadEvents: () => events.promise,
    listCheckRuns: () => [],
    listFailures: () => [],
    taskDescriptions: () => [],
    markCommentsRead: () => undefined,
  })
  render(history())
  expect(screen.getByRole('status', { name: 'Loading Task history…' })).toBeTruthy()
  await act(async () =>
    comments.resolve([
      comment({ kind: 'note', author: { kind: 'human' }, body: 'History has arrived.' }),
      comment({
        id: 'peer-1',
        kind: 'note',
        author: { kind: 'run', runId: 'peer-run' },
        body: 'Peer message from NB-2 (Run peer-run).\n<<<PEER nonce>>>\nraw wrapper\n<<<END PEER nonce>>>',
        peer: {
          sender: 'NB-2',
          text: '**Ready** to coordinate.\n\n- Read the [guide](https://example.com/guide).\n\n```ts\nconst key = "literal";\n```',
        },
      }),
      comment({
        id: 'peer-2',
        kind: 'note',
        author: { kind: 'run', runId: 'other-peer-run' },
        peer: { text: 'Another message.' },
        body: 'Second raw wrapper',
      }),
      comment({
        id: 'ordinary',
        kind: 'note',
        author: { kind: 'human' },
        body: 'Peer message from NB-3 is ordinary quoted text.',
      }),
    ]),
  )
  expect(screen.getByRole('status', { name: 'Loading Task history…' })).toBeTruthy()
  await act(async () => events.resolve([]))
  await screen.findByText('History has arrived.')
  const peer = screen.getByRole('button', { name: 'Peer · NB-2' })
  const other = screen.getByRole('button', { name: 'Peer message' })
  expect(peer.getAttribute('aria-expanded')).toBe('false')
  expect(other.getAttribute('aria-expanded')).toBe('false')
  expect(within(peer).getByText(/Ready to coordinate/).textContent).toBe(
    'Ready to coordinate. Read the guide. const key = "literal";',
  )
  expect(screen.queryByRole('link', { name: 'guide' })).toBeNull()
  expect(screen.queryByText(/raw wrapper/)).toBeNull()
  expect(screen.getByText('Peer message from NB-3 is ordinary quoted text.')).toBeTruthy()
  await user().click(peer)
  expect(peer.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Ready').tagName).toBe('STRONG')
  expect(screen.getByRole('link', { name: 'guide' }).getAttribute('href')).toBe(
    'https://example.com/guide',
  )
  expect(screen.getByRole('region', { name: 'Code block' }).textContent).toContain(
    'const key = "literal";',
  )
  other.focus()
  await user().keyboard('{Enter}')
  expect(other.getAttribute('aria-expanded')).toBe('true')
  expect(peer.getAttribute('aria-expanded')).toBe('true')
  peer.focus()
  await user().keyboard(' ')
  expect(peer.getAttribute('aria-expanded')).toBe('false')
  expect(other.getAttribute('aria-expanded')).toBe('true')
  expect(screen.queryByRole('link', { name: 'guide' })).toBeNull()
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
    listFailures: () => [],
    taskDescriptions: () => [],
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
  bridge({
    agentHealth: () => pending.promise,
    apiCost: () => ({ days: 30, since: '2026-10-12T00:00:00.000Z', agents: [] }),
    library: () => ({ agents: [], version: 'v1' }),
  })
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
  await user().click(screen.getByRole('button', { name: 'Task actions' }))
  await user().click(await screen.findByRole('menuitem', { name: 'Full brief' }))
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
  render(<TaskDescription task={task()} />)
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

test('Full brief exposes its initial loading and retry after opening from Task actions', async () => {
  const a = appState()
  const current = task()
  const brief = {
    taskId: current.id,
    version: 1,
    stage: 'design',
    createdAt,
    text: '## Goal\n\nShow this brief.',
  }
  const initial = deferred<typeof brief>()
  a.state.tasks = [current]
  a.handle('taskBrief', () => initial.promise)
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  expect(screen.queryByRole('region', { name: 'Task brief' })).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Task actions' }))
  await user().click(screen.getByRole('menuitem', { name: 'Full brief' }))
  const full = screen.getByRole('region', { name: 'Full brief' })
  expect(within(full).getByRole('status', { name: 'Loading Task brief…' })).toBeTruthy()
  await act(async () => initial.reject(new Error('Initial brief load failed')))
  expect(within(full).getByRole('alert').textContent).toContain('Initial brief load failed')
  expect(within(full).queryByRole('status')).toBeNull()
  const retry = deferred<typeof brief>()
  a.handle('taskBrief', () => retry.promise)
  await user().click(within(full).getByRole('button', { name: 'Try again' }))
  expect(within(full).getByRole('status', { name: 'Loading Task brief…' })).toBeTruthy()
  await act(async () => retry.resolve(brief))
  expect(within(full).getByText('Show this brief.')).toBeTruthy()
  expect(within(full).queryByRole('status')).toBeNull()
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

test('initial Sign-offs loading is disabled and its failed request can be retried', async () => {
  const { TaskGatesField } = await import('../src/renderer/views/TaskGatesField.tsx')
  const initial = deferred<never>()
  const api = bridge({ taskGates: () => initial.promise })
  render(<TaskGatesField taskId="task-a" factoryId="factory-a" />)
  const loading = screen.getByRole('button', { name: 'Loading sign-offs…' })
  expect(loading.hasAttribute('disabled')).toBe(true)
  await user().click(loading)
  expect(api.request).toHaveBeenCalledTimes(1)
  await act(async () => initial.reject(new Error('Sign-offs unavailable')))
  const retry = screen.getByRole('button', { name: 'Load sign-offs' })
  expect(retry.hasAttribute('disabled')).toBe(false)
  api.handle('taskGates', () => ({ rows: [], overrides: {}, revision: 'v1' }))
  await user().click(retry)
  expect(screen.getByRole('region', { name: 'Sign-offs for this Task' })).toBeTruthy()
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

test('the request shows images while collapsed, expands formatting and files, and resets on another Task', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40)
  const image = { hash: 'image', name: 'request.png', mediaType: 'image/png', size: 68 }
  const file = { hash: 'file', name: 'reference.txt', mediaType: 'text/plain', size: 12 }
  const current = task({ attachments: [image, file], description: 'Latest edited scope.' })
  const api = bridge({
    taskDescriptions: () => [
      {
        version: 1,
        at: createdAt,
        text: '**Original scope**\n\nRead the [guide](https://example.com/guide).\n\n```ts\nconst value = 1\n```',
      },
      { version: 2, at: createdAt, text: current.description },
    ],
    readAttachment: () => ({ data: 'aW1hZ2U=' }),
  })
  const view = render(<TaskDescription task={current} />)
  const request = screen.getByRole('region', { name: 'Original request' })
  await within(request).findByRole('img', { name: image.name })
  expect(within(request).queryByText('1 image')).toBeNull()
  expect(within(request).queryByText(current.description)).toBeNull()
  expect(within(request).queryByText(file.name)).toBeNull()
  expect(within(request).getByText(/Original scope/).textContent).not.toContain('**')
  expect(within(request).getByText('Original scope').closest('[inert]')).toBeNull()
  expect(within(request).getByText('guide')).toBeTruthy()
  expect(within(request).queryByRole('link')).toBeNull()
  expect(within(request).queryByRole('button', { name: 'Copy code' })).toBeNull()
  await user().click(within(request).getByRole('button', { name: `View ${image.name}` }))
  const viewer = screen.getByRole('dialog', { name: image.name })
  await user().click(within(viewer).getByRole('button', { name: 'Close' }))
  await user().click(within(request).getByRole('button', { name: 'See more' }))
  expect(within(request).getByText('Original scope').tagName).toBe('STRONG')
  expect(within(request).getByRole('link', { name: 'guide' }).getAttribute('href')).toBe(
    'https://example.com/guide',
  )
  expect(within(request).getByRole('button', { name: 'Copy code' })).toBeTruthy()
  expect(within(request).getByText(file.name)).toBeTruthy()
  expect(within(request).getAllByRole('img', { name: image.name })).toHaveLength(1)
  await user().click(within(request).getByRole('button', { name: 'See less' }))
  expect(within(request).queryByText(file.name)).toBeNull()
  expect(within(request).getByRole('img', { name: image.name })).toBeTruthy()
  await user().click(within(request).getByRole('button', { name: 'See more' }))
  const pending = deferred<DescriptionVersion[]>()
  api.handle('taskDescriptions', () => pending.promise)
  view.rerender(<TaskDescription task={task({ id: 'NB-2', displayId: 'NB-2' })} />)
  expect(screen.queryByRole('img', { name: image.name })).toBeNull()
  expect(screen.queryByText(current.description)).toBeNull()
  expect(screen.getByRole('status', { name: 'Loading original request…' })).toBeTruthy()
  await act(async () => pending.resolve([{ version: 1, at: createdAt, text: 'Second request.' }]))
  expect(screen.queryByRole('button', { name: 'See less' })).toBeNull()
  expect(screen.getByText('Second request.')).toBeTruthy()
})

test('short, image-only and empty requests need no expansion control', async () => {
  const image = { hash: 'image', name: 'request.png', mediaType: 'image/png', size: 68 }
  const api = bridge({
    taskDescriptions: () => [{ version: 1, at: createdAt, text: 'A short request.' }],
    readAttachment: () => ({ data: 'aW1hZ2U=' }),
  })
  const current = task()
  const view = render(<TaskDescription task={current} />)
  await screen.findByText('A short request.')
  expect(screen.queryByRole('button', { name: 'See more' })).toBeNull()
  api.handle('taskDescriptions', () => [{ version: 1, at: createdAt, text: '' }])
  view.rerender(<TaskDescription task={task({ id: 'NB-2', attachments: [image] })} />)
  await screen.findByRole('img', { name: image.name })
  expect(screen.queryByRole('button', { name: 'See more' })).toBeNull()
  expect(screen.queryByText('No description.')).toBeNull()
  view.rerender(<TaskDescription task={task({ id: 'NB-3' })} />)
  await screen.findByText('No description.')
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.queryByRole('button', { name: 'See more' })).toBeNull()
})

test('a short linked request can reveal its interactive content without hiding the preview', async () => {
  bridge({
    taskDescriptions: () => [
      { version: 1, at: createdAt, text: 'Read the [guide](https://example.com/guide).' },
    ],
  })
  render(<TaskDescription task={task()} />)
  const guide = await screen.findByText('guide')
  expect(guide.closest('[inert]')).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
  await user().click(await screen.findByRole('button', { name: 'See more' }))
  expect(screen.getByRole('link', { name: 'guide' }).getAttribute('href')).toBe(
    'https://example.com/guide',
  )
})
