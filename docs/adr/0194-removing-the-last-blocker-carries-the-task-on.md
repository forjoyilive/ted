# Removing the last blocker carries the Task on

Status: accepted. Replaces the “Removing the last blocker by hand” paragraph of ADR 0046-stop-resume-and-the-idle-nudge.

ADR 0046 stopped a Task when the user removed its last blocker, because the spec said removing a blocker by hand never starts a Task. A Task the user had only blocked, and never stopped, then showed Stopped and needed Resume (TED-623).

## Decision

**When the user removes or archives the last unmerged blocker of a Task that was waiting for it, Ted carries the Task on, as it does when the blocker merges.** `removeBlockers` and `releaseParent` in `tasks/tasks.ts` mark the Task with `v1.TaskBlockersRemovedChanged` before they call `wakeTask`, which reads the mark to choose the reason `removed`. The mark is stored, so it holds across a daemon restart and while a parent’s own work is checked, and `openBlockedTasks` lists every Task that holds it, so the startup wake reaches it. It is cleared in the commit that requeues or starts the Task, when the Task is blocked again, stopped, archived or Done, and by `v1.TaskReset` and `v1.TaskMovedToFactory` (TED-633):

- A Task waiting mid-flow goes back into the queue with `v2.TaskRequeuedAfterBlockers` (`why: removed`). The thread reads “Blockers removed · carrying on”, and the fresh Task Lead Run’s pick-up note says the user removed the blockers.
- A Backlog Task created with Start now starts, with the start cause `blockers-removed` (“Started because its blockers were removed”). A Backlog Task created without Start now stays in Backlog.
- A parent waiting on child Tasks carries on when its last unmerged child is unlinked, archived or deleted.
- When the blocker was a repair Task that ended without merging, Ted’s note says the next Task Lead Run reassesses the failure, which is still open.

**A Task that needs the user stays as it is.** A Task the user stopped is never woken. A Task prepared through Design and waiting for Resume or Autopilot, a Failed Task, and a Task waiting on the user’s answer stop with `why: blockers-removed`, as before (`carryOnOrStop`).

`v1.TaskRequeuedAfterBlockers` stays and still reads as merged; a merged blocker now writes `v2` with `why: merged`.

## Considered Options

- **Keep the stop.** Rejected by the user: adding a blocker is not stopping the Task, so removing it shouldn’t leave the Task stopped.
- **Leave a Task created with Start now in Backlog.** Rejected: it was meant to start once its blockers cleared.
