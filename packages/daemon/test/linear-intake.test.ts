import { defaultMachineSettings, type LinearIntakeScope, parseLinearUrl } from '@ted/protocol'
import { expect, test } from 'vitest'
import { createLinear } from '../src/linear/linear.ts'
import { verifyLinearIntake } from '../src/tasks/linear-intake.ts'
import { startStubLinear } from './fixtures/stub-linear.ts'

const url = 'https://linear.app/acme/issue/NB-1'
const scope: LinearIntakeScope = {
  kind: 'project',
  id: 'project-one',
  name: 'One',
  workspace: 'acme',
  workspaceId: 'workspace-acme',
}
const membership = {
  workspace: 'acme',
  workspaceId: 'workspace-acme',
  teamId: 'team-NB',
  projectId: 'project-one',
}

test('rejects scope changes during membership lookup and before commit', async () => {
  let current = scope
  const store = {
    settings: () => ({ ...defaultMachineSettings, linearIntakeScopes: { f: current } }),
  }
  await expect(
    verifyLinearIntake(
      store,
      {
        intakeMembership: async () => {
          current = { ...scope, id: 'project-two' }
          return membership
        },
      },
      'f',
      url,
    ),
  ).rejects.toThrow('scope changed')
  current = scope
  const check = await verifyLinearIntake(
    store,
    { intakeMembership: async () => membership },
    'f',
    url,
  )
  current = { ...scope, id: 'project-two' }
  expect(check).toThrow('scope changed')
})

test.each([
  { ...membership, workspaceId: 'different' },
  { ...membership, workspace: 'elsewhere' },
  { ...membership, projectId: null },
  { ...membership, projectId: 'different' },
])('rejects membership outside the scope: %j', async (result) => {
  const store = {
    settings: () => ({ ...defaultMachineSettings, linearIntakeScopes: { f: scope } }),
  }
  await expect(
    verifyLinearIntake(store, { intakeMembership: async () => result }, 'f', url),
  ).rejects.toThrow('outside this Factory')
})

const teamScope: LinearIntakeScope = { ...scope, kind: 'team', id: 'team-NB', name: 'Widgets' }

test.each([
  { scope: teamScope, result: membership, accepted: true },
  { scope: teamScope, result: { ...membership, projectId: 'project-two' }, accepted: true },
  { scope: teamScope, result: { ...membership, projectId: null }, accepted: true },
  { scope: teamScope, result: { ...membership, teamId: 'team-OT' }, accepted: false },
  {
    scope: teamScope,
    result: { ...membership, teamId: 'team-OT', projectId: null },
    accepted: false,
  },
  { scope: teamScope, result: { ...membership, workspaceId: 'different' }, accepted: false },
  { scope, result: { ...membership, teamId: 'team-OT' }, accepted: true },
  { scope, result: { ...membership, projectId: 'project-two' }, accepted: false },
])('a team or project scope checks only its own kind of membership: %j', async (row) => {
  const store = {
    settings: () => ({ ...defaultMachineSettings, linearIntakeScopes: { f: row.scope } }),
  }
  const check = verifyLinearIntake(store, { intakeMembership: async () => row.result }, 'f', url)
  if (row.accepted) expect(await check).toBeTypeOf('function')
  else
    await expect(check).rejects.toThrow(
      `NB-1 is outside this Factory’s Linear intake scope (${row.scope.kind}: ${row.scope.name})`,
    )
})

test('does not apply Linear scope to another source or to an unscoped Factory', async () => {
  const store = {
    settings: () => ({ ...defaultMachineSettings, linearIntakeScopes: { f: scope } }),
  }
  expect(await verifyLinearIntake(store, undefined, 'other', url)).toBeTypeOf('function')
  expect(
    await verifyLinearIntake(store, undefined, 'f', 'https://github.com/acme/widgets/issues/1'),
  ).toBeTypeOf('function')
})

test('fresh Linear membership reads observe Project moves and reject incomplete metadata', async () => {
  const key = 'lin_api_fake_key_for_scope_tests'
  const issue = { identifier: 'NB-1', title: 'First', projectId: 'project-one' }
  const account = {
    name: 'Test',
    workspace: { name: 'Acme', urlKey: 'acme' },
    issues: [issue],
    intakeMalformed: false,
  }
  const stub = await startStubLinear({ [key]: account })
  try {
    const linear = createLinear({
      keyring: {
        kind: 'macos-keychain',
        get: async () => key,
        set: async () => {},
        delete: async () => {},
      },
      keyFile: '/unused-test-key',
      apiUrl: stub.url,
    })
    const link = parseLinearUrl(url)
    if (!link) throw new Error('invalid test URL')
    expect(await linear.intakeMembership(link)).toEqual(membership)
    issue.projectId = 'project-two'
    expect((await linear.intakeMembership(link)).projectId).toBe('project-two')
    account.intakeMalformed = true
    await expect(linear.intakeMembership(link)).rejects.toThrow('incomplete issue scope')
    expect(
      stub.requests.filter((request) => request.query.includes('TedIntakeMembership')),
    ).toHaveLength(3)
  } finally {
    await stub.close()
  }
})
