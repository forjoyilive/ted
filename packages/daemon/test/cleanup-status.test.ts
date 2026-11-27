import type { CleanupStepReport } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { cleanupStatus } from '../src/tasks/cleanup.ts'

const steps = [
  { name: 'Stop env', command: 'make down' },
  { name: 'Drop db', command: 'make drop' },
  { name: 'Post note', instruction: 'Post the link.' },
]

const report = (step: string, result: 'done' | 'skipped' | 'failed'): CleanupStepReport => ({
  step,
  result,
  text: 'x',
  runId: 'r',
  at: '',
})

const names = (list: readonly { name: string }[]) => list.map((step) => step.name)

describe('what is left of a Task’s Cleanup', () => {
  test.each([
    {
      when: 'nothing has run yet',
      reports: [],
      failureOpen: false,
      pendingCommands: ['Stop env', 'Drop db'],
      unreported: ['Post note'],
      missing: ['Stop env', 'Drop db', 'Post note'],
      failed: [],
      failedCommands: [],
      left: 'lead',
    },
    {
      when: 'a command failed and the instruction step is done',
      reports: [
        report('Stop env', 'done'),
        report('Drop db', 'failed'),
        report('Post note', 'done'),
      ],
      failureOpen: false,
      pendingCommands: [],
      unreported: [],
      missing: [],
      failed: ['Drop db'],
      failedCommands: ['Drop db'],
      left: 'lead',
    },
    {
      when: 'the commands passed and the instruction step has no report',
      reports: [report('Stop env', 'done'), report('Drop db', 'done')],
      failureOpen: false,
      pendingCommands: [],
      unreported: ['Post note'],
      missing: ['Post note'],
      failed: [],
      failedCommands: [],
      left: 'lead',
    },
    {
      when: 'every step is done or skipped',
      reports: [
        report('Stop env', 'done'),
        report('Drop db', 'skipped'),
        report('Post note', 'done'),
      ],
      failureOpen: false,
      pendingCommands: [],
      unreported: [],
      missing: [],
      failed: [],
      failedCommands: [],
      left: 'nothing',
    },
    {
      when: 'the instruction step failed, which Ted asks the user about',
      reports: [
        report('Stop env', 'done'),
        report('Drop db', 'done'),
        report('Post note', 'failed'),
      ],
      failureOpen: false,
      pendingCommands: [],
      unreported: [],
      missing: [],
      failed: ['Post note'],
      failedCommands: [],
      left: 'nothing',
    },
    {
      when: 'the failure question is open',
      reports: [
        report('Stop env', 'done'),
        report('Drop db', 'done'),
        report('Post note', 'failed'),
      ],
      failureOpen: true,
      pendingCommands: [],
      unreported: [],
      missing: [],
      failed: ['Post note'],
      failedCommands: [],
      left: 'lead',
    },
    {
      when: 'a command has no result, which leaves the Task Lead nothing to do yet',
      reports: [report('Stop env', 'done'), report('Post note', 'done')],
      failureOpen: false,
      pendingCommands: ['Drop db'],
      unreported: [],
      missing: ['Drop db'],
      failed: [],
      failedCommands: [],
      left: 'nothing',
    },
  ])('when $when', ({ reports, failureOpen, left, ...expected }) => {
    const status = cleanupStatus(steps, reports, failureOpen)
    expect({
      pendingCommands: names(status.pendingCommands),
      unreported: names(status.unreported),
      missing: names(status.missing),
      failed: names(status.failed),
      failedCommands: names(status.failedCommands),
    }).toEqual(expected)
    expect(status.left).toBe(left)
  })

  test('a report for a step no longer in the Workflow counts for nothing', () => {
    const status = cleanupStatus(steps, [report('Old step', 'failed')])
    expect(names(status.reported)).toEqual([])
    expect(names(status.failed)).toEqual([])
    expect(names(status.missing)).toEqual(['Stop env', 'Drop db', 'Post note'])
  })
})
