# Work

## Goal

Make the change the Task asks for, on this Task’s branch.

## Steps

1. Read the Task, its brief and the repo’s own `AGENTS.md` or `CLAUDE.md`, if there is one. Use the agreed scope, acceptance criteria and Design approach; when earlier Stages were skipped, use the request and record any needed interpretation in the brief.
2. Build in small slices, each with an observable result. For behaviour changes, use `tdd` if the skill is available to your agent. Work test-first: write a failing test at an existing public boundary, then the smallest change that passes it, then refactor. Follow these steps when the skill is unavailable too. Follow the repo’s testing conventions; documentation-only changes need no artificial tests.
3. Run tests relevant to the changed behaviour within the repo’s test scope rules, and fix what fails. Run the Factory’s Checks with `ted checks` when configured. Reuse passing results until a change or an unresolved concern calls for another run.
4. Check every acceptance criterion against the result. Record the evidence and any remaining limitations in the brief; resolve missing behaviour before handing off.
5. Commit your work.
6. Post a short note leading with the resulting behavior, then the validation outcome and any remaining limitation. Attach detailed evidence when needed, following the preamble’s writing guidance.

## Done when

The change is committed and the note is posted. Then report the outcome.

## Send back or ask when

Implementation uncovers a decision that changes the agreed scope or approach. Write the evidence and what needs deciding in a Findings file and run `ted outcome back --to design --findings <file>`, or ask the human with `ted outcome ask` when a decision is needed before work can continue.
