import { test } from 'vitest'
import { useMergeHarness } from './merge-harness.ts'
import { incorporated, incorporates } from './support/failure-repairs.ts'

useMergeHarness()

test.each(['dirty-worktree', 'conflict', 'unresolved-conflict'] as const)(
  incorporated,
  incorporates,
  90_000,
)
