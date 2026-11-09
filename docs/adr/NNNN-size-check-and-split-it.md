# The size check is a question TED answers itself, and Split it is a `proposal` Comment the daemon turns into Tasks

Clarify’s first step checks whether a Task fits one pull request per repo. The Task Lead asks with `ted clarify too-big "<why>" --settle "<point>" …`, which posts a `question` Comment with four fixed choices (Plan in chat, Split it, Plan it outside TED, Grill anyway) and a `sizeCheck` field listing what a plan must settle. TED, not the Task Lead, carries out the human’s choice:

- **Split it** sends the Task Lead the proposal format. The Task Lead posts the pieces with `ted task propose --file <file>`: JSON with a `title`, an optional `summary` and `tasks` rows (`title`, one-line `scope`, optional `description`, `priority`, `blockedBy` row numbers). Row 1 is the Task itself; it can’t be blocked. The daemon checks row numbers and refuses cycles.
- **Create N Tasks** (`approve` with `proposal: { skip, startUnblocked }`) creates the checked rows in Backlog in blocker order, each linked with `v1.TaskSplitFrom` (shown as created by Split it), blocked by the rows that are kept (row 1 means the original Task). A blocker on an unchecked row is dropped, not replaced by that row’s own blockers. Blocked pieces are created with Start requested, so they start when their blockers merge; unblocked pieces start only when `startUnblocked` is set. The original Task narrows to row 1 in one commit (`v1.TaskEdited` and `v1.TaskSplit`), keeps its thread and Original request, and its Task Lead is told and carries on with Clarify. The approved answer records which rows became which Tasks.
- **Plan it outside TED** posts the Task Lead’s reason and the points to settle as a note from its Run, commits `v1.TaskNeedsPlanning` (Backlog with the Needs planning marker, open requests withdrawn), and removes the worktree the way archiving does. Starting the Task again commits `v1.TaskStartedAfterPlanning`, which clears the marker and queues it at Clarify; the fresh Run picks up from the brief like a resumed one and reads the description, which may now hold the plan.
- **Grill anyway** sets the depth to grilling as the human’s choice.
- **Plan in chat** is refused with 409 until planning chats exist; `planInChat` in `tasks/tasks.ts` is where they plug in, and the card shows the button disabled.

`planProposal` in `packages/protocol/src/proposal.ts` decides which rows are created, their blockers, which are dropped, which would start and the creation order. The app’s card and the daemon both use it, so the button count and warnings always match what the daemon creates.

## Considered Options

- **Let the Task Lead act on the size answer with `ted comment` and its own commands.** Rejected: moving a started Task back to Backlog and stopping its Run are TED’s jobs (ADR 0016), and the human’s choice should take effect even if the agent misreads the message.
- **Markdown proposal files.** Rejected for the same reason as rounds (ADR 0050): JSON gives exact errors by row.
- **Count the first piece in Create N Tasks.** Rejected: the Figma card counts only the Tasks the button creates.

## Consequences

- Planning chats (KRI-151) post the same `proposal` Comment without `firstPiece`, reuse `ProposalAnswer` and `planProposal`, and replace `planInChat`.
- Store events added: `v4.CommentPosted` (adds `proposal` and `sizeCheck`), `v1.TaskSplitFrom`, `v1.TaskSplit`, `v1.TaskNeedsPlanning`, `v1.TaskStartedAfterPlanning`.
- Piece creation is one commit per Task, so a daemon crash in the middle can leave some pieces created and the proposal still open.
