# Work

## Goal

Make the change the Task asks for, on this Task’s branch.

## Steps

1. Read the Task, its brief and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one. Use the agreed scope, acceptance criteria and Design approach; when earlier Stages were skipped, use the request and record any needed interpretation in the brief.
2. Build in small slices. For a behaviour change, write or update the test at an existing public boundary together with the change, following the testing rules in `AGENTS.md`; documentation-only changes need no artificial tests.
3. Don’t run test files in Work: no `pnpm vitest`, `pnpm test` or `pnpm check`, for a new test either. Every test run shares this machine with every other Run, so Ted runs the tests the change affects itself, as the Affected tests check, when the Task enters Validate. Check your work with `pnpm typecheck` and `pnpm lint`, and by reading the code and the test against each other.
4. Check every acceptance criterion against the result. Record the evidence and any remaining limitations in the brief; resolve missing behaviour before handing off.
5. Commit your work. `ted outcome advance` moves the Task to Validate at once, and Ted runs the checks there as Validate’s first step. `ted checks` is refused in Work.
6. Post a short note leading with the resulting behavior, then any remaining limitation. Ted works out which test files the change affects, so don’t list them. Attach detailed evidence when needed, following the preamble’s writing guidance.

## Done when

The change is committed and the note is posted. Then report the outcome with `ted outcome advance`. Do not run any tests yourself: Ted’s checks run them in Validate.

If Validate sent this Task back, repair the evidence-based findings and preserve their original failure history. When a test failed there, fix it from the failure output in the findings; Validate runs it again. Returning to Validate runs fresh verification; a retry or investigation is not a send-back. Do not count acceptance as a passing test or merge approval.

Fix failures in this Task without asking the human whenever you can:

- If a check failed in Validate, Ted’s message names the failure case and gives the check’s output. If this Task’s change caused it, or probably did, fix it, commit and report the outcome again.
- When a failed check sends this Task back, Ted merges the latest base branch into this Task’s branch on the way and says so in its message. If the failure came from outside this Task, that merge may already have fixed it: read the failure again against the merged code before you go on. If Ted says it couldn’t merge, merge the base branch yourself first.
- Before you call a failure outside this Task, fix it here or file a repair Task, look for existing work on it. Search this Factory’s open Tasks (`ted peers`, then `ted peers show <Task>` for their descriptions and briefs) and the base branch’s commits since this branch’s base (`git log` on `origin/<base>`) for the failing test file. If a commit on the base branch fixed it, merge the base branch and report the outcome; Validate runs the check again. If an open Task covers it, run `ted task block --by <Task>`, post a note naming that Task, write the Task brief and end your turn, without filing another repair Task. When that Task merges, Ted starts this one again: merge the base branch, then report the outcome.
- If the cause is outside this Task (a test that fails the same way on the base branch, or a flaky one), read the failure output and the test to find why it failed, then fix it here when the fix is small and clearly right. A test that passes only some of the time is broken: fix its timing. Say in your note that this fix is outside the Task’s own change. Ted closes the failure case when the check passes in the next Validate.
- When the fix is too big for this Task, file it with `ted task create --child --description "<the failure and its evidence>" "<title>"`, naming the failing test file in the description so other Tasks can find it, write the Task brief and end your turn. This Task waits until the repair merges. When it starts again, merge the base branch into this Task’s branch so the repair is included, then report the outcome.

Ask the human only when the fix would change what this Task delivers, needs something only the human has (a device, an account, a credential), or two attempts to fix the same failure have failed. Then add the evidence with `ted failure evidence <id>`, record your assessment with `ted failure assess <id>` (in Work the card offers only Accept this failure, so its `choice` is `accepted`; when another open Task in this Factory tracks the fix, add `"repairTask":"<Task ID>"`, and the decision offers waiting for that Task as one choice), run `ted failure ask <id>` and end your turn. The human can accept the failure while the code is still what the check ran on: don’t commit while you wait. If Ted merged the base branch on the way back, the code is no longer what the check ran on and the card can’t offer Accept, so report the outcome first and let the checks run on the merged code. The Task then goes to Validate, and the checks continue after the accepted one.

## Send back or ask when

Implementation uncovers a decision that changes the agreed scope or approach. Write the evidence and what needs deciding in a findings file and run `ted outcome back --to design --findings <file>`, or ask the human with `ted outcome ask` when a decision is needed before work can continue.
