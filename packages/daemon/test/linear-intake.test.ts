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

test('intake choices are read once per key within the cache time, and again after a key change', async () => {
  const key = 'lin_api_fake_key_for_choice_tests'
  const other = 'lin_api_other_key_for_choice_tests'
  const account = {
    name: 'Test',
    workspace: { name: 'Acme', urlKey: 'acme' },
    teams: [{ id: 'team-NB', key: 'NB', name: 'Notebook' }],
    projects: [{ id: 'project-one', name: 'One' }],
  }
  const second = {
    name: 'Other',
    workspace: { name: 'Beta', urlKey: 'beta' },
    teams: [{ id: 'team-BE', key: 'BE', name: 'Beta' }],
    projects: [],
  }
  const stub = await startStubLinear({ [key]: account, [other]: second })
  try {
    let stored = key
    let now = 0
    const linear = createLinear({
      keyring: {
        kind: 'macos-keychain',
        get: async () => stored,
        set: async (next) => {
          stored = next
        },
        delete: async () => {},
      },
      keyFile: '/unused-test-key',
      apiUrl: stub.url,
      cacheMs: 1000,
      now: () => now,
    })
    const reads = () =>
      stub.requests.filter((request) => request.query.includes('TedIntakeWorkspace')).length
    const [first, same] = await Promise.all([linear.intakeChoices(), linear.intakeChoices()])
    expect(first.teams).toEqual(account.teams)
    expect(same).toEqual(first)
    account.teams = [...account.teams, { id: 'team-NEW', key: 'NEW', name: 'New' }]
    now = 999
    expect(await linear.intakeChoices()).toEqual(first)
    expect(reads()).toBe(1)
    expect((await linear.intakeChoices({ fresh: true })).teams).toHaveLength(2)
    expect(reads()).toBe(2)
    account.teams = account.teams.slice(0, 1)
    now = 999 + 1000
    expect((await linear.intakeChoices()).teams).toHaveLength(1)
    expect(reads()).toBe(3)

    await linear.save({ key: other })
    expect(await linear.intakeChoices()).toMatchObject({ workspace: 'beta', teams: second.teams })
    expect(reads()).toBe(4)
    expect(stub.requests.at(-1)?.authorization).toBe(other)
  } finally {
    await stub.close()
  }
})
