# Checks and Apps run in an OS sandbox outside Bypass

Status: accepted. Changes ADR 0044 and ADR 0084-apps-run-in-detached-hosts. Answers KRI-181.

## Context

An agent in an Auto Factory can edit any file in its worktree, including the scripts a Check or an App runs (`package.json` `"test"`, a Makefile, `scripts/dev.sh`). Until now `ted checks` and `ted run-app` made the daemon run those commands with `$SHELL -lc` or `/bin/sh -c`, as the user and outside any sandbox. So prompt-injected text in a Task could have the agent write a script and then ask TED to run it, at any Stage. ADR 0054-the-app-holds-the-human-token-in-memory holds only while an agent can’t start processes outside its sandbox; this was a way out.

## Decision

**What runs sandboxed.** When the Task’s Workflow has `permissions: auto`, every Check run of the Task and every App of the Task runs inside an OS sandbox, whoever starts it:

- `ted checks` (`POST /tasks/:id/checks`), the Checks at Validate entry and the Merge rerun after a rebase. Validate and Merge run the same agent-written code, and the agent decides when Work ends with `ted outcome advance`, so leaving them out would only add one step to the same escape.
- `ted run-app` (`POST /tasks/:id/apps/start`), the human’s ▶ and Restart, and the approved Apps TED starts for a setup Task. An agent can ask the human to press ▶ on a script it just changed.

In a Factory set to Bypass, the agents already run unsandboxed, and nothing changes.

**One module.** `packages/daemon/src/sandbox.ts` builds the sandbox: `createSandbox` makes one per daemon, `problem()` says whether it works on this machine, and `wrap(argv, { writable, readable, cache, tmp })` returns the command to run and the variables it adds. `runChecks` in `tasks/checks.ts` and the App runner in `apps/apps.ts` both call it; the App host gets the wrapped command in `launch.json` (`shell`, a new optional field). The environment itself still comes from `worktreeCommandEnv` (ADR 0071).

**What a sandboxed command may write.**

- The Task’s worktrees, and the Task folder in a multi-repo Factory.
- Its own temp folder: a fresh folder in the OS temp folder for each Check, deleted afterwards; `TED_HOME/apps/<task>/<repo>/<app>/tmp/` for an App, emptied at each start. `TMPDIR`, `TMP` and `TEMP` point there. On macOS it may also write `/private/tmp`, unless the daemon’s own temp folder is inside it; on Linux `/tmp` is the private folder.
- The Task’s own caches in `TED_HOME/worktrees/<TASK-ID>/sandbox-cache/`, deleted with the Task folder. TED points `XDG_CACHE_HOME`, `npm_config_cache`, pnpm’s `npm_config_store_dir`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`, `GOCACHE` and `GOMODCACHE` there. `COREPACK_HOME` stays on the user’s own Corepack folder, read-only, so a Check uses the same pnpm or yarn as the user’s terminal.

Everything else is read-only, including the user’s own caches (`~/Library/Caches`, `~/.cache`, `~/.npm`, the pnpm store), so a sandboxed command can’t poison what the user runs later. The first Check or App of a Task downloads its packages again into the Task’s store: on this Mac a sandboxed `pnpm install --frozen-lockfile` of a small project took about 1.1 s the first time and 0.6 s after (0.4 s in the user’s own store); a large repo pays its full download once per Task.

**What a sandboxed command may read.** Everything outside `TED_HOME`, and inside it only its own folders above plus the Task’s clones in `TED_HOME/repos/`, which `git` needs because a worktree’s git folder lives there. It can’t read `daemon.json`, the run-token key, the store, Runs, logs or another Task’s worktree. The network stays open, because Apps and tests need loopback ports and package registries; the daemon on loopback answers a sandboxed process with 401, since the process has no token it can read. (`worktreeCommandEnv` drops every `TED_` name, so the agent’s Run token doesn’t reach it either.)

**Only plain folders.** Before it wraps a command, TED checks every writable and readable folder: it must be inside `TED_HOME`, and no part of its path below `TED_HOME` may be a link. The sandbox and the Task Lead can both write the Task folder, so either could swap a worktree for a link to `TED_HOME` or the home folder; TED then refuses to run instead of following it. The paths passed to the sandbox are the checked ones, never a `realpath` of something sandboxed code can change.

**macOS.** `/usr/bin/sandbox-exec` with a profile TED generates. Paths go in as `-D` parameters, never into the profile text. The profile allows by default, then denies every file write and allows `/dev` and `/private/tmp`, denies writing and reading the contents of `TED_HOME`, and finally allows reading the Task’s folders and clones and writing its own folders. Later rules win, so a worktree inside `TED_HOME` stays open while the rest of it is closed. It also denies Apple events, the LaunchServices services and preference writes, so `open`, `osascript` and `defaults write` can’t hand work to processes outside the sandbox; `launchctl submit` is refused too.

**Linux.** `bwrap` from `PATH`: `/` read-only, a fresh `/dev` and `/proc`, its own PID namespace, the private temp folder on `/tmp`, an empty `XDG_RUNTIME_DIR` and no `DBUS_SESSION_BUS_ADDRESS` (so `systemd-run --user` can’t reach the session bus), an empty `tmpfs` over `TED_HOME`, then the Task’s clones read-only and its worktrees, Task folder, caches and temp folder writable. It ends with its parent.

**No sandbox, no run.** TED never falls back to running unsandboxed. If `sandbox-exec` or `bwrap` is missing or fails a test run, `ted checks` is refused with the reason, an App start is refused and the App shows as failed with the reason, and a Validate or Merge Check fails with “TED didn’t run this Check: …” in its log. The Factory gets a `sandbox-unavailable` banner, cleared the next time the sandbox works. `TED_SANDBOX_BIN` names the sandbox program; tests point it at a missing file.

**What stays as it was.** Worktree setup and teardown (ADR 0025) run the Factory’s own commands from the default branch; setup runs on a worktree TED has just made. Run now in Factory settings runs in a scratch worktree of the default branch (ADR 0066). The TED settings Check runs inside the daemon. Simulator tools (`xcrun simctl`) are TED’s own calls.

## Considered Options

- **Allow `ted checks` and `ted run-app` only from Validate on.** Rejected: TED’s own Validate run still executes the code the agent wrote.
- **Accept the risk and record it.** Rejected by the human (KRI-181).
- **Sandbox only what a Run starts.** Rejected: the agent controls when Validate starts and can ask the human to press ▶.
- **Deny-by-default profiles like Codex’s.** Rejected for now: the list of services a toolchain needs (DNS, TLS trust, Xcode) is long and differs by machine; denying writes and the known ways to start outside processes keeps toolchains working.
- **Letting sandboxed commands write the user’s caches.** Rejected in review: a poisoned build or package cache (Go’s `go-build`, Corepack’s package managers, downloaded browsers) runs later outside any sandbox. Each Task gets its own caches instead, at the cost of a cold first run.

## Consequences

- A Check or App that writes outside its worktree now fails there: one that writes `~/.config`, commits or stashes with git (the git folder lives in `TED_HOME`), downloads a new Corepack version, or uses a tool that writes `~/Library/Caches` without honouring the variables above. A Factory that needs more can use Bypass.
- Remaining risk: teardown runs unsandboxed in the worktree the agent edited, and an agent can trigger it with `ted task repos remove`. A teardown that runs repo code (`pnpm run clean`) is still a way out. KRI-164 asks whether TED should ask first.
- Remaining risk: pnpm’s `node_modules` files are hard links into the store that setup used, which is the user’s own, so writing a file in the worktree’s `node_modules` writes the user’s store. That holds for the agent in its own sandbox too.
- Remaining risk: on Linux, `bwrap` resolves its bind paths when it starts, so a Task Lead that swaps a worktree for a link in the moment between TED’s check and `bwrap`’s start could still widen what the Check can write. On macOS the profile names paths, and a later swap only narrows it.
- Remaining risk: sockets and the network are open. A sandboxed command can ask a Docker daemon, an ssh-agent, a tmux server or another local service to run something, and that runs outside the sandbox. The agent’s own sandbox has the same gap when it has network access.
- Remaining risk: an iOS simulator App runs its built app in the simulator through CoreSimulator, outside the sandbox, and Xcode’s DerivedData isn’t writable, so building inside the App command fails.
- Linux is untested on the machines that built this: the `bwrap` arguments, `git` inside `bwrap`, and Ubuntu’s user-namespace restrictions need a manual check (KRI-179). The release-tag test run on GitHub installs `bubblewrap` and turns off Ubuntu’s user-namespace restriction first; the tests that try writing outside the worktree run only on macOS.
