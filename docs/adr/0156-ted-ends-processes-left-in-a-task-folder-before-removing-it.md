# Ted ends processes left in a Task folder before removing it

On the measured home, 497 processes were running from `~/.ted/worktrees/Ted-*` across 23 Tasks: Ted Dev daemons, Run hosts and stub agents that Task Leads, Apps and tests started inside a worktree. `finish` stopped only the Runs and Apps Ted tracks, then deleted the folders. An orphan daemon’s hourly backup then made `worktrees/<TASK-ID>/ted/node_modules/.cache/ted-home` again, so 14 Done Tasks still had a folder, and some processes outlived their folder entirely (TED-355).

**A process belongs to a Task when its working folder or its executable is inside the Task’s folder.** `processPaths` in `packages/daemon/src/leftover-processes.ts` lists both for every process of the daemon’s user: on macOS with one `lsof -a -u <uid> -d cwd,txt -Fpn` (the kernel reports real paths, and `txt` also lists libraries a process mapped from the folder), on Linux from `/proc/<pid>/cwd` and `/proc/<pid>/exe` with any ` (deleted)` suffix removed. Open files and command-line arguments are not matched: an editor or shell that only has a file open stays. The daemon’s own process and its parent are never matched.

**The folder is found without following links.** `taskFolder` checks the name (`[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`), requires the root (`TED_HOME/worktrees` or `TED_HOME/sandbox`) to be a plain folder, and builds the path from the root’s real path. A Task folder that is a link is refused; one that is missing still matches by path, so processes whose folder was already deleted are found. A match is the folder itself or a path under it, so `NB-1` never matches `NB-10`.

**Ending is SIGTERM, then SIGKILL.** `endProcessesInside` sends SIGTERM to every match, waits up to 5 seconds for them to exit, then lists again and sends SIGKILL only to processes that still match, up to three rounds, so a process ID reused in between is not hit. A failure to list is logged and the removal goes on.

**Every removal path calls it.** `finish` in `tasks/tasks.ts` ends the Task’s processes after stopping its Apps and Runs and before teardown, and `cleanFolders` in `tasks/local-lifecycle.ts` ends them again just before it deletes `worktrees/<TASK-ID>` and `sandbox/<TASK-ID>`, which covers Done, archive, reset and delete in every Factory without a teardown command.

**At start, the daemon cleans what closed Tasks left.** A Done Task whose worktree wasn’t removed has `finish` retried, as an archived one already had. Then `sweepLeftovers` in `tasks/leftovers.ts` takes every name under `worktrees/` and `sandbox/`, and every Task folder name a running process is in, that looks like a Task ID (`[A-Z][A-Z0-9]{1,4}-<n>`, so an Automation firing’s `sandbox/<run-id>` and `sandbox/automation-<id>` are never touched). For each one that belongs to no Task, or to a Done or archived Task whose worktrees are all removed and which isn’t being cleared or deleted, it ends the processes and removes the folders with `removeInside`. While it works on a Task that still has a row, it holds the Task in `clearingAway`, which unarchive waits for, and it decides whether the Task is closed inside that hold. The process list taken at the start only says which Tasks have processes; each Task’s processes are listed again before any signal. A daemon that closes while that first list is being taken ends the `lsof` and removes nothing; the next start sweeps again. It removes only under a root that is a plain folder, never through a linked `worktrees` or `sandbox`. It never touches an open Task, a planning chat’s checkout (`TED_HOME/plans/`) or anything outside `TED_HOME`.

## Considered Options

- **A teardown command in this repo’s `.ted/workflow.yaml`.** Rejected: it would help one Factory, and a Task Lead can start processes no teardown knows about.
- **Kill by process group or session.** Rejected: detached daemons and hosts start their own sessions on purpose, so the group doesn’t lead back to the Task.
- **Match command lines that mention the folder.** Rejected: an unrelated process can name a path in its arguments, and a daemon started with a relative `TED_HOME` wouldn’t.

## Consequences

- A user’s own shell or editor whose working folder is inside a Done Task’s worktree is ended when the Task finishes.
- Each finish runs `lsof` once or twice on macOS, about half a second on a busy machine.
- Settings → Storage now shows `TED_HOME/sandbox` as Sandbox caches, and the event log, state database and backups as their own sizes, so the space these folders take is visible.
