# A setting lets the Task Lead close its own fixed failures

ADR 0095 made the human the only one who closes a Failure case recorded outside Validate. On TED-128 the Task Lead ran an extra test in Work, it failed because of another Task’s bug, and the Lead recorded a case. The other Task’s fix was merged into the branch and the test passed. The case still held the Task, and the only way out was a question in the Inbox. The card offered **Accept this failure**, which Ted refused because the branch’s HEAD had changed, and each recheck the human asked for posted another near-identical card. The human was doing bookkeeping: nothing was left to decide.

`stages.work.lead_closes_failures: true` lets the current Task Lead close such a case itself with `ted failure verify <id> --file <json>`, the command it already uses for a Validate Finding after a Retry or a repair. It applies only to a case whose source is a Finding and that was recorded outside Validate, so the Task Lead reported the failure in the first place and trusting its report of the pass adds no new trust. The case becomes verified, its open question is withdrawn, and the thread gets a “Failure repair verified” Comment with the evidence. The original failure stays in the history.

It is a setting, off by default, because Ted can’t check the pass: it never ran the test. A Factory that turns it on accepts the Task Lead’s word. Validate’s Checks and reviewer still run afterwards.

What it doesn’t change:

- A failed Factory Check, a post-rebase Check, a CI failure and any case recorded in Validate keep their rules.
- Only the human accepts a failure that still happens.
- With the setting off, `ted failure verify` on such a case is refused with a message that names the setting and tells the Task Lead to recommend Fixed and ask.

`leadClosesFailures` in `tasks/failure-cases.ts` reads the setting from the Task’s Workflow (`taskWorkflow` without a fetch), and `verifyFailure` in `tasks/tasks.ts` is the only place that uses it. The key is accepted in any layer, on Work only; the settings screens show it under the Work row as **Task Lead closes its own fixed failures**. It sits on Work because that is where the Task Lead runs its own tests, though it covers a Finding recorded in any Stage but Validate. It is not a Gate, so overnight mode and forced Gates leave it alone.

Not done here: the card still offers Accept when the code has changed since the failure, and each reassessment still posts a new card.
