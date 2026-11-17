# Worktree setup and teardown run in the daemon, and copy stays inside two folders

When a Task starts, `packages/daemon/src/tasks/` fetches, makes the branch and worktree from `origin/<base_branch>`, copies the `worktree.copy` files from the repo’s local folder, commits `v1.TaskStarted` with `v1.TaskWorktreeCreated` (which lists what was copied and what was skipped, and why), and then runs `worktree.setup` before it starts the Task Lead. With no `setup`, the Task Lead starts before `POST /tasks/:id/start` answers, as before. With a `setup`, the request answers once the worktree exists; the daemon runs `setup` in the background with `/bin/sh -c` in the worktree, writes its output to `TED_HOME/logs/worktrees/<TASK-ID>-<name>-setup.log`, records `v1.TaskWorktreeSetupStarted` and `v1.TaskWorktreeSetupFinished`, and then starts the Task Lead. If `setup` fails or runs past its timeout (15m unless set), the Task Lead still starts, and its first message opens with the command, the exit code or timeout, and the last 16 KB of output. At Done, Ted stops the Run, runs `worktree.teardown` the same way, removes the worktree whatever teardown did, and records `v1.TaskWorktreeRemoved` with the teardown outcome. `worktree.env` goes to `setup`, `teardown` and the Task Lead Run. The Workflow check ignores, with a warning, any name that would replace Ted’s variables or hijack a loader, an interpreter or an agent’s login: `PATH`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, and names starting `TED_`, `LD_`, `DYLD_`, `ANTHROPIC_`, `CLAUDE_`, `OPENAI_` or `CODEX_`. The spec doesn’t forbid them, but a committed file shouldn’t be able to redirect `ted` or the agent.

Each Task carries `repos`: one entry per worktree with its name, branch, path, copy results, setup state and removal. The app’s Code section reads that, and `GET /tasks/:id/repos/:name/setup-log` returns the log. The local folder is stored per owner/repo with `v1.LocalFolderSet`; `GET /factories` reports whether it still exists, which drives the “Local folder for … not found” banner, and `PUT /factories/:key/local-folder` is **Locate**. Neither route is open to Run tokens.

**Copy stays inside two folders.** `copy` comes from a committed `workflow.yaml`, and the local folder is the user’s own clone, so a pattern or a tracked symlink could otherwise pull files such as SSH keys into a worktree an agent can read and push. Ted skips a pattern that is absolute or contains `..`, a match whose real path leaves the local folder, and any destination whose folders in the worktree aren’t plain folders or whose file is a symlink. Only regular files are copied.

**Restarts.** The setup command is a child of the daemon. When the daemon stops it kills the command’s process group; on the next start, a Task with a worktree, no Task Lead Run and an unfinished setup runs `setup` again, then starts the Task Lead. `v1.TaskWorktreeSetupStarted` records the command, timeout and env, and a resumed setup runs exactly those, never a newer `workflow.yaml` fetched in between. If copying fails partway, Ted removes the new worktree and branch so the Task stays in Backlog and can be started again. A setup that had finished but whose Task Lead never started just starts it.

## Considered Options

- **Run `setup` inside the Run host,** so it survives daemon restarts like a Run does (ADR 0013). Rejected for now: the host contract would gain a pre-command phase and its own result records, and `setup` is meant to be a one-off install that is safe to run again.
- **Make `POST /tasks/:id/start` wait for `setup`.** Rejected: `setup` may take 15 minutes, longer than HTTP clients wait, and the app needs “Setting up…” while it runs.
- **Thread events for copy notes and setup failures now.** Deferred: the Task thread’s event lines come with KRI-90. The records on `Task.repos` hold what those lines will show.

## Consequences

- Archive (KRI-103) must call the same removal path as Done so `teardown` runs.
- Branch names from Linear (KRI-104) plug into `branchFor`; clashes are checked against local branches and `origin`.
- KRI-96’s slot counting should count a Task whose setup is running.
