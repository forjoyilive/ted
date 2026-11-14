import { expect, test } from 'vitest'
import { defaultQuietWaitMs, quietDeadline } from '../src/automations/automations.ts'
import {
  checkFailureText,
  failingTestFiles,
  maxTasksPerFiring,
  planCheckFailures,
  sandboxSkipped,
} from '../src/automations/check-failures.ts'

const output = [
  '\u001b[31m FAIL \u001b[39m |node| packages/daemon/test/a.test.ts > Automations > fires',
  ' FAIL  |node| packages/daemon/test/a.test.ts [ packages/daemon/test/a.test.ts ]',
  '   × packages/app/test/b.test.tsx (3 tests | 1 failed)',
  'FAIL src/jest.spec.js',
  ' FAIL  |node| ../outside.test.ts',
  ' FAIL  |node| packages/$(rm -rf).test.ts',
  ' ✓ packages/daemon/test/c.test.ts',
  'TED_SANDBOX_SKIPPED: the Electron app tests',
  '[electron] TED_SANDBOX_SKIPPED: the Electron app tests',
].join('\n')

test('failing test files come from vitest and jest FAIL lines, safe paths only', () => {
  expect(failingTestFiles(output)).toEqual([
    'packages/app/test/b.test.tsx',
    'packages/daemon/test/a.test.ts',
    'src/jest.spec.js',
  ])
  expect(sandboxSkipped(output)).toEqual(['the Electron app tests'])
})

test('a few failing files get a Task each; none or too many get one Task for the Check', () => {
  expect(planCheckFailures('Nightly', ['a.test.ts', 'b.test.ts'])).toEqual([
    { key: 'file:a.test.ts', title: 'Fix failing tests in a.test.ts', files: ['a.test.ts'] },
    { key: 'file:b.test.ts', title: 'Fix failing tests in b.test.ts', files: ['b.test.ts'] },
  ])
  expect(planCheckFailures('Nightly', [])).toMatchObject([
    { key: 'check', title: 'Fix the scheduled Check “Nightly”' },
  ])
  const many = Array.from({ length: maxTasksPerFiring + 1 }, (_, i) => `t${i}.test.ts`)
  expect(planCheckFailures('Nightly', many)).toMatchObject([{ key: 'check', files: many }])
})

test('the Task text names the command and files, fences the output and links the log', () => {
  const text = checkFailureText({
    name: 'Nightly',
    command: 'pnpm check',
    state: 'failed',
    exitCode: 1,
    commit: 'abcdef1234567890',
    plan: { key: 'file:a.test.ts', title: '', files: ['a.test.ts'] },
    failing: ['a.test.ts'],
    tail: 'before ``` inside\nlast line',
    log: '/home/ted/automation-checks/x/logs/y.log',
    at: '2026-11-13T03:00:00.000Z',
  })
  expect(text).toContain(
    'failed with exit code 1 at 2026-11-13T03:00:00.000Z on commit abcdef123456',
  )
  expect(text).toContain('- a.test.ts')
  expect(text).toContain('````\nbefore ``` inside\nlast line\n````')
  expect(text).toContain('Full output: /home/ted/automation-checks/x/logs/y.log')
})

test('a busy wait ends at the next run-by time, or after 4 hours without one', () => {
  const fired = Date.parse('2026-11-13T03:00:00Z')
  expect(quietDeadline(fired, undefined, 'UTC')).toBe(fired + defaultQuietWaitMs)
  expect(new Date(quietDeadline(fired, '07:00', 'UTC')).toISOString()).toBe(
    '2026-11-13T07:00:00.000Z',
  )
  expect(new Date(quietDeadline(fired, '02:00', 'Europe/Paris')).toISOString()).toBe(
    '2026-11-14T01:00:00.000Z',
  )
})
