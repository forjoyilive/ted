// @vitest-environment jsdom

import type { FactoryLayout } from '@ted/protocol'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { appState } from './support/app.tsx'
import { deferred, required, user } from './support/component.ts'
import { factory } from './support/fixtures.ts'

const nav = () => screen.getByRole('navigation', { name: 'Sidebar' })

test('Developer mode shows live process totals in the sidebar and stops collecting when off', async () => {
  const app = appState()
  let cpuPercent = 15
  const usage = vi.fn(() => ({ cpuPercent, memoryBytes: 192 * 1024 ** 2 }))
  const diagnostics = vi.fn()
  app.handle('getProcessUsage', usage)
  app.handle('getDiagnostics', diagnostics)
  const view = app.mount()
  await screen.findByRole('navigation', { name: 'Sidebar' })
  expect(screen.queryByLabelText('Developer resource usage')).toBeNull()
  expect(usage).not.toHaveBeenCalled()
  vi.useFakeTimers()
  try {
    app.state.settings.developerMode = true
    await act(async () =>
      app.emit({ type: 'settings-changed', settings: { ...app.state.settings } }),
    )
    expect(within(nav()).getByLabelText('Developer resource usage').textContent).toBe(
      'CPU 15% · Memory 192 MB',
    )
    cpuPercent = 32.54
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(usage).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(screen.getByLabelText('Developer resource usage').textContent).toBe(
      'CPU 32.5% · Memory 192 MB',
    )
    app.state.settings.developerMode = false
    await act(async () =>
      app.emit({ type: 'settings-changed', settings: { ...app.state.settings } }),
    )
    expect(screen.queryByLabelText('Developer resource usage')).toBeNull()
    const calls = usage.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(usage).toHaveBeenCalledTimes(calls)
    app.state.settings.developerMode = true
    await act(async () =>
      app.emit({ type: 'settings-changed', settings: { ...app.state.settings } }),
    )
    view.unmount()
    const beforeUnmount = usage.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(usage).toHaveBeenCalledTimes(beforeUnmount)
    expect(diagnostics).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

test('sidebar resource readings stop while the window is hidden and resume when it shows', async () => {
  const app = appState()
  app.state.settings.developerMode = true
  const usage = vi.fn(() => ({ cpuPercent: 1, memoryBytes: 1024 ** 2 }))
  app.handle('getProcessUsage', usage)
  let hidden = false
  const show = (visible: boolean) => {
    hidden = !visible
    document.dispatchEvent(new Event('visibilitychange'))
  }
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  vi.useFakeTimers()
  const view = app.mount()
  try {
    await act(async () => {})
    expect(usage).toHaveBeenCalledOnce()
    show(false)
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(usage).toHaveBeenCalledOnce()
    await act(async () => show(true))
    expect(usage).toHaveBeenCalledTimes(2)
    await act(async () => show(true))
    expect(usage).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(usage).toHaveBeenCalledTimes(3)
  } finally {
    view.unmount()
    Reflect.deleteProperty(document, 'hidden')
    vi.useRealTimers()
  }
})

test('sidebar resource readings recover after a failure without showing stale totals', async () => {
  const app = appState()
  app.state.settings.developerMode = true
  const usage = vi
    .fn()
    .mockResolvedValueOnce({ cpuPercent: 1, memoryBytes: 1024 ** 2 })
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue({ cpuPercent: 0, memoryBytes: 0 })
  app.handle('getProcessUsage', usage)
  vi.useFakeTimers()
  const view = app.mount()
  try {
    await act(async () => {})
    expect(screen.getByText('CPU 1% · Memory 1 MB')).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.getByLabelText('Developer resource usage').textContent).toBe(
      'CPU / Memory unavailable',
    )
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.getByText('CPU 0% · Memory 0 MB')).toBeTruthy()
  } finally {
    view.unmount()
    vi.useRealTimers()
  }
})

test('a slow resource reading does not overlap or restart polling after leaving the main screen', async () => {
  const app = appState()
  const pending = deferred<{ cpuPercent: number; memoryBytes: number }>()
  const usage = vi.fn(() => pending.promise)
  app.handle('getProcessUsage', usage)
  app.state.settings.developerMode = true
  app.mount()
  await screen.findByText('CPU / Memory reading…')
  vi.useFakeTimers()
  try {
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(usage).toHaveBeenCalledOnce()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Settings/ }))
    await act(async () => {})
    expect(screen.queryByLabelText('Developer resource usage')).toBeNull()
    await act(async () => pending.resolve({ cpuPercent: 0, memoryBytes: 0 }))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(usage).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

test('Factories open Dashboard with Board, List and Map folded under Tasks; All Tasks preserves expansion', async () => {
  const a = appState()
  const first = a.mount()
  const u = user()
  const shown = (name: string) => within(nav()).queryByRole('button', { name }) !== null
  const taskViews = () => within(nav()).getByRole('button', { name: 'Task views' })
  const factoryViews = () => within(nav()).getByRole('button', { name: 'Views' })
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  for (const name of ['Dashboard', 'Tasks', 'Plans', 'Automations']) expect(shown(name)).toBe(true)
  expect(['Board', 'List', 'Map'].filter(shown)).toEqual([])
  expect(taskViews().getAttribute('aria-expanded')).toBe('false')
  expect(
    within(nav()).getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current'),
  ).toBe('page')

  await u.click(taskViews())
  expect(['Board', 'List', 'Map'].filter(shown)).toEqual(['Board', 'List', 'Map'])
  await screen.findByRole('heading', { name: 'All Factories › Dashboard', level: 1 })
  await u.click(taskViews())
  expect(['Board', 'List', 'Map'].filter(shown)).toEqual([])

  await u.click(within(nav()).getByRole('button', { name: 'Tasks' }))
  await screen.findByRole('heading', { name: /widgets.*Board/, level: 1 })
  expect(taskViews().getAttribute('aria-expanded')).toBe('true')
  await u.click(within(nav()).getByRole('button', { name: 'List' }))
  await u.click(taskViews())
  await u.click(within(nav()).getByRole('button', { name: 'Dashboard' }))
  expect(shown('Board')).toBe(false)
  fireEvent.keyDown(window, { key: 'g' })
  fireEvent.keyDown(window, { key: 'm' })
  await screen.findByRole('heading', { name: /widgets.*Map/, level: 1 })
  expect(within(nav()).getByRole('button', { name: 'Map' }).getAttribute('aria-current')).toBe(
    'page',
  )

  await u.click(taskViews())
  first.unmount()
  a.mount()
  await screen.findByRole('article', { name: 'widgets' })
  expect(taskViews().getAttribute('aria-expanded')).toBe('false')
  await u.click(taskViews())

  await u.click(within(nav()).getByRole('button', { name: 'All Tasks' }))
  expect(factoryViews().getAttribute('aria-expanded')).toBe('true')
  await u.click(screen.getByRole('button', { name: 'widgets' }))
  expect(factoryViews().getAttribute('aria-expanded')).toBe('false')
  expect(shown('Tasks')).toBe(false)
  await screen.findByRole('heading', { name: 'All Tasks', level: 1 })
  await u.click(screen.getByRole('button', { name: 'widgets' }))
  expect(factoryViews().getAttribute('aria-expanded')).toBe('true')
  expect(taskViews().getAttribute('aria-expanded')).toBe('true')
  await screen.findByRole('heading', { name: 'All Factories › Dashboard', level: 1 })
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

test('a first Factories load that fails is tried again until it succeeds', async () => {
  vi.useFakeTimers()
  try {
    const a = appState()
    let calls = 0
    a.handle('listFactories', () =>
      ++calls < 3 ? Promise.reject(new Error('can’t reach TED’s daemon')) : [factory()],
    )
    const view = a.mount()
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const root = required(view.container.querySelector('[data-loaded]'))
    expect(root.getAttribute('data-loaded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'widgets' })).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(calls).toBe(2)
    expect(root.getAttribute('data-loaded')).toBe('false')
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(calls).toBe(3)
    expect(root.getAttribute('data-loaded')).toBe('true')
    expect(screen.getByRole('button', { name: 'widgets' })).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(calls).toBe(3)
  } finally {
    vi.useRealTimers()
  }
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
  await u.click(within(nav()).getByRole('button', { name: 'Tasks' }))
  for (const view of ['Board', 'List']) {
    await u.click(within(nav()).getByRole('button', { name: view }))
    const header = required(screen.getByRole('main').querySelector('header'))
    await u.click(within(header).getByRole('button', { name: 'New Task' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Task' })
    expect(within(dialog).getByRole('combobox', { name: 'Factory' }).dataset.value).toBe('f1')
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
  fireEvent.keyDown(window, { key: 'g' })
  fireEvent.keyDown(window, { key: 'd' })
  await screen.findByRole('heading', { name: 'All Factories › Dashboard', level: 1 })
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
  expect(within(dialog).getByRole('combobox', { name: 'Factory' }).dataset.value).toBe('f1')
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

test('Move down saves the Factory layout and the numbered shortcut follows the new order', async () => {
  const a = appState()
  a.state.factories = [factory(), factory({ id: 'f2', name: 'site', key: 'MS', position: 1 })]
  a.handle('saveFactoryLayout', (layout) => {
    const updated = [
      factory({ id: 'f2', name: 'site', key: 'MS', position: 0 }),
      factory({ position: 1 }),
    ]
    a.state.factories = updated
    a.state.layout = layout as FactoryLayout
    for (const f of updated) a.emit({ type: 'factory-updated', factory: f })
    a.emit({ type: 'factory-layout-changed', layout: a.state.layout })
    return a.state.layout
  })
  a.mount()
  fireEvent.contextMenu(await screen.findByRole('article', { name: 'widgets' }))
  await user().click(screen.getByRole('menuitem', { name: 'Move down' }))
  expect(a.request).toHaveBeenCalledWith('saveFactoryLayout', {
    items: [{ factoryId: 'f2' }, { factoryId: 'f1' }],
  })
  expect(
    within(nav())
      .getAllByRole('article')
      .map((e) => e.getAttribute('aria-label')),
  ).toEqual(['site', 'widgets'])
  fireEvent.keyDown(window, { key: '1', metaKey: true })
  await screen.findByRole('heading', { name: /site.*Dashboard/ })
})

test('opening a Factory expands its collapsed group, even when it was already the current one', async () => {
  const a = appState()
  a.state.factories = [factory(), factory({ id: 'f2', name: 'site', key: 'MS', position: 1 })]
  a.state.layout = {
    items: [{ group: { id: 'acme', name: 'Acme', factoryIds: ['f1'] } }, { factoryId: 'f2' }],
  }
  a.mount()
  const u = user()
  const acme = await within(nav()).findByRole('region', { name: 'Acme' })
  await within(acme).findByRole('article', { name: 'widgets' })
  fireEvent.keyDown(window, { key: '1', metaKey: true })
  await screen.findByRole('heading', { name: /widgets.*Dashboard/ })
  await u.click(within(acme).getByRole('button', { name: 'Acme' }))
  expect(within(acme).queryByRole('article', { name: 'widgets' })).toBeNull()
  await u.click(within(nav()).getByRole('button', { name: /^Inbox/ }))
  expect(within(acme).queryByRole('article', { name: 'widgets' })).toBeNull()
  fireEvent.keyDown(window, { key: '1', metaKey: true })
  await within(acme).findByRole('article', { name: 'widgets' })
})

test('Factory groups: New group from the + menu, Move to group, collapse and Ungroup', async () => {
  const a = appState()
  a.state.factories = [factory(), factory({ id: 'f2', name: 'site', key: 'MS', position: 1 })]
  a.handle('saveFactoryLayout', (layout) => {
    a.state.layout = layout as FactoryLayout
    a.emit({ type: 'factory-layout-changed', layout: a.state.layout })
    return a.state.layout
  })
  a.mount()
  const u = user()
  await screen.findByRole('article', { name: 'widgets' })
  await u.click(within(nav()).getByRole('button', { name: 'New Factory or group' }))
  await u.click(screen.getByRole('menuitem', { name: 'New group' }))
  await u.type(screen.getByLabelText('Group name'), 'Acme{Enter}')
  const saved = a.request.mock.calls.filter(([name]) => name === 'saveFactoryLayout')
  const created = (required(saved.at(-1))[1] as FactoryLayout).items[0]
  expect(created).toMatchObject({ group: { name: 'Acme', factoryIds: [] } })
  const groupId = created && 'group' in created ? created.group.id : ''
  const acme = await within(nav()).findByRole('region', { name: 'Acme' })
  expect(within(acme).getByText('Drag a Factory here')).toBeTruthy()

  fireEvent.contextMenu(screen.getByRole('article', { name: 'site' }))
  await u.click(screen.getByRole('menuitem', { name: 'Move to group…' }))
  await u.click(screen.getByRole('menuitemradio', { name: 'Acme' }))
  expect(a.state.layout).toEqual({
    items: [{ group: { id: groupId, name: 'Acme', factoryIds: ['f2'] } }, { factoryId: 'f1' }],
  })
  expect(within(acme).getByRole('article', { name: 'site' })).toBeTruthy()

  await u.click(within(acme).getByRole('button', { name: 'Acme' }))
  expect(within(acme).queryByRole('article', { name: 'site' })).toBeNull()

  fireEvent.contextMenu(within(acme).getByRole('article', { name: 'Acme' }))
  await u.click(screen.getByRole('menuitem', { name: 'Ungroup' }))
  expect(a.state.layout).toEqual({ items: [{ factoryId: 'f2' }, { factoryId: 'f1' }] })
  expect(within(nav()).queryByRole('region', { name: 'Acme' })).toBeNull()
})
