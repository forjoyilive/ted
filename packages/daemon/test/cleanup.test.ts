import { describe, expect, test } from 'vitest'
import { cleanupMoveTarget, cleanupProgress } from '../src/tasks/cleanup.ts'

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
