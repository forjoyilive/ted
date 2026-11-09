# Clarify rounds are one Comment with structured questions, and the depth records who chose it

A Clarify round is one `round` Comment. The Task Lead writes it as a JSON file (`title`, optional `summary`, `questions`, each with `question`, `recommended` and optional `choices`) and posts it with `ted ask --round <file>`. The daemon checks the file and stores the questions with the Comment in `v3.CommentPosted`, which adds a `round` field to `v2.CommentPosted`; TED numbers rounds per Task. The human answers with `answer-round` (one answer per question, plus an optional note) or `accept-recommended`. The answer is the usual `v1.CommentAnswered`, now with an `answers` list where each answer is marked `changed` when it differs from the recommended one. The daemon, not the app, decides what counts as changed and sends the Task Lead one message listing every answer as recommended or changed.

**Depth.** `ted clarify depth <none|few|grilling> "<why>"` (the Task Lead, only at Clarify) and `PUT /tasks/:id/clarify-depth` from the app (the human, any depth including Auto, until Done) both commit `v1.ClarifyDepthSet` with who chose it. The Task carries `clarifyDepthBy`; a depth set before this event existed counts as the human’s, as the Task Lead prompt already said. The thread shows “Task Lead picked Clarify depth: Few · <why>”, “Task Lead switched …” for a later change, and “You set Clarify depth to …” for the human. A human change reaches the live Task Lead as a message.

**Rules the daemon enforces.** A round needs a picked depth other than None, and only the Task Lead posts one, only at Clarify. One round may be open at a time; a newer one replaces it only with `--supersedes`. At Few, a second round in the same Clarify visit is refused until the Task Lead switches to grilling. `ted outcome advance` at Clarify is refused while a round is open. At grilling depth, Clarify has a Gate even when `stages.clarify.gate` is off: `advance` needs a fresh brief and posts a `signoff` whose caption says what each button does; Request changes tells the Task Lead to ask another round.

## Considered Options

- **Markdown round files.** Rejected: numbered lists with ticked choices are easy to get subtly wrong, and the daemon would have to guess where a question ends. JSON gives exact errors (“question 2’s recommended answer must be one of its choices”).
- **TED moves the Task on by itself when a Few round is answered.** Rejected: the spec lets the Task Lead switch to grilling when the answers raise something bigger, so the Task Lead reports the outcome after reading them.
- **A separate table for rounds.** Rejected: a round is a request, and the Inbox, the status and the thread already read requests from Comments.

## Consequences

- Talk it through (KRI-143) and planning rounds (KRI-151) build on the same `round` Comment; the card renders Talk it through disabled until then, and rounds are refused outside Clarify until planning chats need them.
- Decisions go under the brief’s Decisions so far; the sign-off card reads that heading and Open questions from the brief.
