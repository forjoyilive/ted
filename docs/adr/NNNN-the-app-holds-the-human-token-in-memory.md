# The app holds the human’s key in memory; the token in daemon.json can’t make decisions

Status: accepted. Changes ADR 0009 and ADR 0015.

## Context

Until now the daemon wrote one token to `TED_HOME/daemon.json`, and that token could call every route. Every Run runs as the same OS user, and Codex’s sandbox limits writes, not reads, so an agent could read the token and approve its own permission requests (ADR 0047), approve Gates and sign-offs (ADR 0032), answer questions, or change settings.

The `ted` CLI a person types in a terminal and the `ted` an agent runs are the same program run by the same user. Nothing on disk can tell them apart.

## Decision

The daemon accepts three kinds of caller:

- **The app.** The app’s main process makes a 32-byte key once per start, in `superviseDaemon` (`packages/daemon/src/launch.ts`). The key lives only in the app’s memory and the daemon’s memory, and is never sent over the socket. Each request carries `Authorization: TED-App <time>.<nonce>.<mac>` and `x-ted-body-sha256`, the SHA-256 of the body; the MAC is HMAC-SHA256 with the key over the time, a random nonce, the method, the path and that hash (`packages/protocol/src/app-auth.ts`). The daemon checks the time (within 60 seconds), the MAC and that it hasn’t seen the nonce before it reads any of the body, then reads the body up to the route’s limit (1 MB, or 25 MB for attachments; none on a `GET`) and refuses it if its hash differs. A captured request can’t be replayed or given another body. Every JSON answer to a signed request carries `x-ted-mac`, HMAC(key, `response`, nonce, status, hash of the answer), and the app refuses an answer without a correct one. The app may call every route.
- **The token in `daemon.json`** (the file token). Written as before, mode 0600, fresh at each start. It may call every `GET` route and only the other routes marked `fileToken: true`.
- **Run tokens**, unchanged (ADR 0015).

**How the daemon learns the key.** Only from the process that starts it. When the app starts the daemon it runs `main.ts --app-token-stdin` and writes the key to the daemon’s stdin, which the daemon reads to the end before it starts. The key never goes in an argument, an environment variable, a file or a request. A daemon started without `--app-token-stdin` (by `ted`) makes a random key that no one knows.

**The daemon proves itself first.** Before the app uses a daemon, it sends a signed `GET /caller`. The daemon answers with HMAC(key, `daemon`, the request’s nonce, the port the request arrived on). The app trusts the daemon only if that proof is right for the port it connected to, so a server on a stale `daemon.json` port learns nothing it can use, and one that relays to the real daemon from another port can’t pass the proof on.

**Restarts and reconnecting.** The supervisor keeps the same key for the life of the app. When it starts a daemon after a crash (ADR 0031), it hands the key over the same way. If the daemon named in `daemon.json` can’t prove the key, it isn’t one this app started: it was started by `ted`, at login before the app was open, or by an earlier copy of the app. The app then **takes it over**: it calls `POST /shutdown` with `{ "keepRuns": true }` using the file token, waits until the daemon has let go of its lock, removes `daemon.json` if it still names that daemon, and starts its own daemon with its key. A daemon from before this change has no `/caller` and would stop its Runs on `/shutdown`, so the app sends it SIGTERM instead, which stops it without stopping Runs, and only when the OS says that pid holds `daemon-lock.db` open (`lockHolders` in `packages/daemon/src/lock.ts`: `lsof` on macOS, `/proc/*/fd` on Linux). Run hosts are detached (ADR 0013), so Runs keep going and the new daemon reattaches them. The takeover happens before the supervisor subscribes, so it isn’t counted as a crash.

**What the file token may still do** (routes marked `fileToken: true`, plus every `GET`):

| `ted` command | Route |
|---|---|
| `ted task create`, with `--source` | `POST /tasks`, `POST /integrations/linear/lookup` |
| `ted task start` | `POST /tasks/:id/start` |
| `ted task block` / `unblock` | `POST` / `DELETE /tasks/:id/blockers` |
| `ted task lead` | `PUT /tasks/:id/lead`, `POST /tasks/:id/lead/use-default-model` |
| `ted backup restore` | `POST /backups/restore` |
| `ted doctor` | `POST /integrations/check` |
| `ted open` | `POST /app/open` |
| (the app’s takeover) | `POST /shutdown` with `keepRuns: true` only |

`ted status`, `ted task list`, `ted backup list`, `ted brief show`, `ted dev run show` and `ted workflow check` only read. Commands meant for Runs (`ted comment`, `ted ask`, `ted outcome`, `ted brief write`, `ted checks`, `ted status "…"`) use the Run token as before.

**Only the app may:** answer any request (permission requests, Gate requests, design reviews and sign-offs, questions), post a Comment as the human, change machine settings, save or remove the Linear key, run a Fix, install the `ted` command, add a Factory or change its local folder, stop, resume, archive, move or reprioritise a Task, restart, stop or message a Run, start a Run outside a Task, remove clones, dismiss or act on banners, and stop the daemon with its Runs. Every new route other than a `GET` is app-only until someone marks it `fileToken: true`.

Removed from `ted`: `ted dev run start`, `ted dev factory add`, `ted dev factory local-folder`, and `ted comment --task` outside a Run. A Run outside a Task takes any folder as its working folder. A Factory’s own `.ted/workflow.yaml` can set `permissions: bypass` and worktree `setup` commands that the daemon runs unsandboxed, and its local folder decides what gets copied into worktrees; a sandboxed agent that could add one from a repo it wrote would escape its sandbox. A human Comment reaches the Task Lead as the human’s words.

**Tests.** `TED_APP_TOKEN` sets the app’s key, so Playwright tests can act as the human. The app reads it only when `app.isPackaged` is false and deletes it from its environment before it starts the daemon, so a packaged TED ignores it and Runs never see it. Tests that start the daemon in-process read `RunningDaemon.appToken`; tests that start `main.ts` use `spawnDaemonProcess` or `daemonAsApp` in `packages/daemon/test/helpers.ts`, and sign with `api(port, { appKey })`, `appClient` or `appHeaders`.

## Considered Options

- **Sending the key as a bearer token.** A process that binds a dead daemon’s port before the app reconnects would receive it.
- **Letting the app register its key with a daemon it didn’t start, first come first served.** An agent could register first while the app is closed. Taking the daemon over leaves nothing to race for.
- **Talking to the daemon over a pipe the app inherits from the spawn.** Needs a second transport for `DaemonClient`; signing over the existing HTTP gives the same guarantee.
- **A challenge file or socket the app proves it can read.** Every file and socket in `TED_HOME` is readable by every process of the user.
- **The macOS keychain with an access list for the signed app.** macOS only, and no help when running from source or on Linux.

## Consequences

Remaining risk, and what it relies on:

- The boundary holds only while an agent can read but not write `TED_HOME` and can’t start processes outside its sandbox. An agent that can run commands as the user unsandboxed (a Run in `permissions: bypass`, a command the human approved, or anything that escapes through macOS LaunchServices) can stop the daemon, start its own with a key it chose, and act as the human until the app takes the daemon back. No key scheme survives that, since the agent is then the user.
- With the file token an agent can still create and start Tasks in existing Factories, set a Task Lead’s agent and model (not its permission mode), add or remove blockers, and restore a backup, which stops Runs and rolls back TED’s data. None of these answers a request, passes a Gate or changes a setting.
- An agent can stop the daemon with the file token (`keepRuns`), and could already kill it. The app restarts it (ADR 0031); this is denial of service, not more power.
- Between a daemon crash and the app noticing, a request the app sends can reach a process that has taken the port. It learns the request but not the key, can’t reuse the signature for anything else, and can’t forge an answer the app accepts. The event stream (`GET /events`) isn’t MACed per event; the app opens it only after the daemon has proved itself, and opens it again only after a fresh proof.
- Another process of the user that can read the app’s or the daemon’s memory (a debugger) can read the key. macOS’s hardened runtime blocks this for the packaged app; Linux’s `ptrace_scope` 1 blocks it for processes that aren’t the app’s ancestors.
- Running TED from source, `TED_APP_TOKEN` in the app’s environment sets the key. Only someone who can already set the app’s environment can use it.
- Taking over a daemon from before this change needs `lsof` on macOS; without it the app can’t prove which process holds the lock and gives up after two minutes with “TED’s daemon didn’t stop to hand over to the app”.
- A `ted` command that runs while the app is taking a daemon over may start a daemon of its own; the app then takes that one over too, and Runs keep going throughout.
