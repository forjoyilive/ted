# Checks run before a Task leaves Work

ADR 0044 ran the Factory’s Checks when a Task entered Validate, and a failure there was a counted send-back to Work. About 3 of 137 measured send-backs were only a failed Typecheck or Lint straight after Work reported it was finished. Each cost a Stage change, a push, a draft pull request update and a round against `max_back`, for something the Task Lead could have fixed where it was.

## Decision

When the Task Lead reports `ted outcome advance` at Work, the next Stage is Validate, Work has no Gate and the Factory has Checks that apply, TED runs the Checks before the Stage changes.

- The order on that `advance` is: obligations, the base-conflict test-merge (ADR 0108), then the Checks. A conflict refuses the outcome first, because Checks on a branch that can’t merge say little.
- The outcome request answers at once with “TED is running the Checks”; the Checks run in the background as a Check run with the trigger `hand-off` and the Stage `work`, through the same `beginChecks` and `runChecks` as every other Check run. The sandbox, Check slots, low priority, the Task’s “Running Checks” activity and the refusal of `ted outcome` and `ted checks` while Checks run all apply unchanged. `v1.ChecksStarted` already stores the trigger as a string, so there is no new event.
- **Pass.** `handOffChecks` in `tasks/tasks.ts` moves the Task to Validate and hands the finished Check run to `validateChecks`, which delivers Validate’s instructions with that run’s results and starts no second run. `judge` picks the same run for the confirmation row: the newest passed `hand-off` run of the Work visit just before this Validate visit, when the visit has no `validate` run of its own. The push and the draft pull request still happen at Validate entry, so nothing is pushed for a branch whose Checks fail.
- **Fail.** The Task stays in Work. The Task Lead gets “# A Check failed” with the same Findings a Validate failure carries (the failing Check’s last 200 lines through `redactSecrets`, and the log path). No `v2.TaskSentBack` is recorded and nothing counts toward `max_back` or the Loop check.
- **Three failures.** After three failed `hand-off` runs in one Work visit, TED posts a `question` (“Checks have failed 3 times as NB-1 tried to leave Work”, one choice, **Try again**) and records it with `v1.SendBackAsked` whose `from` and `to` are both `work`. That reuses the rule that `ted outcome` is refused while a send-back ask is open, and the thread words a same-Stage ask as failing Checks, not a send-back. The human’s answer, with any text, goes to the Task Lead the way any answer does, and the count starts again from the answer.
- **The branch moved.** TED notes each worktree’s `HEAD` before the Checks start. If a `HEAD` differs when they pass, TED doesn’t move the Task and tells the Task Lead to report again, so the run Validate uses is always for the commit TED pushes.
- **Restart.** A daemon that stops mid-run marks the Check run interrupted on start. If its trigger is `hand-off` and the Task is still in Work, TED runs the Checks again and moves the Task if they pass, as it reruns interrupted `validate` runs.

Validate entered any other way still runs the Checks at entry as ADR 0044 describes, and a failure there is still a counted send-back with the cause `check`: a send-back from Review to Validate, the merge watcher’s send-back to Validate, the human’s approval of a Work Gate, and a Workflow whose Stage before Validate isn’t Work.

A setup Task’s hand-off run uses its narrowed Checks, because `beginChecks` chooses them. Overnight mode changes nothing here: Work’s Gate, when the mode turns it off, is recorded as skipped when the Task moves after the Checks pass, and the three-failures question waits for the human like any other question.

## Considered Options

- **Hold the `ted outcome advance` request open until the Checks finish.** Rejected: Checks can run for many minutes, and ADR 0044 already keeps a long Check from holding an HTTP request.
- **Require a passed `ted checks` run on the current commit before `advance`.** Rejected: it leaves the work to the Task Lead, which is what the Stage file already asked for and what the three measured send-backs skipped.
- **Move to Validate first and undo the Stage change on failure.** Rejected: the push, the draft pull request and the Stage entry would already have happened.
- **A new event for the three-failures question.** Rejected: `v1.SendBackAsked` already blocks outcomes, shows in the thread and survives a restart; a same-Stage ask can’t be mistaken for a real one because no Stage sends back to itself.
- **Count a failed hand-off run toward `max_back`.** Rejected: nothing was reviewed and no round happened. The three-failures question is the bound.

## Consequences

- A Task Lead that reports `advance` at Work gets its answer later, in a message, not in the command’s output. The Work Stage file and `workRoundText` say so.
- A Check failure straight after Work no longer appears as a send-back. A dashboard that wants them counts `hand-off` Check runs with the outcome `failed`.
- With Checks configured, the `check` send-back cause now comes only from the other ways into Validate.
- A Work Stage with a Gate keeps the old order: the human approves, the Task enters Validate, the Checks run there.
