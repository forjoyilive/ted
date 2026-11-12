# Archiving during worktree setup

KRI-357 reported one working slot after worktree removal, with no Task Lead,
in the Loaded 2 measurement. See [the measurement results](suite-measurement-results.md)
and [the source issue](https://linear.app/kriyadesign/issue/KRI-357/diagnose-a-working-slot-left-after-archiving-during-setup).
That measurement used frozen commit `c0594f81851e15c8d68faf96da8d0b1a164d8d7c`.

## Completion ordering on current source

The current implementation permits removal and setup cancellation to finish in
either order:

1. `launchQueued` in `packages/daemon/src/tasks/tasks.ts` starts setup preparation
   in the background. The `beginning` promise covers launching that preparation,
   not its completion.
2. `prepare` in `tasks/lead-lifecycle.ts` takes a slot hold around `setUp` and
   releases it in `finally` when setup returns. An interrupted setup returns
   without launching a Task Lead.
3. `archiveNow` records the archive and starts `clearAway` in the background.
   `clearAway` aborts setup, awaits `beginning` and removes worktrees through
   `finish`. It does not await the background preparation promise.
4. `runWorktreeCommand` in `tasks/worktree.ts` sends a termination signal on
   cancellation and awaits the child’s exit. `runTaskCommand` also finishes
   command cleanup before returning to setup preparation.
5. `finish` records worktree removal after deleting the worktree and cleaning
   its folders. This says nothing about whether the setup promise has returned.
6. `slotUse` counts a Task with a hold even when its worktree has been removed.
   `GET /slots` computes this from current state; it does not return the cached
   event publication.

Thus a slot observed immediately after removal can still belong to a stopping
setup command. The code trace supports a missing test completion wait; it does
not establish a permanent slot leak or reproduce the historical loaded failure.
No production change is made.

## Test boundary

The archive-during-setup case in `packages/daemon/test/worktrees.test.ts` now
waits for a file written by the setup command before archiving. This ensures
the command actually started, rather than only having its running state recorded.
After archiving it waits separately for worktree removal and zero working slots.
The existing bounded `waitUntil` fails if the slot never releases.

After those waits, the test reads the Task again and asserts it is archived,
its repo is removed and it has no Task Lead. It also retains the directory absence
and zero-slot assertions. No fixed delay is added, and no test lock or worker cap
changes. A missing cancellation or leaked hold still fails this test.

Runtime verification is reserved for Validate: run only
`pnpm vitest run packages/daemon/test/worktrees.test.ts`.
The historical loaded scenario and the full suite are not claimed as verified.
