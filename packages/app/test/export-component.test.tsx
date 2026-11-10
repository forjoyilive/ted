// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ConnectionContext } from '../src/renderer/data.ts'
import { ExportGroup } from '../src/renderer/settings/ExportGroup.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { factory } from './support/fixtures.ts'

test('chooses Factory/format, prevents duplicate saves, and reports success and cancellation', async () => {
  const result = deferred<{ canceled: false; path: string; tasks: number }>()
  const api = bridge({
    listFactories: () => [factory(), factory({ id: 'f2', name: 'Second' })],
    exportFactory: () => result.promise,
  })
  render(<ExportGroup />)
  await screen.findByRole('combobox', { name: 'Factory' })
  const u = user()
  await u.selectOptions(screen.getByRole('combobox', { name: 'Factory' }), 'f2')
  await u.selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'markdown')
  await u.click(screen.getByRole('button', { name: 'Export…' }))
  expect(api.request).toHaveBeenCalledWith('exportFactory', 'f2', 'markdown')
  expect(screen.getByRole('button', { name: 'Exporting…' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: 'Factory' }).hasAttribute('disabled')).toBe(true)
  await act(async () => result.resolve({ canceled: false, path: '/chosen/export.md', tasks: 2 }))
  expect(screen.getByRole('status').textContent).toContain('Exported 2 Tasks to /chosen/export.md')
  api.handle('exportFactory', () => ({ canceled: true }))
  await u.click(screen.getByRole('button', { name: 'Export…' }))
  expect(screen.getByRole('status').textContent).toBe('')
})

test.each([
  ['Disk full', 'Disk full'],
  [
    "Error invoking remote method 'ted:request': Error: That destination already exists. Choose a new filename.",
    'That destination already exists. Choose a new filename.',
  ],
  [
    "Error invoking remote method 'ted:request': DaemonRequestError: Not authorized",
    'Not authorized',
  ],
])('save errors retain choices and can be retried: %s', async (failure, expected) => {
  const api = bridge({
    listFactories: () => [factory()],
    exportFactory: () => {
      throw new Error(failure)
    },
  })
  render(<ExportGroup />)
  await screen.findByRole('combobox', { name: 'Factory' })
  await user().selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'markdown')
  await user().click(screen.getByRole('button', { name: 'Export…' }))
  expect((await screen.findByRole('alert')).textContent).toBe(expected)
  api.handle('exportFactory', () => ({ canceled: true }))
  await user().click(screen.getByRole('button', { name: 'Export…' }))
  expect(api.request).toHaveBeenLastCalledWith('exportFactory', 'f1', 'markdown')
  expect(screen.queryByRole('alert')).toBeNull()
})

test('loads again after a connection epoch, handles an empty Factory list and failed loading', async () => {
  const api = bridge({ listFactories: () => [] })
  const view = render(
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch: 0 }}>
      <ExportGroup />
    </ConnectionContext>,
  )
  await screen.findByText('Add a Factory to export its work.')
  expect(screen.queryByRole('button', { name: 'Export…' })).toBeNull()
  api.handle('listFactories', () => {
    throw new Error("Error invoking remote method 'ted:request': Error: Disconnected")
  })
  view.rerender(
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch: 1 }}>
      <ExportGroup />
    </ConnectionContext>,
  )
  await screen.findByText('Couldn’t load Factories')
  expect(screen.getByRole('alert').textContent).toBe('Disconnected')
  api.handle('listFactories', () => [factory()])
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('combobox', { name: 'Factory' })
  expect(screen.queryByRole('alert')).toBeNull()
})
