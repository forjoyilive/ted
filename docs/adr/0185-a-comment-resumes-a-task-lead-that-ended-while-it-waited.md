# A Comment resumes a Task Lead that ended while it waited

A Task Lead that asked a request and ended its turn can lose its Run while it waits, most often because TED quit or updated. ADR 0141-an-answer-resumes-a-task-lead-that-ended-while-it-waited restarts it when the user answers. A plain Comment did nothing: it showed “Goes to the next Task Lead Run”, and Resume wasn’t offered because a request was still open, so the Task sat until the user found Resume elsewhere (TED-532).

- **The user’s Comment is the go-ahead.** When `humanComment` in `tasks/tasks.ts` finds no live Task Lead, it calls `resumeAfterComment`. That resumes the Task through the same `resumeEnded` path as an answer: it records the restart answer to any pending TED stop, then `store.resumeTask` and the pump. The queue order, the working-Run limit and the full-disk hold apply, and the new Run gets the Comment under “Comments since the last Run” (ADR 0041).
- **Open requests don’t block it.** `taskWakesOnComment` in `tasks/status.ts` is `taskCanResume` without the open-request condition. The request stays open for the new Run to see. Everything else still refuses: a Task the user stopped, Backlog, Done, archived, failed, blocked, already queued or with a Run going.
- **Only the user’s own Comments.** `coordinatorTell` posts with `wakes` off, so a Coordinator’s note waits for the next Run as before. Comments sent with answers, line comments and uploads go through `humanComment` and wake the Task.
- **The label says what happens next.** `commentDelivery` in `tasks/status.ts` puts `starting`, `queued` or `paused` (a Provider pause, such as a usage limit) on the Task. The thread shows “Starting the Task Lead…”, “Waiting for a free slot” or “Waits for <Provider> to come back” under an undelivered Comment, and “Goes to the next Task Lead Run” only when nothing will start on its own.

## Considered Options

- **Show Resume beside the comment box and let the user choose.** The user chose that a Comment starts the Task Lead, since they comment to get an answer.
- **Also wake Tasks TED stopped for its own reasons** (`blockers-removed`, `repair-incorporation`, `prepared`). These count as stopped and keep their Resume button; a Comment never undoes a stop.

## Consequences

- This narrows ADR 0128-ted-asks-before-restarting-tasks-it-stopped further: the user’s Comment on a Task restarts it, like an answer.
