# Validate

## Goal

Find out whether the work does what the Task asks, without breaking anything else, through Checks, independent code review and security review. Pass means no blocking Findings.

## Before you start

If the Factory has Checks, TED has already run them, one after another, and their results are at the end of these instructions. If one had failed, TED would have kept the Task in Work, or sent it back there, instead of handing you this Stage.

## Steps

1. Read the Checks and Work evidence. Run relevant tests, including end-to-end tests where appropriate, to cover gaps in that evidence. Follow the repo’s test scope rules; repeat a passing check when the change or an unresolved concern warrants it.
2. Have the reviewer perform code review and security review of the committed diff with no Work conversation: start it with `ted run start --reviewer --prompt-file <file>` and wait for its Findings with `ted run wait <id>`. Supply the Task, acceptance criteria, Design brief, repo guidance and diff against a stated base commit. TED picks the reviewer’s agent, model and effort. One reviewer can cover both reviews. Tell the reviewer to use `code-review` if the skill is available to its agent, or follow the review criteria below manually. Keep TED’s reviewer selection and workflow commands. Ask it to report these separately:
   - **Requested behaviour:** missing or incorrect behaviour against the acceptance criteria, missed edge cases, scope creep and tests that fail to demonstrate the result. Cite the requirement and affected file and line. If criteria are missing, report that gap rather than inventing requirements.
   - **Repo standards:** breaches of documented rules. Cite the rule and affected file and line; distinguish violations from suggestions.
   - **Security:** assess the change’s security impact every time. When it touches input, files, processes, network or credentials, review the relevant trust boundaries, permissions and failure cases. Use an available security review skill or tool when helpful, or review manually. State the scope, method and confirmed Findings; if there is no security-sensitive impact, explain why.
   Findings from either review need evidence of the problem and its effect.
   Start one reviewer per visit. TED refuses a second reviewer, and any other sub-agent unless the Factory’s Workflow sets `stages.validate.sub_agents: true`. Don’t send the diff to any other review tool or service as well.
   From the second round, TED tells you which round this is and lists the earlier Findings. It gives the reviewer those Findings and the diff since the commit the last round reviewed, and limits it to checking that each Finding is fixed and that the fixes broke nothing. Your prompt file still supplies the Task, acceptance criteria and repo guidance; it can’t widen the review.
   When the Task comes back only because its branch conflicted with the base branch, TED says so and limits the reviewer to the conflict resolution: the base commit merged in, the files that conflicted and the Task’s own commits since the last review.
3. Check each acceptance criterion against the Task’s description, Design brief and verification evidence. Confirm reviewer Findings against the files. Look for missing cases, broken behaviour and leftover debugging code.
4. For UI changes, take screenshots of each changed screen as the preamble describes (headless, never by taking over the human’s screen), judge them against what was wanted, and attach them to your note as evidence.
5. Confirm both reviews cover the committed change. Sort every code and security Finding as blocking (the Task isn’t done until it’s fixed) or a note (worth knowing, fine to merge). From the second round, a new Finding about code the fixes didn’t touch is a note unless it is P1. P1 means the change loses or corrupts data, opens a security hole, or breaks behaviour the Task’s description asks for. When TED says the round checks a conflict resolution, a new Finding about code the resolution didn’t touch is a note unless it is P1. When TED says the round reviews the whole change again, sort Findings as in the first round. When TED says that only P1 Findings send the Task back in this round (the Factory’s `stages.validate.p1_only_from`), every Finding that isn’t P1 is a note, wherever it is in the change. Lead the human note with pass or fail and the remaining concerns, explaining their effect. Summarize relevant test coverage and the security review’s scope, method and outcome. Attach the detailed review and test evidence rather than repeating its inventory, revisions and Run IDs in the note.

## Done when

Code review and security review are complete, there are no blocking Findings and the note is posted. Then report the outcome with what both reviews and the screenshots found, for the human’s confirmation row: `ted outcome advance --review pass --review-notes <n>`, counting notes from both reviews and adding `--visual pass --visual-notes <n>` when you judged screenshots. The notes go into the Review brief.

## Send back when

There is a blocking Finding. Write each one, numbered, in a Findings file and run `ted outcome back --to work --findings <file>`, with `--review fail` or `--visual fail` when that is where it came from. In a round where TED says only P1 Findings send the Task back, mark the P1 Findings in the file and add `--severity p1`; TED refuses the send-back without it, and the other Findings go in your note. Keep the full reproduction and repair evidence in that file; a human update summarizes what remains and whether the previous fixes held. From the third send-back TED checks whether the rounds are converging and may ask the human instead. At the send-back limit it checks progress again, unless Loop checks are disabled, and asks the human regardless of the verdict; it tells you what happens.

## Ask the human when

A check fails for a reason outside this Task, or fixing a Finding would change what the Task delivers.
