import type { SetupAppTried, SetupCheckTried } from '@ted/protocol'
import { expect, test } from 'vitest'
import type { AppDeclaration } from '../src/apps/declared.ts'
import {
  approvedApps,
  approvedChecks,
  setupWorktreeDifferences,
} from '../src/tasks/setup-access.ts'

const simulator: AppDeclaration = {
  name: 'iOS simulator',
  kind: 'ios-simulator',
  run: 'xcodebuild build',
  ready: 'start',
  env: {},
  sandboxAccess: ['ios-xcode'],
}

const triedApp: SetupAppTried = {
  name: 'iOS simulator',
  kind: 'ios-simulator',
  run: 'xcodebuild build',
  ready: 'ready in 90s',
  passed: true,
}

const triedCheck: SetupCheckTried = {
  name: 'Build',
  command: 'xcodebuild build',
  passed: true,
  durationMs: 1000,
}

test('a setup Task’s App keeps the access groups the user approved for it', () => {
  const apps = approvedApps(
    [simulator],
    [{ ...triedApp, sandboxAccess: ['ios-xcode'] }],
    ['app'],
    'app',
  )
  expect(apps).toEqual([simulator])
})

test('a setup Task’s App loses access groups its branch adds without approval', () => {
  const [app] = approvedApps([simulator], [triedApp], ['app'], 'app')
  expect(app).toBeDefined()
  expect(app).not.toHaveProperty('sandboxAccess')
})

test('an App the proposal didn’t list, or listed as failed, isn’t started', () => {
  expect(approvedApps([simulator], [{ ...triedApp, run: 'other' }], ['app'], 'app')).toEqual([])
  expect(
    approvedApps([simulator], [{ ...triedApp, passed: false, reason: 'No Xcode' }], ['app'], 'app'),
  ).toEqual([])
})

test('a setup Task’s Check keeps only approved access groups', () => {
  const declared = [
    { name: 'Build', run: 'xcodebuild build', sandbox_access: ['ios-xcode' as const] },
  ]
  expect(
    approvedChecks(declared, [{ ...triedCheck, sandboxAccess: ['ios-xcode'] }], 'app'),
  ).toEqual(declared)
  const [check] = approvedChecks(declared, [triedCheck], 'app')
  expect(check).toEqual({ name: 'Build', run: 'xcodebuild build' })
  expect(approvedChecks([{ name: 'Review', instruction: 'Look' }], [triedCheck], 'app')).toEqual([])
})

test('worktree setup and teardown must ask for exactly the approved access groups', () => {
  const repos = [
    { worktree: { setup: { run: 'pod install', sandbox_access: ['ios-xcode' as const] } } },
  ]
  expect(
    setupWorktreeDifferences(
      { worktree: [{ step: 'setup', sandboxAccess: ['ios-xcode'] }] },
      repos,
      'app',
    ),
  ).toEqual([])
  expect(setupWorktreeDifferences({}, repos, 'app')).toEqual([
    'app’s worktree setup asks for sandbox access ios-xcode; the approved proposal lists none',
  ])
  expect(
    setupWorktreeDifferences(
      { worktree: [{ repo: 'mobile', step: 'teardown', sandboxAccess: ['ios-xcode'] }] },
      [{ name: 'mobile' }],
      'app',
    ),
  ).toEqual([
    'app’s worktree teardown asks for sandbox access none; the approved proposal lists ios-xcode',
  ])
})
