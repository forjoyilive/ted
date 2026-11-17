import { describe, expect, test } from 'vitest'
import { cleanupMoveTarget, cleanupProgress } from '../src/tasks/cleanup.ts'
import { cleanupCommandsText } from '../src/tasks/cleanup-commands.ts'
import { cleanupStepsText } from '../src/workflow/workflow.ts'

describe('where a move goes when Cleanup is on', () => {
  const withMerge = ['backlog', 'intake', 'work', 'merge', 'cleanup', 'done']
  const mergeOff = ['backlog', 'intake', 'work', 'cleanup', 'done']

  test('a merged Task goes from Merge to Cleanup, and from Cleanup to Done', () => {
    expect(cleanupMoveTarget('merge', 'done', withMerge)).toEqual({
      next: 'cleanup',
      why: 'cleanup',
    })
    expect(cleanupMoveTarget('merge', 'cleanup', withMerge)).toEqual({
      next: 'cleanup',
      why: 'cleanup',
    })
    expect(cleanupMoveTarget('cleanup', 'done', withMerge)).toEqual({ next: 'done' })
    expect(cleanupMoveTarget('merge', 'done', ['intake', 'work', 'merge', 'done'])).toEqual({
      next: 'done',
    })
  })

  test('no Stage before Merge reaches Cleanup, even when the Workflow leaves Merge out', () => {
    expect(cleanupMoveTarget('work', 'cleanup', mergeOff)).toEqual({
      next: 'merge',
      why: 'merge-off',
    })
    expect(cleanupMoveTarget('review', 'cleanup', withMerge)).toEqual({
      next: 'merge',
      why: 'merge-off',
    })
    expect(cleanupMoveTarget('work', 'done', mergeOff)).toEqual({ next: 'merge', why: 'merge-off' })
    expect(cleanupMoveTarget('work', 'validate', mergeOff)).toEqual({ next: 'validate' })
  })
})

describe('a fresh Task Lead in Cleanup', () => {
  const steps = [
    { name: 'Post note', instruction: 'Post the link.' },
    { name: 'Drop db', instruction: 'Drop it.' },
  ]
  const report = (step: string, result: 'done' | 'failed') => ({
    step,
    result,
    text: 'x',
    runId: 'r',
    at: '',
  })

  test('is told which steps already have a result and does only the rest', () => {
    expect(cleanupProgress(steps, [])).toBeUndefined()
    const text = cleanupProgress(steps, [report('Post note', 'done')])
    expect(text).toContain('- “Post note”: done')
    expect(text).toContain('Do only these, then report each: “Drop db”.')
    expect(
      cleanupProgress(steps, [report('Post note', 'done'), report('Drop db', 'failed')]),
    ).toContain('Every step has a result.')
  })
})

describe('Cleanup command steps', () => {
  const steps = [
    { name: 'Stop env', command: 'make down' },
    { name: 'Post note', instruction: 'Post the link.' },
  ]

  test('the Task Lead’s list names the commands but asks it to report only the instructions', () => {
    const text = cleanupStepsText(steps)
    expect(text).toContain('1. **Post note**\n\n   Post the link.')
    expect(text).not.toContain('make down')
    expect(text).toContain('Ted runs the command step itself (“Stop env”)')
    expect(cleanupStepsText([steps[0] as (typeof steps)[0]])).not.toContain('ted cleanup report "')
  })

  test('the results message shows a failed command’s output and says what is left', () => {
    const failed = {
      step: 'Stop env',
      state: 'failed' as const,
      exitCode: 3,
      timeout: '10m',
      durationMs: 5,
      output: 'env refused',
    }
    const passed = { ...failed, step: 'Prune', state: 'passed' as const, exitCode: 0 }
    const text = cleanupCommandsText([failed, passed], 1)
    expect(text).toContain(
      '- “Stop env”: failed with exit code 3. Its last lines:\n\n```\nenv refused\n```',
    )
    expect(text).toContain('- “Prune”: passed')
    expect(text).toContain('Don’t report it with `ted cleanup report`')
    expect(text).toContain('Now do the instruction steps.')
    expect(cleanupCommandsText([passed], 0)).toContain('There are no instruction steps left.')
  })

  test('a fresh Task Lead sees command results and does only the instructions left', () => {
    const text = cleanupProgress(steps, [
      {
        step: 'Stop env',
        result: 'failed',
        text: 'Ted ran the command; it failed with exit code 3',
        runId: '',
        at: '',
      },
    ])
    expect(text).toContain(
      '- “Stop env” (a command): Ted ran the command; it failed with exit code 3',
    )
    expect(text).toContain('A failed command counts as a failed step.')
    expect(text).toContain('Do only these, then report each: “Post note”.')
  })
})
