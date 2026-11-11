# Validate

## Goal

Find out whether the work does what the Task asks, without breaking anything else. Validate runs without the human: it never asks a question. Every doubt ends as a blocking Finding sent back to Work, or as a note. Pass means no blocking Findings.

## Before you start

If the Factory has Checks, TED has already run them, one after another, and their results are at the end of these instructions. If one had failed, TED would have sent the Task back to Work instead of handing you this Stage.

## Steps

1. The Checks already ran Typecheck and Lint. GitHub CI runs these two commands automatically on pull requests and pushes to `main`; full-suite CI is reserved for `v*` release tags. Agents never start GitHub workflows. Run only the test files the change touches, with `pnpm vitest run <files>`; never `pnpm test` or `pnpm check`. A test command can sit waiting for a test slot before it starts; let it wait. When a test fails, run the same test on the base branch. If it fails there the same way, it is outside this Task: record it as a note with the test name and the error, and carry on.
2. Have the reviewer review the diff with no Work context: start it with `ted run start --reviewer --prompt-file <file>`, give it only the Task, the Design brief and the diff against the base branch, and wait for its Findings with `ted run wait`. TED picks the reviewer’s agent, model and effort. A reviewer that is queued is waiting for a free Run; keep waiting with `ted run wait`, which holds no slot, however long it takes, and don’t start a second one. If `ted run start --reviewer` fails, try again after a minute, up to three times. If it still fails, review the diff yourself against the Task and the Design brief, and say in your note that TED’s reviewer could not start and what the error was. Start one reviewer per visit: TED refuses a second reviewer and any other sub-agent in Validate. From the second round, TED tells you which round this is and lists the earlier Findings. It gives the reviewer those Findings and the diff since the commit the last round reviewed, and limits it to checking that each Finding is fixed and that the fixes broke nothing. Your prompt file still supplies the Task and the Design brief; it can’t widen the review.
3. The reviewer’s review is the code review `AGENTS.md` asks for before a merge. Don’t run `/codex-review` or send the diff to any other service as well.
4. Perform a security review when the change touches starting agents or running shell commands, messages between processes, credentials or tokens, network requests, or reading and writing files outside the repo. Use an available security review skill or tool, or review manually when none is available. Include the method used and its confirmed Findings in the Validate result.
5. Check the diff against `AGENTS.md` and record any rule it breaks.
6. Check the change against the Task’s description and the Design brief. Look for missing cases, broken behaviour and leftover debugging code.
7. Try the change by hand, always against this Task’s own `TED_HOME` (`node_modules/.cache/ted-home` in the worktree), never `~/.ted` or `~/.ted-dev`:
   - For a change in `packages/app`, start TED Dev with `ted run-app "TED Dev"`, open each changed screen in light and dark mode, and attach a screenshot of each with `ted comment --attach`. Take them with Playwright against TED Dev launched with `TED_HIDDEN_WINDOW=1`. Judge them against the Design brief and the Figma file named in `AGENTS.md`. If Figma can’t be read, judge them against the Design brief alone and say so in a note. Quit TED Dev when the screenshots are taken.
   - Something that can’t be checked this way, such as a native dialog, is a note saying what the human should look at, not a reason to wait.
   - For a change in `packages/daemon`, `packages/cli` or `packages/protocol`, run the changed `ted` commands with `env -u TED_RUN_CAPABILITY -u TED_RUN_TOKEN -u TED_RUN -u TED_TASK -u TED_PLAN TED_HOME="$PWD/node_modules/.cache/ted-home" pnpm ted <args>` and paste the output into your note. Keep Task-control commands such as `ted comment`, `ted checks` and `ted outcome` in the normal Run environment.
8. Sort every Finding as blocking (the Task isn’t done until it’s fixed) or a note (worth knowing, fine to merge). Post a short note listing what you ran and what you found, with the notes.

## Done when

There are no blocking Findings and the note is posted. Then report the outcome with what the review and the screenshots found, for the human’s confirmation row: `ted outcome advance --review pass --review-notes <n>`, adding `--visual pass --visual-notes <n>` when you judged screenshots. The notes go into the Review brief.

## Send back when

There is a blocking Finding. Write each one, numbered, in a Findings file and run `ted outcome back --to work --findings <file>`, with `--review fail` or `--visual fail` when that is where it came from. From the third send-back TED checks whether the rounds are converging and may ask the human instead; it tells you what happens.

## Never ask the human

Don’t run `ted outcome ask`, `ted ask` or `ted comment --choice` in Validate. Decide with these rules, and list each decision in your note under “Decided without the human”:

- A check fails for a reason outside this Task: a note, as in step 1.
- Fixing a Finding would change what the Task delivers: send it back to Work with the smallest fix that keeps what the Task’s description promises. If no such fix exists, send it back saying Work must remove the part that causes the Finding and say so in its note.
- A Finding is about code this Task didn’t change, or asks for more than the Task’s description does: a note, not a blocking Finding.
- From the second round, a new Finding about code the fixes didn’t touch: a note, unless it is P1. P1 means the change loses or corrupts data, opens a security hole, or breaks behaviour the Task’s description asks for. When TED says the round reviews the whole change again, after a send-back for a conflict with the base branch, sort Findings as in the first round.
- A tool or service is unavailable (a reviewer that can’t start, Figma, a sandbox refusal): do the step another way or skip it, and say which in a note.
