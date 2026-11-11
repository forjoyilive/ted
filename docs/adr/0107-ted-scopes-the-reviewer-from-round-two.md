# From round two, TED scopes Validate’s reviewer to the fixes

_ADR 0112 adds a third scope: after send-backs that are all for a base conflict, the reviewer checks the conflict resolution, not the whole change. It also changes the `fixes` command when Work merged the base in between rounds. ADR 0111 means a Check failure straight after Work is no longer a send-back._

In two days of history, 17 Tasks had three or more send-backs and made up 102 of 137. Their rounds didn’t converge: each round’s Findings were a new edge case in different code, because the Task Lead ran a fresh full-branch review every round. The Stage file already said to give the reviewer the earlier Findings and ask only whether they were fixed. An instruction the Task Lead may skip wasn’t enough, so TED now writes the reviewer’s scope itself.

**What TED records.** When the Task Lead requests a reviewer in Validate, `v1.ReviewScopeRecorded` stores, keyed by the reviewer’s Run ID: the round, `full` or `fixes`, the HEAD commit of each of the Task’s worktrees at that moment (`commits`), and for `fixes` the commits the review starts from (`since`). The round is one more than Validate’s counted send-backs in the current series, the same count `max_back` uses.

**When a round is scoped.** `reviewRound` in `tasks/tasks.ts` takes the newest reviewer of an earlier Validate visit that finished a review (it has a final message and didn’t fail). The round is `fixes` only when all of these hold:

- every send-back recorded after that reviewer is a counted send-back from Validate to Work in the current series, and at least one of them is not a Check failure;
- none of them has the cause `base-conflict` (ADR 0110);
- the Task has the same repos, and in each one the commit that reviewer started at is an ancestor of HEAD.

Anything else is a `full` round with the Task Lead’s prompt, as before: the first round, a round after a Check failure with no review before it, a send-back from Review or from the human at a Gate (both reset the series or sit outside it), Back to Design, a send-back for a conflict with the base branch, a rebased or rewritten branch, a changed Repos field.

A `base-conflict` send-back from Validate or Review is uncounted and one from Merge isn’t from Validate, so the first condition already excludes them; the second states it. Work resolved a conflict since the last review, and the earlier Findings don’t cover that resolution, so the round is a full review and `validateRoundText` says so in place of the “checks the fixes” rule.

**What the reviewer is told.** For a `fixes` round the request’s prompt is `scopedReviewPrompt` in `tasks/review-rounds.ts`, started under “Your instructions from TED” like the loop check. It holds the earlier rounds’ blocking Findings (Check failures left out, each round cut at 8,000 characters), `git diff <since> <HEAD>` for each repo with the changed files, and three rules: say for each Finding whether it is fixed; check the fixes broke nothing in the lines they changed or in code that depends on them; don’t review the rest of the branch, and report a problem in untouched code as a note unless it is P1. P1 means lost or corrupted data, a security hole, or broken behaviour the Task’s description asks for. The Task Lead’s prompt file follows as context and can’t widen the scope.

The Findings and the Task Lead’s text are each quoted between two fence lines with a fresh nonce, the way Linear and GitHub text is, and TED’s prompt says the scope wins where the Task Lead’s text asks for more.

**What the Task Lead is told.** TED adds to its own messages, not only the Stage file:

- At a send-back from Validate to Work, `workRoundText`: the send-back number and limit, fix the Findings and nothing else because every other changed line is reviewed again, and run `ted checks` after the last commit.
- At Validate entry in round two or later, and in the prompt of a fresh Task Lead started in Validate, `validateRoundText`: the round and limit, the earlier Findings, that TED scopes the one reviewer, and that a new Finding about code the fixes didn’t touch is a note unless it is P1. After a `base-conflict` send-back it says instead that the round reviews the whole change again, including the conflict resolution, and that any Finding can be blocking.

The first round is unchanged, so a first review catches what it caught before.

## Considered Options

- **Finding the last reviewed commit from send-back times**, as the loop check does (`git rev-list -1 --before=<time>`). Rejected: a commit made after the reviewer started and before the send-back would count as reviewed, and committer dates don’t survive an amend.
- **A new `v3.TaskSentBack` with the reviewed commit.** Rejected: the commit belongs to the reviewer’s start, not the send-back, and a Validate that passes has no send-back to carry it.
- **Putting the diff text in the prompt.** Rejected: it can be large, and the reviewer already works in the worktree and can run `git diff`.
- **Refusing the Task Lead’s prompt file in scoped rounds.** Rejected: the reviewer still needs the Task, the acceptance criteria and repo guidance, which only the Task Lead writes.

## Consequences

- TED can’t stop a Task Lead that reviews the whole branch itself or runs a review tool from its shell. The Validate entry text tells it not to; ADR 0108 closes the `ted run start` path.
- A serious bug the first review missed in untouched code is found in a later round only if the reviewer notices it and it is P1. That is the intended trade: later rounds check fixes.
- Anything new that sends a Task back from Validate, or changes history under a Task’s branch, must keep `reviewRound`’s conditions true or the next round falls back to a full review.
