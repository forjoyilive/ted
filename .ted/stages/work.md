# Work

## Goal

Make the change the Task asks for, on this Task’s branch.

## Steps

1. Read the Task, its brief and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one. Use the agreed scope, acceptance criteria and Design approach; when earlier Stages were skipped, use the request and record any needed interpretation in the brief.
2. Build in small slices. For a behaviour change, write or update the test at an existing public boundary together with the change, following the testing rules in `AGENTS.md`; documentation-only changes need no artificial tests.
3. Don’t run test files in Work: no `pnpm vitest`, `pnpm test` or `pnpm check`, for a new test either. Every test run shares this machine with every other Run, so TED runs the tests the change affects itself, as the Affected tests check, when you report the outcome. Check your work with `pnpm typecheck` and `pnpm lint`, and by reading the code and the test against each other.
4. Check every acceptance criterion against the result. Record the evidence and any remaining limitations in the brief; resolve missing behaviour before handing off.
5. Commit your work. When the Factory has checks, TED runs them when you report the outcome, before the Task leaves Work. If one fails, the Task stays in Work and TED sends you the output: fix it, commit and report the outcome again. After three failures TED asks the human, who can keep the Task in Work or move it to Validate to diagnose the failure there. If a check fails for a reason outside this Task, don’t change unrelated code to make it pass; say so in the Task brief with what shows it. You can run them yourself first with `ted checks`.
6. Post a short note leading with the resulting behavior, then any remaining limitation. TED works out which test files the change affects, so don’t list them. Attach detailed evidence when needed, following the preamble’s writing guidance.

## Done when

The change is committed and the note is posted. Then report the outcome. Do not run any tests yourself: TED’s checks run them.

If Validate sent this Task back, repair the evidence-based findings and preserve their original failure history. When a test failed there, fix it from the failure output in the findings; Validate runs it again. Returning to Validate runs fresh verification; a retry or investigation is not a send-back. Do not count acceptance as a passing test or merge approval.

## Send back or ask when

Implementation uncovers a decision that changes the agreed scope or approach. Write the evidence and what needs deciding in a findings file and run `ted outcome back --to design --findings <file>`, or ask the human with `ted outcome ask` when a decision is needed before work can continue.
