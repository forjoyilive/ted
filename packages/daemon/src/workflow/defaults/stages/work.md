# Work

## Goal

Make the change the Task asks for, on this Task’s branch.

## Steps

1. Read the Task, its brief and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one. Use the agreed scope, acceptance criteria and Design approach; when earlier Stages were skipped, use the request and record any needed interpretation in the brief.
2. Build in small slices, each with an observable result. For behaviour changes, use `tdd` if the skill is available to your agent. Work test-first: write a failing test at an existing public boundary, then the smallest change that passes it, then refactor. Follow these steps when the skill is unavailable too. Follow the repo’s testing conventions; documentation-only changes need no artificial tests.
3. Run tests relevant to the changed behaviour within the repo’s test scope rules, and fix what fails. Reuse passing results until a change or an unresolved concern calls for another run.
4. Check every acceptance criterion against the result. Record the evidence and any remaining limitations in the brief; resolve missing behaviour before handing off.
5. Commit your work. `ted outcome advance` moves the Task to Validate at once, and Ted runs the checks there as Validate’s first step. You can run the Factory’s checks yourself first with `ted checks`.
6. Post a short note leading with the resulting behavior, then the validation outcome and any remaining limitation. Attach detailed evidence when needed, following the preamble’s writing guidance.

## Done when

The change is committed and the note is posted. Then report the outcome with `ted outcome advance`.

If Validate sent this Task back, repair the evidence-based findings and preserve their original failure history. Returning to Validate runs fresh verification; a retry or investigation is not a send-back. Do not count acceptance as a passing test or merge approval.

If a check failed in Validate, Ted’s message names the failure case and gives the check’s output. If this Task’s change caused it, fix it, commit and report the outcome again. If the cause is outside this Task (a flaky test, or one already broken on the base branch), don’t change unrelated code to make it pass: add the evidence with `ted failure evidence <id>`, record your assessment with `ted failure assess <id>`, run `ted failure ask <id>` and end your turn. The human can accept the failure while the code is still what the check ran on: don’t commit while you wait. The Task then goes to Validate, and the checks continue after the accepted one.

## Send back or ask when

Implementation uncovers a decision that changes the agreed scope or approach. Write the evidence and what needs deciding in a findings file and run `ted outcome back --to design --findings <file>`, or ask the human with `ted outcome ask` when a decision is needed before work can continue.
