# The app supervises the daemon and shows its crashes itself

The app’s main process keeps the daemon running through `superviseDaemon` in `packages/daemon/src/launch.ts`. It starts or reuses the daemon with `withDaemon` and holds the event stream open. When the stream ends without the app closing it, the daemon has gone, and the supervisor counts a crash.

- **Restarts.** Each outage gets up to three restart attempts: at once, then 5 s later, then 30 s later. An attempt fails if the daemon it started exits before it answers or doesn’t answer within 30 s. Once an attempt connects, the supervisor subscribes again and reports `connected`.
- **Giving up.** On the third crash within 10 minutes, or when all three attempts of one outage fail, the supervisor stops and reports `stopped` with the crash times. Restart from the banner clears the crash count and runs one more outage’s attempts.
- **Runs.** Run hosts are detached (ADR 0013), so they keep working; the new daemon reattaches them as at any start.

The app sends the state (`connected`, `reconnecting`, `stopped`) to the renderer on `ted:event` as a `connection` event, and the renderer can ask for it with the `connection` request. Requests to the daemon fail while it is down. When the state returns to `connected`, every list in the renderer loads again, because events sent while the daemon was down are lost.

While reconnecting, the window shows the dark Reconnecting bar above everything and wraps the rest of the window in a disabled, dimmed `<fieldset>`, so every button and field is off without each component knowing. When stopped, the bar goes and the app shows the stops-work banner “Ted’s background process keeps stopping” with **Restart ▾**, whose menu holds **Restart Ted in the background** and **Copy report**, and shows one notification.

This banner is the one exception to ADR 0021: it is built in the renderer from the connection state, because the daemon that keeps banners is the thing that is down.

## Logs

- The daemon writes its own log, everything it sends to `console` after `redactSecrets` (ADR 0024), to `~/.ted/logs/daemon.log`, rolling at 20 MB and keeping 7 files (`daemon.log`, `daemon.log.1` … `daemon.log.6`).
- The daemon’s stdout and stderr go to `~/.ted/logs/daemon-output.log`, which holds crash output that never reaches `console`: uncaught exceptions and fatal errors. The launcher writes a “starting” line before each start and rolls the file at start under the same limits.
- **Copy report** puts the end of both logs (256 KB of each, reaching back into `.1` when the current file is short), the Ted version, the OS and the crash times on the clipboard, with secrets redacted, Ted’s folder shown as `<Ted home>` and the user’s home as `~`. Nothing is uploaded.

## Considered Options

- **Restart delays by crash count** (first crash at once, second after 5 s, third after 30 s). With a stop at the third crash, the 30 s delay would never be used.
- **Raising the banner through the daemon once it is back.** By then it isn’t stopping any more, and while it is down nothing could raise it.
- **Disabling each button by hand.** Every later screen would need to remember the connection state; one disabled `<fieldset>` covers all of them.

## Consequences

- Quit (ADR 0028) closes the supervisor before it calls `POST /shutdown`, so quitting is not a crash. Any other stop of the daemon while the app is open, such as an update (KRI-123) or a `/shutdown` from another client, looks like a crash and the app starts the daemon again, unless that ticket tells the supervisor first.
- Under `TED_HIDDEN_WINDOW=1` the app shows no notification (ADR 0028), so the tests check the banner but not the notification.
- `TED_RESTART_DELAYS_MS` (comma-separated) overrides the restart delays, for tests.
