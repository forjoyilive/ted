# An Automation Run drives its web Apps in a headless browser

`ted browser` worked only for a Task, through the app’s window (ADR 0097), so it needed the TED app open. Audits run unattended (ADR 0146) and need to click through the App they started, at different sizes and in light and dark mode, and save screenshots.

**The daemon starts the app’s own executable as a hidden, headless browser for each Automation Run that opens one.** `packages/app/src/entry.ts` is the package’s main: with `--ted-headless-browser` it loads `headless-browser.ts`, otherwise `main.ts`. A packaged Electron app always runs its main, so the browser has to be a mode of it. The helper takes no single-instance lock and has no Dock icon. Its page sits in a hidden `BrowserWindow` with offscreen rendering, because Chromium can’t capture or hit-test a page outside a window, and a hidden window without offscreen rendering fails some captures. Each start gets its own profile folder, `TED_HOME/browsers/<run-id>-<id>/` (`TED_BROWSER_PROFILE`), removed once the helper has exited. On Linux it starts with `--ozone-platform=headless`. `helperCommand` in `packages/daemon/src/apps/run-browser.ts` picks the executable: `$APPIMAGE`, the daemon’s own Electron executable without `ELECTRON_RUN_AS_NODE`, or, for a TED Dev daemon on plain Node, `TED_ELECTRON_BIN` or the app package’s Electron.

**Daemon and helper talk over the child’s stdin and stdout**, one JSON line per command and reply, screenshots as base64. There is no port, route or credential for the helper. Only `createRunBrowsers` in `run-browser.ts` starts it, through `workCommand` like other work for a Run, in its own process group, one per Run, one command at a time, each with a deadline; a command that runs over kills the helper and is never replayed.

**The page code is shared.** `packages/app/src/browser-page.ts` holds the origin lock, the WebRTC, file-chooser and dialog guards, and every action, for both the Task browser and the headless one, so the two can’t drift. `resize` (320–3840 by 240–2160) and `color-scheme` (light or dark, through `Emulation.setEmulatedMedia`, kept across navigation) are new actions; the Task browser refuses them.

**Only a live Automation Run with a checkout reaches it**, on a running loopback web App it started: `POST /runs/:id/browser` (`runToken`, own Run only, `Tasks.runBrowserCommand`). Each command checks the App again; if it restarted, the helper closes and the Run must open it again. Any change that leaves the opened App not running with the same start (stopped, exited on its own or restarted, seen through the Apps module’s `apps-changed` event), and stopping the Run’s Apps (which the firing’s end does), closes the helper; a start still under way is canceled; the daemon clears `browsers/` when it starts. `ted browser` picks the Run’s route inside an Automation Run, as `ted run-app` does.

**Screenshots belong to the Run.** Each one is saved with the attachment store and recorded as `v1.RunBrowserCaptureAdded` with its Run and Automation, counted in `store.filesInUse()`, added to the Run’s uploads so `ted task create --attach` accepts it, shown on the Automation Run page under Screenshots, and deleted with the Automation.

## Considered Options

- **Playwright’s Chromium.** Rejected: the release doesn’t ship it.
- **Reuse the app’s poll bridge with a credential for the helper.** Rejected: a private pipe to a child adds no route or token.
- **Run the helper in the OS sandbox.** Not done, as for the Task browser: the helper runs only TED’s code, the App’s page runs in Chromium’s renderer sandbox behind the origin lock, and the App itself runs in the OS sandbox. Electron can’t register as an app inside `sandbox-exec` anyway.

## Consequences

The end-to-end test (`packages/daemon/test/run-browser.test.ts`) launches Electron, so it is in the `electron` test project and skipped inside TED’s sandbox. There is no live view of an Automation Run’s browser.
