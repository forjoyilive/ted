// @vitest-environment jsdom
import type { FailureCase } from '@ted/protocol'
import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { FailureDetails } from '../src/renderer/components/FailureDetails.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, task } from './support/fixtures.ts'

test('an obsolete Check repair does not claim a later execution', () => {
  const value: FailureCase = {
    id: 'abcdef01-0000-4000-8000-000000000000',
    contextId: '12345601-0000-4000-8000-000000000000',
    taskId: 'fixture',
    source: { kind: 'factory-check', checkRunId: 'failed-run', position: 0 },
    recordedBy: 'lead',
    provenance: 'stored-check',
    evidence: 'The original Check failed.',
    createdAt: '2026-01-01T00:00:00Z',
    validation: true,
    assessments: [],
    additions: [],
    decisions: [],
    resolutions: [],
    invalidations: [],
    verifications: [
      {
        at: '2026-01-02T00:00:00Z',
        evidence:
          'Task Lead reported repair against a fresh Validate visit. Current Checks: (empty plan). Original execution remains failed.',
      },
    ],
  }
  render(<FailureDetails failure={value} />)
  expect(screen.getByText('abcdef').getAttribute('title')).toBe(value.id)
  expect(screen.getByText('123456').getAttribute('title')).toBe(value.contextId)
  expect(screen.queryByText(/verified by a later execution/)).toBeNull()
  expect(screen.getByText(/verified with recorded evidence/)).toBeTruthy()
})

test('a dropped repair says fresh Checks close the failure, and a closed case names the Task that fixed it', async () => {
  const repairTask = { id: 'NB-2', displayId: 'NB-2', title: 'Repair the export' }
  const fixer = { id: 'NB-3', displayId: 'NB-3', title: 'Fix the export elsewhere' }
  const value: FailureCase = {
    id: 'abcdef01-0000-4000-8000-000000000000',
    taskId: 'NB-1',
    source: { kind: 'finding', runId: 'lead', finding: 'Export timezone missing' },
    recordedBy: 'lead',
    provenance: 'task-lead-reported',
    evidence: 'The export lost its timezone.',
    createdAt,
    validation: true,
    assessments: [],
    additions: [],
    decisions: [],
    resolutions: [
      {
        requestId: 'request',
        resolution: 'repair',
        repairTask,
        at: createdAt,
        assessmentId: 'assessment',
      },
    ],
    invalidations: [],
  }
  bridge({
    listTasks: () => [
      task({ blockedBy: [] }),
      task({
        ...repairTask,
        number: 2,
        archived: { at: createdAt, ended: { kind: 'never-started' } },
      }),
      task({ ...fixer, number: 3, stage: 'done' }),
    ],
  })
  const open = vi.fn()
  const { rerender } = render(<FailureDetails failure={value} onOpenTask={open} />)
  expect(
    await screen.findByText(
      'Repair archived without merging. Fresh passing checks close this failure. If this Task is stopped, use Resume in Task details first.',
    ),
  ).toBeTruthy()
  rerender(
    <FailureDetails
      failure={{
        ...value,
        verifications: [{ at: createdAt, evidence: 'Checks passed.', fixedBy: fixer }],
      }}
      onOpenTask={open}
    />,
  )
  await user().click(await screen.findByRole('button', { name: 'NB-3 · Fix the export elsewhere' }))
  expect(open).toHaveBeenCalledWith('NB-3')
  expect(screen.getByText(/Later verification closed this failure/)).toBeTruthy()
})
