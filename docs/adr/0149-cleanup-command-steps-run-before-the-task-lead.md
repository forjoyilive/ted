# Cleanup command steps run before the Task Lead

A Cleanup step was only an instruction for the Task Lead (ADR 0148). Much after-merge work is a fixed command, such as stopping a test environment or deleting a preview, and needs no agent judgment; asking a Task Lead to run it costs a turn and adds a way to get it wrong (TED-320).

**A step is `{name, instruction}` or `{name, command, timeout?}`.** `checkSteps` in `workflow/check.ts` refuses a step with both or neither and a `timeout` on an instruction step; `timeout` has a Check’s format and defaults to `10m`.

- **Running.** On entering Cleanup, `move` calls `cleanupThen` in `tasks/tasks.ts`. When command steps have no result yet, it marks the Task as checking (so `ted outcome advance` waits and the Task shows “Running Cleanup commands”), takes one `CheckSlots` place for the batch and runs them through `runCleanupCommands` in `tasks/cleanup-commands.ts`: one after another, `$SHELL -lc` in the primary repo’s worktree, the Check environment from `checkEnv`, low priority, and `prepareCommandLaunch`, so outside Bypass they run in the sandbox and a missing sandbox refuses the command. A failed or timed-out command doesn’t stop the rest. Stopping, clearing or deleting the Task aborts the batch through its `checkWaits` controller.
- **Recording.** Each result is one `v1.CleanupCommandRan` (state, exit code, timeout, duration and the last 20 output lines, redacted). Its materializer also inserts a `cleanupReports` row (`done` or `failed`), so `finishCleanup`, `cleanupProgress`, Try again and Finish anyway treat command steps like any other step. The thread draws one line per command with the output folded under it. `ted cleanup report` refuses a command step.
- **Handing on.** After the batch, when no instruction step is left and no command failed, TED finishes Cleanup itself through `finishCleanup` and the Task goes to Done with no Task Lead turn. Otherwise the Task Lead gets the Cleanup message, which lists only the instruction steps, followed by the command results with a failed command’s output; it diagnoses failed commands in its note and never reports them. A Task Lead that has ended is resumed from the brief, and `cleanupProgress` includes the command results.
- **Try again** clears the failed steps’ results as before, then `cleanupThen` reruns the failed commands before the Task Lead is sent the failed instruction steps.
- **Restarts.** At daemon start, a Task in Cleanup that isn’t stopped or archived and has no open failure question gets its command steps without a result run again. `ted outcome advance` does the same when it finds one, instead of refusing. So a Cleanup command should be safe to run twice.

## Considered Options

- **Running commands through `runChecks`.** Rejected: it stops at the first failure and writes a Check run, which would count as Validate coverage and show in the Checks panel.
- **Always giving the Task Lead a turn.** Rejected: with only passing commands there is nothing for it to do; TED-307 proposed skipping it.
- **The Task Lead running the commands.** That is what an instruction step already allows; a command step exists so TED runs it the same way every time.

## Consequences

- A Factory can run Cleanup with no agent at all when every step is a command.
- A command interrupted by a restart runs again from the start.
