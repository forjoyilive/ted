# Stop and Resume are Task events; a fresh Run starts from the brief; an idle Task Lead is nudged once

**Stop.** `POST /tasks/:id/stop` (human token only) records `v1.TaskStopped` first, with how many Runs were live, and then stops every Run on the Task, cancels a running `setup`, releases a held Run and lets any start that is under way finish before stopping what it started. Recording first means no new Run can start for the Task while it stops: `launch` refuses a Stopped Task. The event takes the Task out of the queue and clears “waits for blockers”, so neither a free slot nor a blocker merging starts it again. The worktree, branch and Comments stay. The Task shows Stopped (“Stopped by you · 10m ago” in the header) unless a higher status applies, and its activity line says what was kept. An unanswered “The Task Lead stopped without saying why” question is answered for the human with “The Task was stopped.”

**Resume.** `POST /tasks/:id/resume` with an optional `comment` (Send and resume) posts the Comment, then records `v1.TaskResumed`, which clears Stopped and puts the Task at the end of the queue. If the Task still has unmerged blockers it waits for them instead. When a slot is free, the queued Task with a worktree starts a **fresh Task Lead Run from the brief**: `fromTheBrief` in `tasks/tasks.ts` builds a pick-up note with a heading, the reason, the latest Task brief and the Comments since it, and the Run also gets the Comments that no Run has read yet. The reason is taken from the last of `v1.TaskResumed` and `v1.TaskRequeuedAfterBlockers` in the Task’s log, so it survives a daemon restart. Later tickets (failed resume, unarchive, agent change) add a reason and call the same function. Retry on a Failed Task uses the same route.

**Removing the last blocker by hand** from a Task that stopped mid-flow to wait for it now leaves the Task Stopped (`v1.TaskStopped` with `why: blockers-removed`) instead of queueing a fresh Run, because the spec says removing a blocker by hand never starts a Task. The human resumes it.

**Idle Task Lead.** When the Task Lead’s Run has been idle for `nudgeAfterMs` (default 60 s; `TED_NUDGE_AFTER_MS` for the daemon process) with no unanswered request on the Task, TED sends “Continue. If you need the human to decide or do something, ask with `ted outcome ask "<question>"`; a plain `ted comment` doesn’t wait for them, so TED will ask them why you stopped.” and records `v1.TaskLeadNudged`. If the Run goes idle again with nothing open and nothing from the human since that nudge (no human Comment, no answer, no Stage change), TED posts a `question` from TED, “The Task Lead stopped without saying why”, quoting the agent’s last message (`agentTextFrom` on each agent), with the single choice **Nudge again**, which sends another nudge. The question is answered for the human with “The Task Lead carried on.” when the Run starts working again. The idle timer restarts whenever the agent accepts a new message, because a short turn can go from idle to working and back between two reads of the Run’s log. TED never nudges at Merge, where only the merge watcher moves the Task, and doesn’t nudge while it is working for the Task itself (a sub-agent working or queued, a Check run unfinished, a loop check without a verdict); it checks again after another `nudgeAfterMs`. A Task Lead that asked the human with a plain Comment was being asked about again, so the nudge names `ted outcome ask`.

## Considered Options

- **Stop as a flag kept only in memory.** Rejected: a daemon restart would resume the Task.
- **Resume starting the Run at once.** Rejected: §6.5 says Resume goes through the queue.
- **Nudge the moment the Run goes idle.** Rejected: an agent often ends a turn just as the human is typing, and tests and real use would see a nudge after every short turn.
- **Count nudges in memory.** Rejected: the log gives the same answer after a restart and also draws the thread line.

## Consequences

- A Task’s Stopped state is `stoppedAt` on the `tasks` table; the activity line and header chip read it.
- The app’s Task actions menu, the header’s Resume button, the comment box’s Send and resume and the `S` shortcut all call these two routes.
- KRI-107’s Run bar can call `ted.stopTask` from the renderer for **Stop Task**.
