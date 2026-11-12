# A Task reset is one event that clears the thread and keeps the Task

A Task that went down a wrong path could only be steered further, or archived and created again by hand, which loses its ID, Source link, blockers and place in the list (KRI-317). The human wants to throw the attempt away and start the same Task again from what it was created with.

- **Who and which Tasks.** Only the app’s key calls `POST /tasks/:id/reset`; there is no `ted` command, and no Run, Coordinator or Automation can reset. `resetRefusal` in `packages/protocol/src/task.ts` decides, for the app and the daemon alike: the Task is started, and not Done, archived, Partly merged or holding a merged pull request.
- **Order.** `Tasks.reset` refuses while the Task’s Checks are running, because a running Check is not stopped and the new worktree has the same path. It then marks the Task as stopped, so the queue, Task Lead recovery and the merge watcher leave it alone, and waits for a merge cycle in flight. It closes the open pull requests and reads their state again: if one is still open, or one has merged, it stops there with nothing discarded. Then it runs the `clearing` path Archive uses (stop every Run, sub-agent and App, teardown, remove the worktrees) and deletes the Task’s branch on GitHub, when it was pushed, and in each clone. A branch that is already gone counts as deleted; any other failure stops the reset with the thread intact. Only then does it commit the reset.
- **One event.** `v1.TaskReset { taskId, description, clarifyDepth, clarifyDepthBy, runIds, checkRunIds, at }` deletes the rows `v1.TaskDeleted` deletes for the thread and the code, and the Task’s interval boundaries, and sets the Task row back to Backlog. `description` is the first description version, so a Task narrowed by Split it gets the whole request back. A Clarify depth the Task Lead picked goes back to the human’s choice, or to Auto.
- **What stays.** The Task row (ID, number, title, Priority, rank, Task Lead choice, forced Gates, Gate overrides, Autopilot choice), blockers, Source, the attachments from creation, and the `v1.Linear*` Task log rows, because Linear sync consent and the issue’s last seen state are read from them. The thread draws only what follows the last `v1.TaskReset`, so those rows don’t show.
- **Starting again.** The Task rejoins the queue through `queueStart` with its old rank (`store.queueTask`’s `keepRank`). With unfinished blockers it waits in Backlog with a start requested, as any blocked Task does.
- **The app.** “Reset…” sits above “Archive…” in the Task actions menu and the command palette. The dialog lists what is lost and what is kept; a `task-reset` event makes the Comment and Check run lists load again.

## Considered Options

- **Delete the Task and create a new one with the same number.** Blockers, the Linear sync record, the rank and links from other Tasks point at the Task’s ID, and the human chose the same Task.
- **Keep the old branch on GitHub.** The new attempt’s first push to it would be refused, or it would need a new branch name; the human chose to discard the code.
- **Record the title from before a split.** TED keeps old descriptions but not old titles, so this would help only Tasks split after the change. A narrowed Task keeps its narrowed title, and the dialog says so.

## Consequences

- A reset can’t be undone. The events of the old attempt stay in the event log, as with a deleted Task.
- The Dashboard’s times for the Task start again, because the Task log and interval boundaries are cleared. What its Runs used (`v1.RunUsageRecorded`) stays in the API cost totals.
- A Linear issue TED already moved to review stays there until the new attempt reaches that step again; TED never moves an issue backwards.
- A planning chat started from the Task is unlinked, with the reason `reset`.
