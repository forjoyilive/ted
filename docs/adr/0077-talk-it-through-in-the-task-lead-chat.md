# Talk it through uses the Task Lead’s own Run chat, and the Task Lead closes the round

**Talk it through** on an open round commits `v1.RoundTalkStarted` with the Task Lead’s Run and sends that Run one line saying the human wants to talk it through. The app then shows the Task Lead’s Run chat (KRI-107) with a “Talking through Round N” header and the round collapsed above the input; messages go through `Conversations.send` like any other chat message. **Done talking** commits `v1.RoundTalkDone` and tells the Task Lead to write a summary. The Task Lead closes the round with `ted ask --close --summary <file>`, either after Done talking or when it decides the talk is over. The daemon posts the file as the Task Lead’s `note` and answers the round with the usual `v1.CommentAnswered`, `kind: 'answered'` with `talkedThrough: { runId, summaryId, messages }`. `messages` counts the human’s delivered chat messages and the agent’s messages between the start of the talk and the summary.

Both app routes (`POST /comments/:id/talk`, `POST /comments/:id/done-talking`) are app-only; `POST /tasks/:id/rounds/close` takes the Task Lead’s Run token only. A talk needs a live Task Lead Run. Starting a talk again on the same Run returns the round unchanged.

## Considered Options

- **A separate Run for the talk.** Rejected: the spec wants the Task Lead’s own context, agent, model and effort, and a second Run would have to be told what the first one knows.
- **Ted writes the summary or closes the round on Done talking.** Rejected: only the Task Lead knows what was agreed, and the spec has the Task Lead post the summary.
- **Counting the round as answered at Few.** A round closed by Talk it through doesn’t use up Few’s one round, so the Task Lead can put what is still open into a new round.

## Consequences

- Messages typed while a talk is open add no “You steered the Task Lead in its Conversation” thread line; the answered card links to the chat with **Open chat**.
- The round stays open, and answerable from its card, until the Task Lead closes it.
