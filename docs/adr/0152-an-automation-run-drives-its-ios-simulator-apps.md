# An Automation Run drives its iOS simulator Apps

ADR 0151 gave an Automation Run input for its Android emulator Apps through `ted app screen`, `tap`, `type`, `key`, `swipe`, `appearance`, `size` and `screenshot`, with a kind-neutral `DeviceRequest`. iOS simulator Apps (ADR 0085) could be started, screenshotted and recorded, but an Audit still skipped them.

**The same commands and route drive iOS simulators.** `POST /runs/:id/apps/device` and its checks are unchanged: a live Automation Run with a checkout, on an App it started. The Apps module hands an iOS request to `control` in `apps/simulators.ts`, which stays the only file that runs `xcrun simctl`, and now also the only file that runs `idb`.

**Input and screen reading go through Meta’s `idb`.** `simctl` can’t tap or read the accessibility tree. `control` runs `idb ui describe-all --json`, `ui tap`, `ui text`, `ui key`, `ui button HOME` and `ui swipe`, each with `--udid` of the Run’s own device, as separate arguments, never a shell string. `parseIdbScreen` in `apps/ios-screen.ts` turns the elements into the same listing as Android (`formatScreen`, fenced as App data, at most 200 elements), with positions in points and the screen size from the Application element. Typed text is printable ASCII, capped at 1,000 characters, after `--` so it can’t be read as a flag. Keys map to fixed HID codes; home is the Home button; `back` is refused, because iOS has none. When `idb` isn’t installed, every command refuses with a message saying how to install it, and the Audit lists the App as skipped with that message. `TED_IDB_BIN` points tests at `test/fixtures/stub-idb.ts`, which shares the stub `xcrun`’s state file. Release finds `idb` through the login-shell `PATH`.

**Appearance is `simctl ui <udid> appearance light|dark`.**

**Size on iOS is a device type.** A simulator’s screen can’t be resized the way `wm size` resizes an emulator, so `ted app size <App> "<device type>"` takes a name from `simctl list devicetypes` and restarts the App on a device of that type; `reset` goes back to the App’s configured `device`. The choice is kept in memory per App until the Run’s Apps are removed. A `<width>x<height>` size and `--density` are refused for iOS.

## Considered Options

- **A Ted-built XCUITest runner.** Rejected: it needs an Xcode build on each Mac and far more code than calling `idb`.
- **Separate `ted simulator …` commands.** Rejected for the same reason as in ADR 0151.

## Consequences

The Audit template audits `ios-simulator` Apps. `packages/daemon/test/simulators.test.ts` runs an Audit against the stub `idb`’s two-screen App, and `ios-screen.test.ts` checks the parser. No test boots a real simulator or runs the real `idb` or `xcodebuild`.
