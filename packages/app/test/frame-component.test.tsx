// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { appState } from './support/app.tsx'
import { required, user } from './support/component.ts'
import { factory } from './support/fixtures.ts'

const nav = () => screen.getByRole('navigation', { name: 'Sidebar' })

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

test('sidebar and view header open New Task', async () => {
  const a = appState()
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  await u.click(within(nav()).getByRole('button', { name: 'New Task' }))
  await screen.findByRole('dialog', { name: 'New Task' })
  await u.click(screen.getByRole('button', { name: 'Close' }))
  await u.click(
    required(within(screen.getByRole('main')).getAllByRole('button', { name: 'New Task' })[0]),
  )
  expect(screen.getByRole('dialog', { name: 'New Task' })).toBeTruthy()
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
  expect(document.activeElement).toBe(within(dialog).getByLabelText('Description'))
  expect((within(dialog).getByLabelText('Factory') as HTMLSelectElement).value).toBe('f1')
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  fireEvent.keyDown(window, { key: 'c' })
  dialog = screen.getByRole('dialog', { name: 'New Task' })
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
