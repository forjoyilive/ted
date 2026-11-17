# Checks run when a Task enters Validate from Work

_Superseded by ADR 0187-the-checks-run-as-validates-first-step-and-every-return-to-work-counts: the Checks now run as Validate’s first step, a failure there is a counted return to Work that also counts toward the Loop check, the limit question offers Keep going and Stop the Task, and nothing is pushed before Merge. There are no `hand-off` Check runs, no Diagnose in Validate and no three-failures question. What follows is the TED-539 version of this ADR, kept as the record._

ADR 0044 ran the Factory’s Checks when a Task entered Validate, and a failure there was a counted send-back to Work. Later a failure at Validate entry stayed in Validate as a failure case for diagnosis (ADR 0095-failure-cases-preserve-results-and-bind-human-decisions, `tasks/validation.ts`), and a regression still cost a counted send-back. About 3 of 137 measured send-backs were only a failed Typecheck or Lint straight after Work reported it was finished.

The first version of this ADR ran those Checks in Work, before the Stage changed, so a failure cost no Stage change, push, draft pull request update or round against `max_back`. Users read that as Work running the tests, though `.ted/workflow.yaml` lists the Checks under Validate and they are validation. TED-539 moved them into Validate and made a failure a counted send-back again, so what the user sees matches the Workflow. The file keeps its name so links to it still work.

## Decision

When the Task Lead reports `ted outcome advance` at Work, the next Stage is Validate and Work has no Gate, Ted moves the Task to Validate first and runs the Checks there.

- The order on that `advance` is: obligations, the base-conflict test-merge (ADR 0110), the new-work hold, then the move. A conflict refuses the outcome in Work, because Checks on a branch that can’t merge say little.
- `move` takes a `handOff` option. It holds back the first push and draft pull request (`pullRequestWork(…, 'first')`) and runs `handOffChecks` in `tasks/tasks.ts` instead of `validation.enter`. The run has the trigger `hand-off` and the Stage `validate`. `beginChecks` neither tracks nor diagnoses it, so it records no failure case. The Task shows Validate · Running Checks everywhere its Stage appears, and the Stage time counts under Validate. The outcome request answers at once; the Task Lead gets nothing more until the Checks finish, and `ted outcome` and `ted checks` are refused while they run. `v1.ChecksStarted` already stores the trigger as a string, so there is no new event.
- **Pass.** `handOffChecks` queues the first push and hands the run to `validation.enter`. `adoptHandOff` in `tasks/validation.ts` saves it as the visit’s Check coverage, marks an earlier failure case of a Check that now passed as verified, and delivers Validate’s instructions with the results; no second run starts. Ted notes what the Checks cover (each repo’s `HEAD` and worktree tree, and the Check hash) before they start. If the worktree changed while they ran, Ted runs them again, up to 3 runs; past that, or if the Check plan changed, the run is not adopted and the Checks run at entry. `judge` picks the newest passed `hand-off` run of the visit for the confirmation row when the visit has no `validate` run.
- **Fail.** `handOffChecks` sends the Task back to Work with `sendBack`: the failing Check’s last 200 lines through `redactSecrets` and the log path as Findings, the run’s id, cause `check`, counted toward `max_back`. The Thread shows one line, “Typecheck failed in Validate, back to Work”, with the Checks folded under it. Nothing is pushed. The Loop check never starts for it, and `loopRounds` leaves hand-off send-backs out of the Loop check’s count and rounds, because a Check failure has no reviewer Findings to judge.
- **At `max_back`.** Ted asks the human with `askAboutLoop`, whose choices for a hand-off failure are **Try again**, **Back to Design** (when Design comes before Validate) and **Diagnose in Validate**, which replaces “Move to … anyway”. **Diagnose in Validate** is for a Check that fails for a reason outside the Task, such as a flaky test or one already broken on the base branch: `answerLoopAsk` in `tasks/request-answers.ts` calls `diagnoseInValidate`, which keeps the Task in Validate and runs `validation.enter`, so a failure becomes a failure case with Retry, Fix in this Task and Accept this failure. No send-back is recorded.
- **Stopped, failed or a new Task Lead.** Stopping a Task doesn’t stop Checks that are already running. When they finish and the Task is stopped or Failed, Ted leaves it in Validate and uses nothing; the next Validate `advance` runs the Checks first. If the Task Lead Run changed, Ted runs the Checks again through `validation.enter`. Only a passed hand-off run whose coverage still matches, or a Workflow with no Checks, queues the first push; every other path leaves it to Validate passing (`pullRequestWork(…, 'again')`), so nothing is pushed before the current code’s Checks pass.
- **Restart.** A daemon that stops mid-run marks the Check run interrupted on start. For a Task in Validate that isn’t stopped or Failed, Ted runs `handOffChecks` again and `validation.recover` skips that Task. `validation.recover` also skips a Task in Validate with an open send-back question, so a restart doesn’t run Checks before the human answers. A Task left in Work by a hand-off run from before this change gets a message to report again.

Validate entered any other way still runs the Checks at entry through `validation.enter`, and a failure there stays in Validate as a failure case: a send-back from Review to Validate, the merge watcher’s send-back to Validate, the human’s approval of a Work Gate, and a Workflow whose Stage before Validate isn’t Work.

A setup Task’s hand-off run uses its narrowed Checks, because `validation.begin` chooses them. Overnight mode changes nothing here.

## Considered Options

- **Run the Checks in Work, before the Stage changes** (this ADR’s first version). Replaced: users read it as Work running the tests, and it needed its own three-failures question and a second way into Validate.
- **Show Validate while the Checks run in Work.** Rejected: a display Stage that differs from the real one has to be kept in step in every client, and the Task Lead would still be in Work.
- **Keep a failure uncounted.** Rejected by the user: a Task that goes back from Validate to Work is a send-back, and anything else breaks that model.
- **Keep the three-failures question.** Rejected: with failures counted, `max_back` already stops the Task and asks. One limit, not two.
- **Leave a failure in Validate as a failure case**, as other entries do. Rejected: the Task Lead repairs a plain Typecheck or Lint failure faster in Work, and Diagnose in Validate covers the rest at the limit.
- **Push at Validate entry, before the Checks.** Rejected: a branch whose Checks fail would be pushed. Pushing only at Merge is TED-542.
- **Hold the `ted outcome advance` request open until the Checks finish.** Rejected: Checks can run for many minutes, and ADR 0044 already keeps a long Check from holding an HTTP request.

## Consequences

- A Task Lead that reports `advance` at Work gets its answer later, in a message. The Work Stage file, the preamble and `workRoundText` say so.
- A Check failure straight after Work appears as a send-back again, with cause `check`, and counts toward `max_back`. A dashboard that wants them alone counts send-backs whose Check run has the trigger `hand-off`.
- A Check that fails for a reason outside the Task costs send-backs until `max_back`, where the human can choose Diagnose in Validate. The failure message and the Work Stage file tell the Task Lead not to change unrelated code to get past the Check and to write what it found in the Task brief.
- Old `v1.SendBackAsked` rows with `from` and `to` both `work`, from the first version, still show in the Thread; an answer to one goes to the Task Lead as an ordinary answer.
- A Work Stage with a Gate keeps the old order: the human approves, the Task enters Validate, the Checks run there as a `validate` run.
