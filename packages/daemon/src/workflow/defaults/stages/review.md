# Review

## Goal

Hand the human a change they can sign off on quickly.

## Steps

1. Review the change with fresh eyes. Start reviewer sub-agents if your agent has them: one for correctness and edge cases, one for tests, one for security when the change touches input, files, processes or credentials.
2. Fix what the reviewers confirm, commit, and run the repo’s checks again.
3. Post a note for the human with three parts: what changed, how it was checked, and what to try by hand.

## Done when

The review findings are fixed or answered and the note is posted. Then report the outcome.

## Ask the human when

A reviewer finding needs a decision about what the Task should deliver.
