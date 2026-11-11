# Base conflicts are checked at hand-off and recorded as a send-back’s cause

Over two days, 43 of 137 send-backs (31%) said only that the pull request conflicted with its base branch: 20 from Merge, 9 from Review, 14 from Validate. Each one cost a Work visit and a full Validate visit with a reviewer Run.

## What produced them

All three paths start from GitHub reporting a real textual conflict, not from a branch that was only behind.

- **Merge.** `nextStep` in `tasks/merge.ts` returns `conflict` when the pull request is `CONFLICTING` or `DIRTY`, and the merge watcher sends the Task back to Work. It also sends back when `mergeStateStatus` is `BEHIND` and GitHub’s rebase (`rebasePullRequest`) fails with a conflict. `BEHIND` appears only when the base branch requires branches to be up to date; a repo without that rule never takes this path.
- **Validate and Review.** The poller’s `noticesFor` in `tasks/github-activity.ts` makes a conflict notice when the pull request is `CONFLICTING`, and `activityMessage` told the Task Lead to send the Task back to Work with `ted outcome back`. From Validate that send-back counted toward `max_back` and the Loop check.

Bringing the base into the branch earlier, when that is conflict-free, does not prevent these. A three-way merge conflicts where the branch’s changes overlap the base’s changes since the merge base. If the branch merged cleanly with the base at one point, a later base change conflicts with the branch’s own changes whether or not TED merged the earlier base in. An earlier clean update helps only the `BEHIND` path, where GitHub’s rebase replays each commit and can conflict on a branch that a merge would take cleanly.

What was avoidable is where the conflict was found. A Task’s first Work visit has no pull request, so the poller says nothing; the conflict surfaced only after Validate’s push, Checks and reviewer had started. On later Work visits the pull request still shows the last pushed commit, and a conflict notice is sent once per head commit, so a base that moved again after the Task Lead resolved one conflict went unreported until Validate too. And a notice at Validate or Review was advice the Task Lead could pass over, which left the conflict to Merge, after the human’s sign-off.

## Decision

**TED test-merges the base at every hand-off.** When the Task Lead reports `ted outcome advance` at Work, Validate or Review, `baseConflict` in `tasks/tasks.ts` fetches each repo’s base branch tip with `fetchBranch` and test-merges it with the worktree’s `HEAD` through `mergeConflicts` in `git.ts` (`git merge-tree --write-tree` in a scratch bare repo that borrows the clone’s objects; nothing in the worktree, its index or its refs changes). If files conflict, the outcome is refused with 409 and the Task stays where it is:

- At Work the message names the base commit and the conflicting files and tells the Task Lead to merge that commit, resolve, run the tests and Checks the conflict touches, commit and report again. No Stage changes and no send-back is recorded.
- At Validate and Review the message tells the Task Lead to send the Task back to Work with `--cause base-conflict`. This happens before the sign-off is posted or the Task reaches Merge, so the human doesn’t sign off a branch that can’t merge.

A fetch or test-merge that fails (offline, a history TED can’t read) lets the outcome through; the poller and the merge watcher still catch the conflict later. A branch that is behind but merges cleanly passes: GitHub merges it, and the `BEHIND` rebase at Merge is unchanged.

**A send-back carries its cause.** `base-conflict` is one more value of the cause ADR 0109 records: `store.recordSendBack({ cause })` commits `v1.SendBackCauseRecorded` beside the unchanged `v2.TaskSentBack`, and `SendBack.cause` carries it to clients. That event has a Task log entry, which the thread reads to end the line with “· base conflict”.

- The merge watcher sets it on both of its conflict send-backs. They still count toward Merge’s `max_back`, which is the only limit on a Task that keeps conflicting at Merge.
- From Validate or Review, the Task Lead names it with `ted outcome back --to work --cause base-conflict`. TED records the cause only when its own test-merge finds the conflict. It then appends the base commit and the conflicting files to the Findings and does not count the send-back toward `max_back` or the Loop check, because a moved base says nothing about whether review rounds are converging. If TED finds no conflict, it is an ordinary send-back and the reply says so. After the human asked for changes at the Gate the flag is ignored. A verified conflict also goes back from Validate while a failure case is open without a regression assessment: a Check result on a branch that can’t merge says little, and the next Validate visit runs the Checks again. The obligations check on `advance` still runs before the test-merge.

The poller’s conflict notice outside Work now names the flag.

## Not done here

_The first item is now built (ADR 0112), and conflicts caught at Work are now in the store (ADR 0113)._

- **Scoping the next Validate to the conflict resolution.** After a `base-conflict` send-back from Review or Merge, Validate had already passed on the last commit TED pushed (`pushed.commit`). The next Validate could give the reviewer only the resolution: `git show --remerge-diff` for a merge, `git range-diff` against `pushed.commit` for a rebase. Not built: `reviewRound` (ADR 0107) gives the Validate round after a `base-conflict` send-back a full review from the Task Lead’s prompt, never a `fixes` round, because the earlier Findings say nothing about the resolution. The recorded cause is what a narrower scope would need.
- **Resolving in place at Validate.** Letting the Task Lead resolve the conflict inside Validate would skip the Work visit, but TED would have to rerun the Checks itself and decide who reviews the resolution. Nothing is signed off at Validate, so it is possible; it needs a decision on Validate’s rule that fixes belong in Work.
- **A merge update when GitHub’s rebase conflicts.** At `BEHIND`, TED could ask GitHub for `updateMethod: MERGE` after a failed rebase and verify the result the way `adoptRebase` does. It matters only for repos that require up-to-date branches.

## Considered Options

- **TED merges the base into the Task branch itself when that is clean** (at Validate entry, or when the poller reports the branch behind). Rejected for this problem: it removes none of the measured send-backs, for the reason above, and it would add a second place where TED writes commits to a Task branch and moves the worktree.
- **Infer the cause from the Findings text or from a conflict notice sent in the same visit.** Rejected: Findings are free text, and a notice in the visit doesn’t mean the conflict was the only Finding.
- **Trust the Task Lead’s `--cause` without checking.** Rejected: an uncounted send-back would then be a way around `max_back`.
- **Add `cause` to `v2.TaskSentBack`.** Rejected: shipped events aren’t edited (ADR 0010).
- **A `v3.TaskSentBack` with a `cause` field.** Rejected for the reasons in ADR 0109, which already records causes in their own event.

## Consequences

- `ted outcome advance` at Work, Validate and Review makes one fetch of the base branch per repo, with a 60-second limit, while the Task’s outcome is being handled.
- A dashboard can count `cause: 'base-conflict'` send-backs by `from`. Conflicts caught at Work are refusals, not send-backs, and aren’t in the store.
- A Merge send-back that goes over `max_back` becomes a question; if the human sends the Task back from it, that send-back has no cause.
- A custom Stage file that tells the Task Lead to advance regardless gets the same refusal.
