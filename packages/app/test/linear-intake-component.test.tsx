// @vitest-environment jsdom
import { defaultMachineSettings, type LinearIntakeScope } from '@ted/protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { LinearIntakeSection } from '../src/renderer/views/LinearIntakeSection.tsx'
import { bridge, deferred, user } from './support/component.ts'

const scope: LinearIntakeScope = {
  kind: 'team',
  id: 'team-one',
  name: 'One',
  workspaceId: 'workspace-acme',
  workspace: 'acme',
}
const choices = {
  workspaceId: 'workspace-acme',
  workspace: 'acme',
  teams: [{ id: 'team-one', name: 'One', key: 'ONE' }],
  projects: [{ id: 'project-one', name: 'Product' }],
}

function setup(
  saved?: LinearIntakeScope,
  overrides: Record<string, (...args: unknown[]) => unknown> = {},
) {
  let settings = { ...defaultMachineSettings, linearIntakeScopes: saved ? { f: saved } : {} }
  const save = vi.fn(async (_factory: unknown, scope: unknown) => {
    settings = {
      ...settings,
      linearIntakeScopes: scope === null ? {} : { f: scope as LinearIntakeScope },
    }
    api.emit({ type: 'settings-changed', settings })
    return settings
  })
  const api = bridge({
    getSettings: () => settings,
    getLinear: () => ({ state: 'connected' }),
    getLinearIntakeChoices: () => choices,
    setFactoryLinearIntake: save,
    ...overrides,
  })
  render(<LinearIntakeSection factoryId="f" />)
  return { ...api, save }
}

const field = (label: string) => screen.getByLabelText(label) as HTMLSelectElement

test('saves only a complete selection and restores it through settings events', async () => {
  const { save } = setup()
  await waitFor(() => expect(field('Scope').value).toBe('none'))
  fireEvent.change(field('Scope'), { target: { value: 'project' } })
  expect(save).not.toHaveBeenCalled()
  await user().selectOptions(field('Project'), 'project-one')
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith('f', {
      kind: 'project',
      id: 'project-one',
      name: 'Product',
      workspaceId: 'workspace-acme',
      workspace: 'acme',
    }),
  )
  await waitFor(() => expect(field('Project').value).toBe('project-one'))
  await user().selectOptions(field('Scope'), 'none')
  await waitFor(() => expect(save).toHaveBeenLastCalledWith('f', null))
  await waitFor(() => expect(field('Scope').value).toBe('none'))
  expect(screen.queryByLabelText('Project')).toBeNull()
})

test('while loading and without a key, shows only the connect line with the saved scope', async () => {
  const pending = deferred<{ state: string }>()
  setup(scope, { getLinear: () => pending.promise })
  await screen.findByText('Loading Linear Teams and Projects…')
  expect(screen.queryByLabelText('Scope')).toBeNull()
  pending.resolve({ state: 'no-key' })
  await screen.findByText(
    'Connect Linear in App Settings → Integrations to choose a Team or Project. The saved scope (Team: One · acme) stays in effect.',
  )
  expect(screen.queryByLabelText('Scope')).toBeNull()
})

test('shows a retained inaccessible target, empty choices, and retry after a connection failure', async () => {
  const { handle } = setup(scope, {
    getLinearIntakeChoices: () => {
      throw new Error('Network unavailable')
    },
  })
  await screen.findByText(/Network unavailable/)
  expect(screen.getByText('One (saved; unavailable)')).toBeTruthy()
  handle('getLinearIntakeChoices', () => ({ ...choices, teams: [] }))
  await user().click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByText('No accessible Teams found.')
  expect(field('Team').value).toBe('saved-unavailable')
})

test('a failed save keeps the persisted scope and allows retrying Unscoped', async () => {
  const { handle } = setup(scope, {
    setFactoryLinearIntake: () => {
      throw new Error('Save unavailable')
    },
  })
  await waitFor(() => expect(field('Team').value).toBe('team-one'))
  await user().selectOptions(field('Scope'), 'none')
  await screen.findByRole('alert')
  expect(field('Scope').value).toBe('team')
  expect(field('Team').value).toBe('team-one')
  const again = vi.fn(() => defaultMachineSettings)
  handle('setFactoryLinearIntake', again)
  await user().selectOptions(field('Scope'), 'none')
  await waitFor(() => expect(again).toHaveBeenCalledWith('f', null))
})
