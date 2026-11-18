# Cleanup skips the busy hold, and queued labels say only why

Status: accepted (TED-579). Amends ADR 0184-work-in-progress-skips-the-busy-hold.

ADR 0184 let a Task Lead continuation after Checks or an answer skip the busy hold, and kept Cleanup waiting like new work. In practice Tasks in Cleanup showed “Queued · this computer is busy” often: their pull requests had merged and only a short Task Lead turn was left, yet they waited behind the load with their worktree and Apps still up. A Factory whose Cleanup has instruction steps always needs that turn. By Cleanup the Task Lead has often ended (it sleeps while Merge waits), so the Task comes back through `resumeTask` as a queued Task, not a continuation.

**A Task in Cleanup skips the busy hold.** The Task’s Stage decides it, through `isCleanup`, so nothing new is stored. `continuationsReady` in `tasks/tasks.ts` gives a Cleanup continuation `skipsBusy`, and the store’s `queue()`, `heldReady` and `revivesReady` give a queued, held or revived Task in Cleanup `skipsBusy`. `queueOrder` sorts a queued Task with `skipsBusy` with the continuations, ahead of Tasks that haven’t started; it still launches as a Task, with a new Task Lead Run. The working-Run limit, Factory caps, the disk hold and agent pauses still apply. Autopilot reminders still wait like new work.

**Queued labels say only why.** A queued Task reads “Queued · computer is busy” when the busy hold stops it, and “Queued · 2nd” with its place otherwise. The “Checks passed / Checks finished / Answered, waiting for a slot” labels of ADR 0184 are gone: the user wants the status to say why the Task waits, not what it did before. `TaskFacts.queue` carries `skipsBusy` in place of `after`, and `TaskStatus` no longer carries `after`; `after` stays on held Task Lead messages, where it decides `skipsBusy`. `busyHold` reads “computer is busy” everywhere it shows, including queued sub-agents and the Runs line.

## Considered Options

- **Starting Cleanup past the working-Run limit.** The user chose to keep the limit.
- **A Cleanup label (“Queued · Cleanup, waiting for a slot”).** The user chose one label for every wait.
