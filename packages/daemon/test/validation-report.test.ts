import type { FailureCase, FailureResolution } from '@ted/protocol'
import { expect, test } from 'vitest'
import { briefFailureHistory } from '../src/tasks/validation-report.ts'

const output = Array.from({ length: 200 }, (_, n) => `line ${n + 1}`).join('\n')

function failure(id: string, name: string, change: Partial<FailureCase> = {}): FailureCase {
  return {
    id,
    taskId: 'task',
    source: { kind: 'factory-check', checkRunId: 'run', position: 0 },
    recordedBy: 'ted',
    provenance: 'stored-check',
    evidence: `1. The check “${name}” failed.\n\n\`\`\`\n${output}\n\`\`\``,
    originalCheck: { name, timeout: '10m', state: 'failed' },
    createdAt: '2026-11-18T00:00:00.000Z',
    validation: true,
    assessments: [],
    additions: [],
    decisions: [],
    resolutions: [],
    invalidations: [],
    ...change,
  }
}

const resolved = (resolution: FailureResolution['resolution'], reason = '') => [
  {
    requestId: `request-${resolution}`,
    resolution,
    reason,
    assessmentId: 'assessment',
    at: '2026-11-18T01:00:00.000Z',
  },
]

test('a fixed or later-passing failure is one line; an accepted one keeps its output', () => {
  const history = briefFailureHistory([
    failure('aaaaaa111111', 'Affected tests', { resolutions: resolved('fixed') }),
    failure('bbbbbb222222', 'Lint', {
      verifications: [{ at: '2026-11-18T02:00:00.000Z', evidence: 'Passed in Validate' }],
    }),
    failure('cccccc333333', 'Typecheck', { resolutions: resolved('accepted', 'Broken on main') }),
  ])
  const [closed, ...open] = history.split('\n\n')
  expect(closed).toBe(
    [
      '- Failure aaaaaa · the Affected tests check · fixed',
      '- Failure bbbbbb · the Lint check · passed on a later run',
    ].join('\n'),
  )
  expect(history.match(/line 200/g)).toHaveLength(1)
  expect(open.join('\n\n')).toContain('Failure cccccc')
  expect(history).toContain('Decision: failed, accepted by you · Broken on main')
})
