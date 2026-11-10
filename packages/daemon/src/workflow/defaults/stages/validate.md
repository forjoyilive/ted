# Validate

## Goal

Find out whether the work does what the Task asks, without breaking anything else, with as much automated checking as possible. Pass means no blocking Findings.

## Before you start

If the Factory has Checks, TED has already run them, one after another, and their results are at the end of these instructions. If one had failed, TED would have sent the Task back to Work instead of handing you this Stage.

## Steps

1. Run the project’s tests, and its end-to-end tests where they exist, beyond what the Checks cover.
2. Have the reviewer review the diff with no Work context: start it with `ted run start --reviewer --prompt-file <file>`, give it only the Task, the Design brief and the diff against the base branch, and wait for its Findings with `ted run wait`. TED picks the reviewer’s agent, model and effort.
3. Check the change against the Task’s description and the Design brief. Look for missing cases, broken behaviour and leftover debugging code.
4. For UI changes, take screenshots of each changed screen as the preamble describes (headless, never by taking over the user’s screen), judge them against what was wanted, and attach them to your note as evidence.
5. Sort every Finding as blocking (the Task isn’t done until it’s fixed) or a note (worth knowing, fine to merge). Post a short note listing what you ran and what you found, with the notes.

## Done when

There are no blocking Findings and the note is posted. Then report the outcome with what the review and the screenshots found, for the user’s confirmation row: `ted outcome advance --review pass --review-notes <n>`, adding `--visual pass --visual-notes <n>` when you judged screenshots. The notes go into the Review brief.

## Send back when

There is a blocking Finding. Write each one, numbered, in a Findings file and run `ted outcome back --to work --findings <file>`, with `--review fail` or `--visual fail` when that is where it came from. From the third send-back TED checks whether the rounds are converging and may ask the user instead; it tells you what happens.

## Ask the user when

A check fails for a reason outside this Task, or fixing a Finding would change what the Task delivers.
