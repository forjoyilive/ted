# Merge

## Goal

Let TED merge the Task’s pull requests.

## Steps

1. Don’t merge, push or report an outcome. TED waits for CI, merges each pull request with `gh pr merge` under the human’s login, deletes the branch and moves the Task to Done.
2. With a Merge sign-off, TED posts the Merge sign-off itself once CI passes, and merges when the human approves it. With Merge off, the human merges on GitHub and TED moves the Task to Done when it sees the merge.
3. If the base branch moves, TED rebases the pull request on GitHub and runs the local Factory Checks again. If a Check fails, the Task stays in Merge for diagnosis. Investigate the Failure case, add evidence and assess regression, unrelated or uncertain. A supported regression assessment lets the merge watcher send the Task back through Work, Validate and Review sign-off. For unrelated or uncertain failures, ask the user with `ted failure ask <id>`; they can Retry, Fix in this Task, Accept this failure or wait for a repair Task. Acceptance covers only that failure in its tested context and continues the remaining Checks. A new failure needs its own decision; original failures stay failed. Only TED’s merge watcher progresses Merge. Do not advance, merge or approve the Task.
4. If CI fails, the branch conflicts with its base, or the branch changes after sign-off, TED sends the Task back to Work with Findings. Fix it there; the Task comes back through Validate for a short re-sign-off.
5. If CI doesn’t report, TED asks the human. If they send it to you, the Task comes back to Work with what TED saw.
6. If the human cancels the merge with a Comment, it counts as Request changes: send the Task back to Work or Design with `ted outcome back`.
7. With several repos, TED merges in `repos` order, and only once every pull request is ready. If a merge fails after another merged, the Task shows Partly merged and goes back to Work. Fix only the repos that haven’t merged; TED never reverts a merged pull request.

8. If a failure decision offers Wait for a repair Task, the user selects existing work or approves creation of a focused repair in this Factory. TED keeps this Stage and worktree, records the original failure and repair link in the brief, and stops the Task Lead without holding a working-Run slot. After the repair merges, TED queues continuation and incorporates it before fresh verification. Check the thread if incorporation is held. Archive, deletion or manual unblock never passes validation; a manually unblocked Task needs Resume. Existing revalidation and re-sign-off rules still apply, and only TED’s merge watcher can move Merge forward.

## Done when

TED has merged every pull request. Diagnose local post-rebase Check failures when TED reports them; the merge watcher owns progression.

## Ask the human when

When a local post-rebase Check fails for an unrelated or uncertain reason, record your assessment and ask through its Failure case. Answer any other question the human asks here.
