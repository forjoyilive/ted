# The app holds the human’s token in memory; the token in daemon.json can’t make decisions

Status: accepted. Changes ADR 0009 and ADR 0015.

## Context

Until now the daemon wrote one token to `TED_HOME/daemon.json`, and that token could call every route. Every Run runs as the same OS user, and Codex’s sandbox limits writes, not reads, so an agent could read the token and approve its own permission requests (ADR 0047), approve Gates and sign-offs (ADR 0032), answer questions, or change settings.

The `ted` CLI a person types in a terminal and the `ted` an agent runs are the same program run by the same user. Nothing on disk can tell them apart.

## Decision

The daemon accepts three kinds of token:

- **The app’s token.** 32 random bytes the app’s main process makes once per start, in `superviseDaemon` (`packages/daemon/src/launch.ts`). It lives only in the app’s memory and the daemon’s memory. It may call every route.
- **The token in `daemon.json`** (the file token). Written as before, mode 0600, fresh at each start. It may call every `GET` route and only the other routes marked `fileToken: true`.
- **Run tokens**, unchanged (ADR 0015).

`GET /caller` says which kind a token is.

**How the daemon learns the app’s token.** Only from the process that starts it. When the app starts the daemon it runs `main.ts --app-token-stdin` and writes the token to the daemon’s stdin, which the daemon reads to the end before it starts. The token never goes in an argument, an environment variable or a file, all of which another process of the same user can read. A daemon started without `--app-token-stdin` (by `ted`) makes a random app token that no one knows.

**Restarts and reconnecting.** The supervisor keeps the same token for the life of the app. When it starts a daemon after a crash (ADR 0031), it hands the token over the same way. Each time the supervisor connects, it asks `GET /caller` with its token. If the daemon answers anything but `app`, it isn’t the daemon this app started: it was started by `ted`, at login before the app was open, or by an earlier copy of the app. The app then **takes it over**: it calls `POST /shutdown` with `{ "keepRuns": true }` using the file token, waits until the daemon has let go of its lock, and starts its own daemon with its token. Run hosts are detached (ADR 0013), so Runs keep going and the new daemon reattaches them, as after any restart. The takeover happens before the supervisor subscribes, so it isn’t counted as a crash.

**What the file token may still do** (routes marked `fileToken: true`, plus every `GET`):

| `ted` command | Route |
|---|---|
| `ted comment` (a note by the human) | `POST /tasks/:id/comments` |
| `ted task create`, with `--source` | `POST /tasks`, `POST /integrations/linear/lookup` |
| `ted task start` | `POST /tasks/:id/start` |
| `ted task block` / `unblock` | `POST` / `DELETE /tasks/:id/blockers` |
| `ted task lead` | `PUT /tasks/:id/lead`, `POST /tasks/:id/lead/use-default-model` |
| `ted backup restore` | `POST /backups/restore` |
| `ted doctor` | `POST /integrations/check` |
| `ted open` | `POST /app/open` |
| `ted dev factory add` / `local-folder` | `POST /dev/factories`, `PUT /factories/:id/local-folder` |
| (the app’s takeover) | `POST /shutdown` with `keepRuns: true` only |

`ted status`, `ted task list`, `ted backup list`, `ted brief show`, `ted dev run show` and `ted workflow check` only read. Commands meant for Runs (`ted outcome`, `ted brief write`, `ted checks`, `ted ask`, `ted status "…"`) use the Run token as before.

**Only the app may:** answer any request (permission requests, Gate requests, design reviews and sign-offs, questions), change machine settings, save or remove the Linear key, run a Fix, install the `ted` command, stop, resume, archive, move or reprioritise a Task, restart, stop or message a Run, start a Run outside a Task, add a Factory through the form, remove clones, dismiss or act on banners, and stop the daemon with its Runs. Every new route other than a `GET` is app-only until someone marks it `fileToken: true`.

`ted dev run start` is removed. A Run outside a Task takes any folder as its working folder, and a sandboxed agent that could start one in `~/.ted` or `~` would get write access there.

**Tests.** `TED_APP_TOKEN` sets the app’s token, so Playwright tests can act as the human. The app reads it only when `app.isPackaged` is false and deletes it from its environment before it starts the daemon, so a packaged TED ignores it and Runs never see it. Tests that start the daemon in-process read `RunningDaemon.appToken`; tests that start `main.ts` use `spawnDaemonProcess` in `packages/daemon/test/helpers.ts`.

## Considered Options

- **Letting the app register its token with a daemon it didn’t start, first come first served.** An agent could register first while the app is closed. Taking the daemon over is no more work and leaves nothing to race for.
- **A challenge file or socket the app proves it can read.** Every file and socket in `TED_HOME` is readable by every process of the user.
- **The macOS keychain with an access list for the signed app.** macOS only, and no help when running from source or on Linux.
- **Keeping the file token all-powerful and checking the caller’s process.** An agent can run the TED binary itself (`ELECTRON_RUN_AS_NODE`), so the executable path proves nothing.

## Consequences

Remaining risk, and what it relies on:

- The boundary holds only while an agent can read but not write `TED_HOME` and can’t start processes outside its sandbox. An agent that can run commands as the user unsandboxed (a Claude Code Run whose permission request the human approved, or anything that escapes through macOS LaunchServices) can call `/shutdown` with `keepRuns`, start its own daemon with a token it chose, and act as the human until the app takes the daemon back. No token scheme survives that, since the agent is then the user.
- With the file token an agent can still post a Comment that shows as the human’s on any Task (and so reaches that Task Lead), create and start Tasks, add Factories, set a Task Lead’s agent and model, restore a backup (which stops Runs) and add or remove blockers. None of these answers a request, passes a Gate or changes a setting, but a Comment that looks like the human’s can mislead another agent.
- An agent can stop the daemon with the file token (`keepRuns`), and could already kill it. The app restarts it (ADR 0031); this is denial of service, not more power.
- Another process of the user that can read the app’s or the daemon’s memory (a debugger) can read the token. macOS’s hardened runtime blocks this for the packaged app; Linux’s `ptrace_scope` 1 blocks it for processes that aren’t the app’s ancestors.
- Running TED from source, `TED_APP_TOKEN` in the app’s environment sets the token. Only someone who can already set the app’s environment can use it.
- A `ted` command that runs while the app is taking a daemon over may start a daemon of its own; the app then takes that one over too, and Runs keep going throughout.
