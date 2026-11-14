// @vitest-environment jsdom
import {
  type AsanaChoicesPage,
  type AsanaIntakeCheck,
  type AsanaIntakeScope,
  type AsanaRef,
  defaultMachineSettings,
} from '@ted/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AsanaIntakeSection } from '../src/renderer/views/AsanaIntakeSection.tsx'
import { bridge, deferred, user } from './support/component.ts'

const acme = { gid: '1', name: 'Acme' }
const roadmap = { gid: '9', name: 'Roadmap' }
const now = { gid: '91', name: 'Now' }
const saved: AsanaIntakeScope = { workspace: acme, project: roadmap, section: now }

function paged(items: AsanaRef[], size: number) {
  return (offset?: unknown): AsanaChoicesPage => {
    const start = Number(typeof offset === 'string' ? offset : '0')
    const next = start + size
    return {
      items: items.slice(start, next),
      ...(next < items.length && { nextOffset: String(next) }),
    }
  }
}

const many = (prefix: string, count: number, from: number) =>
  Array.from({ length: count }, (_, i) => ({
    gid: String(from + i),
    name: `${prefix} ${String(i + 1).padStart(3, '0')}`,
  }))

function setup(
  scope: AsanaIntakeScope | undefined,
  overrides: Record<string, (...args: unknown[]) => unknown> = {},
) {
  let settings = { ...defaultMachineSettings, asanaIntakeScopes: scope ? { f: scope } : {} }
  const save = vi.fn(async (_factory: unknown, next: unknown) => {
    settings = {
      ...settings,
      asanaIntakeScopes: next === null ? {} : { f: next as AsanaIntakeScope },
    }
    api.emit({ type: 'settings-changed', settings })
    return settings
  })
  const api = bridge({
    getSettings: () => settings,
    getAsana: () => ({ state: 'connected', configured: true, redirectUri: '' }),
    checkFactoryAsanaIntake: (): AsanaIntakeCheck =>
      settings.asanaIntakeScopes.f
        ? { state: 'current', scope: settings.asanaIntakeScopes.f }
        : { state: 'none' },
    listAsanaWorkspaces: paged([...many('Workspace', 2, 100), acme], 2),
    listAsanaProjects: (_workspace: unknown, offset?: unknown) =>
      paged([...many('Project', 150, 1000), roadmap], 100)(offset),
    listAsanaSections: (_project: unknown, offset?: unknown) =>
      paged([now, { gid: '92', name: 'Later' }], 100)(offset),
    setFactoryAsanaIntake: save,
    ...overrides,
  })
  render(<AsanaIntakeSection factoryId="f" />)
  return { ...api, save }
}

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

test('pages through long lists and saves a project without, then with, a section', async () => {
  const { save } = setup(undefined)
  await screen.findByText('Saved: Off')
  await user().click(screen.getByRole('switch', { name: 'Import Asana work into this Factory' }))
  await screen.findByText('Showing 2 workspaces.')
  expect(within(select('Workspace')).queryByText('Acme')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Load more workspaces' }))
  await waitFor(() => expect(within(select('Workspace')).getByText('Acme')).toBeTruthy())
  expect(screen.queryByRole('button', { name: 'Load more workspaces' })).toBeNull()
  await user().selectOptions(select('Workspace'), '1')
  await screen.findByText('Showing 100 projects.')
  expect(saveButton().disabled).toBe(true)
  await user().click(screen.getByRole('button', { name: 'Load more projects' }))
  await waitFor(() => expect(select('Project').options.length).toBe(152))
  await user().selectOptions(select('Project'), '9')
  await waitFor(() => expect(within(select('Section (optional)')).getByText('Later')).toBeTruthy())
  expect(select('Section (optional)').value).toBe('')
  await user().click(saveButton())
  await screen.findByText('Saved: Roadmap · Acme')
  expect(save).toHaveBeenLastCalledWith('f', { workspace: acme, project: roadmap })

  await user().selectOptions(await screen.findByLabelText('Section (optional)'), '91')
  await user().click(saveButton())
  await screen.findByText('Saved: Roadmap › Now · Acme')
  expect(save).toHaveBeenLastCalledWith('f', saved)

  await user().click(screen.getByRole('switch', { name: 'Import Asana work into this Factory' }))
  await user().click(saveButton())
  await screen.findByText('Saved: Off')
  expect(save).toHaveBeenLastCalledWith('f', null)
})

test('a failed read keeps the saved values, and a failed save leaves them as they were', async () => {
  const unreadable = () => {
    throw new Error('Couldn’t read Asana: Asana returned 503.')
  }
  const { handle, save } = setup(saved, {
    checkFactoryAsanaIntake: () => ({ state: 'unreadable', reason: 'Asana returned 503.' }),
    listAsanaWorkspaces: unreadable,
    listAsanaProjects: unreadable,
    listAsanaSections: unreadable,
  })
  await screen.findAllByRole('alert')
  expect(screen.getByText(/The saved choice stays as it was/)).toBeTruthy()
  expect(select('Workspace').value).toBe('1')
  expect(select('Workspace').disabled).toBe(true)
  expect(within(select('Project')).getByText('Roadmap (saved)')).toBeTruthy()
  expect(within(select('Section (optional)')).getByText('Now (saved)')).toBeTruthy()
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByText('Saved: Roadmap › Now · Acme')).toBeTruthy()

  handle('checkFactoryAsanaIntake', () => ({ state: 'current', scope: saved }))
  handle('listAsanaWorkspaces', paged([acme], 100))
  handle('listAsanaProjects', () => paged([roadmap], 100)())
  handle('listAsanaSections', () => paged([now, { gid: '92', name: 'Later' }], 100)())
  handle('setFactoryAsanaIntake', () => {
    throw new Error('Couldn’t confirm the Asana intake choice with Asana: Asana returned 503.')
  })
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(select('Section (optional)').disabled).toBe(false))
  await user().selectOptions(select('Section (optional)'), '92')
  await user().click(saveButton())
  await screen.findByText(/Couldn’t confirm the Asana intake choice/)
  expect(screen.getByText('Saved: Roadmap › Now · Acme')).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
})

test('a stale saved project shows as stale and can’t be saved again as it is', async () => {
  const { save, request } = setup(saved, {
    checkFactoryAsanaIntake: () => ({
      state: 'stale',
      part: 'project',
      reason: 'Roadmap is archived',
    }),
    listAsanaProjects: () => paged([{ gid: '8', name: 'Other' }], 100)(),
  })
  await screen.findByText(/The saved project is out of date: Roadmap is archived/)
  await waitFor(() =>
    expect(within(select('Project')).getByText('Roadmap (saved; no longer in Asana)')).toBeTruthy(),
  )
  expect(screen.queryByLabelText('Section (optional)')).toBeNull()
  expect(saveButton().disabled).toBe(true)
  expect(request.mock.calls.some(([name]) => name === 'listAsanaSections')).toBe(false)
  expect(screen.queryByText(/Couldn’t read Asana/)).toBeNull()
  await user().selectOptions(select('Project'), '8')
  expect(screen.queryByText(/The saved project is out of date/)).toBeNull()
  expect(saveButton().disabled).toBe(false)
  await user().click(saveButton())
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith('f', {
      workspace: acme,
      project: { gid: '8', name: 'Other' },
    }),
  )
})

test('a late page from the previous workspace doesn’t replace the new workspace’s projects', async () => {
  const late = deferred<AsanaChoicesPage>()
  setup(undefined, {
    listAsanaWorkspaces: () => ({ items: [acme, { gid: '2', name: 'Elsewhere' }] }),
    listAsanaProjects: (workspace: unknown, offset: unknown) =>
      workspace === '2'
        ? { items: [{ gid: '20', name: 'Two' }] }
        : offset === undefined
          ? { items: [roadmap], nextOffset: '1' }
          : late.promise,
  })
  await user().click(
    await screen.findByRole('switch', { name: 'Import Asana work into this Factory' }),
  )
  await waitFor(() => expect(within(select('Workspace')).getByText('Acme')).toBeTruthy())
  await user().selectOptions(select('Workspace'), '1')
  await user().click(await screen.findByRole('button', { name: 'Load more projects' }))
  await user().selectOptions(select('Workspace'), '2')
  await waitFor(() => expect(within(select('Project')).getByText('Two')).toBeTruthy())
  late.resolve({ items: [{ gid: '10', name: 'Late' }] })
  await late.promise
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(within(select('Project')).queryByText('Late')).toBeNull()
  expect(within(select('Project')).getByText('Two')).toBeTruthy()
  expect(select('Project').disabled).toBe(false)
  expect(screen.queryByText('Loading projects…')).toBeNull()
})

test('a list that fails after an edit disables every picker and Save, and shows the reason once', async () => {
  const message = 'Couldn’t read Asana: Asana couldn’t find it. The saved choice stays as it was.'
  setup(saved, {
    listAsanaProjects: () => ({ items: [roadmap, { gid: '8', name: 'Other' }] }),
    listAsanaSections: (project: unknown) => {
      if (project === '8') throw new Error(message)
      return { items: [now] }
    },
  })
  await waitFor(() => expect(within(select('Project')).getByText('Other')).toBeTruthy())
  await user().selectOptions(select('Project'), '8')
  await screen.findByText(message)
  expect(select('Workspace').disabled).toBe(true)
  expect(select('Project').disabled).toBe(true)
  expect(select('Section (optional)').disabled).toBe(true)
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
})

test('an Asana connection error shows its reason and can be tried again', async () => {
  const { handle } = setup(saved, {
    getAsana: () => ({
      state: 'error',
      configured: true,
      redirectUri: '',
      error: 'Unlock your keyring to use Asana.',
    }),
  })
  await screen.findByText(/Asana: Unlock your keyring to use Asana\. The saved choice stays/)
  expect(screen.queryByText(/Connect Asana in App Settings/)).toBeNull()
  handle('getAsana', () => ({ state: 'connected', configured: true, redirectUri: '' }))
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(select('Project').value).toBe('9'))
})

test('a stale check that answers after the lists shows no read error and leaves Project usable', async () => {
  const check = deferred<AsanaIntakeCheck>()
  const { request } = setup(saved, {
    checkFactoryAsanaIntake: () => check.promise,
    listAsanaProjects: () => ({ items: [{ gid: '8', name: 'Other' }] }),
    listAsanaSections: () => {
      throw new Error(
        'Couldn’t read Asana: Asana couldn’t find it. The saved choice stays as it was.',
      )
    },
  })
  await waitFor(() => expect(within(select('Workspace')).getByText('Acme')).toBeTruthy())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const listed = (name: string) => request.mock.calls.some(([called]) => called === name)
  expect(listed('listAsanaProjects')).toBe(false)
  expect(listed('listAsanaSections')).toBe(false)
  check.resolve({ state: 'stale', part: 'project', reason: 'Roadmap is archived' })
  await screen.findByText(/The saved project is out of date/)
  await waitFor(() => expect(within(select('Project')).getByText('Other')).toBeTruthy())
  expect(select('Project').disabled).toBe(false)
  expect(listed('listAsanaSections')).toBe(false)
  expect(screen.queryByText(/Couldn’t read Asana/)).toBeNull()
})
