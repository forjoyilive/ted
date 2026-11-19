import { expect, test } from 'vitest'
import { savedCheckAccess } from '../src/check-tries.ts'
import type { FactoryRepoEntry } from '../src/tasks/repos.ts'
import type { CheckSettings } from '../src/workflow/check.ts'

const entry = (name: string, primary: boolean) =>
  ({ name, repo: `kriya/${name}`, cloneUrl: '', primary }) as FactoryRepoEntry
const app = entry('app', true)
const api = entry('api', false)
const entries = [app, api]
const checks: CheckSettings[] = [
  { name: 'Build', run: 'xcodebuild test', sandbox_access: ['ios-xcode'] },
  { name: 'Server', run: 'make', repo: 'api', sandbox_access: ['socket:docker'] },
  { name: 'Lint', run: 'pnpm lint' },
  { name: 'Review', instruction: 'Look it over' },
]

test('a try that matches the saved Check’s name, command and repo gets its access', () => {
  expect(savedCheckAccess(checks, entries, { name: 'Build', run: 'xcodebuild test' }, app)).toEqual(
    { sandboxAccess: ['ios-xcode'] },
  )
  expect(
    savedCheckAccess(checks, entries, { name: 'Build', run: 'xcodebuild test', repo: 'app' }, app),
  ).toEqual({ sandboxAccess: ['ios-xcode'] })
  expect(
    savedCheckAccess(checks, entries, { name: 'Server', run: 'make', repo: 'api' }, api),
  ).toEqual({ sandboxAccess: ['socket:docker'] })
})

test('a try whose command or repo differs gets no access and records what was withheld', () => {
  const withheld = { withheldAccess: ['ios-xcode'] }
  expect(
    savedCheckAccess(checks, entries, { name: 'Build', run: 'xcodebuild test ' }, app),
  ).toEqual(withheld)
  expect(
    savedCheckAccess(checks, entries, { name: 'Build', run: 'xcodebuild test\n' }, app),
  ).toEqual(withheld)
  expect(savedCheckAccess(checks, entries, { name: 'Build', run: 'xcodebuild' }, app)).toEqual(
    withheld,
  )
  expect(
    savedCheckAccess(checks, entries, { name: 'Build', run: 'xcodebuild test', repo: 'api' }, api),
  ).toEqual(withheld)
  expect(savedCheckAccess(checks, entries, { name: 'Server', run: 'make' }, app)).toEqual({
    withheldAccess: ['socket:docker'],
  })
})

test('a try with no saved Check of its name, or one without access, gets none', () => {
  expect(savedCheckAccess(checks, entries, { name: 'build', run: 'xcodebuild test' }, app)).toEqual(
    {},
  )
  expect(savedCheckAccess(checks, entries, { name: 'New', run: 'xcodebuild test' }, app)).toEqual(
    {},
  )
  expect(savedCheckAccess(checks, entries, { name: 'Lint', run: 'pnpm lint' }, app)).toEqual({})
  expect(savedCheckAccess(checks, entries, { name: 'Review', run: 'Look it over' }, app)).toEqual(
    {},
  )
})
