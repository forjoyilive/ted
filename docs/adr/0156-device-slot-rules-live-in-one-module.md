# Device slot rules live in one module

iOS simulators (ADR 0085) and Android emulators (ADR 0147) follow the same rules for who gets a device slot: a limit on how many run at once, a first-come line for Automation Runs, a `simulator` permission Comment when a Task Run needs another device shut down, the human’s choice of which one, and shutting down idle devices. `apps/simulators.ts` and `apps/emulators.ts` each had their own copy, and the copies had begun to differ in ways a reader couldn’t tell were intended.

**The rules live in `apps/device-slots.ts`.** `createDeviceSlots` keeps the records file (`devices.json`), the serial work queue, the idle hold, the line, the poll timer, `acquire`, `wait`, `withdraw`, `withRequest`, `remove`, the idle check and every message about slots. It runs no platform tool.

**Each platform passes a `DeviceDriver`.** The driver lists which devices are live, creates or reuses a device for an App, boots, stops and removes one, says whether a device is recording, names its limit setting and event, and gives the words for its messages (`simulator`/`emulator`, `a`/`an`, `booted`/`running`). Each platform keeps its own record shape on disk. `simulators.ts` is still the only file that runs `xcrun` and `idb`, and `emulators.ts` the only one that runs `emulator`, `adb` and `avdmanager`. Each also keeps `control`, screenshots, `show`, and its own extras: recording and device types for iOS, the Show snapshot and console ports for Android.

**The two platforms keep separate instances.** `Simulators` and `Emulators` keep their public interfaces. They had separate limits, `maxBootedSimulators` and `maxRunningEmulators`, until ADR 0190 put both kinds in one `DevicePool` with one limit.

## Considered Options

- **Pure decision functions only.** Rejected: the records file, queue, idle check, line and `wait` would still be written twice.
- **One device interface for `apps.ts`.** Left for later. It isn’t needed to remove the copies.

## Consequences

A change to a slot rule is made once and tested once, in `packages/daemon/test/device-slots.test.ts`, with a fake driver and no stub tools. The platform tests (`simulators.test.ts`, `emulators.test.ts`) still cover each platform through the daemon.
