# Review

## Goal

Hand the human a change they can sign off on quickly.

## Steps

1. Review the change with fresh eyes. Start reviewer sub-agents if your agent has them, each with no Work context and only the diff against the base branch. Suggested reviewers:
   - **Correctness:** “Read this diff as a senior engineer seeing it for the first time. List bugs, missed edge cases and behaviour that doesn’t match the Task description. Cite file and line for each.”
   - **Tests:** “Check that the tests in this diff fail without the change and pass with it, and that they cover the edge cases. List untested behaviour.”
   - **Security,** when the change touches input, files, processes, network or credentials: “Look for injection, path traversal, secrets in logs or output, and unsafe use of shell commands. Rate each finding.”
2. Fix what the reviewers confirm, commit, and run the repo’s checks again with `ted checks`.
3. Write the Task brief with `ted brief write`. Under Current state, say what changed, how it was checked (the Checks, the reviewers, any screenshots or recordings from Validate), and a “How to try it” list of steps for trying it by hand. The human tries it from this branch before signing off, so never write “after this change is installed”. When one of the Factory’s Apps shows the change, the first step is “Press ▶ <App> in the sign-off’s Preview row (or under Apps)”, followed by what to click and what to look for. When no App shows it, give the manual steps from a shell in the Task’s worktree. Then run `ted outcome advance`: TED posts the sign-off to the human and marks the pull requests ready for review. If the Task came back from Merge (a rebase with conflicts, or CI failing), this is a short re-sign-off: add `--changes "<one line>"` saying what changed since the human approved, for example `--changes "main added a debounce; I kept it and moved the guard after it"`. TED lists the changed files.

## Done when

The review findings are fixed or answered, the brief is written, and the sign-off is posted.

## If the human asks for changes

Decide whether the fix belongs in Work or in Design, put the human’s request in a Findings file, and run `ted outcome back --to work --findings <file>` (or `--to design`). The fix passes Validate again and comes back here for a new sign-off.

## Ask the human when

A reviewer finding needs a decision about what the Task should deliver.

TED never approves the pull request on GitHub, and neither do you.
