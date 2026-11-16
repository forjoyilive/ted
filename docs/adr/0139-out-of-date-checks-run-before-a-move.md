# Out-of-date Checks run before a move instead of refusing it

Before a Task moves past Validate, `requireCoverage` in `packages/daemon/src/tasks/validation.ts` checks that the Factory’s Checks passed on the code as it is now. When the code, the Check plan or the Validate visit had changed since they ran, it refused with “Validate Check coverage is stale or incomplete; run ted checks before advancing.” The human saw that on Mark done and approving a sign-off, and could do nothing about it in the app: `ted checks` is a Task Lead command. Mark done hit it most, because it checked coverage before recording the merge, so it compared the Check plan read from the default branch, which by then held the Task’s own changes.

## The rule

- **Mark done compares code only.** `markDone` passes `mergedOnGitHub` through `requireObligations` to `currentCoverage`, which then judges the Task as it judges a merged one: the plan is ignored and only the tested code is compared.
- **Out of date means run them.** `requireCoverage` throws `StaleCoverageError` only when the Checks haven’t run on the current inputs. A Check that ran and failed is a plain 409 naming the failure case, so a failure is never rerun by a click.
- **The action waits for the Checks.** `checksFirst` in `tasks/tasks.ts` wraps Mark done and the Task Lead’s `ted outcome advance`; approving a sign-off in `request-answers.ts` records the approval and hands the move to `checksThen`. `checksThen` starts the Checks through `validation.begin` (trigger `merge` at Merge, `agent` elsewhere, so Validate and Merge record a failure as a failure case), or waits for Checks already running, and answers at once. When they pass it runs the same action again from the start, with every other refusal still in place. Stale again: one more run, then a Ted note. A failure: the Task stays put and Ted posts a note and tells the Task Lead.
- **One at a time, in memory.** A Task has at most one waiting move. Stopping, archiving or a daemon restart drops it; the human clicks again. Nothing new is stored.
- **What the human sees.** `movingAfterChecks` in `TaskFacts` makes the activity line “Running Checks before moving on”. The request answers 200, so the app shows no error.

## Tests

`status.test.ts` covers the activity line, `request-answers.test.ts` an approval while the Checks are out of date, `validate-coverage.test.ts` advancing with a changed plan, changed code and a failing Check, and `merge-gate.test.ts` Mark done after the Check plan changed on the default branch.
