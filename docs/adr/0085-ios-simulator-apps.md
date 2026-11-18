# iOS simulator Apps: one Ted device per App, booted only into a free slot

An `ios-simulator` App (spec §9.6, §9.7) needs a simulator device as well as its `run` command. `packages/daemon/src/apps/simulators.ts` owns those devices; `apps.ts` asks it for a booted device before it starts the App’s host, and nothing else calls `simctl`.

- **Devices.** The first ▶ or `ted run-app` clones the App’s `device` (a shut-down device of that name, newest runtime first) as “Ted NB-40 iPhone”, or creates one from the device type of that name when there is nothing to clone. The device stays in Xcode’s default set so Simulator.app shows it. Ted keeps its devices in `TED_HOME/simulators/devices.json`, one per App per Task, and deletes them (shutdown, then `simctl delete`) when the Task’s Apps end for good: Done, archive, delete, Factory removal, or the repo leaving the Task.
- **Slots.** At most `maxBootedSimulators` (machine setting, default 3) (replaced by the combined `maxRunningDevices` in ADR 0190) of Ted’s own devices are booted. Simulators the user booted outside Ted don’t count. Every decision that boots a device runs in one queue and reads `simctl list devices` first, so two starts can’t both take the last slot.
- **Never silently.** When every slot is taken, the human’s ▶ is refused unless it names the simulator to shut down (`shutDown`, from the app’s popover). A Run’s `ted run-app` posts a `permission` Comment carrying the booted simulators (`v1.SimulatorRequested`), sets the Run waiting and leaves the App `waiting`; the CLI keeps polling. Approve names a simulator; Deny ends the App with “No simulator slot: the human denied”. While the request is open Ted checks for a free slot every App poll; when one frees up it boots the device and closes the request as `withdrawn` with `slotFreed`. A recording simulator can’t be picked. Shutting a device down for someone else, or because it was idle, stops that App’s process and is a `v1.SimulatorShutDown` thread event on its Task.
- **Build folders.** The App’s `run` builds with `xcodebuild -derivedDataPath "$TED_DERIVED_DATA" -packageCachePath "$TED_SWIFTPM_CACHE"` (or a tool that passes them on), so the build writes only the Task’s cache folder, which the sandbox allows and Ted removes with the Task’s sandbox folder. ▶ gets the same variables, so one `run` works both ways (ADR 0091, KRI-220).
- **Idle.** A booted device whose App isn’t running and that hasn’t been used (booted, shown, captured) for 30 minutes is shut down. The human’s ■ Stop also shuts the device down.
- **Captures.** `ted app screenshot` and `ted app record --start|--stop` use `simctl io`; the file is saved as an attachment and posted as a note Comment from the caller. A recording lives only as long as the daemon that started it.
- **Missing tools.** If `simctl list runtimes` fails, or lists no available iOS runtime, starting the App fails and raises the stops-work Factory banner `simulator-tools` with **Check again**. Off macOS the daemon lists no `ios-simulator` Apps, `/simulators` reports `supported: false`, and the app shows nothing about simulators.
- **Tests.** `TED_XCRUN_BIN` and `TED_OPEN_BIN` point at `packages/daemon/test/fixtures/stub-xcrun.ts` in `vitest.config.ts`; `TED_STUB_XCRUN` names its state file, and without one the stub behaves as if Xcode were missing. Tests force `simulators.supported` so they run on Linux CI. No test boots a real simulator or runs `xcodebuild`.

## Considered Options

- **A device set under `TED_HOME` (`simctl --set`).** Keeps Ted’s devices apart and makes the Storage count exact, but Simulator.app shows only the default set, and spec §9.7 wants the device shown there.
- **Hold `ted run-app` open in one long HTTP request until the human answers.** A request can wait for hours; polling the App’s `waiting` state survives daemon restarts.
- **Shut down the oldest simulator automatically.** The spec says Ted never does.

## Consequences

- Checks that need a real Mac with Xcode (clone, boot, Simulator.app focus, `simctl io` output, an `expo run:ios` build with `TED_SIMULATOR_UDID`) are manual, on KRI-179.
- The Storage page still counts only `TED_HOME/simulators`, not the devices’ data under `~/Library/Developer/CoreSimulator`.
