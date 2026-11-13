# Clarify

## Goal

Remove ambiguity before Design, so the rest of the Workflow builds the right thing.

## Skip when

The Task is already clear: a small, specific change with one obvious reading. Post a one-line note saying Clarify had nothing to ask, then run `ted outcome advance --skip`.

## Steps

Read the Task, its sources and the relevant code before asking. Use the repo to settle facts; ask the human about choices that affect behaviour, scope or how success will be checked.

1. Check the Task’s size first. If it won’t fit in one pull request per repo, ask the human what to do: `ted clarify too-big "<why>" --settle "<point>" --settle "<point>"`, where the text says why it’s too big and each `--settle` names something a plan must decide. End your turn. TED offers the human Split it, Plan it outside TED and Grill anyway, and sends you their choice:
   - **Split it:** post the pieces with `ted task propose --file <file>`. Prefer small slices that each deliver a verifiable result across the layers they need. Each piece’s description states its success criteria; dependencies name work that must merge first. The file is JSON: a short `title`, an optional `summary`, and `tasks`, one row per piece, each with a `title`, a one-line `scope`, an optional `description`, a `priority` (urgent, high, medium, low or none) and `blockedBy`, the row numbers that must merge first. Row 1 is this Task: when the human approves, it narrows to row 1 and carries on through Clarify, so it can’t be blocked. The other rows become new Tasks in Backlog. For example:

     ```json
     {
       "title": "Offline editing for notes, in three Tasks",
       "tasks": [
         { "title": "Local note cache", "scope": "Notes save to a local cache first.", "priority": "high" },
         { "title": "Sync queue with retry", "scope": "Send offline edits in order on reconnect.", "priority": "high", "blockedBy": [1] },
         { "title": "Offline badge", "scope": "A badge while edits wait to sync.", "priority": "low" }
       ]
     }
     ```

   - **Plan it outside TED:** TED posts your reason and what a plan must settle, moves the Task to Backlog and stops your Run.
   - **Grill anyway:** the Task stays whole and TED sets the depth to grilling.
2. Unless the human already chose a Clarify depth, pick one and say why in one line: `ted clarify depth <none|few|grilling> "<why>"`.
   - **None** when nothing is unclear. Record the result in the Task brief as described below, then run `ted outcome advance`.
   - **Few** when one round would settle it, however many questions that round needs.
   - **Grilling** when the Task hides real decisions. Use `grilling` (or `batch-grill-me`) if the skill is available to your agent; otherwise follow the rounds below. Ask in rounds until nothing is left open.
3. Ask a round with `ted ask --round <file>`. Put every question you can ask now in the round; hold back only a question whose answer depends on one still open, and ask it in the next round. A round holds up to 12 questions. The file is JSON: a short `title`, an optional one-line `summary`, and `questions`. Each question has its `question`, your `recommended` answer, and, when there are a few likely answers, `choices` that include the recommended one. Without `choices`, the human edits your recommended answer as text. For example, with two questions to keep it short (a real round usually has more):

   ```json
   {
     "title": "Conflicts and sync",
     "summary": "Each question has my recommended answer filled in.",
     "questions": [
       {
         "question": "When a note is edited on two devices offline, what happens on reconnect?",
         "choices": ["Keep both and let me merge", "Keep the latest edit"],
         "recommended": "Keep both and let me merge"
       },
       {
         "question": "If a note is deleted on one device and edited on the other, which wins?",
         "recommended": "The edit wins, with a line saying it was deleted elsewhere."
       }
     ]
   }
   ```

4. End your turn. TED sends you the human’s answers, each marked recommended or changed.
5. If the human clicks **Talk it through** instead, TED tells you, and the human writes to you in your Conversation. Discuss the round’s questions there. When it’s settled, or when TED says the human is done talking, write a summary to a file (each question and what you agreed, then anything still open) and run `ted ask --close --summary <file>`. TED posts it as your note and closes the round as answered in Talk it through. Ask anything still open in a new round.

## Done when

Use the Task brief’s existing headings: put observable acceptance criteria under Goal, agreed decisions and exclusions under Decisions so far, and unresolved questions under Open questions. Carry forward only decisions supported by the request or the human’s answers; label proposals as proposals.

- **Few:** the one round is answered. Write the brief, then run `ted outcome advance`.
- **Grilling:** nothing is left open. Write the brief, then run `ted outcome advance`. The effective Clarify sign-off setting applies at every depth. When it is on, TED posts the brief to the human as the sign-off: Approve moves the Task on; Request changes means another round. When it is off, TED moves the Task on without sign-off.

## Ask the human when

Any answer at Few raises something bigger than the question it answered. Switch to grilling with `ted clarify depth grilling "<why>"` and ask another round.
