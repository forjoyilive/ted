# An Automation Run drives its Electron Apps over their debugging port

An Audit (ADR 0146) could only use web Apps through the Run’s headless browser (ADR 0149). Desktop apps run as `command` Apps, so TED Dev, this repo’s own App, was skipped. Inside TED’s macOS sandbox Electron aborted at launch, so `pnpm app` refused there.

**A `command` App says it is Electron with `electron: true`.** TED gives it a port like a web App. When a Run (not the human) starts it, `electronEnv` in `apps.ts` sets `TED_ELECTRON_ARGS`, which the App’s `run` passes to Electron: `--remote-debugging-port=<port>`, plus `--no-sandbox` when TED sandboxes it, because Chromium’s own sandbox can’t start inside TED’s, plus `--ozone-platform=headless` on Linux. It also sets `TED_ELECTRON_HIDDEN=1`, and the App should open no visible window, tray icon or notification. A start with ▶ runs outside the sandbox, so it gets neither: no local process can reach a debugging port of an App running with the human’s full access, and the Run browser refuses an Electron App the human started. TED Dev treats it like `TED_HIDDEN_WINDOW=1`, and its daemon then exits with the app (`TED_EXIT_WITH_PID`). A Run’s Electron App is ready when `http://127.0.0.1:<port>/json/version` answers; the human’s counts as running once started.

**On macOS an Electron App’s sandbox allows one more Mach service, `com.apple.coreservices.launchservicesd`.** Electron aborts unless it can check in with it. Only `SandboxScope.electron` adds it, with `TED_SANDBOX_ELECTRON=1` in the environment, so `sandboxRefusal` lets `pnpm app` start. Every other sandboxed command keeps the old profile. Testing showed this service doesn’t let a sandboxed command launch other apps: `open -a` already could before the change, which is a separate gap.

**The App starts and stops through `apps.ts` as before; the Run’s headless browser attaches to it.** For an Electron App, `run-browser.ts` sends the helper the App’s port instead of a URL, and the helper connects to `ws://127.0.0.1:<port>/devtools/page/<id>`. TED builds that address itself from the port it allocated and the first `page` target `/json/list` reports, with the ID’s format checked. `packages/app/src/remote-page.ts` puts the same `PageDriver` interface over that connection that `browser-page.ts` puts over Electron’s `WebContents`, so `runOnPage` runs every action for both. Scripts run in an isolated world; `resize` sets the viewport with `Emulation.setDeviceMetricsOverride` at scale 1, because Electron has no window commands over CDP; `navigate` is refused, because a desktop App has no origin to stay inside.

## Considered Options

- **Playwright’s `_electron.launch`.** Rejected: it starts Electron itself, around `apps.ts`, the sandbox and the App’s process group, and the release doesn’t ship Playwright. Playwright stays a test tool.
- **Run Electron Apps outside the sandbox.** Rejected: an App an agent starts must stay sandboxed (ADR 0091).

## Consequences

While a Run’s Electron App runs, any local process can reach its debugging port and control its pages. Other sandboxed commands can reach loopback ports too, so they can drive the audited App, which is itself sandboxed, but nothing outside it. A release TED ignores `TED_EXIT_WITH_PID`, so auditing a packaged TED app can leave its daemon running until it goes idle. An Electron App that ignores `TED_ELECTRON_HIDDEN` shows its window when a Run starts it. The test (`packages/daemon/test/run-browser.test.ts`) starts a fixture Electron App in the real sandbox and is in the `electron` test project.
