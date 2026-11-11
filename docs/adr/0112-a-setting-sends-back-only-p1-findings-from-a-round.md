# A Workflow setting sends a Task back from Validate only for P1 Findings, from a chosen round

ADR 0105 scopes later Validate rounds to the fixes, but a round still sends the Task back for any blocking Finding in those fixes. A Factory owner who would rather read the remaining Findings at Review than pay for more rounds had no way to say so.

`stages.validate.p1_only_from: <round>` says it. It is off by default and this repo doesn’t set it, because it lowers the review bar on purpose: Findings that Validate would have had fixed reach Review unfixed.

## Decision

**The setting.** `p1_only_from` takes a whole number of 2 or more, or `false`. `checkLayer` rejects anything else with “must be a round number, 2 or more, or false”, and warns on any Stage other than Validate. Unset and `false` both mean off; `false` lets a Factory turn off a value the Library sets, the way `loop_check: false` does. It merges like every Stage setting (a later layer’s value wins), is written by `workflow/edit.ts`, and is a select on the Validate row of Factory settings → Workflow and of the Library page.

**The round.** A Validate round’s number is the count of counted send-backs from Validate in the current series plus one, the number `max_back`, `reviewRound` and the send-back line already use. The rule is in force when that number is `p1_only_from` or more. `p1OnlyAt` in `tasks/validate-settings.ts` is the only place that decides it.

**What changes in those rounds.**

- `validateRoundText` tells the Task Lead that only a P1 Finding sends the Task back, that every other Finding is a note to list and count in `--review-notes`, and that `ted outcome back` needs `--severity p1`. This replaces the “new Finding about untouched code is a note unless it is P1” line, and the “any Finding can be blocking” line of a round after a base conflict.
- The reviewer’s prompt carries a “Severity” section from TED: mark every Finding P1 or not P1, and report the others in full as notes. In a scoped round it is part of `scopedReviewPrompt`. In a full round, where TED added nothing before, `p1OnlyReviewPrompt` puts the section above the Task Lead’s prompt, which goes inside a fence with a fresh nonce; the reviewer starts under “Your instructions from TED”. `v1.SeverityRuleReviewRecorded` (`runId`, `taskId`, `round`, `from`, `at`) records that a reviewer ran under the rule, and is how a queued request is known to be TED’s after a daemon restart.
- `ted outcome back` from Validate is refused with 409 unless it carries `--severity p1`. The message says the round, the setting and what P1 means, and tells the Task Lead to advance with the Findings as notes. The refusal comes before the Validate judgment is recorded.

P1 keeps the meaning ADR 0105 gave it: the change loses or corrupts data, opens a security hole, or breaks behaviour the Task’s description asks for.

**The declaration.** TED can’t verify severity. `--severity p1` is the Task Lead’s declaration that at least one Finding is P1, and TED records it as `v1.SendBackSeverityDeclared` (`id`, `taskId`, `runId`, `round`, `severity`, `at`) when it accepts the report, in any round and whether or not the setting is on. `SendBack.severity` in `GET /tasks/:id/send-backs` is that declaration, matched when read: the newest declaration made after the Task’s previous send-back and no later than this one, for a counted send-back from Validate with no Check run. The thread line of such a send-back ends “· P1 declared”. `--severity` outside Validate is refused with 400.

**What is not affected.**

- A failed Check at Validate entry: TED sends the Task back itself, not through `ted outcome back`.
- A base conflict TED verified (`--cause base-conflict`, ADR 0108).
- A send-back after the human asked for changes at Validate’s Gate.
- `max_back` and `loop_check`: a send-back that does happen is counted, can start the loop check and can reach the over-limit question, as before.
- Gates. The setting isn’t a Gate, so overnight mode, forced Gates and a Task’s own Gate overrides leave it alone. A setup Task gets no forced value and takes what the layers give.

**Where the value is read.** From `taskWorkflow` at the moment it is needed: when Validate is entered, when the reviewer is requested (without a fetch) and when `ted outcome back` is reported, like `max_back` and `loop_check`. The Factory layer is `.ted/workflow.yaml` on `origin/<default branch>`, so a Run that edits the file in its worktree changes nothing until the change merges.

## Considered Options

- **Turn the remaining Findings into a Follow-up Task.** Rejected: `ted task create` with a Run token works only from an Automation Run (ADR 0070), and opening it to Task Leads is a larger change in what a Run may start. The Findings become notes; the human can make a Follow-up from Review.
- **Have TED read the Findings and decide severity.** Rejected: TED can’t judge a Finding’s text. A declaration that is recorded and shown is honest about that.
- **Carry the severity in the send-back event.** `v2.TaskSentBack` is shipped (ADR 0010), and a send-back held for the loop check or the over-limit question is recorded later from `v1.LoopCheckStarted` or `v1.SendBackAsked`, which are shipped too and have no field for it. A separate declaration event at report time covers both paths; the price is matching it to its send-back when read.
- **Apply the rule from round two always.** Rejected as a default: it trades review quality for speed, and that is the Factory owner’s call.
- **A machine setting.** Rejected: the review bar belongs to the Workflow, where a Factory’s collaborators see it in `.ted/workflow.yaml`.

## Consequences

- With the setting on, a Task can reach Review with known Findings that aren’t P1. The human sees them only by reading Validate’s note and the Review brief.
- A Task Lead can declare P1 for a Finding that isn’t. The declaration is in the event log and on the thread line, so a dashboard can count how often a Factory’s late rounds still send back.
- A Task Lead that advances with a real P1 Finding as a note is the same risk as a Task Lead that calls a blocking Finding a note today.
- A declaration whose send-back never happens (the human chose Move on anyway at the loop question) stays in the event log and matches no send-back.
