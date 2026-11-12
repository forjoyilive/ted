# The app keeps running in the background, and quitting it ends the daemon

Closing the window hides it; the app process stays alive with its menu-bar icon (tray on Linux) and its event stream to the daemon, so the daemon never goes idle while the app runs. Quit asks the daemon to stop: the app calls `POST /shutdown`, which stops every active Run, answers, and then the daemon exits. With work running, Quit first follows the setting **When you quit with work running** (`quitWithWorkRunning`: `ask`, `keep-running`, `stop`). `keep-running` hides every window and the Dock icon and leaves the app, the daemon and the Runs going; **Quit TED completely** from the menu goes through the same decision.

The menu-bar menu, the app menu and the Linux window title read one summary from the daemon, `Activity` (`GET /activity`): how many requests wait on the human, Runs working, active and queued, and Automations on. `TedStore` works it out from the store and emits `activity-changed` only when it changes. Until the Inbox, the queue and Automations exist, “waiting” counts Runs in the `waiting` state and the queue and Automations count zero; the tickets that add them change `TedStore.activity()` and nothing else.

`ted open` and a second launch of the app both bring the running app forward. A second launch hands over through Electron’s single-instance lock. `ted open` asks the daemon (`POST /app/open`), which sends `open-requested` only to event streams opened with `/events?app=1`, and answers whether any app was listening. `ted open` does not start the daemon.

What the menus contain, what Quit decides and what the dialog says are plain functions in `packages/app/src/background.ts`, tested without Electron; the menu-bar icon is drawn as a PNG in `packages/app/src/tray-icon.ts`. `main.ts` only wires them to Electron. Under `TED_HIDDEN_WINDOW=1` the app shows no tray icon or notification, and a Quit that would ask stops the work and quits instead, so automated launches never block on a dialog or take focus.

When `TED_HOME` is set, Electron’s profile (and so its single-instance lock) lives in `TED_HOME/electron`, so test launches with separate homes don’t hand over to each other.

## Considered Options

- **The app counts Runs and waiting requests from Task and Run events itself.** Against ADR 0011: the app holds no business logic, and the CLI and later clients would each count again.
- **`ted open` launches the app binary.** Needs the installed app’s path, which packaging (KRI-122) settles. Asking the running app through the daemon works from source and in every package format; launching when nothing runs can be added once the path is known.
- **Start the daemon without `--exit-when-idle` from the app.** Not needed: the app’s event stream holds the idle timer for as long as the app runs, and a daemon left behind by a crashed app still exits once its Runs finish.

## Consequences

- Quitting the app with nothing running now ends the daemon too; before, it lingered for the idle timeout.
- A new kind of work that should keep TED alive (queued Runs, Automations) is counted in `TedStore.activity()`; the quit dialog and menus pick it up.
- The menu-bar icon, menus and dialog need a manual check on macOS and Linux; the automated tests cover the logic and the Electron app menu.
