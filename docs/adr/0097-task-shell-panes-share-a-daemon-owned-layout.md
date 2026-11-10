# Task shell panes share a daemon-owned layout

Task shells now support split panes (KRI-32), extending ADR 0075’s single PTY per Task and repo. The daemon owns a binary split tree and up to eight independent PTYs per Task/repo. Leaves name opaque shell IDs; branches record a direction and divider ratio. Keeping both together lets the app reconnect to the same panes and processes without guessing which shells to create. Layout mutations carry a revision, so a stale view cannot overwrite a newer arrangement.

Each pane has its own input queue, output cursor, generation, size and exit status. A split starts a new login shell at the worktree root with `Tasks.worktreeAccess`’s environment; it does not copy another process’s current directory or variables. Close and Restart confirm before ending that pane’s process group. Closing the last pane leaves an empty layout; opening the view again does not silently start a shell. An exited shell retains its output until explicitly restarted or closed.

The existing shell routes remain aliases for the first surviving shell; the app uses explicit pane IDs. New workspace and pane routes stay app-only, including GETs, and every operation revalidates access to the Task/repo. Creating a pane changes the layout only after its PTY launches. Closing a pane wakes its long-poll readers, which return missing instead of creating a replacement. Each live PTY contributes an idle hold and to the machine’s running-shell count. Removing the worktree closes every pane.

## Considered options

- **Store the arrangement only in the renderer.** Rejected: the daemon owns the shell lifetime, and a reloaded app needs an authoritative list of surviving shells. A daemon-owned tree also avoids two views assigning different arrangements to the same processes.
- **Persist the layout across daemon restarts.** Deferred: the shell processes already end with the daemon. Recreating a saved arrangement would start fresh processes that might look like continuations. As with ADR 0075, panes and their layout survive app restarts while the daemon runs; the next open after a daemon restart starts with one fresh shell.
- **Automatically reopen missing pane IDs.** Rejected: a missing ID can mean the human closed that pane. The app refreshes the layout instead and creates shells only on an explicit open or split.
