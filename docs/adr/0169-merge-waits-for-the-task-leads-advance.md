# Merge waits for the Task Lead’s advance

Under ADR 0056 and ADR 0062 the Task Lead had nothing to do at Merge: `ted outcome advance` was refused there, and the merge watcher merged as soon as GitHub said a pull request was ready. In a Factory without GitHub CI that was seconds after the Task entered Merge, so the Task Lead had no chance to work on the pull request first, for example to write its title and merge message (TED-416, TED-420).

Merge now works like the other Stages. The Task Lead does the Merge Stage’s work and runs `ted outcome advance`; only then does TED merge. TED still performs every merge, only through the merge watcher, under the user’s GitHub login.

- **Two events.** `store.changeStage` commits `v1.MergeAwaitsLead` with every entry into Merge. `ted outcome advance` at Merge commits `v1.MergeLeadAdvanced { taskId, by: 'lead' }` and doesn’t change the Stage. It records only that event, so it doesn’t take the Task’s transition or wait for running Checks; it is refused while a GitHub CI or post-rebase Check Failure case is open, after a cancel or Request changes, and once already recorded. It starts the merge (`v1.MergeStarted`) at once when the mode becomes `merge`. The user’s Merge anyway commits the same event with `by: 'human'`. `store.mergeHistory` reads both for the current Merge visit.
- **A fifth merge mode, `lead`.** `leadPending` in `tasks/merge-watcher.ts` is true while the visit has `MergeAwaitsLead` and no advance, or while a GitHub CI or post-rebase Check Failure case recorded after the Task Lead’s advance is open. `mergeMode` then returns `lead`, after `off` and `canceled`. In `lead` mode the watcher still notices merges outside TED, records CI Failure cases, rebases and reruns Checks, and sends the Task back on conflicts or a changed branch; it keeps GitHub auto-merge off, posts no Merge sign-off, records no `v1.MergeStarted` and doesn’t merge. After the advance the mode is `merge` or `gate` as before, so the sign-off still comes from TED once CI passes and a Comment cancels the merge only once it has started. With Merge off the watcher only watches, as before; the Task Lead still does the work and advances.
- **Tasks already at Merge** have no `MergeAwaitsLead` and merge as before.
- **The Task Lead at Merge is a Task Lead in a Stage.** The idle nudge, the interrupted status that lets an answer resume it and the quit-stop offer now cover it while `leadPending` holds. `ted outcome back` from Merge goes to Work or Design only. If it is Failed, the Failed question offers **Merge anyway** (`v1.FailedRunMergeAnywayOffered` sets the choices), which only the user can answer; it records the advance with `by: 'human'` and a TED note.
- A Task at Merge with no open pull request finishes at once, as before: there is nothing to merge.

## Considered Options

- **Hold the merge as an obligation in `requireObligations`.** Rejected: obligations also gate `markDone` and rebases, and auto-merge and the sign-off need to follow the hold, which a mode gives.
- **Let the Task Lead trigger the merge itself.** Rejected: the merge watcher keeps the only path that merges, and the advance is the same signal every other Stage uses.
- **Make every Failure case after the advance require a new advance.** Rejected: TED closes some cases on its own (a later CI attempt passes) without telling the Task Lead, which would leave the Task waiting. The merge is held only while such a case is open.
- **Tell old Merge visits apart by date or daemon version.** Rejected: an event is the store’s normal record and needs no migration.

## Consequences

- Every Task with a pull request spends at least one Task Lead turn at Merge before it merges.
- An open request on the Task holds the merge, as before; the Task Lead’s own questions at Merge do too.
