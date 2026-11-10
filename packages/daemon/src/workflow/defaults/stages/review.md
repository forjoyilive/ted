# Review

## Goal

Hand the human a change they can sign off on quickly.

## Steps

1. Read Validate’s Findings, Checks and evidence against the acceptance criteria. Reuse its independent review for unchanged work. If Validate was skipped or later changes need review, start the reviewer with `ted run start --reviewer --prompt-file <file>` and wait with `ted run wait <id>`. Supply the Task, Design brief, repo guidance and committed diff against a stated base, with no Work conversation. Ask for correctness, test coverage and compliance with the request and repo rules, citing each Finding’s file, line and requirement. Include security when the change touches input, files, processes, network or credentials.
2. Resolve confirmed Findings. If a fix is needed, send it to Work as described below so it passes Validate again. Reuse passing Checks for unchanged work; run `ted checks` again when new changes or an unresolved concern warrant it.
3. If a difficulty in this Task exposed a repeatable process problem, post a short note citing what happened and a candidate improvement for future work. Keep changes to tooling, standards or Workflow outside the agreed scope as proposals for the human; a smooth Task needs no retrospective note.
4. Write the Task brief with `ted brief write`. Under Current state, say what changed, how it was checked (the Checks, the reviewers, any screenshots or recordings from Validate), and a “How to try it” list of steps for trying it by hand. The human tries it from this branch before signing off, so never write “after this change is installed”. When one of the Factory’s Apps shows the change, the first step is “Press ▶ <App> in the sign-off’s Preview row (or under Apps)”, followed by what to click and what to look for. When no App shows it, give the manual steps from a shell in the Task’s worktree. Then run `ted outcome advance`: TED posts the sign-off to the human and marks the pull requests ready for review. If the Task came back from Merge (a rebase with conflicts, or CI failing), this is a short re-sign-off: add `--changes "<one line>"` saying what changed since the human approved, for example `--changes "main added a debounce; I kept it and moved the guard after it"`. TED lists the changed files.

## Done when

The review findings are fixed or answered, the brief is written, and the sign-off is posted.

## If the human asks for changes

Decide whether the fix belongs in Work or in Design, put the human’s request in a Findings file, and run `ted outcome back --to work --findings <file>` (or `--to design`). The fix passes Validate again and comes back here for a new sign-off.

## Ask the human when

A reviewer finding needs a decision about what the Task should deliver.

TED never approves the pull request on GitHub, and neither do you.
