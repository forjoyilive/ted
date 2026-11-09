# Gates are requests the Task Lead’s outcome posts, and answers are one event on the Comment

A Comment now has one of the seven kinds in spec 10.5 and an author that is the human, a Run or TED (`v2.CommentPosted`). It records the Stage the Task was in when it was posted. A request is any Comment that isn’t a `note`; it stays open until it gets an answer. The answer is one `v1.CommentAnswered` event holding the whole answer as JSON: `approved`, `changes-requested`, `answered` (a choice, the human’s own words, or both) or `withdrawn` (with the Stage the Task moved to). The Inbox is every open request from every Factory, sorted by the Task’s Priority and then by age (`GET /inbox`). An open request counts in `TaskFacts.openRequests`, which makes the Task “Waiting on you” (ADR 0023). Only the human answers: `POST /comments/<id>/answer` is closed to Run tokens (ADR 0015).

**Gates.** The Task Lead doesn’t post a Gate request itself. At a Stage whose `gate` is on, `ted outcome advance` refuses until the Task Lead has written the Task brief since it entered the Stage, and since the human last asked for changes there. Then it posts the request in the Task Lead’s name: a `review` at Design, a `signoff` elsewhere, titled with the brief’s Goal and carrying the brief as its content. The Task stays put. **Approve** moves the Task on and sends the next Stage’s instructions to the Task Lead’s live Run; **Request changes** sends the human’s text to that Run and keeps the Stage. When the Task leaves a Stage with its Gate request still open, the same commit that changes the Stage withdraws it. `ted outcome advance --skip` is how a Stage skips itself, and so skips its Gate (spec 6.7). The card’s approve label (“Approve”, “Approve and merge”, the Merge-off caption) is chosen in the daemon when the request is posted, so the app only draws it.

**Send-backs.** `ted outcome back --to <Stage> --findings <file>` goes only to an enabled Stage earlier in the Workflow’s `order`, and needs non-empty Findings, which go to the Task Lead with the earlier Stage’s instructions (`v1.TaskSentBack`). A send-back counts against the sending Stage’s `max_back` unless the human asked for changes at that Stage’s Gate during this visit. The count is the counted send-backs since that Stage’s last `v1.SendBackCountReset`. Over the limit, TED posts a `question` in its own name with “Send it back to …” and “Keep it in …” and doesn’t move the Task. Any answer to a request resets the count of the Stage it was posted in. A send-back from Review also resets Validate’s count.

**Task brief.** `ted brief write` stores a new numbered version (`v1.TaskBriefWritten`). Only the Task Lead writes one, and it must have the five headings of spec 7.9, in order. Runs may read it (`GET /tasks/<id>/brief`, `ted brief show`).

## Considered Options

- **The Task Lead posts the Gate request with `ted comment --kind review`.** Rejected: an agent could then forget the request or post one outside a Gate, and TED would have to match a later `advance` to it. Making `advance` post it keeps “agents can’t skip a Gate” in one place.
- **Answers as a Comment from the human, linked to the request.** Rejected for now: an answer is part of the request’s state (open, answered, withdrawn) and the Inbox, the status and the card all read it from the request. KRI-90 can still show the human’s text as a thread line.
- **A counter table updated in materializers.** Rejected: counting send-backs since the last reset reads the facts directly and can’t drift.

## Consequences

- Tests that walk a Task through every Stage use `ted outcome advance --skip`, or a `.ted/workflow.yaml` that turns the Gates off, so the default Gates on Design and Review don’t stop them.
- If the Task Lead’s Run has finished, an answer is stored but nothing reaches an agent; spec 6.20 (the next Run gets it with the brief) is left to the ticket that starts fresh Runs.
- Clarify rounds, permissions and proposals use the same kinds and answer event; their own answer rules come with their tickets.
