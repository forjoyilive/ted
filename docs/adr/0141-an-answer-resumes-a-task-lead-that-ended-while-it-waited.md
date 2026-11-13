# An answer resumes a Task Lead that ended while it waited

A Task Lead that asks a request (a Clarify round, a question, a sign-off) ends its turn and waits. If its Run ends before the answer comes, most often because TED quit or updated, the answer is held for the next Run. Nothing started that Run: the Task showed “The Task Lead has stopped. Resume to carry on.” until the user pressed Resume. The restart dialog (ADR 0128) didn’t offer such a Task either, because it was waiting on a request when TED stopped it, and `v1.TaskStoppedByTed` is recorded only for a working Task Lead.

- **Answering is the go-ahead.** After every answer, `answerAs` in `tasks/tasks.ts` calls `resumeAfterAnswer`. When `interrupted` allows a resume (the Task can resume, can start fresh, and isn’t being revived, recovered or advanced), it records the restart answer to any pending TED stop and calls `store.resumeTask` and the pump, the same path as Resume. The queue order, the working-Run limit and the full-disk hold apply. The new Run gets the held answer as Resume’s Run would.
- **Every request kind and every answerer.** Clarify rounds, questions, sign-offs, size checks and failure decisions all go through `answerAs`, and so do the human’s answers, Autopilot’s and the Coordinator’s. The human chose that Autopilot and Coordinator answers restart the Task too.
- **At Merge, only the Task Lead’s own requests.** `taskCanResume` keeps Merge out of Resume (ADR 0128), but a Task Lead started there by GitHub activity can ask. An answer to a request that Task Lead Run posted restarts it when the Run ended as `stopped` and nothing else is open (`leadAskedAtMerge` in `tasks/status.ts`). An answer to TED’s own requests at Merge, such as the Merge sign-off, starts no Run: the merge watcher handles those.
- **A Task the human stopped stays stopped.** `canStartFresh` refuses a Task with `stopped` set, so only Resume starts it again.
- **A Task with other open requests waits.** `taskCanResume` is false while any request is open, so the Task resumes when the last one is answered.

## Considered Options

- **Only the human’s answers restart it.** The human chose any answer, so a Task Autopilot or the Coordinator answers carries on without the human.
- **Only Clarify rounds.** Every request kind leaves the same stopped Task behind, so all of them restart it.

## Consequences

- This narrows ADR 0128’s “nothing but the app’s answer restarts these Tasks”: an answer to the Task’s own request restarts it too, and clears a pending offer for it.
