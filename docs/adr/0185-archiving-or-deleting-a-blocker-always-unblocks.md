# Archiving or deleting a blocker always unblocks

Status: accepted (TED-528). Replaces the “Blocking others” choice of ADR 0058-archive-unarchive-and-delete.

ADR 0058 gave Archive and Delete a `blocked: "unblock" | "keep"` choice. An archived or deleted Task never merges, so a kept link never clears by itself: the blocked Task waited until someone removed the link by hand. Users answered Unblock almost every time, and a Task Lead’s own archive and the archive after a tracker issue closes already unblocked without asking.

**Archive and Delete always unblock.** `settleDependents` in `tasks/tasks.ts` removes the link from every Task the archived or deleted Task blocks, as a human removing the blocker would, and posts the existing note (and the repair notice when the blocker was a repair Task). The `blocked` field is gone from `ArchiveTaskRequest`, `DeleteTaskRequest`, the Coordinator’s removal input and card choices, and `ted coordinator archive|delete --blocked`; the parsers ignore it if an older client sends it. Unblocking starts nothing: a Backlog Task loses its start request and a Task waiting mid-flow stops until the user resumes it.

**The dialogs list, they don’t ask.** The Archive and Delete dialogs, the multi-Task dialog and the Coordinator’s card show “Unblocks N Tasks” with the Tasks that will be unblocked, counting those blocked by any Task archived or deleted with it. A Coordinator archive whose only warning was the block no longer makes a card; it happens at once and its receipt names the unblocked Tasks. A card shown for another reason still goes stale when the Tasks it blocks change, because it lists them. The Task Lead’s archive request no longer opens the dialog for blocked Tasks alone.

Links kept before this change stay, still marked “Blocked by archived NB-12” or “Blocked by deleted NB-35”, until the user removes them.

**Unarchive puts the blocks back (TED-530).** After an archive removes the links, `settleDependents` commits `v1.ArchiveUnblocked` with the Tasks it unblocked, kept in the `archiveUnblocks` table. Any later `TaskBlockerAdded` or `TaskBlockerRemoved` for the same pair drops its row, so a change the user made by hand wins. Unarchive (`unarchive` in `tasks/tasks.ts`, for the Task and every child restored with it) puts back each recorded link whose Task isn’t archived (unless it is restored in the same unarchive), isn’t Done, has no link to it already and wouldn’t make a cycle. `restoreBlock` checks each one and adds it right before the unarchive commits, with no wait in between, so a Task archived meanwhile is skipped and each cycle check sees the blocks already restored. A restored link follows the rules for a blocker the user adds: a queued Task goes back to Backlog and a running Task Lead gets the usual message. `v2.TaskUnarchived` carries only the Tasks actually restored, as `reblocked`; the thread line reads “You unarchived this Task · NB-12 is blocked by it again”, and its materializer clears the Task’s rows. Delete records nothing. Tasks archived before this change have no rows, so nothing comes back for them.

## Considered Options

- **Keep the choice and change only the default.** The default was already Unblock; the extra question was the cost.
- **Ignore `blocked` in the API but keep accepting it.** The app, daemon and CLI ship together, so nothing current sends it; the parsers already ignore unknown fields.
- **Put the blocks back on Unarchive.** Done in TED-530; see “Unarchive puts the blocks back” above.
