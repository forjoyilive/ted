# Validate

## Goal

Find out whether the work does what the Task asks, without breaking anything else, with as much automated checking as possible. Pass means no blocking Findings.

## Before you start

If the Factory has Checks, TED has already run them, one after another, and their results are at the end of these instructions. If one had failed, TED would have sent the Task back to Work instead of handing you this Stage.

## Steps

1. The Checks already ran Typecheck and Lint. Run tests covering the changed behaviour. The full `pnpm test` suite failed on the setup baseline (73 failing tests); compare any failures with that baseline and report them. Before merging to `main`, run all three commands required by `AGENTS.md`; if the suite is still failing for reasons outside the Task, ask the human how to proceed.
2. Have the reviewer review the diff with no Work context: start it with `ted run start --reviewer --prompt-file <file>`, give it only the Task, the Design brief and the diff against the base branch, and wait for its Findings with `ted run wait`. TED picks the reviewer’s agent, model and effort.
3. Run `/codex-review` on the branch against `main`, every time. Include its confirmed Findings in the Validate result.
4. Run `/security-review` when the change touches starting agents or running shell commands, messages between processes, credentials or tokens, network requests, or reading and writing files outside the repo. Include its confirmed Findings in the Validate result.
5. Check the diff against `AGENTS.md` and record any rule it breaks.
6. Check the change against the Task’s description and the Design brief. Look for missing cases, broken behaviour and leftover debugging code.
7. Try the change by hand, always against this Task’s own `TED_HOME` (`node_modules/.cache/ted-home` in the worktree), never `~/.ted` or `~/.ted-dev`:
   - For a change in `packages/app`, start TED Dev with `ted run-app "TED Dev"`, open each changed screen in light and dark mode, and attach a screenshot of each with `ted comment --attach`. Judge them against the Design brief and the Figma file named in `AGENTS.md`.
   - For a change in `packages/daemon`, `packages/cli` or `packages/protocol`, run the changed `ted` commands with `TED_HOME="$PWD/node_modules/.cache/ted-home" pnpm ted <args>` and paste the output into your note.
8. Sort every Finding as blocking (the Task isn’t done until it’s fixed) or a note (worth knowing, fine to merge). Post a short note listing what you ran and what you found, with the notes.

## Done when

There are no blocking Findings and the note is posted. Then report the outcome with what the review and the screenshots found, for the human’s confirmation row: `ted outcome advance --review pass --review-notes <n>`, adding `--visual pass --visual-notes <n>` when you judged screenshots. The notes go into the Review brief.

## Send back when

There is a blocking Finding. Write each one, numbered, in a Findings file and run `ted outcome back --to work --findings <file>`, with `--review fail` or `--visual fail` when that is where it came from. From the third send-back TED checks whether the rounds are converging and may ask the human instead; it tells you what happens.

## Ask the human when

A check fails for a reason outside this Task, or fixing a Finding would change what the Task delivers.
