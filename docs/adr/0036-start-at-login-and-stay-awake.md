# Start at login from the app, Stay Awake from the daemon

Status: accepted (KRI-118)

## Context

Spec 3.1 and 3.2 add two machine settings: **Start TED in the background when you log in** and **Stay Awake while Runs are working**, both on by default. Registering a login item needs Electron’s `app.setLoginItemSettings` on macOS, which only the app’s main process has. Keeping the machine awake depends on Runs, which the daemon owns, and the daemon can run without the app (started by `ted`).

## Decision

- Both are fields in `MachineSettings` (`startAtLogin`, `stayAwake`), stored and changed like every other machine setting (ADR 0024).
- **Stay Awake lives in the daemon.** `stayAwakeWhileWorking` in `packages/daemon/src/stay-awake.ts` watches `activity-changed` and `settings-changed` and holds the machine awake while `stayAwake` is on and `activity().runs.working` is above zero. A Run waiting on the human, a held or queued Run, and Automations don’t count. The hold is a child process: `/usr/bin/caffeinate -i -w <daemon pid>` on macOS, and on Linux `systemd-inhibit --what=idle:sleep --mode=block` around `tail --pid=<daemon pid> -f /dev/null`, both from `/usr/bin` or `/bin` and never from `PATH`. Releasing kills it; if the daemon dies first, the `-w`/`--pid` watch ends it. Without `systemd-inhibit` there is nothing to run and TED doesn’t keep Linux awake.
- **Start at login lives in the app.** `packages/app/src/login-item.ts` applies the setting whenever it changes and once at every start, and returns `on`, `off`, `requires-approval` or `unavailable`, which the General page shows. On macOS 13 and later it registers the LaunchAgent `Contents/Library/LaunchAgents/design.kriya.ted.background.plist` through `SMAppService` (`type: 'agentService'`); the plist runs `Contents/MacOS/TED --background`. `requires-approval` shows “Allow TED in System Settings → Login Items” and a button that opens that pane. On Linux it writes `~/.config/autostart/ted.desktop` (or under `XDG_CONFIG_HOME`) running the app binary, or `$APPIMAGE`, with `--background`; writing it at every start keeps an AppImage’s path current after an update. A copy run from source, macOS 12, a bundle without the plist and Windows are `unavailable`, and the OS isn’t touched.
- `--background` starts the app with its menu-bar icon (tray on Linux) and the daemon, with no window and no Dock icon. It keeps running until **Quit TED completely**, as ADR 0028 already does.
- The first-launch screen (spec 11.1) doesn’t exist yet, so the default (on) applies at the first packaged start. The first-launch ticket shows the checkbox and writes the setting.

## Considered Options

- **Electron’s `powerSaveBlocker` in the app.** Needs the app running; a daemon started by `ted` would let the machine sleep with Runs working.
- **`mainAppService` on macOS.** Registers the app itself but can’t pass `--background`, and `wasOpenedAsHidden` is gone in Electron 45, so TED couldn’t tell a login start from a click.
- **Stay Awake in each Run host.** Every working Run would start its own `caffeinate`; one hold per daemon is simpler and survives Runs flipping between working and waiting.

## Consequences

- Packaging must copy `packages/app/build/mac/LaunchAgents/` into `TED.app/Contents/Library/LaunchAgents/`; without it macOS reports `not-found` and the row says Start at login works only in an installed copy.
- Tests never touch the OS: `vitest.config.ts` sets `TED_STAY_AWAKE=off`, the daemon in tests gets a fake `holdAwake`, and the app writes login-item changes to `TED_LOGIN_ITEM_LOG` when it is set.
- Whether the machine really stays awake, and whether login really starts TED with no window, needs a manual check on macOS and on Linux desktops.
