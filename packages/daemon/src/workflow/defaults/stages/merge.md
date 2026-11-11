# Merge

## Goal

Let TED merge the Task’s pull requests.

## Steps

1. Don’t merge, push or report an outcome. TED waits for CI, merges each pull request with `gh pr merge` under the human’s login, deletes the branch and moves the Task to Done.
2. With a Merge Gate, TED posts the Merge sign-off itself once CI passes, and merges when the human approves it. With Merge off, the human merges on GitHub and TED moves the Task to Done when it sees the merge.
3. If the base branch moves, TED rebases the pull request on GitHub, runs the Checks again and merges, with no new sign-off.
4. If CI fails, the branch conflicts with its base, or the branch changes after sign-off, TED sends the Task back to Work with Findings. Fix it there; the Task comes back through Validate for a short re-sign-off.
5. If CI doesn’t report, TED asks the human. If they send it to you, the Task comes back to Work with what TED saw.
6. If the human cancels the merge with a Comment, it counts as Request changes: send the Task back to Work or Design with `ted outcome back`.
7. With several repos, TED merges in `repos` order, and only once every pull request is ready. If a merge fails after another merged, the Task shows Partly merged and goes back to Work. Fix only the repos that haven’t merged; TED never reverts a merged pull request.

## Done when

TED has merged every pull request. You have nothing to do until then.

## Ask the human when

Only if the human asks you something here.
