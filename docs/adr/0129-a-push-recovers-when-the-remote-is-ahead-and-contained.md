# A push recovers when the remote branch is ahead of the recorded push and contained in the pushed commit

Ted pushes a Task branch with `--force-with-lease` against the commit it recorded as its last push (ADR 0048). When the branch on GitHub was at any other commit, the push failed with “stale info”, and nothing ever changed the record, so every later push and sign-off failed the same way. TED-177 was stuck like this: the record said `9eaef80d`, GitHub had `2ac276ea`, and the reviewed local commit `6b3cb1cd` contained both.

**A refused push looks at the remote.** `pushOne` in `tasks/pull-requests.ts` reads the worktree’s `HEAD` once, before the first push, and every later step uses that commit. When `pushBranch` fails for a branch that has a recorded push, `pushPastRecord` there:

1. Fetches the remote branch’s tip with `fetchBranch`. If the fetch fails, or the tip is the recorded commit, the first error stands: the push failed for another reason.
2. Checks with `isAncestor` that the commit read before the first push contains the fetched tip. If it doesn’t, the push fails with a message naming the remote tip, the commit being pushed and the recorded commit. Nothing is pushed and the record stays.
3. Records `v1.TaskPushRecordReconciled` (the old recorded commit and the fetched tip), which sets the stored pushed commit to the fetched tip and adds one line to the Task thread.
4. Pushes that same commit, not whatever `HEAD` is by then, with the fetched tip as the lease. When the fetched tip already is that commit, there is nothing to push.

The push that follows is a fast-forward, because the pushed commit contains the lease commit. A remote that moves between the fetch and the push fails the lease, and a commit the worktree gains after the first read isn’t pushed until the next push.

## Considered Options

- **A button or command the human starts.** Rejected by the human in Clarify: the containment check is what makes the recovery safe, and it needs no judgment.
- **Push without a lease when the remote is contained.** Rejected: a plain push would also be a fast-forward, but the lease is what stops a push over a branch that moved after Ted looked.
- **Ask in the Inbox when the remote holds commits that aren’t contained.** Rejected by the human in Clarify: the push fails as before, with a message that says what Ted found.
- **Repair the installed Ted’s store by hand for TED-177.** Rejected: the Task recovers at its next push once a release with this change is installed.

## Consequences

- Why a record falls behind is not settled. One way is a daemon that stops after the push lands and before `v1.TaskBranchPushed` is written, since CI detection runs between the two. This change recovers from that case and does not close the window.
- A branch that someone else pushed to stays blocked until the Task’s worktree contains those commits.
