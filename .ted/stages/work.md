# Work

## Goal

Make the change the Task asks for, on this Task’s branch.

## Steps

1. Read the Task, its brief and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one. Use the agreed scope, acceptance criteria and Design approach; when earlier Stages were skipped, use the request and record any needed interpretation in the brief.
2. Build in small slices. For a behaviour change, write or update the test at an existing public boundary together with the change, following the testing rules in `AGENTS.md`; documentation-only changes need no artificial tests.
3. Don’t run test files in Work: no `pnpm vitest`, `pnpm test` or `pnpm check`, for a new test either. Every test run shares this machine with every other Run, so TED runs the tests the change affects itself, as the Affected tests check, when the Task enters Validate. Check your work with `pnpm typecheck` and `pnpm lint`, and by reading the code and the test against each other.
4. Check every acceptance criterion against the result. Record the evidence and any remaining limitations in the brief; resolve missing behaviour before handing off.
5. Commit your work. `ted outcome advance` moves the Task to Validate at once, and TED runs the checks there as Validate’s first step.
6. Post a short note leading with the resulting behavior, then any remaining limitation. TED works out which test files the change affects, so don’t list them. Attach detailed evidence when needed, following the preamble’s writing guidance.

## Done when

The change is committed and the note is posted. Then report the outcome with `ted outcome advance`. Do not run any tests yourself: TED’s checks run them in Validate.

If Validate sent this Task back, repair the evidence-based findings and preserve their original failure history. When a test failed there, fix it from the failure output in the findings; Validate runs it again. Returning to Validate runs fresh verification; a retry or investigation is not a send-back. Do not count acceptance as a passing test or merge approval.

If a check failed in Validate, TED’s message names the failure case and gives the check’s output. If this Task’s change caused it, fix it, commit and report the outcome again. If the cause is outside this Task (a test that fails the same way on the base branch, or a flaky one), don’t change unrelated code to make it pass: add the evidence with `ted failure evidence <id>`, record your assessment with `ted failure assess <id>`, run `ted failure ask <id>` and end your turn. The human can accept the failure while the code is still what the check ran on: don’t commit while you wait. The Task then goes to Validate, and the checks continue after the accepted one.

## Send back or ask when

Implementation uncovers a decision that changes the agreed scope or approach. Write the evidence and what needs deciding in a findings file and run `ted outcome back --to design --findings <file>`, or ask the human with `ted outcome ask` when a decision is needed before work can continue.
