# Daemon decision coverage (KRI-256, stage 2)

## Prioritization and measurement limits

At the start of TED-43, neither `node_modules/.cache/ted-test-times.json` nor
`node_modules/.cache/ted-test-failures.json` existed in this worktree. No saved
reports were found in its cache or timing/failure rankings in `docs/`. There is
therefore no historical failure ranking or per-file timing baseline to quote.
No full suite was run to manufacture one. The final measurement Task and the
human/merge own full-suite measurements and before/after performance claims.

The fallback priority was based on inspected setup cost and duplicated assertions:

1. Linear sync: both removed cases used the merge harness (temporary git remote,
   daemon, stub agents and HTTP Linear server). The missing-review-state case
   additionally walked through sign-off and merge.
2. Permission display: the removed Write-card case started a daemon, git repo and
   Claude stub solely to assert parsed title, command and JSON details.
3. Queue Priority: the removed case started a daemon, a working Run and two
   queued Tasks solely to assert order already exercised by `queueOrder`.
4. Status, merge steps and schedules: existing unit suites already cover their
   decision tables; integration cases also assert wiring and side effects, so
   they remain intact.

This ordering is qualitative, not a measured speed or failure ranking. The global
suite lock, process cleanup, test runner, Electron worker cap (3 in
`scripts/check.ts`) and node worker cap (6) are unchanged.

## Removed cases and their replacements

Paths below are relative to `packages/daemon/test/`. Titles name individual tests
so a reviewer can search them directly. No other cases or portions were deleted.

| Removed end-to-end case | Exact unit replacement | Retained integration coverage |
| --- | --- | --- |
| `linear-sync.test.ts` — “a team without a review state stays where it is at sign-off” | `linear-decisions.test.ts` — “a team without a review state skips the move and can still progress to Done” exercises the production `linearMove` and `pickState` functions, including a missing review target and the next Done target. | `linear-sync.test.ts` — “the issue moves to In Progress, gets the pull request once, In Review at sign-off, and Done when merged” retains HTTP writes, store progress, PR attachment deduplication, thread entries and merged-Task catch-up. The sync loop still records the attempted step even when `pickState` returns no state. |
| `linear-sync.test.ts` — “an issue already further along isn’t moved back” | `linear-decisions.test.ts` — “an issue already further along records progress without moving backward” checks both started and review targets; “recorded steps never repeat or move backward” checks record progression. | The same retained main-path Linear test exercises the loop’s use of the decision, writes and record deduplication. Cancellation, reopening, credentials, workspace matching and team-consent cases remain in `linear-sync.test.ts`. |
| `queue-limits.test.ts` — “a higher Priority Task queues ahead of earlier ones” | Existing `queue.test.ts` — “Tasks go by Priority, Urgent first, then by rank, across Factories” covers all Priorities and same-Priority rank ordering. | `queue-limits.test.ts` — “with the limit full, a started Task is Queued with its place and starts when a slot frees” retains queued-place serialization, slots endpoint ordering, absence of premature branches/Runs, pumping and slot release. Factory caps, setup holders, waiting Runs and daemon restart cases remain. |
| `permissions.test.ts` — “every field a Claude Code tool call would use is on the card” | `permission-decisions.test.ts` — “every field a Claude Code tool call would use is on the card and in the approved input” passes the same Write input directly through `permissionPromptFrom` and additionally checks `permissionReply` preserves it. | `permissions.test.ts` — “a prompt becomes a permission Comment in the thread and Inbox; Approve reaches the agent” retains Comment/Inbox persistence and actual reply delivery. All Codex grant, file-change and command cases remain, including automatic denial when the card cannot show a request. |

## Six-area audit and boundaries

| Area | Decision seam and unit coverage | Why remaining integration coverage stays |
| --- | --- | --- |
| Status choice | `tasks/status.ts`, `TaskFacts`; `status.test.ts` — “each status wins over every status below it”, chip payloads, markers and activity text. No deletions here. | Task lifecycle tests supply real facts; `queue-limits.test.ts` checks Queued places; `permissions.test.ts` checks open requests; `merge.test.ts` checks GitHub wait status. Pure precedence tests cannot prove these facts are collected and updated. |
| Queue order | `tasks/queue.ts`, `queueOrder` and `startsNow`; `queue.test.ts` covers class/Priority/rank order, machine room and Factory caps. One deletion mapped above. | Pumping, slot release, live updates, setting changes, setup and restart persistence remain in `queue-limits.test.ts`. |
| Linear sync | `linearMove` is a pure extraction of the existing target/rank decision in `tasks/linear-sync.ts`; the effectful loop still owns API calls, events, callbacks, consent and timing. `linear-decisions.test.ts` also covers inactive/merged Tasks, closed states and preferred names/position fallback. Two deletions mapped above. | API writes, linking, cancellation, reopening, workspace isolation and team consent remain in `linear-sync.test.ts`. No network client or store is started by the new unit tests. |
| Merge steps | `tasks/merge.ts`, `nextStep`, `ciState`, `chooseMethod`; `merge-steps.test.ts` already covers pending/failed/required checks, required reviews, changed heads, conflicts, moved bases and allowed methods. No deletions here. | `merge.test.ts` — “with no CI, Ted merges at once, deletes the branch, removes the worktree and releases blocked Tasks” is a main path. Failing CI sends back, rebase reruns Checks, draft/head changes return to Validate, and GitHub auth changes status: these cases check effects beyond `nextStep`. Multi-repo and Merge Gate tests stay. |
| Schedules | Protocol `schedule.ts`; `schedule.test.ts` already covers cron/RRULE intervals, DST, weekdays, invalid input, the minimum interval and display text. No deletions here. | `automations.test.ts` — “an Automation fires at its clock time in the app-wide time zone and the Run finishes” is a main path. Zone changes, queued Runs, skipped/missed firings and restart persistence stay. “the shortest interval is 15 minutes and bad schedules are refused” stays as route-level validation/preview wiring. |
| Permission rules | Agent `permissionPromptFrom` and `permissionReply`, plus `hidesText`; `permission-decisions.test.ts` covers Write fields/input, legacy quoting, unknown fields, invalid arguments, unshowable modern requests, grants and unsafe text. One deletion mapped above. | All authorization, app/file/Run token boundaries, actual approved/denied replies, agent-generation isolation, withdrawal, path labeling and hidden-text refusal wiring remain in `permissions.test.ts`. Legacy reply translation is agent-driver behavior, so its mixed integration case stays too. |
