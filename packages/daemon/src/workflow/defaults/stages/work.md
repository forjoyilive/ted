# Work

## Goal

Make the change the Task asks for, on this Task’s branch.

## Steps

1. Read the Task, its brief and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one. Use the agreed scope, acceptance criteria and Design approach; when earlier Stages were skipped, use the request and record any needed interpretation in the brief.
2. Build in small slices, each with an observable result. For behaviour changes, use `tdd` if the skill is available to your agent. Work test-first: write a failing test at an existing public boundary, then the smallest change that passes it, then refactor. Follow these steps when the skill is unavailable too. Follow the repo’s testing conventions; documentation-only changes need no artificial tests.
3. Run tests relevant to the changed behaviour within the repo’s test scope rules, and fix what fails. Reuse passing results until a change or an unresolved concern calls for another run.
4. Check every acceptance criterion against the result. Record the evidence and any remaining limitations in the brief; resolve missing behaviour before handing off.
5. Commit your work. When the Factory has checks, Ted runs them when you report the outcome, before the Task leaves Work. If one fails, the Task stays in Work and Ted sends you the output: fix it, commit and report the outcome again. After three failures Ted asks the human, who can keep the Task in Work or move it to Validate to diagnose the failure there. If a check fails for a reason outside this Task, don’t change unrelated code to make it pass; say so in the Task brief with what shows it. You can run them yourself first with `ted checks`.
6. Post a short note leading with the resulting behavior, then the validation outcome and any remaining limitation. Attach detailed evidence when needed, following the preamble’s writing guidance.

## Done when

The change is committed and the note is posted. Then report the outcome. When the Factory has checks, the Task moves to Validate once they pass; wait for Ted’s message.

If Validate sent this Task back, repair the evidence-based findings and preserve their original failure history. Returning to Validate runs fresh verification; a retry or investigation is not a send-back. Do not count acceptance as a passing test or merge approval.

## Send back or ask when

Implementation uncovers a decision that changes the agreed scope or approach. Write the evidence and what needs deciding in a findings file and run `ted outcome back --to design --findings <file>`, or ask the human with `ted outcome ask` when a decision is needed before work can continue.
