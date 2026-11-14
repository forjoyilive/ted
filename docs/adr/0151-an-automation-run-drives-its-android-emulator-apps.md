# An Automation Run drives its Android emulator Apps

Android emulator Apps (ADR 0147) could be started and screenshotted, but nothing could send them input, so an Audit (ADR 0149, the headless browser) listed them as skipped. An Audit needs to read the screen, tap through it, type, go back, try another screen size and dark mode, and attach screenshots.

**`ted app screen`, `tap`, `type`, `key`, `swipe`, `appearance` and `size` work only for a live Automation Run with a checkout, on an emulator App it started.** They go through `POST /runs/:id/apps/device` (`runToken`, own Run only, `Tasks.runDeviceCommand`), the same checks as the headless browser. `ted app screenshot` takes the same route in an Automation Run and saves the image as a Run capture (`v1.RunBrowserCaptureAdded`), so `ted task create --attach` accepts it; in a Task Run it still saves to the Task. Task Runs get no input commands.

**The request is kind-neutral.** `DeviceRequest` in `packages/protocol/src/device.ts` carries the action, the App, an element number or points, text, a key from a fixed list, light or dark, and the size as a string the App’s kind interprets (`1080x1920` or `reset` on Android). The Apps module hands it to the kind’s own module; iOS simulators (TED-312) will read the same request, with their own sizes and keys.

**Only `apps/emulators.ts` runs `adb`.** `control` there reads the screen with `uiautomator dump`, parses it with `parseUiDump` in `apps/android-screen.ts` and keeps each element’s centre in memory until the next read, so a tap by number needs no second dump. Taps and swipes are refused off the screen that `wm size` reports, turned by the rotation the last screen read gave. Text for `input text` must be printable ASCII without line breaks or `%s` (which `input text` types as a space), goes in one single-quoted argument, and is capped at 1,000 characters, because `adb shell` hands its arguments to the device’s shell. Keys map to fixed key codes. Appearance is `cmd uimode night`; size is `wm size` and `wm density`, and both reset when the AVD is deleted with the Run’s Apps.

**What the App shows is data.** The screen listing puts every element between `<<<SCREEN <nonce>>>>` lines with a fresh nonce, says that text comes from the App, flattens each text to one line of at most 200 characters, and lists at most 200 elements.

## Considered Options

- **Separate `ted emulator …` commands.** Rejected: iOS would need its own set, and the Audit prompt would name both.
- **Return refs that expire on any input.** Not done: the emulator can change on its own, so numbers are only as good as the last read either way, and the listing says to read again after each step.

## Consequences

`packages/daemon/test/emulators.test.ts` runs an Audit against the stub `adb`’s two-screen App. No test boots a real emulator.
