# Event lines come from a per-Task log, and the human’s Comments go into the Task Lead’s Run

**Event lines.** Every event that changes a Task and carries its `taskId` also writes a row in the `taskLog` table: the event’s name, the few fields a line needs, and its time. The rows are keyed by the event’s sequence number, so rebuilding the state from the event log gives the same rows, and Tasks made before this change get their history too. Fields that are large or may hold secrets, such as a Run’s prompt or a setup command’s `env`, are left out. `threadEvents` in `packages/daemon/src/tasks/thread.ts` turns the rows into plain lines with a tone (`edit`, `done`, `run`, `failure`, `quiet`, `request`), which the app draws as the dot colour. `GET /tasks/:id/events` returns them. A Stage entry that follows an approved Gate reads “You approved · Task moved to Work”; one that follows a send-back is folded into the red send-back line, which carries the Findings. TED’s own notes show as grey event lines.

**Comments into Runs.** `POST /tasks/:id/comments` with the human’s token posts a `note` from the human. If the Task Lead’s Run is live (working, idle, waiting or paused), TED records `v1.CommentsDelivered` and writes the Comment into the Run’s input; the agent CLI queues it until its current turn ends, and the Codex driver holds it until `turn/completed`. When the agent accepts a user message (Claude Code’s replayed user message, Codex’s `userMessage` item) that contains the Comment, TED records `v1.CommentsRead`. With no live Run, the Comment stays undelivered. An answer to a request that couldn’t reach a Run is marked with `v1.CommentAnswerHeld`. The next Task Lead Run, fresh or resumed, gets both in a “Comments since the last Run” section of its first message (with the Task brief when the Run is fresh and has no other pick-up note), and TED records them as delivered to it. Comments that arrive while that Run is starting are sent once it has started. Agents’ and TED’s Comments count as read when the human opens the thread (`POST /tasks/:id/read`).

**Comment box.** The daemon chooses the box’s state with `commentBox` in `tasks/status.ts` (`live`, `paused`, `no-run`, `stopped`, `failed`, `done`) and sends it on the Task.

## Considered Options

- **Build lines from the state tables.** Rejected: those tables keep only the latest state, so queueing, holds, blocker removals and setup times would have no history.
- **A thread-event event written next to each change.** Rejected: it would copy facts already in the log, and older Tasks would have no lines.
- **Mark a Comment read when the Run next becomes working.** Rejected: a message written mid-turn can be taken in the same turn, with no state change to see.

## Consequences

- A new kind of event line is an entry in `taskLogEntries` in `store/schema.ts` and a case in `thread.ts`; adding a table rebuilds the state from the event log once.
- Event lines don’t emit their own live update; the app reloads them on `task-updated` and Comment events for the Task.
- Stopped’s **Send and resume**, Failed’s Retry, Done’s **Follow up** and the Archived box come with their tickets.
