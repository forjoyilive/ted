// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { appState } from './support/app.tsx'
import { deferred, required, user } from './support/component.ts'
import { factory } from './support/fixtures.ts'

const nav = () => screen.getByRole('navigation', { name: 'Sidebar' })

test('Developer mode shows live process totals in the sidebar and stops collecting when off', async () => {
  const app = appState()
  let cpuPercent = 12.5
  const diagnostics = vi.fn(() => ({
    memory: { totalBytes: 1024 ** 3, availableBytes: 512 * 1024 ** 2 },
    runs: [{ cpuPercent: 99, memoryBytes: 999 * 1024 ** 2 }],
    processes: [
      { pid: 1, owner: 'daemon', cpuPercent, memoryBytes: 64 * 1024 ** 2 },
      { pid: 2, owner: { runId: 'run' }, cpuPercent: 2.5, memoryBytes: 128 * 1024 ** 2 },
    ],
  }))
  app.handle('getDiagnostics', diagnostics)
  const view = app.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  expect(screen.queryByLabelText('Developer resource usage')).toBeNull()
  expect(diagnostics).not.toHaveBeenCalled()
  vi.useFakeTimers()
  try {
    app.state.settings.developerMode = true
    await act(async () =>
      app.emit({ type: 'settings-changed', settings: { ...app.state.settings } }),
    )
    expect(within(nav()).getByLabelText('Developer resource usage').textContent).toBe(
      'CPU 15% · Memory 192 MB',
    )
    cpuPercent = 30
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByLabelText('Developer resource usage').textContent).toBe(
      'CPU 32.5% · Memory 192 MB',
    )
    app.state.settings.developerMode = false
    await act(async () =>
      app.emit({ type: 'settings-changed', settings: { ...app.state.settings } }),
    )
    expect(screen.queryByLabelText('Developer resource usage')).toBeNull()
    const calls = diagnostics.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(diagnostics).toHaveBeenCalledTimes(calls)
    app.state.settings.developerMode = true
    await act(async () =>
      app.emit({ type: 'settings-changed', settings: { ...app.state.settings } }),
    )
    view.unmount()
    const beforeUnmount = diagnostics.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(diagnostics).toHaveBeenCalledTimes(beforeUnmount)
  } finally {
    vi.useRealTimers()
  }
})

test('sidebar resource readings recover after a diagnostics failure without showing stale totals', async () => {
  const app = appState()
  app.state.settings.developerMode = true
  const diagnostics = vi
    .fn()
    .mockResolvedValueOnce({ processes: [{ cpuPercent: 1, memoryBytes: 1024 ** 2 }] })
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue({ processes: [] })
  app.handle('getDiagnostics', diagnostics)
  vi.useFakeTimers()
  const view = app.mount()
  try {
    await act(async () => {})
    expect(screen.getByText('CPU 1% · Memory 1 MB')).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByLabelText('Developer resource usage').textContent).toBe(
      'CPU / Memory unavailable',
    )
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByText('CPU 0% · Memory 0 MB')).toBeTruthy()
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})

test('slow diagnostics do not overlap or restart polling after leaving the main screen', async () => {
  const app = appState()
  const pending = deferred<{ processes: [] }>()
  const diagnostics = vi.fn(() => pending.promise)
  app.handle('getDiagnostics', diagnostics)
  app.state.settings.developerMode = true
  app.mount()
  await screen.findByText('CPU / Memory reading…')
  vi.useFakeTimers()
  try {
    await act(async () => vi.advanceTimersByTimeAsync(6_000))
    expect(diagnostics).toHaveBeenCalledOnce()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Settings/ }))
    await act(async () => {})
    expect(screen.queryByLabelText('Developer resource usage')).toBeNull()
    await act(async () => pending.resolve({ processes: [] }))
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(diagnostics).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

test('Factories open Board and expose their Views; All Tasks preserves expansion', async () => {
  const a = appState()
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  for (const name of ['Board', 'List', 'Plans', 'Automations'])
    expect(within(nav()).getByRole('button', { name })).toBeTruthy()
  expect(within(nav()).getByRole('button', { name: 'Board' }).getAttribute('aria-current')).toBe(
    'page',
  )
  await u.click(within(nav()).getByRole('button', { name: 'All Tasks' }))
  expect(within(nav()).getByRole('button', { name: 'Views' }).getAttribute('aria-expanded')).toBe(
    'true',
  )
})

test('a live Factory event updates the sidebar', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  await act(async () =>
    a.emit({ type: 'factory-added', factory: factory({ id: 'f2', key: 'MS', name: 'site' }) }),
  )
  expect(screen.getByRole('button', { name: 'site' })).toBeTruthy()
})

test('the window is marked loaded once the first Factories load finishes', async () => {
  const a = appState()
  const factories = deferred<unknown[]>()
  a.handle('listFactories', () => factories.promise)
  const view = a.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  const root = required(view.container.querySelector('[data-loaded]'))
  expect(root.getAttribute('data-loaded')).toBe('false')
  await act(async () => factories.resolve([factory()]))
  expect(root.getAttribute('data-loaded')).toBe('true')
  expect(screen.getByRole('button', { name: 'widgets' })).toBeTruthy()
})

test('sidebar expansion survives a component remount', async () => {
  const a = appState()
  a.state.factories.push(factory({ id: 'f2', key: 'MS', name: 'site' }))
  const first = a.mount()
  const u = user()
  const views = (name: string) =>
    within(screen.getByRole('article', { name })).getByRole('button', { name: 'Views' })
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  await u.click(views('widgets'))
  expect(views('widgets').getAttribute('aria-expanded')).toBe('false')
  views('site').focus()
  await u.keyboard('{Enter}')
  expect(views('site').getAttribute('aria-expanded')).toBe('true')
  first.unmount()
  a.mount()
  await screen.findByRole('article', { name: 'site' })
  expect(views('widgets').getAttribute('aria-expanded')).toBe('false')
  expect(views('site').getAttribute('aria-expanded')).toBe('true')
  views('site').focus()
  await u.keyboard(' ')
  expect(views('site').getAttribute('aria-expanded')).toBe('false')
  await u.click(screen.getByRole('button', { name: 'widgets' }))
  expect(views('widgets').getAttribute('aria-expanded')).toBe('true')
})

test('Settings shortcut and Back restore the previous screen', async () => {
  const a = appState()
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  fireEvent.keyDown(window, { key: ',', metaKey: true })
  await screen.findByRole('navigation', { name: 'Settings' })
  expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull()
  fireEvent.keyDown(window, { key: 'Escape' })
  await screen.findByRole('heading', { name: 'All Tasks' })
  await a.settings()
  await user().click(screen.getByRole('button', { name: /Back/ }))
  expect(screen.getByRole('heading', { name: 'All Tasks' })).toBeTruthy()
})

test('view headers open New Task without a duplicate sidebar button', async () => {
  const a = appState()
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  expect(within(nav()).queryByRole('button', { name: 'New Task' })).toBeNull()
  for (const view of ['Board', 'List']) {
    await u.click(within(nav()).getByRole('button', { name: view }))
    const header = required(screen.getByRole('main').querySelector('header'))
    await u.click(within(header).getByRole('button', { name: 'New Task' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Task' })
    expect((within(dialog).getByLabelText('Factory') as HTMLSelectElement).value).toBe('f1')
    await u.click(within(dialog).getByRole('button', { name: 'Close' }))
  }
})

test('G navigation and history shortcuts use the App keymap', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  for (const [letter, heading] of [
    ['a', 'All Tasks'],
    ['b', /widgets.*Board/],
    ['l', /widgets.*List/],
    ['p', /widgets.*Plans/],
  ] as const) {
    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: letter })
    await screen.findByRole('heading', { name: heading, level: 1 })
  }
  fireEvent.keyDown(window, { key: '[', code: 'BracketLeft', metaKey: true })
  await screen.findByRole('heading', { name: /widgets.*List/, level: 1 })
  fireEvent.keyDown(window, { key: '[', code: 'BracketLeft', metaKey: true })
  await screen.findByRole('heading', { name: /widgets.*Board/, level: 1 })
  fireEvent.keyDown(window, { key: '[', code: 'BracketLeft', metaKey: true })
  await screen.findByRole('heading', { name: 'All Tasks', level: 1 })
  for (const heading of [/widgets.*Board/, /widgets.*List/]) {
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', metaKey: true })
    await screen.findByRole('heading', { name: heading, level: 1 })
  }
  fireEvent.keyDown(window, { key: ']', code: 'BracketRight', metaKey: true })
  await screen.findByRole('heading', { name: /widgets.*Plans/, level: 1 })
  fireEvent.keyDown(window, { key: 'g' })
  fireEvent.keyDown(window, { key: 'i' })
  await screen.findByRole('heading', { name: 'Inbox', level: 1 })
})

test('question mark opens the shortcut sheet and dialog cancel closes it', async () => {
  const a = appState()
  a.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  fireEvent.keyDown(window, { key: '?' })
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('Keyboard shortcuts')
  expect(dialog.textContent).toContain('New Task')
  expect(dialog.textContent).toContain('Approve')
  expect(within(dialog).getByRole('region', { name: 'Task actions' })).toBeTruthy()
  const row = within(dialog).getByRole('row', { name: /Go to Board/ })
  expect([...row.querySelectorAll('kbd')].map((e) => e.textContent)).toEqual(['G', 'B'])
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(window, { key: '/', code: 'Slash', metaKey: true })
  expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()
})

test('New Task shortcuts select the current Factory and keep letters in inputs as text', async () => {
  const a = appState()
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'widgets' }))
  fireEvent.keyDown(window, { key: 'n', metaKey: true })
  let dialog = screen.getByRole('dialog', { name: 'New Task' })
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Description')),
  )
  expect((within(dialog).getByLabelText('Factory') as HTMLSelectElement).value).toBe('f1')
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  fireEvent.keyDown(window, { key: 'c' })
  dialog = screen.getByRole('dialog', { name: 'New Task' })
  await vi.waitFor(() =>
    expect(within(dialog).getByLabelText('Description').matches(':disabled')).toBe(false),
  )
  await user().type(within(dialog).getByLabelText('Description'), 'gace')
  expect((within(dialog).getByLabelText('Description') as HTMLInputElement).value).toBe('gace')
})

test('Factory Rename saves on Enter and cancels on Escape', async () => {
  const a = appState()
  a.handle('renameFactory', (_id, name) => {
    const updated = { ...required(a.state.factories[0]), name: String(name) }
    a.emit({ type: 'factory-updated', factory: updated })
    return updated
  })
  a.mount()
  const u = user()
  const row = await screen.findByRole('article', { name: 'widgets' })
  fireEvent.contextMenu(row)
  await u.click(screen.getByRole('menuitem', { name: 'Rename…' }))
  const field = screen.getByLabelText('Rename widgets')
  await u.clear(field)
  await u.type(field, 'Notebook{Enter}')
  expect(a.request).toHaveBeenCalledWith('renameFactory', 'f1', 'Notebook')
  const renamed = screen.getByRole('article', { name: 'Notebook' })
  fireEvent.contextMenu(renamed)
  await u.click(screen.getByRole('menuitem', { name: 'Rename…' }))
  await u.type(screen.getByLabelText('Rename Notebook'), 'discard{Escape}')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(a.request.mock.calls.filter(([name]) => name === 'renameFactory')).toHaveLength(1)
})

test('Move down sends Factory order and the numbered shortcut follows the new order', async () => {
  const a = appState()
  a.state.factories = [factory(), factory({ id: 'f2', name: 'site', key: 'MS', position: 1 })]
  a.handle('reorderFactories', () => {
    const updated = [
      factory({ id: 'f2', name: 'site', key: 'MS', position: 0 }),
      factory({ position: 1 }),
    ]
    a.state.factories = updated
    for (const f of updated) a.emit({ type: 'factory-updated', factory: f })
    return updated
  })
  a.mount()
  fireEvent.contextMenu(await screen.findByRole('article', { name: 'widgets' }))
  await user().click(screen.getByRole('menuitem', { name: 'Move down' }))
  expect(a.request).toHaveBeenCalledWith('reorderFactories', ['f2', 'f1'])
  expect(
    within(nav())
      .getAllByRole('article')
      .map((e) => e.getAttribute('aria-label')),
  ).toEqual(['site', 'widgets'])
  fireEvent.keyDown(window, { key: '1', metaKey: true })
  await screen.findByRole('heading', { name: /site.*Board/ })
})

test('finishing setup with an existing Factory opens the plain Add Factory form', async () => {
  const a = appState()
  a.handle('homeFolder', () => '/test')
  a.handle('getIntegrations', () => ({
    github: { cli: { state: 'ready' }, hosts: [] },
    git: { state: 'ready' },
  }))
  a.mount({ addFactoryFirst: true })
  const dialog = await screen.findByRole('dialog', { name: 'Add Factory' })
  expect(
    (within(dialog).getByRole('checkbox', { name: /^Show the tutorial/ }) as HTMLInputElement)
      .checked,
  ).toBe(false)
})
