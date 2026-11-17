# The Checks run as Validate’s first step and every return to Work counts

Status: accepted (TED-540). Supersedes ADR 0111-checks-run-before-a-task-leaves-work. Changes ADR 0044, ADR 0048, ADR 0055, ADR 0110 and ADR 0116.

ADR 0111 ran the Checks when the Task Lead reported `ted outcome advance` at Work, before the Stage changed. Two things went wrong with that in use.

- **The Task showed as Work while its tests ran.** The Task Lead had finished, but the Task stayed in Work for as long as the Checks took, often many minutes. The user couldn’t tell a Task still being written from one being tested.
- **Returns to Work counted inconsistently.** A failed hand-off Check was not a send-back and counted toward nothing; a failed Check at Validate entry was a failure case, counted only if the Task Lead called it a regression or the user chose Fix in this Task; a base conflict found in Validate was a send-back that didn’t count; a reviewer’s Findings counted. A Task could go back to Work many times and still show round 1, and `max_back` stopped bounding how long a Task went round.

TED-539 then rewrote ADR 0111 while this ADR was being built: Work moved the Task to Validate first and ran the hand-off Checks there. A failure was a counted send-back with cause `check` but stayed out of the Loop check, the limit question offered **Diagnose in Validate** in place of “Move to … anyway”, and the branch was still pushed as a draft once the Checks passed. This ADR replaces that version too: a failed Check counts toward the Loop check like any other return, the limit question offers only Keep going and Stop the Task, and nothing is pushed before Merge.

ADR 0048 also pushed the branch and opened a draft pull request at Validate entry. With every Check and review round now a return to Work, that would push and update a pull request on GitHub for each round, before anyone had decided the work was ready.

## Decision

**Work moves to Validate at once.** On `ted outcome advance` at Work, Ted checks the obligations, then test-merges the base branch (ADR 0110), then moves the Task to Validate. A conflict still refuses the outcome and keeps the Task in Work, with no send-back and no count. There are no hand-off Checks: `handOffChecks`, `adoptHandOff`, `leaveWorkToDiagnose` and the three-failures question go. The Task Lead in Work commits, may run the Factory’s fast checks (in this repo `pnpm typecheck` and `pnpm lint`), and runs no tests.

**The Checks are Validate’s first step.** `validation.enter` always runs the Checks when the Task enters Validate, and the Task shows “Validate · Running checks · Lint (2 of 3)” meanwhile. Validate’s instructions go to the Task Lead only after every Check passes, so a failed Check starts no Validate Task Lead Run. When a Check fails, Ted:

1. records the failure case, as ADR 0095-failure-cases-preserve-results-and-bind-human-decisions describes, so it can be assessed and accepted later;
2. sends the Task back to Work through `sendBack`, with cause `check`, the Check run, and the failing Check’s last 200 lines (through `redactSecrets`) and log path as the Findings;
3. counts it toward Validate’s `max_back` and the Loop check, like any other return.

The Work Task Lead’s message names the failure case. If the change caused the failure, the Task Lead fixes it. If the cause is outside the Task (a flaky test, or one already broken on the base branch), it records evidence and an assessment and runs `ted failure ask`. It doesn’t change unrelated code to get past the Check.

The same rule holds however the Task enters Validate: from Work, from Review, from Merge, after a Work sign-off, or in a Workflow with no Work before Validate. A failure is always a counted return to Work.

**A failure from outside the Task is accepted from Work.** `resolveValidationFailure` accepts a decision on a `factory-check` failure case while the Task is in Work, when that case caused the Task’s latest return. Only **Accept this failure** is offered there; Retry and Fix in this Task make no sense for a Task already in Work. Accept is allowed only while each worktree is still at the code the failing run checked (ADR 0095 binds a decision to the code). Ted then moves the Task to Validate with no send-back and no count, and the Checks continue from the Check after the accepted one. The Checks that passed before it on that same code are not run again: `beginChecks` resumes the saved `ValidationProgress`. If the code changed, Ted refuses the answer and says why: the Task Lead reports again, and the Checks run on the new code.

**Every return from Validate to Work counts once.** A failed Check, a reviewer’s Findings and a base conflict found in Validate all count toward Validate’s `max_back` and the Loop check. `--cause base-conflict` from Validate still records the cause and Ted still verifies it, but the send-back now counts. A send-back after the user asked for changes at a Gate is unchanged: it isn’t a return from Validate’s own work, and it doesn’t count. The default `max_back` for Validate goes from 5 to 8, because Check failures now take rounds that used to be free.

The round number is the count of returns in the current series plus one. `reviewRound`, `p1OnlyAt` (for `stages.validate.p1_only_from`) and the Loop check all use it, so a failed Check moves the round on. The Loop check, at its default round 3, reads every round’s Findings; for a Check return those are the failing output. The earlier review rounds listed for a scoped reviewer stay review rounds only, because a Check return has no review Findings to scope against.

**The limit question has two choices.** At Validate’s `max_back`, or after a looping Loop check verdict, Ted asks the user **Keep going** or **Stop the Task**. Keep going records the held return as round 1 of a new series and moves the Task to Work. Stop the Task records the held return the same way and moves the Task to Work, then stops it the way the Stop button does; when the user resumes it, the Work Task Lead starts with those Findings. Either answer starts Validate’s count again from that return; a Task stopped with the Stop button keeps its count. Words alone go to the Task Lead and the Task stays where it is. Back to Design and Move to <next Stage> anyway are no longer offered. The answer route still accepts the old choices on a question that was open when this shipped.

**The header shows the count.** From the first return on, the Task header shows “Back to Work 3 of 8” in its meta row, in every Stage, until the count starts again. With no limit set it reads “Back to Work 3”. At 0 it is hidden.

**The branch is pushed and the pull request opened at Merge entry.** Ted no longer pushes at Validate entry, when Validate passes, or at the Validate Gate. When the Task enters Merge, Ted pushes every repo with commits and opens its pull request ready for review, with no `--draft`; a draft that already exists is pushed and marked ready (`gh pr ready`). Then it records the sign-off. Review works from the local diff, as the Changes section already shows it. With Merge off, the Task’s pull requests are pushed and opened when it leaves Review, so the user has them to merge on GitHub.

Merge can’t finish before each repo with commits has a pull request. The merge watcher and `ted task done` treat such a repo as not merged, and the merge watcher retries a failed push on its next pass; the old retry was at the next Validate pass, which no longer comes. `mode: 'first' | 'again'` stays for the pushes after a send-back from Merge.

**Tasks in flight when this ships.** Counts recorded so far carry over as they are. A hand-off Check run that is running or interrupted at upgrade is marked interrupted and not run again; the Task Lead is told to report again, at once if its Run is live, else as a held message. An open “Checks have failed 3 times” question can still be answered with **Try again** or **Diagnose in Validate**. Open draft pull requests stay as drafts and are marked ready at Merge entry. The `hand-off` trigger stays readable in Check run history. Tasks that ran TED-539’s version keep working: a `hand-off` Check run left unfinished in Validate is marked interrupted at start and the Validate Checks run again under this ADR’s rules. An open limit question with TED-539’s choices still takes them: Try again works as Keep going, Back to Design as before, and Diagnose in Validate keeps the Task in Validate and runs the Checks again. For the rest of that Validate visit a failed Check stays in Validate as a failure case for the Task Lead to assess, as it did under TED-539, instead of returning to Work. No shipped event changes; a new versioned event is added only where an existing one can’t carry what is needed.

## Considered Options

- **Keep the hand-off Checks (ADR 0111).** Rejected: it is what made the Task look like Work while its tests ran, and its failures counted toward nothing. A failure from outside the Task cost three Check runs before the user could choose.
- **Keep the Task in Validate for a failure from outside the Task**, as a failure case the Validate Task Lead diagnoses. Rejected: it needs a Validate Task Lead Run for every failed Check, and it is a second path beside the return to Work. The Work Task Lead has the context to tell a regression from an outside cause, and `ted failure ask` from Work reaches the same decision.
- **Push and open the pull request at Review entry.** Rejected: the user reviews in Ted from the local diff, and a pull request at Review would be updated by every send-back from Review. Pushing at Merge entry puts nothing on GitHub until the user has signed off, or until the Workflow skips the sign-off. The cost is that CI and a hosted preview are not there during Review.
- **Count only reviewer rounds.** Rejected: it keeps Check returns and base conflicts outside the limit, so a Task that keeps failing its Checks never reaches the limit question.

## Consequences

- `ted outcome advance` at Work answers at once with the move to Validate. The Work Stage file no longer tells the Task Lead to wait for the Checks.
- A Check failure straight after Work is a counted send-back with cause `check`. A dashboard that counted `hand-off` Check runs to find them now counts send-backs with that cause.
- Typecheck and lint failures now cost a round each. That is why the default limit went from 5 to 8; a Factory that sets its own `max_back` for Validate reaches it sooner than before.
- A Factory that set `p1_only_from` reaches that round sooner, because Check returns move the round on.
- Nothing reaches GitHub before Merge. During Review there is no CI run, no hosted preview from the pull request, and no GitHub comment or conflict notice to forward; the base-conflict test-merge on `advance` at Review still guards conflicts.
- A pull request opens ready for review, so a repo that asks for teammate reviews sees it only when the Task is at Merge.
