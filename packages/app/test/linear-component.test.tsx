// @vitest-environment jsdom
import type { LinearLookup } from '@ted/protocol'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { NewTaskDialog } from '../src/renderer/views/NewTaskDialog.tsx'
import { bridge, draftHandlers, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

const url = 'https://linear.app/kriyadesign/issue/NOTE-212/search-ignores-accents'
const found: LinearLookup = {
  state: 'found',
  issue: {
    url,
    identifier: 'NOTE-212',
    title: 'Search ignores accents',
    priority: 'high',
    branchName: 'nabha/note-212-search-ignores-accents',
    description: 'Typing “cafe” should find “Café”.',
  },
}

async function open(lookup: LinearLookup) {
  const create = vi.fn((..._args: unknown[]) => task())
  const save = vi.fn((..._args: unknown[]) => ({ state: 'connected' }))
  let result = lookup
  const api = bridge({
    ...draftHandlers(),
    taskDefaults: () => ({ clarifyDepth: 'auto', lead: { agent: 'claude' } }),
    lookupLinear: () => result,
    createTask: create,
    saveLinearKey: (...args) => {
      save(...args)
      result = found
      return { state: 'connected', storedIn: 'keyring' }
    },
  })
  render(<NewTaskDialog factories={[factory()]} tasks={[]} factoryId="f1" onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('Description').matches(':disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: url } })
  return { create, save, ...api }
}

test('Linear lookup fills title and Priority, previews description and submits the source URL', async () => {
  const { create, request } = await open(found)
  await screen.findByText('NOTE-212 · Search ignores accents')
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Search ignores accents')
  expect((screen.getByLabelText('Priority') as HTMLSelectElement).value).toBe('high')
  expect(request).toHaveBeenCalledWith('lookupLinear', url)
  await user().click(screen.getByRole('button', { name: 'Show Linear’s description' }))
  expect(
    within(screen.getByLabelText('Linear’s description')).getByText(
      'Typing “cafe” should find “Café”.',
    ),
  ).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Create' }))
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ source: url, title: 'Search ignores accents', priority: 'high' }),
  )
})

test('removing the source leaves the description but omits source from create', async () => {
  const { create } = await open(found)
  await screen.findByText('NOTE-212 · Search ignores accents')
  await user().click(screen.getByRole('button', { name: 'Remove source' }))
  expect(screen.queryByRole('group', { name: 'Source' })).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Create' }))
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty('source')
})

test('without a key Create keeps the link without blocking', async () => {
  const { create } = await open({ state: 'no-key' })
  await screen.findByText(/^Add a Linear API key/)
  await user().click(screen.getByRole('button', { name: 'Create' }))
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ source: url, description: url }))
})

test('inline Save stores the entered key and immediately repeats lookup', async () => {
  const { request } = await open({ state: 'no-key' })
  await screen.findByText(/^Add a Linear API key/)
  await user().type(
    screen.getByLabelText('Linear API key'),
    'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  )
  await user().click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('NOTE-212 · Search ignores accents')
  expect(request).toHaveBeenCalledWith(
    'saveLinearKey',
    'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    false,
  )
  expect(request.mock.calls.filter(([name]) => name === 'lookupLinear')).toHaveLength(2)
})

test('failed lookup explains the problem and preserves the source link', async () => {
  const { create } = await open({
    state: 'failed',
    error:
      'Couldn’t fetch from Linear: NOTE-212 is unavailable. The Task will be created with the link only.',
  })
  await screen.findByText(/Couldn’t fetch from Linear/)
  expect(within(screen.getByRole('group', { name: 'Source' })).getByText('NOTE-212')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Create' }))
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ source: url }))
})

test('Linear Sync switch and declined-team Allow send machine settings', async () => {
  const { LinearGroup } = await import('../src/renderer/settings/LinearGroup.tsx')
  const api = bridge({
    listFactories: () => [factory()],
    getLinear: () => ({
      state: 'connected',
      keyring: 'macos-keychain',
      storedIn: 'keyring',
      last4: 'ABCD',
      user: 'Nabha',
      workspace: 'Kriya Design',
    }),
    tedFolder: () => ({ path: '/test/' }),
    updateSettings: vi.fn(),
    allowLinearTeam: vi.fn(),
  })
  const view = render(<LinearGroup sync teams={{}} declined={{ f1: ['NOTE'] }} />)
  await screen.findByText('Connected as Nabha · Kriya Design')
  const toggle = screen.getByRole('switch', { name: 'Sync status with Linear' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await user().click(toggle)
  expect(api.request).toHaveBeenCalledWith('updateSettings', { linearSync: false })
  view.rerender(<LinearGroup sync={false} teams={{}} declined={{ f1: ['NOTE'] }} />)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  view.rerender(<LinearGroup sync teams={{}} declined={{ f1: ['NOTE'] }} />)
  await user().click(screen.getByRole('button', { name: 'Allow NOTE for Automations in widgets' }))
  expect(api.request).toHaveBeenCalledWith('allowLinearTeam', 'f1', 'NOTE')
  view.rerender(<LinearGroup sync teams={{ f1: ['NOTE'] }} declined={{}} />)
  expect(screen.queryByText(/You chose Not now/)).toBeNull()
  expect(
    (screen.getByLabelText('Linear teams for Automations in widgets') as HTMLInputElement).value,
  ).toBe('NOTE')
})

test('Linear source images render from attachment bytes and retain the source on create', async () => {
  if (found.state !== 'found') throw new Error('missing issue fixture')
  const file = {
    hash: 'hash1',
    name: 'search results.gif',
    mediaType: 'image/gif',
    size: 12,
    url: 'https://uploads.example.test/file',
  }
  const create = vi.fn((..._args: unknown[]) => task())
  const api = bridge({
    ...draftHandlers(),
    taskDefaults: () => ({ clarifyDepth: 'auto', lead: { agent: 'claude' } }),
    lookupLinear: () => ({ ...found, issue: { ...found.issue, files: [file] } }),
    readAttachment: () => ({ data: 'R0lGODlhAQABAAAAADs=' }),
    createTask: create,
  })
  render(<NewTaskDialog factories={[factory()]} tasks={[]} factoryId="f1" onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('Description').matches(':disabled')).toBe(false))
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: url } })
  const image = await screen.findByRole('img', { name: 'search results.gif' })
  expect(image.getAttribute('src')).toBe('data:image/gif;base64,R0lGODlhAQABAAAAADs=')
  expect(api.request).toHaveBeenCalledWith('readAttachment', 'hash1', 'search results.gif')
  await user().click(screen.getByRole('button', { name: 'Create' }))
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ source: url }))
})

test('Linear key Save, masking, Test errors and Remove update the connected row', async () => {
  const { LinearGroup } = await import('../src/renderer/settings/LinearGroup.tsx')
  const api = bridge({
    listFactories: () => [],
    getLinear: () => ({ state: 'no-key', keyring: 'macos-keychain' }),
    tedFolder: () => ({ path: '/test/' }),
    saveLinearKey: () => ({
      state: 'connected',
      storedIn: 'keyring',
      keyring: 'macos-keychain',
      last4: 'ABCD',
      user: 'Nabha',
      workspace: 'Kriya Design',
    }),
    testLinear: () => ({
      state: 'invalid',
      storedIn: 'keyring',
      keyring: 'macos-keychain',
      last4: 'ABCD',
      error: 'Linear didn’t accept this key',
    }),
    removeLinearKey: () => ({ state: 'no-key', keyring: 'macos-keychain' }),
  })
  render(<LinearGroup sync teams={{}} declined={{}} />)
  await screen.findByText('No API key')
  await user().type(screen.getByLabelText('Linear API key'), 'lin_api_fixtureABCD')
  await user().click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Connected as Nabha · Kriya Design')
  expect((screen.getByLabelText('Linear API key') as HTMLInputElement).value).toMatch(/•+ABCD$/)
  expect(screen.getByText(/stored in the macOS Keychain/)).toBeTruthy()
  expect(api.request).toHaveBeenCalledWith('saveLinearKey', 'lin_api_fixtureABCD', false)
  await user().click(screen.getByRole('button', { name: 'Test' }))
  await screen.findByText('Linear didn’t accept this key')
  await user().click(screen.getByRole('button', { name: 'Remove' }))
  await screen.findByText('No API key')
  expect(api.request).toHaveBeenCalledWith('removeLinearKey')
})

test('without a keyring, saving a Linear key requires the explicit file button', async () => {
  const { LinearGroup } = await import('../src/renderer/settings/LinearGroup.tsx')
  const api = bridge({
    listFactories: () => [],
    getLinear: () => ({ state: 'no-keyring', keyring: 'secret-service' }),
    tedFolder: () => ({ path: '/test/' }),
    saveLinearKey: () => ({
      state: 'connected',
      storedIn: 'file',
      keyring: 'secret-service',
      user: 'Nabha',
      workspace: 'Kriya Design',
    }),
  })
  render(<LinearGroup sync teams={{}} declined={{}} />)
  await screen.findByText('No keyring found on this computer')
  await user().type(screen.getByLabelText('Linear API key'), 'lin_api_fixture')
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Save in a file only you can read' }))
  expect(api.request).toHaveBeenCalledWith('saveLinearKey', 'lin_api_fixture', true)
  await screen.findByText('Connected as Nabha · Kriya Design')
  expect(screen.getByText(/stored in .*secrets\/linear-api-key/)).toBeTruthy()
})
