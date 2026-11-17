# Only the Factory setting starts Backlog Tasks, and a start request is used once

The human saw Backlog Tasks start while both **Start Backlog Tasks automatically** and Autopilot were off (KRI-376). Two things made Backlog starts hard to predict.

**Autopilot started Backlog Tasks.** ADR 0100 and ADR 0127 let the global Autopilot switch start eligible Backlog Tasks in every Factory, whatever the Factory’s own setting said. The human decided that Autopilot never starts a Backlog Task. `backlogEligible` in `tasks/tasks.ts` now starts a Backlog Task on its own only when its Factory has `autoStartBacklog` on or the Task has a due snooze. Autopilot still continues prepared Tasks (`preparedEligible`) and still makes routine decisions for started work. This replaces the “retains its eligible automatic starts” sentence in ADR 0127.

**A start request was never cleared.** `startRequested` (ADR 0035) makes `wake` start a Backlog Task once its blockers have merged. Nothing cleared it when the Task started, and the blocker links stay after they merge. So a Task that had started this way and was then moved back to Backlog, by hand from Queued or by a failed start, started again the next time any Task reached Done, a Task was unarchived or deleted, or Ted restarted. `store.queueTask` and `store.startAfterPlanning` now commit `v1.TaskStartRequestChanged` with `false` together with the start when the flag is set. Adding a blocker to a Queued Task still sets it again.

A Task that already carries a stale flag from before this change starts one more time; that start clears it.

Unchanged: a blocked piece from Split it or a planning chat, a blocked Task made with Start now, and a Queued Task that got a blocker still start once when their blockers merge (ADR 0035, ADR 0082, ADR 0083). A due snooze, an Automation and the Coordinator still start Tasks as before.
