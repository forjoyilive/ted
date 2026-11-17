# A Workflow setting sends a Task back from Validate for a new Finding only if it is P1, from a chosen round

_Changed by ADR 0187-the-checks-run-as-validates-first-step-and-every-return-to-work-counts: the round now counts every return to Work from Validate, failed Checks and verified base conflicts included, so a failed Check moves the round on. There are no Checks before a Task leaves Work, so that line under “What is not affected” no longer applies._

ADR 0107 scopes later Validate rounds to the fixes, but a round still sends the Task back for any blocking Finding in those fixes. A Factory owner who would rather read the remaining Findings at Review than pay for more rounds had no way to say so.

`stages.validate.p1_only_from: <round>` says it. It is off by default and this repo doesn’t set it, because it lowers the review bar on purpose: new Findings that Validate would have had fixed reach Review unfixed.

## Decision

**The setting.** `p1_only_from` takes a whole number of 2 or more, or `false`. `checkLayer` rejects anything else with “must be a round number, 2 or more, or false”, and warns on any Stage other than Validate. It also warns when the same file sets `max_back` for Validate and `p1_only_from` is more than `max_back` + 1: Validate reaches round `max_back` + 1 at most before Ted asks the human, so a later round comes only if the human sends the Task back again. `checkLayer` sees one layer at a time, so a value that is out of reach only against another layer’s `max_back` gets no warning. Unset and `false` both mean off; `false` lets a Factory turn off a value the Library sets, the way `loop_check: false` does. It merges like every Stage setting (a later layer’s value wins), is written by `workflow/edit.ts`, and is a select on the Validate row of Factory settings → Workflow and of the Library page.

**The round.** A Validate round’s number is the count of counted send-backs from Validate in the current series plus one, the number `max_back`, `reviewRound` and the send-back line already use. The rule is in force when that number is `p1_only_from` or more. `p1OnlyAt` in `tasks/validate-settings.ts` is the only place that decides it.

**What changes in those rounds.**

- `validateRoundText` and `conflictRoundText` tell the Task Lead that a new Finding sends the Task back only if it is P1, that an earlier round’s Finding that is still not fixed stays blocking whatever its severity, that every other new Finding is a note to list and count in `--review-notes`, and that `ted outcome back` needs `--severity p1` or `--severity unfixed`. This replaces the “new Finding about untouched code is a note unless it is P1” line, and the “any Finding can be blocking” line of a full round.
- The rule relaxes only new Findings. A Finding an earlier round sent the Task back for was already judged worth a round; letting it through unfixed because the round number went up would make `p1_only_from` a way to skip fixes.
- The reviewer’s prompt carries a “Severity” section from Ted: report an earlier Finding that is still not fixed as not fixed, mark every new Finding P1 or not P1, and report the others in full as notes. In a scoped round it is part of `scopedReviewPrompt` or, when the round checks a conflict resolution (ADR 0112), of `conflictReviewPrompt`; both then ask for “new P1 Findings” in the report where they otherwise ask for “new blocking Findings”, so the prompt doesn’t say two things. In a full round, where Ted added nothing before, `p1OnlyReviewPrompt` puts the section above the Task Lead’s prompt, which goes inside a fence with a fresh nonce; the reviewer starts under “Your instructions from Ted”. `v1.SeverityRuleReviewRecorded` (`runId`, `taskId`, `round`, `from`, `at`) records that a reviewer ran under the rule, and is how a queued request is known to be Ted’s after a daemon restart.
- `ted outcome back` from Validate is refused with 409 unless it carries `--severity p1` or `--severity unfixed`. The message says the round, the setting and what P1 means, and tells the Task Lead to advance with the Findings as notes. `--severity unfixed` is refused when no earlier round of the series sent the Task back with Findings. The refusal comes before the Validate judgment is recorded.
- In a round that follows a base conflict, scoped to the resolution or a full review, a resolution that drops or breaks what the base branch changed in the conflicting lines counts as P1. P1’s own meaning covers only what the Task’s description asks for, and without this line a merge that lost the base branch’s change would be a note.

P1 keeps the meaning ADR 0107 gave it: the change loses or corrupts data, opens a security hole, or breaks behaviour the Task’s description asks for.

**The declaration.** Ted can’t verify severity or read whether a Finding is fixed. `--severity p1` is the Task Lead’s declaration that at least one Finding is P1, and `--severity unfixed` its declaration that an earlier round’s Finding is still not fixed. Ted records which one in the `severity` string of `v1.SendBackSeverityDeclared` (`id`, `taskId`, `runId`, `round`, `severity`, `at`) when it accepts the report, in any round and whether or not the setting is on. When both are true the Task Lead declares `p1`. `SendBack.severity` in `GET /tasks/:id/send-backs` is that declaration, matched when read: the newest declaration made after the Task’s previous send-back and no later than this one, for a counted send-back from Validate with no Check run. The thread line of such a send-back ends “· P1 declared” or “· earlier Finding unfixed declared”. `--severity` outside Validate is refused with 400.

**What is not affected.**

- A failed Check in Validate. The human’s Fix in this Task decision sends the Task back without `ted outcome back`. A `ted outcome back` for a failed Check the Task Lead assessed as a regression needs no `--severity`, unless it also reports a failed review or visual result.
- The Checks failing before a Task leaves Work (ADR 0111): the Task stays in Work and there is no send-back.
- A base conflict Ted verified (`--cause base-conflict`, ADR 0110).
- A send-back after the human asked for changes at Validate’s Gate.
- A send-back when the code is no longer the commit this visit’s reviewer was given (`movedSinceReview`, ADR 0107). Ted refuses `ted outcome advance` then and tells the Task Lead to send the Task back for a new review, so that send-back needs no `--severity`. It is counted toward `max_back` like any other.
- `max_back` and `loop_check`: a send-back that does happen is counted, can start the loop check and can reach the over-limit question, as before.
- Gates. The setting isn’t a Gate, so overnight mode, forced Gates and a Task’s own Gate overrides leave it alone. A setup Task gets no forced value and takes what the layers give.

**Where the value is read.** From `taskWorkflow` at the moment it is needed: when Validate is entered, when the reviewer is requested (without a fetch) and when `ted outcome back` is reported, like `max_back` and `loop_check`. The Factory layer is `.ted/workflow.yaml` on `origin/<default branch>`, so a Run that edits the file in its worktree changes nothing until the change merges.

## Considered Options

- **Turn the remaining Findings into a Follow-up Task.** Rejected: `ted task create` with a Run token works only from an Automation Run (ADR 0070), and opening it to Task Leads is a larger change in what a Run may start. The Findings become notes; the human can make a Follow-up from Review.
- **Have Ted read the Findings and decide severity.** Rejected: Ted can’t judge a Finding’s text. A declaration that is recorded and shown is honest about that.
- **Carry the severity in the send-back event.** `v2.TaskSentBack` is shipped (ADR 0010), and a send-back held for the loop check or the over-limit question is recorded later from `v1.LoopCheckStarted` or `v1.SendBackAsked`, which are shipped too and have no field for it. A separate declaration event at report time covers both paths; the price is matching it to its send-back when read.
- **Apply the rule from round two always.** Rejected as a default: it trades review quality for speed, and that is the Factory owner’s call.
- **A machine setting.** Rejected: the review bar belongs to the Workflow, where a Factory’s collaborators see it in `.ted/workflow.yaml`.

## Consequences

- With the setting on, a Task can reach Review with known new Findings that aren’t P1. The human sees them only by reading Validate’s note and the Review brief.
- A Task Lead can declare P1 for a Finding that isn’t, or call a new Finding an earlier one. The declaration is in the event log and on the thread line, so a dashboard can count how often a Factory’s late rounds still send back.
- A Task Lead that advances with a real P1 Finding as a note is the same risk as a Task Lead that calls a blocking Finding a note today.
- A declaration whose send-back never happens (the human chose Move on anyway at the loop question) stays in the event log and matches no send-back.
