# A canceled merge keeps watching GitHub

A human Comment while the merge is pending cancels TED’s merge (ADR 0062). After the cancel the merge watcher turned GitHub auto-merge off and stopped looking at the pull requests. When the human then merged them by hand on GitHub, TED never noticed, and the Tasks stayed at Merge for good; a restart didn’t help, because the watcher saw the cancel again and stopped again (TED-214, TED-217, TED-228). A pull request merged outside TED was also noticed only deep in the merge cycle, after an open request, the merge Checks or open failure cases had already ended it.

- **A canceled merge keeps watching.** In `mergeCycle` (`tasks/merge-watcher.ts`) the `canceled` mode turns auto-merge off and then runs `watchOnlyCycle`, the same read Merge off uses: each pull request merged on GitHub is recorded as merged by someone else, and the Task moves to Done when none is left open. It never merges or sends back, and it doesn’t mark the pull requests as waiting.
- **A merge outside TED is noticed first.** Before any other merge step, in every mode, `mergedOutside` checks whether every open pull request of the Task is merged on GitHub. If so it records each one (with the auto-merge method, if TED had turned auto-merge on), deletes the branch as a merge by TED would, and finishes the Task. A read that failed for a host leaves the check out and the cycle goes on as before. When only some pull requests of a multi-repo Task are merged, the usual path runs, so Partly merged still comes only from `v1.MergeStoppedPartway`.
- **An open request no longer hides it.** `watchMerge` in `tasks/tasks.ts` still reads GitHub while an open request holds the merge, and runs the cycle with `onlyMergedOutside`, which does that check and nothing else.

## Considered Options

- **End the watcher after the cancel, and start it again on a later event.** Nothing reliable happens after a hand merge: the Task Lead may be gone and the human has no reason to act in TED.

## Consequences

- The merge loop of a canceled Task runs until the Task leaves Merge, reading GitHub on the poller’s schedule.
- A Task with an open request at Merge moves to Done when its pull requests are merged on GitHub. Gate requests are withdrawn by the stage change as before; other open requests stay.
