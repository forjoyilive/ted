# TED Dev and the release run side by side

Status: accepted.

## Context

The human runs an installed release of TED and works on TED from source on the same Mac. Until now both used `~/.ted` by default, so `pnpm ted` or `pnpm app` talked to the release’s daemon, read its store and could start Runs in its Factories. Both Electron apps also shared the app name `TED`, its userData folder and single-instance lock, and the Linear key in the keyring under service `TED`.

`app.isPackaged` can’t decide which copy is running: the daemon, the CLI and Run hosts run without Electron.

## Decision

Code has an **edition**, `release` or `dev`, set in one place: `edition` in `packages/protocol/src/edition.ts`. In the source it is `'dev'`. `markRelease` in `packages/app/scripts/stage.ts` rewrites that line to `'release'` in the staged JavaScript, so only an installer built by `pnpm package` is the release; staging fails if the line isn’t there. `identity()` gives each edition’s name, home folder and keyring service.

What differs:

| | Release | TED Dev (from source) |
|---|---|---|
| Default `TED_HOME` | `~/.ted` | `~/.ted-dev` |
| App name, window and tray title, notification titles | TED | TED Dev |
| Electron userData and single-instance lock | `~/Library/Application Support/TED` (or `TED_HOME/electron` when `TED_HOME` is set) | `TED_HOME/electron` |
| Linear key in the keyring | service `TED` | service `TED Dev` |
| `ted` command install | `/usr/local/bin/ted` or `~/.local/bin/ted` | never; use `pnpm ted` |
| Login item | when packaged | never |
| Update checks | when packaged | never |
| iOS simulator device names | `TED NB-1 iPhone` | `TED Dev NB-1 iPhone` |

`TED_HOME` still overrides the default home for both, and tests set it as before. The daemon, Run hosts and each Run’s `ted` shim already get `TED_HOME` from the process that starts them, so a Run always talks to its own daemon. Everything else a copy writes (store, logs, `daemon.json`, `daemon-lock.db`, worktrees, clones, Time Machine exclusions, `TED_HOME/secrets`) lives under its home, so it follows. The daemon listens on a random loopback port, and temporary folders come from `mkdtemp`, so neither collides.

## Considered Options

- **Deciding from `app.isPackaged` or the path of the running code.** The first doesn’t exist outside Electron; the second breaks when someone runs the staged folder or moves the app.
- **An environment variable such as `TED_EDITION`.** It would have to reach every process TED starts, and a release launched with the wrong value would read the dev store.
- **A marker file next to the staged code.** Works, but needs a file read at import; rewriting one line in the staged code is checked by the staging test and costs nothing at run time.

## Consequences

- An existing `~/.ted` made while running from source now belongs to the release. Developers who want that data in TED Dev move it to `~/.ted-dev` or set `TED_HOME`.
- macOS shows an unpackaged Electron app as “Electron” in the Dock and the app menu bar, and its notifications come from Electron’s bundle, whatever name TED sets. That already differs from the release, so nothing else is needed.
- Both copies use the same `claude`, `codex`, `gh` and `git` with the user’s own credentials and settings, and the same agent CLI accounts and usage limits. They also share the ports that Apps declare in `workflow.yaml`.
