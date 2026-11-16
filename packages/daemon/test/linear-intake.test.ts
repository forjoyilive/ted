import { parseLinearUrl } from '@ted/protocol'
import { expect, test } from 'vitest'
import { createLinear } from '../src/linear/linear.ts'
import { startStubLinear } from './fixtures/stub-linear.ts'

const url = 'https://linear.app/acme/issue/NB-1'
const membership = {
  workspace: 'acme',
  workspaceId: 'workspace-acme',
  teamId: 'team-NB',
  projectId: 'project-one',
}

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

test('the intake listing stops after 1,000 issues read, even when pages repeat issues', async () => {
  const key = 'lin_api_fake_key_for_listing_tests'
  const account = {
    name: 'Test',
    workspace: { name: 'Acme', urlKey: 'acme' },
    issues: Array.from({ length: 60 }, (_, i) => ({
      identifier: `NB-${i + 1}`,
      title: `Issue ${i + 1}`,
      assignedToMe: true,
    })),
    intakeRepeats: true,
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
    const list = await linear.intakeIssues({
      kind: 'team',
      id: 'team-NB',
      name: 'Notebook',
      workspaceId: 'workspace-acme',
      workspace: 'acme',
    })
    expect(list.issues).toHaveLength(50)
    expect(list.incomplete).toBe('TED read the first 1000 issues; the rest wait for the next run.')
    expect(
      stub.requests.filter((request) => request.query.includes('TedIntakeIssues')),
    ).toHaveLength(20)
  } finally {
    await stub.close()
  }
})
