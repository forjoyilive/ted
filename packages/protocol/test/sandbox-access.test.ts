import { expect, test } from 'vitest'
import {
  type AccessHolder,
  sandboxAccessChanges,
  sandboxAccessChangeText,
} from '../src/sandbox-access.ts'

const app = (groups: AccessHolder['groups']): AccessHolder => ({
  kind: 'app',
  repo: 'mobile',
  name: 'iOS simulator',
  groups,
})

test('a holder that gains, loses or is removed with a group is listed; an unchanged one is not', () => {
  const changes = sandboxAccessChanges(
    [
      app([]),
      { kind: 'check', name: 'Build', groups: ['ios-xcode'] },
      { kind: 'teardown', repo: 'mobile', name: 'teardown', groups: ['ios-xcode'] },
      { kind: 'setup', repo: 'mobile', name: 'setup', groups: ['ios-xcode'] },
    ],
    [
      app(['ios-xcode']),
      { kind: 'check', name: 'Build', groups: [] },
      { kind: 'setup', repo: 'mobile', name: 'setup', groups: ['ios-xcode'] },
      { kind: 'check', name: 'New', groups: [] },
    ],
  )
  expect(changes).toEqual([
    { kind: 'app', repo: 'mobile', name: 'iOS simulator', gained: ['ios-xcode'], lost: [] },
    { kind: 'check', name: 'Build', gained: [], lost: ['ios-xcode'] },
    { kind: 'teardown', repo: 'mobile', name: 'teardown', gained: [], lost: ['ios-xcode'] },
  ])
  expect(changes.map(sandboxAccessChangeText)).toEqual([
    'iOS simulator App in mobile gains ios-xcode',
    'Build Check loses ios-xcode',
    'Worktree teardown in mobile loses ios-xcode',
  ])
})

test('holders that share a name are each compared with their own earlier entry', () => {
  const sim = (groups: AccessHolder['groups']): AccessHolder => ({
    kind: 'app',
    repo: 'mobile',
    name: 'Sim',
    groups,
  })
  expect(
    sandboxAccessChanges([sim([]), sim(['ios-xcode'])], [sim(['ios-xcode']), sim([])]),
  ).toEqual([
    { kind: 'app', repo: 'mobile', name: 'Sim', gained: ['ios-xcode'], lost: [] },
    { kind: 'app', repo: 'mobile', name: 'Sim', gained: [], lost: ['ios-xcode'] },
  ])
  expect(sandboxAccessChanges([sim([])], [sim([]), sim(['ios-xcode'])])).toEqual([
    { kind: 'app', repo: 'mobile', name: 'Sim', gained: ['ios-xcode'], lost: [] },
  ])
})
