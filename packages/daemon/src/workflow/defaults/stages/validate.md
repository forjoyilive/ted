# Validate

## Goal

Find out whether the work does what the Task asks, without breaking anything else. Resolve every blocking Finding and failure case, complete all remaining Checks, and keep failed results distinct from the human’s acceptance.

## Before you start

TED runs Factory Checks sequentially and stops at the first failure. A failure keeps the Task in Validate and gives you the original output and failure case ID. Checks after it have not run. Investigation, retry and a human decision do not count as send-backs.

Use `ted failure list`, `ted failure show <id>` and `ted failure obligations` to inspect evidence, decisions and remaining Checks. Never treat an accepted failure or a not-run Check as passed.

## Steps

1. Investigate each failed Check before deciding what to do. Add concise evidence with `ted failure evidence <id> --file <json>` (`{"evidence":"…","contextId":"optional captured context ID"}`). Assess it with `ted failure assess <id> --file <json>` (`{"assessment":"regression|unrelated|uncertain","recommendation":"Evidence-based explanation and recommended next step"}`). Substantiate the assessment with reproduction, changed-code analysis, logs, environment evidence or a useful base-branch comparison. A base comparison is not compulsory. Say what remains uncertain; do not guess that a failure is unrelated.
2. A supported regression goes back through the existing send-back path with Findings. For unrelated or uncertain causes, run `ted failure ask <id>` and wait for the human. They can Retry, Fix in this Task or Accept this failure. Acceptance covers only that execution in its verified tested context; it resumes remaining Checks, and does not approve a merge. Every later failing Check or failed retry gets its own case and decision.
3. Run the project’s relevant tests and end-to-end tests beyond what Factory Checks cover, following the repo’s testing rules. Before running extra verification, capture context with `ted failure context`. Record a failing result with `ted failure record --file <json>`: `{"source":{"kind":"finding","runId":"originating Run ID","finding":"Original Finding"},"evidence":"What ran and what failed","contextId":"context captured before verification"}`. Omit contextId for historical or unknown evidence; it cannot be accepted without reliable execution context. Apply the same assessment and human-decision policy to extra tests, reviewer Findings and visual failures. A Retry for a reported Finding means repeat that verification and record its fresh evidence; it never marks the Finding passed automatically. When repeated verification passes, record the fresh evidence with `ted failure verify <id> --file <json>` (`{"evidence":"What repeated and why it now passes"}`). This is Task Lead reported verification, not human acceptance.
4. Have the reviewer review the diff with no Work context: `ted run start --reviewer --prompt-file <file>`, giving only the Task, Design brief and diff against the base branch; wait with `ted run wait`. TED chooses its agent, model and effort. Capture context while the reviewer’s Run is live if you will need to bind its Findings to that execution. Never borrow a capture taken after a finished reviewer Run.
5. Check the change against the description and Design brief for missing cases, broken behaviour and debugging code. For UI changes, capture changed screens unattended as the preamble describes, judge them and attach evidence. Continue reviewer and visual validation even after the human accepts a Check failure.
6. Sort Findings as blocking or notes. Record every failure that needs diagnosis and resolution, rather than hiding it as a nonblocking note. Post what ran, evidence, assessments, human decisions and remaining uncertainty. Write these into the Review brief, explicitly labelling accepted failures as “failed, accepted by you”.

## Done when

Every required Check ran or has an explicit legitimate no-change skip, every failure case is resolved in its tested context, reviewer and applicable visual validation are complete, and there are no unresolved blocking Findings. Check `ted failure obligations` before advancing. Post the note and write the Task brief. Then use `ted outcome advance --review pass|fail --review-notes <n>`, adding `--visual pass|fail --visual-notes <n>` when you judged screenshots. Keep failing observations factual even when accepted. All existing Gates still apply.

## Send back when

Evidence supports a regression or the human chose Fix in this Task. For a regression, record its assessment, write numbered Findings and use `ted outcome back --to work --findings <file>`, with `--review fail` or `--visual fail` for their original results. TED applies the existing max_back and loop-check rules to actual send-backs. A pending escalation is not itself another send-back. Never repair code silently inside Validate.

## Ask the human when

The cause is unrelated or uncertain, or a fix changes what the Task delivers. Use the failure decision with evidence and a recommendation. When the Workflow has no earlier Work Stage, Fix is unavailable; explain that constraint while the Task remains held for a valid decision.
