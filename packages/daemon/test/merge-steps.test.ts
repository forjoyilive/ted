import { describe, expect, test } from 'vitest'
import {
  chooseMethod,
  type MergeTarget,
  nextStep,
  type RemotePullRequest,
} from '../src/tasks/merge.ts'

const target: MergeTarget = {
  name: 'app',
  repo: 'acme/app',
  number: 12,
  branch: 'ted/nb-1-x',
  base: 'main',
  expectedHead: 'abc',
  hasCi: true,
  method: 'squash',
}

const pr = (over: Partial<RemotePullRequest> = {}): RemotePullRequest => ({
  id: 'PR_12',
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'abc',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  autoMerge: false,
  checks: [],
  allowed: ['squash', 'merge', 'rebase'],
  autoMergeAllowed: false,
  deleteBranchOnMerge: false,
  ...over,
})

describe('the next merge step', () => {
  test('merges once every check passes, or at once with no CI', () => {
    const passed = { name: 'test', state: 'passed' as const, required: false }
    expect(nextStep(target, pr({ checks: [passed] }))).toEqual({ kind: 'merge', noCi: false })
    expect(nextStep({ ...target, hasCi: false }, pr())).toEqual({ kind: 'merge', noCi: true })
  })

  test('waits for CI while a check is pending or none has appeared', () => {
    expect(nextStep(target, pr())).toEqual({ kind: 'wait', on: 'ci', autoMerge: false })
    const pending = { name: 'test', state: 'pending' as const, required: false }
    expect(nextStep(target, pr({ checks: [pending] }))).toMatchObject({ on: 'ci' })
  })

  test('only required checks count when the base requires some', () => {
    const checks = [
      { name: 'lint', state: 'failed' as const, required: false },
      { name: 'test', state: 'passed' as const, required: true },
    ]
    expect(nextStep(target, pr({ checks, mergeStateStatus: 'UNSTABLE' }))).toEqual({
      kind: 'merge',
      noCi: false,
    })
    const failing = [{ name: 'test', state: 'failed' as const, required: true }]
    expect(nextStep(target, pr({ checks: failing }))).toEqual({
      kind: 'ci-failed',
      checks: ['test'],
    })
  })

  test('a required review waits for GitHub review and asks for auto-merge where allowed', () => {
    const step = nextStep(
      { ...target, hasCi: false },
      pr({
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'BLOCKED',
        autoMergeAllowed: true,
      }),
    )
    expect(step).toEqual({ kind: 'wait', on: 'review', autoMerge: true })
  })

  test('a moved head, a conflict and a base that moved are each their own step', () => {
    expect(nextStep(target, pr({ headRefOid: 'def' }))).toEqual({ kind: 'changed', head: 'def' })
    expect(nextStep(target, pr({ mergeable: 'CONFLICTING' }))).toEqual({ kind: 'conflict' })
    expect(nextStep(target, pr({ mergeStateStatus: 'BEHIND' }))).toEqual({ kind: 'behind' })
    expect(nextStep(target, pr({ state: 'MERGED', headRefOid: 'zzz' }))).toEqual({
      kind: 'merged',
    })
  })
})

describe('the merge method', () => {
  test('uses the Factory’s method when GitHub allows it, otherwise one it allows', () => {
    expect(chooseMethod('squash', ['squash', 'merge'])).toBe('squash')
    expect(chooseMethod('squash', ['rebase', 'merge'])).toBe('merge')
    expect(chooseMethod('rebase', [])).toBeUndefined()
  })
})
