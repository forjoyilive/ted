# The human can mark a merged Task done

A Task can stay at Merge after the human merged its pull requests on GitHub by hand: the merge watcher stops watching a canceled merge, and a watcher bug can leave a Task behind. Until now the human had no way to finish such a Task except archiving it, which leaves it not merged (`TedStore.isMerged`).

**Mark as Done finishes a Task at Merge on the human’s word, once GitHub agrees.** The Task’s actions menu shows **Mark as Done** while the Task is at Merge. It calls `POST /tasks/:id/mark-done`, which sets neither `runToken` nor `fileToken`, so only the app’s key can call it. `markDone` in `tasks/tasks.ts` does the work:

1. It waits for the Task to be free (`untilFree`) and for any merge watcher cycle in flight (`mergeWatcher.settled`), then takes the Task with `holding`, so no watcher cycle or other Stage change runs while it acts.
2. It asks the poller for a fresh read (`watch.next({ now: true })`), like the merge watcher. It never queries GitHub itself.
3. Every pull request that isn’t removed and isn’t recorded as merged must read as `MERGED`. One that is open, closed without merging, missing from the read, or on a host whose read failed refuses the whole request with a 409 that names it (`owner/repo#N is still open on GitHub`), and nothing changes. A Task with no pull request is refused too.
4. `requireObligations` must pass, as for any move to Done.
5. In one holding it commits `v1.TaskMarkedDone`, records each pull request with `store.pullRequestMerged` (`byTed: false`), and moves the Task to Done through `move`, the same step `finishMerge` takes. Done then does what it always does: stops Runs and Apps, removes worktrees, syncs Linear.

A Task already Done and merged answers success, so a second click or a race with the watcher is harmless. A Task at any other Stage is refused with a 409.

The thread shows “You marked the Task done after its pull requests merged on GitHub”, followed by one “The pull request for … merged on GitHub” line per pull request.

## Considered Options

- **Let the human finish the Task without checking GitHub.** Rejected: a Task must never reach Done with a pull request that isn’t merged, because `isMerged`, Linear sync and retention all trust Done.
- **Read the pull requests with a separate `gh` call.** Rejected: the poller is the one place that reads Task pull requests (ADR 0065).
- **Fix only the watcher.** That fix is separate. The human still needs a way out when the watcher has stopped, as it does after a canceled merge.

## Consequences

- A canceled merge whose pull requests the human then merged on GitHub can be finished from the app.
- A Run or another local process holding the `daemon.json` token can’t finish a Task.
- Marking done costs one poller read, which counts against the poller’s burst like any urgent read.
