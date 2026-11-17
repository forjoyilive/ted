import type { CheckRun } from '@ted/protocol'
import { expect, test } from 'vitest'
import { demoCheckProblem } from '../src/dev/scenarios.ts'

test('seeding names a Check run Ted could not finish', () => {
  const run = (id: string, outcome?: CheckRun['outcome']): CheckRun => ({
    id,
    taskId: 'task',
    trigger: 'hand-off',
    stage: 'work',
    startedAt: '2025-01-02T12:00:00.000Z',
    checks: [],
    ...(outcome && { outcome }),
  })
  expect(demoCheckProblem([run('a', 'passed'), run('b')])).toBeUndefined()
  expect(demoCheckProblem([run('a', 'passed'), run('b', 'interrupted')])).toContain(
    'Demo check run b was interrupted',
  )
  expect(demoCheckProblem([run('a', 'failed')])).toContain('Demo check failed')
})
