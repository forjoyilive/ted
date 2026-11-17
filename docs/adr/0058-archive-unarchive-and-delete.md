# Archive, Unarchive and Delete

Status: accepted. Builds on ADR 0035 (blocked Tasks) and ADR 0048 (pull requests). ADR 0185-archiving-or-deleting-a-blocker-always-unblocks replaces its “Blocking others” choice.

## Context

KRI-98 added `v1.TaskArchived`, which stops a Task’s Runs and removes its worktree but can’t be undone. Spec §6.19 also needs Unarchive, Delete, and a choice about the Tasks an archived or deleted Task blocks (§6.16). Spec §3.6 says deleting a Task removes its files at once while its events stay in the event log.

## Decision

- **Archive** writes `v2.TaskArchived` with the pull requests it is closing (“widgets #7”) and how many branches it keeps, so the thread line can say “You archived this Task · closed widgets #7 on GitHub · kept the branch”. Clearing away (stop Runs, `teardown`, remove the worktree) runs in the background as before; the Tasks module keeps one clearing promise per Task so Unarchive and Delete wait for it.
- **Unarchive** writes `v1.TaskUnarchived`. A Backlog or Done Task just comes back, with nothing running. A Task mid-flow is queued again (the event carries its rank) and its stopped, failed and waiting flags are cleared; if it still has unmerged blockers it waits for them as after Resume. When the queue launches it, `launchQueued` sees repos that were all removed and makes the primary repo’s worktree again from the Task’s branch (local branch, else `origin/<branch>`, else the base branch), copies the `copy` files, runs `setup`, and starts a fresh Task Lead Run whose prompt starts “Picking up after unarchiving” with the brief and Comments since. Closed pull requests are reopened with `gh pr reopen`; one whose branch is gone fails and is logged.
- **Delete** is `POST /tasks/:id/delete`. It archives the Task first if it isn’t archived, waits for clearing away, then writes `v1.TaskDeleted` and removes the Task’s Run folders, check and worktree logs, its worktree folder and attachments no other Task uses. Every file is removed through `removeInside`, which takes one plain file name inside a real folder and never follows a link. The `v1.TaskDeleted` materializer deletes the Task’s rows from every state table (Runs, Conversations, Comments, briefs, Checks, repos, pull requests) and adds a row to `deletedTasks` with the Factory and number. The events stay in the event log.
- **Numbers aren’t reused.** A new Task’s number is one more than the highest of the Factory’s Tasks and deleted Tasks.
- **Blocking others.** Archive and Delete take `blocked: "unblock" | "keep"`, default `unblock`. Unblock removes each link as a human removing the blocker would. Keep leaves the links; the blocker then never counts as merged (a deleted one) or counts only once it is unarchived and merges (an archived one). The Task’s status and marker carry `ended: "archived" | "deleted"`, and its activity reads “Blocked by archived NB-12” or “Blocked by deleted NB-35”. `deletedTasks` keeps the deleted Task’s ID.
- **Read-only.** An archived Task’s `commentBox` is `archived` and the daemon refuses a human Comment on it. The app shows only Unarchive and Delete in its Task actions.
- **Live updates.** Delete emits a new `task-deleted` event with the Task’s ID; Archive, Unarchive and Delete send `task-updated` for each Task it blocks.
- All three routes are app-only (ADR 0054).

## Considered Options

- **Delete without archiving first.** The Task would have to stay in the store until its worktree is gone, or the daemon would need to find leftover worktrees after a restart. Archiving first reuses the restart path that finishes clearing away.
- **Keep the Task row with a deleted flag.** Every query would have to skip it, and the spec says the Task is removed.
- **Recreate the worktree in the Unarchive request.** It would bypass the queue and slot limits; the queue already starts fresh Runs for Resume and blockers.

## Consequences

- If the daemon stops between archiving and deleting, the Task stays archived and Delete can be pressed again.
- Only the primary repo’s worktree is made again; other repos of a multi-repo Task come back when they are added again (KRI-126).
- Uncommitted changes in an archived Task’s worktree are gone; the fresh Run is told so.
