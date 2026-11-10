# Validate

## Goal

Find out whether the work does what the Task asks, without breaking anything else, with as much automated checking as possible. Pass means no blocking Findings.

## Before you start

If the Factory has Checks, TED has already run them, one after another, and their results are at the end of these instructions. If one had failed, TED would have sent the Task back to Work instead of handing you this Stage.

## Steps

1. Read the Checks and Work evidence. Run relevant tests, including end-to-end tests where appropriate, to cover gaps in that evidence. Follow the repo’s test scope rules; repeat a passing check when the change or an unresolved concern warrants it.
2. Have the reviewer review the committed diff with no Work conversation: start it with `ted run start --reviewer --prompt-file <file>` and wait for its Findings with `ted run wait <id>`. Supply the Task, acceptance criteria, Design brief, repo guidance and diff against a stated base commit. TED picks the reviewer’s agent, model and effort. Ask it to perform the review directly and report these separately:
   - **Requested behaviour:** missing or incorrect behaviour against the acceptance criteria, missed edge cases, scope creep and tests that fail to demonstrate the result. Cite the requirement and affected file and line. If criteria are missing, report that gap rather than inventing requirements.
   - **Repo standards:** breaches of documented rules. Cite the rule and affected file and line; distinguish violations from suggestions.
   Include security checking when the change touches input, files, processes, network or credentials. Findings need evidence of the problem and its effect.
3. Check each acceptance criterion against the Task’s description, Design brief and verification evidence. Confirm reviewer Findings against the files. Look for missing cases, broken behaviour and leftover debugging code.
4. For UI changes, take screenshots of each changed screen as the preamble describes (headless, never by taking over the human’s screen), judge them against what was wanted, and attach them to your note as evidence.
5. Sort every Finding as blocking (the Task isn’t done until it’s fixed) or a note (worth knowing, fine to merge). Post a short note listing what you ran and what you found, with the notes.

## Done when

There are no blocking Findings and the note is posted. Then report the outcome with what the review and the screenshots found, for the human’s confirmation row: `ted outcome advance --review pass --review-notes <n>`, adding `--visual pass --visual-notes <n>` when you judged screenshots. The notes go into the Review brief.

## Send back when

There is a blocking Finding. Write each one, numbered, in a Findings file and run `ted outcome back --to work --findings <file>`, with `--review fail` or `--visual fail` when that is where it came from. From the third send-back TED checks whether the rounds are converging and may ask the human instead; it tells you what happens.

## Ask the human when

A check fails for a reason outside this Task, or fixing a Finding would change what the Task delivers.
