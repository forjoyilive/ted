# One rank per Task, placed by the daemon

Amended by ADR 0195-stage-queue-priority-and-busy-hold-skip-are-workflow-settings: the queue applies Stage priority and continuation order before Priority and rank, so its order can differ from the List’s Manual sort.

The List (KRI-98) and the Board (KRI-97) both let the human drag Tasks into order, and the List’s Queued view orders the machine-wide queue. All three use the same number: every Task has a `rank`, and the Manual order everywhere is Priority, then rank.

**Where rank lives.** `v1.TaskRanked` sets `tasks.rank` and, if the Task is queued, the `taskQueue` row’s rank, so the queue’s order (ADR 0030) and the List’s Manual sort can’t disagree. A new Task gets a rank one more than the highest on the machine, committed with `v2.TaskCreated`, so it lands at the bottom of its Priority group. Starting a Task gives it a new bottom rank again, so the queue stays first-come within a Priority until someone drags. Tasks created before this event have no stored rank and use their number.

**How a drag becomes a rank.** Clients never send a rank. They send `POST /tasks/:id/move` with the Task it now sits after and the one it sits before, as the human sees them. `Tasks.move` reads those two Tasks and `placeBetween` in `packages/daemon/src/tasks/order.ts` picks the rank halfway between them and the Priority: the neighbours’ shared Priority, the Task’s own when it lands on the border between its group and another, otherwise the Priority of the Task above. A Priority change and the new rank commit together (`v1.TaskPriorityChanged`, `v1.TaskRanked`). Start and un-start between groups stay their own calls (`/start`, `/backlog`), made before the move.

**Priority and archive.** `PUT /tasks/:id/priority` sets Priority on its own (multi-select). `POST /tasks/:id/archive` records `v1.TaskArchived`, which takes the Task out of the queue in the same commit, then stops its Runs and removes its worktrees in the background. An archived Task has no status or markers and carries `archived: { at, ended }`, where `ended` is never started, merged, or stopped in a Stage. Its requests leave the Inbox. Starting, moving or archiving an archived Task answers 409. Unarchive, Delete and the archive dialog are KRI-103.

**What the List shows.** A Task now carries `statuses` (every status it has right now, from `taskStatuses` in `status.ts`, so the Status filter can match more than the one shown), `updatedAt` (the latest of creation, Priority change, queueing, Stage entry, Run start, Comment, answer and brief) and `createdBy` (always `human` until Automations, planning chats, splits and Follow-ups exist). The List’s sort, group, filters and columns are the machine setting `listViews`, keyed by scope (`all` or a Factory ID), validated in `settingParsers`. Filtering, sorting and grouping run in the renderer (`list-view.ts`) on the Tasks it already has.

## Considered Options

- **A separate queue rank and Board rank.** The queue already had a rank, but a Queued Task appears in the queue, on the Board and in the List; two numbers would let the List say one order while the pump starts another.
- **Clients send the new rank.** Simple, but each client would need the same midpoint and Priority rules, and two clients could disagree. Sending neighbours keeps the rule in one place for the Board, the List and ⌥↑/⌥↓ later.
- **Integer ranks renumbered on each move.** Renumbering touches every Task after the drop, one event each. Halving between neighbours writes one event; the gap only runs out after about fifty drags into the same spot, and a later ticket can rebalance if it ever matters.
- **List views in the renderer’s local storage.** The app holds no state of its own (ADR 0011), and machine settings already persist per machine.

## Consequences

- The Board drops rows through the same `/move` route.
- The Tokens column shows “—”: counting tokens per Task means reading every Run’s Conversation, which is too slow for every Task on every list.
- `createdBy` only has `human` until the features that create Tasks for the human exist.
- Archive here is the minimum the List needs; KRI-103 adds the dialog, pull request closing, Unarchive and Delete on top of `v1.TaskArchived`.
