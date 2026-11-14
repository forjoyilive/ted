# Android emulator Apps: one headless emulator per App per Task

An `android-emulator` App needs an Android emulator as well as its `run` command. It works like an iOS simulator App (ADR 0085), with the differences below. `packages/daemon/src/apps/emulators.ts` is the only code that runs the Android SDK’s `emulator`, `adb` and `avdmanager`; `apps.ts` asks it for a running emulator before it starts the App’s host.

- **Devices.** The App’s `device` names an existing Android virtual device (AVD); `ted workflow check` refuses an Android App without one. The first ▶ or `ted run-app` reads that AVD’s `config.ini` (found through `avdmanager list avd`) and creates a new AVD, “TED_NB-40_android”, with the same system image and hardware profile. TED keeps its AVDs in `TED_HOME/emulators/devices.json`, one per App per Task, and deletes them (`emu kill`, then `avdmanager delete avd`) when the Task’s Apps end for good, as for simulators.
- **No window.** Emulators boot with `-no-window -no-snapshot-save`, as the user asked. A headless emulator can’t open a window later, so **Show** saves a snapshot (`adb emu avd snapshot save ted-show`), stops the emulator and boots it again from that snapshot with a window, then restarts the App so its `run` reaches the new emulator. The window lasts until the emulator shuts down; the next boot is headless.
- **Slots.** At most `maxRunningEmulators` (machine setting, default 2) of TED’s emulators run at once, counted apart from simulators. Emulators the user started outside TED don’t count. TED picks each emulator’s console port (5554 to 5584, the range adb finds on its own) in the same queue that decides boots, so the serial (`emulator-5554`) is known before boot and two starts can’t take one port. A running emulator counts as TED’s only when `adb emu avd name` names the AVD TED made.
- **Asking for a slot.** The same as iOS: ▶ must name an emulator to shut down, a Run’s `ted run-app` posts the `simulator` permission Comment and waits, and an Automation Run waits in line. The ask carries `platform: 'android'`, so the existing `v1.SimulatorRequested` event, request card, Autopilot and Coordinator exclusions and answer route serve both. Shutting an emulator down for someone else or for idleness is the new `v1.EmulatorShutDown` thread event.
- **Variables.** The App’s `run` gets `ANDROID_SERIAL` (which adb and Gradle read) and `TED_EMULATOR_SERIAL`. `GRADLE_USER_HOME` points at `gradle` in the Task’s cache folder for every sandboxed command, because the sandbox refuses `~/.gradle`; the first build in each Task downloads its dependencies again.
- **Captures.** `ted app screenshot` saves `adb exec-out screencap -p`. Recording isn’t supported yet. The App row has a Screenshot button, since a headless emulator has nothing else to look at.
- **Missing tools.** TED finds the SDK through `ANDROID_HOME` or `ANDROID_SDK_ROOT` from the login shell, else `~/Library/Android/sdk` on macOS or `~/Android/Sdk` on Linux. When `adb`, `emulator` or `avdmanager` won’t run, starting the App fails and raises the stops-work Factory banner `emulator-tools` with **Check again**. Android emulator Apps work on macOS and Linux.
- **Tests.** `TED_EMULATOR_BIN`, `TED_ADB_BIN` and `TED_AVDMANAGER_BIN` point at stubs in `packages/daemon/test/fixtures/`; `TED_STUB_ANDROID` names their state file, and without one they act as if the SDK were missing. The stub emulator is a process that lives until `adb emu kill`. No test boots a real emulator.

## Considered Options

- **Copy the named AVD’s folder.** Keeps its saved data and settings, but the copy carries paths to the original and can be large.
- **Mirror a headless emulator with scrcpy for Show.** No reboot, but it needs another tool installed.
- **Share the simulator limit.** Emulators and simulators load the machine differently, so each has its own.

## Consequences

- A check with a real emulator (create from a Play Store image, boot, Show, screenshot, a Gradle build with `ANDROID_SERIAL`) is manual, on KRI-399.
- Show restarts the App’s `run` command, so a command that only installs and launches the app runs again.
