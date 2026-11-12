# Checks and Apps run in an OS sandbox outside Bypass

Status: accepted. Changes ADR 0044 and ADR 0084-apps-run-in-detached-hosts. Answers KRI-181. KRI-254 changed it: the human’s ▶ runs outside the sandbox (see “The human’s ▶” below).

## Context

An agent in an Auto Factory can edit any file in its worktree, including the scripts a Check or an App runs (`package.json` `"test"`, a Makefile, `scripts/dev.sh`). Until now `ted checks` and `ted run-app` made the daemon run those commands with `$SHELL -lc` or `/bin/sh -c`, as the user and outside any sandbox. So prompt-injected text in a Task could have the agent write a script and then ask TED to run it, at any Stage. ADR 0054-the-app-holds-the-human-token-in-memory holds only while an agent can’t start processes outside its sandbox; this was a way out.

## Decision

**What runs sandboxed.** When the Task’s Workflow has `permissions: auto`, every Check run of the Task and every App an agent or TED starts runs inside an OS sandbox:

- `ted checks` (`POST /tasks/:id/checks`), the Checks at Validate entry and the Merge rerun after a rebase. Validate and Merge run the same agent-written code, and the agent decides when Work ends with `ted outcome advance`, so leaving them out would only add one step to the same escape.
- `ted run-app` (`POST /tasks/:id/apps/start` with a Run token) and the approved Apps TED starts for a setup Task.

**The human’s ▶.** The human’s ▶, Restart and the sign-off Preview row’s Run or Open start the App outside the sandbox (KRI-254). Electron and other desktop Apps, such as TED’s own “TED Dev”, can’t start inside it, and the human pressing ▶ to try a change is the same as running it in the Task’s shell. The daemon tells the two apart only by the caller: a start signed with the app’s in-memory key (ADR 0054-the-app-holds-the-human-token-in-memory) is the human’s; a Run token is an agent’s. No field in the request changes it, so a Run can’t ask for an unsandboxed start. When the human starts an App that is running or waiting sandboxed, TED stops it and starts it again outside the sandbox.

Because an agent can ask the human to press ▶ on a script it just changed, the app asks first. Each `TaskApp` in an Auto Factory carries `confirmOutsideSandbox` until the human chooses **Always for <App> in this Factory**; while it is set, ▶, Restart and the Preview row show a dialog (“<App> runs code from the Task’s branch on your Mac, outside the sandbox, like running it yourself in the Task’s shell.”) with **Run** and that checkbox. The choice is the machine setting `appsOutsideSandbox` (App names by Factory ID), changed only through `PATCH /settings`, which Run tokens and the `daemon.json` token can’t call. Removing the Factory removes its entry. The daemon doesn’t require the dialog; it is the human’s own check before they run the code.

**Preview row for desktop Apps.** With no web App, the sign-off’s Preview row offers the Task’s first `command` App as **Open <App>**, which starts it like ▶, and shows **Running** once it is up. TED treats every `command` App as one that opens its own window rather than adding a `window:` field to the App declaration: a background `command` App shows the same button, which only starts it.

In a Factory set to Bypass, the agents already run unsandboxed, and nothing changes.

**One module.** `packages/daemon/src/sandbox.ts` builds the sandbox: `createSandbox` makes one per daemon, `problem()` says whether it works on this machine, and `wrap(argv, { writable, readable, cache, tmp })` returns the command to run and the variables it adds. `runChecks` in `tasks/checks.ts` and the App runner in `apps/apps.ts` both call it; the App host gets the wrapped command in `launch.json` (`shell`, a new optional field). The environment itself still comes from `worktreeCommandEnv` (ADR 0071).

**What a sandboxed command may write.**

- The Task’s worktrees. Not the Task folder of a multi-repo Factory, which holds them.
- Its own temp folder: a fresh `TED_HOME/sandbox/<TASK-ID>/tmp-*` folder for each Check, deleted afterwards; `TED_HOME/apps/<task>/<repo>/<app>/tmp/` for an App, emptied at each start. `TMPDIR`, `TMP` and `TEMP` point there. On macOS it may also write `/private/tmp`, unless the daemon’s own temp folder is inside it; on Linux `/tmp` is the private folder.
- The Task’s own caches in `TED_HOME/sandbox/<TASK-ID>/cache/`, deleted with the Task’s worktrees and when the Task is deleted. TED points `XDG_CACHE_HOME`, `npm_config_cache`, pnpm’s `npm_config_store_dir`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`, `GOCACHE` and `GOMODCACHE` there. `COREPACK_HOME` stays on the user’s own Corepack folder, read-only, so a Check uses the same pnpm or yarn as the user’s terminal.

Everything else is read-only, including the user’s own caches (`~/Library/Caches`, `~/.cache`, `~/.npm`, the pnpm store), so a sandboxed command can’t poison what the user runs later. The first Check or App of a Task downloads its packages again into the Task’s store: on this Mac a sandboxed `pnpm install --frozen-lockfile` of a small project took about 1.1 s the first time and 0.6 s after (0.4 s in the user’s own store); a large repo pays its full download once per Task.

**What a sandboxed command may read.** Everything outside `TED_HOME`, and inside it only its own folders above plus the Task’s clones in `TED_HOME/repos/`, which `git` needs because a worktree’s git folder lives there. A clone holds every Task’s branches, but the agent already reads the same clone through its own worktree’s git folder, so the sandbox shows a Check nothing its agent can’t see. It can’t read `daemon.json`, the run-token key, the store, Runs, logs or another Task’s worktree. The network stays open, because Apps and tests need loopback ports and package registries; the daemon on loopback answers a sandboxed process with 401, since the process has no token it can read. (`worktreeCommandEnv` drops every `TED_` name, so the agent’s Run token doesn’t reach it either.)

**Only plain folders, never one inside another.** Before it wraps a command, TED checks every folder it opens: it must be inside `TED_HOME`, no part of its path below `TED_HOME` may be a link, and no open folder may sit inside a writable one. So a sandboxed command never holds the parent of a folder it was given, and can’t swap that folder for a link to `TED_HOME` or the home folder between TED’s check and the sandbox starting. The daemon makes the cache and temp folders under `TED_HOME/sandbox/`, which nothing sandboxed can write. The paths passed to the sandbox are the checked ones, never a `realpath` of something sandboxed code can change. On macOS the profile names paths and Seatbelt matches the real path of each access, so a link a sandboxed command makes later never leads anywhere new.

**macOS.** `/usr/bin/sandbox-exec` with a profile TED generates. Paths go in as `-D` parameters, never into the profile text. The profile allows by default, then denies every file write and allows `/dev` and `/private/tmp`, denies writing and reading the contents of `TED_HOME`, and finally allows reading the Task’s folders and clones and writing its own folders. Later rules win, so a worktree inside `TED_HOME` stays open while the rest of it is closed. It also denies Apple events, the LaunchServices services and preference writes, so `open`, `osascript` and `defaults write` can’t hand work to processes outside the sandbox; `launchctl submit` is refused too.

**Linux.** `bwrap` from `PATH`: `/` read-only, a fresh `/dev` and `/proc`, its own PID namespace, the private temp folder on `/tmp`, an empty `XDG_RUNTIME_DIR` and no `DBUS_SESSION_BUS_ADDRESS` (so `systemd-run --user` can’t reach the session bus), an empty `tmpfs` over `TED_HOME`, then the Task’s clones read-only and its worktrees, caches and temp folder writable. It ends with its parent.

**No sandbox, no run.** TED never falls back to running unsandboxed. If `sandbox-exec` or `bwrap` is missing or fails a test run, `ted checks` is refused with the reason, an App start is refused and the App shows as failed with the reason, and a Validate or Merge Check fails with “TED didn’t run this Check: …” in its log. The Factory gets a `sandbox-unavailable` banner, cleared the next time the sandbox works. `TED_SANDBOX_BIN` names the sandbox program; tests point it at a missing file.

**Worktree lifecycle.** ADR 0096 extends this sandbox to Task setup and teardown (ADR 0025), including recovered setup and agent-requested repo removal. Run now in Factory settings runs in a scratch worktree of the default branch (ADR 0066). The TED settings Check runs inside the daemon. Simulator tools (`xcrun simctl`) are TED’s own calls.

## Considered Options

- **Allow `ted checks` and `ted run-app` only from Validate on.** Rejected: TED’s own Validate run still executes the code the agent wrote.
- **Accept the risk and record it.** Rejected by the human (KRI-181).
- **Sandbox only what a Run starts.** Rejected for Checks: the agent controls when Validate starts. Accepted for Apps in KRI-254 with the confirmation above, since desktop Apps can’t run in the sandbox at all.
- **A `window: true` field for command Apps.** Rejected for now: one more field to validate and edit for a button label; every `command` App gets Open.
- **Deny-by-default profiles like Codex’s.** Rejected for now: the list of services a toolchain needs (DNS, TLS trust, Xcode) is long and differs by machine; denying writes and the known ways to start outside processes keeps toolchains working.
- **Letting sandboxed commands write the user’s caches.** Rejected in review: a poisoned build or package cache (Go’s `go-build`, Corepack’s package managers, downloaded browsers) runs later outside any sandbox. Each Task gets its own caches instead, at the cost of a cold first run.

## Consequences

- A Check or App that writes outside its worktree now fails there: one that writes `~/.config`, commits or stashes with git (the git folder lives in `TED_HOME`), downloads a new Corepack version, or uses a tool that writes `~/Library/Caches` without honouring the variables above. A Factory that needs more can use Bypass.
- Remaining risk: an App the human starts runs the Task’s branch outside the sandbox, including anything it loads later from the worktree the agent keeps editing (a dev server that reloads, a script it reads on demand). The confirmation names this; Always skips it for that App in that Factory.
- ADR 0096 closes the teardown escape through agent-edited repo scripts, including `ted task repos remove`.
- Remaining risk: existing `node_modules` files may be hard links into the user’s package store. ADR 0096 gives new Task setup installs private caches; it does not migrate existing worktrees.
- Remaining risk: on Linux, `bwrap` resolves its bind paths when it starts. In a multi-repo Factory the Task Lead, in its own sandbox, can write the Task folder that holds the worktrees, so one that swaps a worktree for a link in the moment between TED’s check and `bwrap`’s start could still widen what a Check can write. The sandboxed Check itself can’t, since it holds no parent of what it was given. `--bind-fd` would close this where `bwrap` has it.
- Remaining risk: sockets and the network are open. A sandboxed command can ask a Docker daemon, an ssh-agent, a tmux server or another local service to run something, and that runs outside the sandbox. The agent’s own sandbox has the same gap when it has network access.
- Remaining risk: an iOS simulator App runs its built app in the simulator through CoreSimulator, outside the sandbox, and Xcode’s DerivedData isn’t writable, so building inside the App command fails.
- Linux is untested on the machines that built this: the `bwrap` arguments, `git` inside `bwrap`, and Ubuntu’s user-namespace restrictions need a manual check (KRI-179). The release-tag test run on GitHub installs `bubblewrap` and turns off Ubuntu’s user-namespace restriction first; the tests that try writing outside the worktree run only on macOS.
