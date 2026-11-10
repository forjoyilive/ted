# Review

## Goal

Prepare the human review and sign-off when this Stage is enabled, using Validate’s code review, security review and evidence.

## Steps

1. Read Validate’s Findings, Checks and evidence against the acceptance criteria. Reuse its code review and security review for unchanged work. If either review is missing or later changes need review, write the gap in a Findings file and run `ted outcome back --to validate --findings <file>`. If the Workflow omits Validate, ask the human how to restore validation before sign-off.
2. Before posting the sign-off, use `codex-review` if the skill is available to your agent; otherwise check the committed diff against the acceptance criteria and repo standards manually, using Validate’s review as evidence. When the change touches security-sensitive areas listed in the repo’s `AGENTS.md`, use `security-review` if the skill is available to your agent, or review those areas manually using Validate’s security evidence. These checks supplement Validate’s independent reviews. Check that Validate resolved the blocking Findings and carried forward the notes. If a fix is needed, send it to Work as described below so it passes Validate again.
3. If a difficulty in this Task exposed a repeatable process problem, post a short note citing what happened and a candidate improvement for future work. Keep changes to tooling, standards or Workflow outside the agreed scope as proposals for the human; a smooth Task needs no retrospective note.
4. Write the Task brief with `ted brief write`. Under Current state, say what changed, how it was checked (the Checks, the code review, the security review’s scope, method and outcome, any screenshots or recordings from Validate), any remaining notes, and a “How to try it” list of steps for trying it by hand. The human tries it from this branch before signing off, so never write “after this change is installed”. When one of the Factory’s Apps shows the change, the first step is “Press ▶ <App> in the sign-off’s Preview row (or under Apps)”, followed by what to click and what to look for. When no App shows it, give the manual steps from a shell in the Task’s worktree. Then run `ted outcome advance`: TED posts the sign-off to the human and marks the pull requests ready for review. If the Task came back from Merge (a rebase with conflicts, or CI failing), this is a short re-sign-off: add `--changes "<one line>"` saying what changed since the human approved, for example `--changes "main added a debounce; I kept it and moved the guard after it"`. TED lists the changed files.

## Done when

Validate has completed both reviews and resolved the blocking Findings, the brief is written, and the sign-off is posted.

## If the human asks for changes

Decide whether the fix belongs in Work or in Design, put the human’s request in a Findings file, and run `ted outcome back --to work --findings <file>` (or `--to design`). The fix passes Validate again and comes back here for a new sign-off.

## Ask the human when

A reviewer finding needs a decision about what the Task should deliver.

TED never approves the pull request on GitHub, and neither do you.

Include every accepted failure in the brief with its assessment, evidence and human decision, labelled “failed, accepted by you”. Keep it distinct from passed Checks. Confirm all remaining Checks and reviewer/visual obligations were completed. Acceptance resolves only that failure and never grants this Gate or merge approval.
