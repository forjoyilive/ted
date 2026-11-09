# The daemon owns each Task shell’s PTY; editors start from a fixed argument list

The human tries a branch by hand through the Task’s shell and **Open in editor** (spec 9.8). Both start programs on the human’s behalf, so both live in the daemon and the app only draws them.

**Shell.** `packages/daemon/src/shells.ts` keeps one PTY per Task and repo, started with `node-pty` as the user’s login shell (`$SHELL -l`, else `/bin/zsh` on macOS and `/bin/sh` elsewhere) in that repo’s worktree root. The worktree and its environment come only from `Tasks.worktreeAccess`, which refuses a removed repo or a worktree outside `TED_HOME/worktrees`, and builds the environment through `worktreeCommandEnv` (ADR 0071): `worktree.env`, `TED_TASK` and `TED_HOME`, with no `TED_RUN`, Run token or agent credentials, so `ted` there acts as the human. The PTY starts on the first open, survives the app closing or reloading while the daemon runs, stays while the Task is Stopped, and ends when the store reports the repo removed or the Task deleted, or when the daemon stops. A running shell holds the daemon’s idle timer.

The daemon keeps the last 512 KB of output per shell. The app reads it by long poll: `GET /tasks/:id/repos/:name/shell/output?generation&from&waitMs` answers at once when there is output after `from`, else waits up to 25 seconds. A Restart bumps `generation`, and an answer with `reset` tells the app to clear its terminal. Keystrokes go one request at a time through `POST …/shell/input`, so they arrive in order. Every shell route is app-only: the non-GET ones by the usual rule (ADR 0054), the output route by checking the caller, because a GET is otherwise open to the token in `daemon.json`.

**Editor.** `packages/daemon/src/editors.ts` lists the editors it finds on the login shell’s `PATH` (and, on macOS, in the app bundles of VS Code, Cursor, Windsurf, Zed and Sublime Text under `/Applications` and `~/Applications`; `TED_EDITOR_APP_DIRS` overrides those folders and is empty in tests). The `editor` machine setting is `null` until the human picks one, so the first **Open in editor** shows a picker. Each editor’s line syntax is in `editorArgs`. A custom command is split into words once, its `{path}`, `{line}` and `{column}` are filled into single arguments, and it starts with `spawn` and no shell. A file from a diff must be a relative path whose real path stays inside the worktree.

## Considered Options

- **`script(1)` or Python’s `pty` instead of a native module.** Rejected: neither can resize the terminal without more tricks, and Python isn’t on every Mac. `node-pty` 1.2 ships prebuilt binaries for macOS and Linux on x64 and arm64 and uses Node-API, so the same binary loads in Node and in Electron running as Node, and pnpm needs no build script. ADR 0014 avoided a PTY for agents; that still holds.
- **The PTY in a detached host, like Run hosts (ADR 0013).** Rejected for now: the spec asks only that the shell survive the app, and Quit with **Stop it and quit** ends the daemon on purpose. A host would add a second protocol for little gain.
- **Shell output as a `DaemonEvent` on `/events`.** Rejected: every client, including `ted` with the `daemon.json` token, would see what the human types and reads.
- **Allow `style-src 'unsafe-inline'` for xterm.js.** Rejected: xterm.js writes its theme and cell sizes into `<style>` elements, which the CSP blocks. `TaskShell.tsx` copies their text into an adopted `CSSStyleSheet` instead, which the CSP allows, so the renderer CSP and ADR 0073’s frames stay as they were.

## Consequences

- The shell ends with the daemon. If the human quits with **Stop it and quit**, it starts fresh next time.
- `node-pty` is the daemon’s second native module after the keyring; packaging copies its prebuilt files like any other dependency.
- The app tests can’t start VS Code, Cursor or Zed; they put fake `code` launchers on `PATH`. Opening at a line in the real editors is a manual check.
