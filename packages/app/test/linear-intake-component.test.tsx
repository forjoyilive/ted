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

test('saves only a complete selection and restores it through settings events', async () => {
  const { save } = setup()
  await screen.findByText('Saved scope: Unscoped')
  await waitFor(() => expect(screen.queryByText('Loading Linear Teams and Projects…')).toBeNull())
  fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'project' } })
  expect(save).not.toHaveBeenCalled()
  await user().selectOptions(screen.getByLabelText('Project'), 'project-one')
  await screen.findByText('Saved scope: Project: Product · acme')
  expect(save).toHaveBeenCalledWith('f', {
    kind: 'project',
    id: 'project-one',
    name: 'Product',
    workspaceId: 'workspace-acme',
    workspace: 'acme',
  })
  await user().selectOptions(screen.getByLabelText('Scope'), 'none')
  await screen.findByText('Saved scope: Unscoped')
  expect(save).toHaveBeenLastCalledWith('f', null)
})

test('keeps a saved scope during loading and permits clearing it without a key', async () => {
  const pending = deferred<{ state: string }>()
  const { save } = setup(scope, { getLinear: () => pending.promise })
  await screen.findByText('Saved scope: Team: One · acme')
  expect((screen.getByLabelText('Team') as HTMLSelectElement).disabled).toBe(true)
  pending.resolve({ state: 'no-key' })
  await screen.findByText(/Connect Linear in App Settings/)
  await user().selectOptions(screen.getByLabelText('Scope'), 'none')
  await screen.findByText('Saved scope: Unscoped')
  expect(save).toHaveBeenCalledWith('f', null)
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
  expect(screen.getByText('Saved scope: Team: One · acme')).toBeTruthy()
})

test('a failed save keeps the persisted scope and allows retrying Unscoped', async () => {
  const { handle } = setup(scope, {
    setFactoryLinearIntake: () => {
      throw new Error('Save unavailable')
    },
  })
  await screen.findByText('Saved scope: Team: One · acme')
  await user().selectOptions(screen.getByLabelText('Scope'), 'none')
  await screen.findByRole('alert')
  expect((screen.getByLabelText('Scope') as HTMLSelectElement).value).toBe('team')
  expect(screen.getByText('Saved scope: Team: One · acme')).toBeTruthy()
  const again = vi.fn(() => defaultMachineSettings)
  handle('setFactoryLinearIntake', again)
  await user().selectOptions(screen.getByLabelText('Scope'), 'none')
  await waitFor(() => expect(again).toHaveBeenCalledWith('f', null))
})
