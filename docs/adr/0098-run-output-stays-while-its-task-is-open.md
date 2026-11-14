# Run output stays while its Task is open, then for a set number of days

This amends the Retention paragraph of ADR 0039.

Since ADR 0097 a Run’s chat is read from `runs/<run-id>/host.log` and nowhere else. ADR 0039 deleted a Run folder 14 days after its `host.log` was last written, whatever its Task was doing, so a Task open for three weeks lost the chats of its early Runs, and cut a finished Run’s log over 100 MB to its tail.

Retention now asks who owns the Run. `runOutputEnd` in `packages/daemon/src/retention.ts` answers `keep`, a time the clock starts from, or `unknown`; `pruneRunOutput` deletes the Run folder once that time is more than `runOutputDays` days ago.

- **A Run that isn’t finished** in the store, or whose host still holds `host.lock`: kept.
- **A Run of a Task** (Task Lead Runs and sub-agents): kept while the Task is open, that is not Done and not archived, however old. Once it is closed the clock starts when it became Done (the `at` of its newest Done Stage entry; a Task with no such entry uses its merge time, then `updatedAt`) or was archived (`archived.at`), whichever came first. Unarchiving a Task makes it open again, so its output is kept again. ADR 0156 amends this for finished sub-agents, whose clock starts when they ended.
- **A Coordinator’s Runs** (every ID in its `runIds`): kept while the Coordinator exists, because it revives its newest Run and rebuilds its history from the others’ output.
- **A Planning Run**: kept until the plan is Finished or Stopped, then the clock starts at the plan’s `finishedAt`. A Failed plan keeps its output, because **Retry** revives the same Run.
- **An Automation Run**: kept until its firing ends, then the clock starts at the firing’s `finishedAt`.
- **An Automation draft’s Run**: kept. `automations/drafts.ts` already deletes the draft and its Run folder on its own timer.
- **Any other Run without a Task** (a dev Run): the clock starts when the Run ended.
- **A folder under `runs/` with no Run in the store** (left by a deleted Task, plan or Coordinator, or newer than a restored backup): `unknown`, so the clock starts at the last write to its `host.log`. A Run’s folder is made just before its store row, so a new folder is never old enough to delete.

`runOutputDays` is a machine setting (ADR 0024): a whole number from 1 to 365, default 7, set in Settings → Storage as “Keep Run output after a Task is done”. Pruning runs at start, every 6 hours, and as soon as the setting changes.

**The whole Run folder is deleted, not only `host.log`.** The other files (`launch.json`, `env.json`, `input.jsonl`, `prompt-inputs.jsonl`, `queued`, `host.pid`, `host.lock` and the agent’s own files) are only used to start, feed or revive the Run. If `host.log` alone were deleted, a later revive would append to a new, short file while the store still held the old read offset, and the daemon would read nothing from it (the cut-log problem ADR 0097 notes). With the folder gone, `RunManager.revive` fails and recovery starts a fresh Run from the brief (ADR 0051), as it already did after the 14-day delete. Attachments live in `TED_HOME/attachments`, not in the Run folder.

**The 100 MB tail cut is gone.** It would shorten the chats of an open Task, which is what this change exists to stop, and a cut log breaks a revived Run. A closed Task’s large log now lasts at most `runOutputDays` more days. The reader still serves the tail of a log that was cut before this change.

Deleting keeps ADR 0039’s checks and adds one: the name must be a Run ID, the entry must be a real folder (`lstat`, never a link) whose real path is `runs/<id>` under the real `runs/`, and the delete goes through `removeInside`.

## Considered Options

- **Start the clock at the Run’s last output, but only once the Task is closed.** A Task Done today with a Run from last month would lose that chat at once. The owner asked for days after Done.
- **Keep the tail cut for closed Tasks only.** It saves little once those logs live 7 days, and an unarchived Task could revive a Run with a cut log.
- **A separate setting for Runs without a Task.** One number is easier to explain, and those Runs have a clear end time.

## Consequences

- An open Task’s Run output is never pruned, so `runs/` can grow without limit while Tasks stay open. Settings → Storage shows it under “Conversations and logs”.
- A Done or archived Task’s Run chats show “Output no longer kept” after `runOutputDays` days. The Task, its thread and its Comments stay.
- A Task archived for longer than `runOutputDays` and then unarchived starts a fresh Task Lead Run from the brief instead of resuming the old one.
- A Failed plan that is never retried or deleted keeps its output.
- Tests drive the clock with `startDaemon`’s `retention.now` and a short `retention.checkEveryMs`.
