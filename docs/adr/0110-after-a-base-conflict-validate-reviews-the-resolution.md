# After a base conflict, Validate reviews the resolution

ADR 0108 left the Validate round after a `base-conflict` send-back as a full review of the whole branch. For the 29 measured conflict send-backs from Review and Merge, Validate had already reviewed the branch; only the conflict resolution was new.

## Decision

`reviewRound` in `tasks/tasks.ts` gives the round a third scope, `conflict`, when all of these hold:

- an earlier Validate visit has a reviewer that finished a review, so `v1.ReviewScopeRecorded` holds the commits it started at;
- at least one send-back was recorded after that reviewer started, and every one of them has the cause `base-conflict`;
- the Task has the same repos as that review, and in each one the reviewed commit is on the first-parent chain of `HEAD` (`ownCommits` in `git.ts`), so the Task’s own commits since the review can be listed;
- every merge commit on that chain has two parents and brought in a commit TED knows is on the base branch: an ancestor of a tip TED fetched for this Task, either recorded in `v1.BaseConflictFound` (ADR 0111) or fetched at the last hand-off in this daemon’s lifetime.

Anything else after a `base-conflict` send-back stays a full review with ADR 0105’s “reviews the whole change again” text: a review or Check send-back among them, a rebased or rewritten branch, a changed Repos field, a merge of something TED can’t place on the base branch, a daemon restart that lost the only known tip.

**What the reviewer is told.** `conflictReviewPrompt` in `tasks/review-rounds.ts`, under “Your instructions from TED”. For each repo it names each merge commit, the base commit it brought in and the files that conflicted, and gives one command:

- `git show --remerge-diff <merge>` when the only commit since the last review is one merge;
- `git log -p --reverse --first-parent --remerge-diff <reviewed>..<HEAD>` when there are other commits too. It shows each of the Task’s own commits and, for each merge, only what the resolution changed against git’s own merge result;
- `git diff <reviewed> <HEAD>` when there is no merge commit, because Work changed its own code until the branch stopped conflicting.

The reviewer checks that the resolution keeps both sides’ behaviour and that it, and any other commit since the last review, broke nothing in the lines touched. It doesn’t review the rest of the branch or what the base branch brought in; a problem elsewhere is a note unless it is P1. The Findings of the send-backs since the last review and the Task Lead’s prompt file are each quoted between fence lines with a fresh nonce, and file names have control characters removed and are cut at 300 characters, as in the `fixes` prompt.

The conflicting files come from git, not from the Findings text: TED test-merges each merge commit’s two parents with `mergeConflicts`. Where a send-back recorded its conflict (`v1.BaseConflictFound` with a `sendBackId`), the prompt lists those files too.

**What is recorded.** `v1.ReviewScopeRecorded` with `scope: 'conflict'` and `since`. The event’s `scope` is a plain string, so this is a new value and not a new event. A later round treats a finished `conflict` review like any other finished review.

**What the Task Lead is told.** `conflictRoundText`, at Validate entry and in a fresh Task Lead’s prompt, in round one too: this round checks how the conflict was resolved, TED scopes the one reviewer, and a Finding about code the resolution didn’t touch is a note unless it is P1.

**The `fixes` diff no longer includes the base.** When Work resolved a conflict in place between two `fixes` rounds (no send-back, ADR 0108), `git diff <reviewed> <HEAD>` showed everything the base merge brought in. When the reviewed commit is on `HEAD`’s first-parent chain and every merge on it is a verified base merge, the `fixes` prompt now gives the same `git log -p --reverse --first-parent --remerge-diff` command and lists the Task’s own files and the conflicting files. Otherwise it keeps `git diff`, which shows too much but hides nothing.

## Not done

- **The last passed Validate’s pushed commit as the starting point.** A Task whose last review predates `v1.ReviewScopeRecorded` has no recorded reviewed commit. The pull request’s `pushed.commit` can’t stand in: by the time the next reviewer is requested, Validate entry has pushed the new `HEAD` over it. Such a Task gets a full review.
- **A rebased branch.** `git range-diff` against the reviewed commit could scope it. It stays a full review.

## Considered Options

- **Read the conflicting files from the send-back’s Findings.** Rejected: Findings are free text the Task Lead wrote, and the merge watcher’s send-backs name no files.
- **Limit the fallback to `git diff <reviewed> <HEAD> -- <conflicted files>`.** Rejected: a `base-conflict` send-back from Validate can carry real review Findings in the same Findings file, and Work’s fixes for them may sit in other files. Showing every commit of the Task since the review can’t hide them.
- **Trust any merge commit as a merge of the base.** Rejected: `--remerge-diff` hides what a merge brought in, so a merge of some other branch would put unreviewed code past the reviewer.
- **Persist the fetched base tip at every hand-off.** Rejected for now: an event per `advance` for a value needed only in the round after a conflict. Losing it on a restart costs one full review.

## Consequences

- A base change that breaks the Task without a textual conflict (a renamed function, say) is not in the reviewer’s scope. The Checks run on the merged branch before Validate (ADR 0109) and are what catches it.
- `--remerge-diff` needs git 2.36 or newer; `mergeConflicts` already needs 2.38.
- Anything new that sends a Task back with the cause `base-conflict`, or changes history under a Task’s branch, must keep `reviewRound`’s conditions true or the round falls back to a full review.
