# The daemon serves plain JSON over HTTP behind one loopback guard

The daemon’s API is plain JSON over `node:http`, with no web framework, listening on `127.0.0.1` on a port the OS picks. Every request passes one guard, in this order: a `Host` other than `127.0.0.1` or `localhost` gets 403, any `Origin` header gets 403, and a missing or wrong `Authorization: Bearer <token>` gets 401. Only `/healthz` skips the token check; it still gets the `Host` and `Origin` checks, which block DNS rebinding. The CLI, and later the app and MCP server, reach the daemon only through `DaemonClient` in `packages/protocol`.

At each start the daemon takes the lock, opens the store, starts listening, and then writes `daemon.json` (`port`, `token`, `pid`, `version`) to a temp file with mode 0600 and renames it into place. The lock stops two `ted` commands that both start a daemon from running two daemons on one store.

The lock is an exclusive SQLite transaction on `daemon-lock.db`, opened with Node’s built-in `node:sqlite` and held while the daemon runs. SQLite takes an OS file lock, so the OS releases it when the daemon exits for any reason, SIGKILL included, and there is no stale lock to detect or clear. The lock file is never deleted.

## Considered Options

- **A pid file created exclusively, taken over when its pid is dead.** Rejected after review: taking over a stale file means reading, checking and deleting it, and two starters can interleave those steps so both win, at every level of takeover lock added on top. A pid reused after a reboot also looks alive, so TED would refuse to start.

## Consequences

- `node:sqlite` is still experimental in Node 24, so the daemon logs an `ExperimentalWarning` and the API may change. The Node inside Electron must include it; Electron 45.2.3, with Node 24.22.2, does (checked in KRI-83).

- New routes get the guard by default; nothing has to remember to add it.
- A daemon that `ted` starts runs with `--exit-when-idle` and exits after a minute without a request. Later work that keeps the daemon busy, such as Runs and enabled Automations, has to report itself to the idle timer.
