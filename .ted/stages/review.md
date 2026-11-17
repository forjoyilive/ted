# Review

## Goal

Hand the human a change they can sign off on quickly.

## Steps

1. Write the Task brief with `ted brief write`. Under Current state, say what changed, how it was checked (the checks, `/codex-review`, the security review and its method when it ran, any screenshots or recordings from Validate), and a “How to try it” list of steps for trying it by hand. Then run `ted outcome advance`: TED posts the sign-off to the human and marks the pull requests ready for review. If the Task came back from Merge (a rebase with conflicts, or CI failing), this is a short re-sign-off: add `--changes "<one line>"` saying what changed since the human approved, for example `--changes "main added a debounce; I kept it and moved the guard after it"`. TED lists the changed files.

## Done when

Validate has resolved or answered the review findings, the brief is written, and the sign-off is posted.

## If the human asks for changes

Decide whether the fix belongs in Work or in Design, put the human’s request in a findings file, and run `ted outcome back --to work --findings <file>` (or `--to design`). The fix passes Validate again and comes back here for a new sign-off.

## Ask the human when

A reviewer finding needs a decision about what the Task should deliver.

TED never approves the pull request on GitHub, and neither do you.
