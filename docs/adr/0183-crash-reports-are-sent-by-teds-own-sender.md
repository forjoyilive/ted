# Crash reports are sent by TED’s own sender

Status: accepted (TED-478). Builds on ADR 0024 (`redactSecrets`) and the Sentry project TED-476 added for Report a problem.

TED-477 added the `reporting` machine setting and a consent prompt that promises to send “the error, TED’s version and your operating system’s name and version”. TED-478 makes the main process, the renderer and the daemon send crashes and uncaught errors to Sentry while that setting is on.

**One sender, `crashReporter` in `packages/daemon/src/crash-report.ts` (`@ted/daemon/crash-report`).** It builds a Sentry `event` envelope by hand and posts it over HTTPS with `sentryTarget` and `envelopeRequest` from `packages/daemon/src/sentry.ts`, which Report a problem uses too. There is no Sentry SDK. Each process makes its own reporter with an `enabled` function that is read before every send: `settings.reporting` in the main process, kept current by `settings-changed`, and `RunningDaemon.reporting()` in the daemon, read from the open store. Until settings are known, nothing is sent. Turning the setting off takes effect at once.

**A report holds only the error.** It holds the error type, its message, its stack frames, a `part` tag (`main`, `renderer` or `daemon`), the mechanism (`uncaught`, `rejection`, `render` or `gone`), environment (`release` or `dev` from `edition`), release (TED’s version) and the OS name and version. There are no breadcrumbs, log lines, settings, Task details, `server_name` or `user`.

**Paths are removed before anything else is read.** `cleanText` first makes TED’s own code root relative (`packages/daemon/src/tasks/queue.ts:120`; in release the root is `app.asar`), then replaces the home folder and the rest of its path up to a quote, bracket or line end with `<path>`, then any other absolute POSIX, Windows or `file://` path, and finally runs `redactSecrets`. Messages are cut to 500 characters and stacks to 50 frames. Only frames in TED’s code are marked `in_app`.

**Each process limits itself.** The same error (type, message and top frame) is sent once per process run, and at most 10 reports an hour. A failed send is dropped, never queued, and the reporter never throws.

**Where each process catches errors.**
- Main: the existing `uncaughtException` handler, a new `unhandledRejection` handler (both skip `isConnectionError`), and `render-process-gone` on the main window for every reason except `clean-exit` and `killed`. A `--worker` app sends nothing.
- Renderer: `window` `error` and `unhandledrejection` listeners and `createRoot`’s `onUncaughtError` send the error to main through the `reportCrash` custom request. Main reads it with `parseRendererCrash`, which accepts it only from the main window and cuts each field to size, writes it to `app.log` and reports it. The renderer makes no network request.
- Daemon: an `uncaughtException` handler (Node routes unhandled rejections there) logs the error, waits up to 5 seconds for the report, then exits with code 1, so the supervisor still restarts it.

**Native crashes are not sent.** Electron minidumps hold raw process memory, which can include prompts and repo contents.

`TED_FORCE_ERROR` (test-only) throws one error in each named process once it has read settings, so tests and a trial from TED Dev can check the whole path.

## Considered Options

- **`@sentry/electron` and `@sentry/node`.** Rejected: large dependencies that collect breadcrumbs and context by default and need care to send nothing before consent.
- **Daemon crashes sent by the app.** Rejected: a daemon started by the `ted` CLI with no app open would go unreported.
- **The renderer posts to Sentry itself.** Rejected: it would need network access and a copy of the DSN.
- **Breadcrumbs or recent log lines.** Rejected: the consent text doesn’t cover them and logs name repos and Tasks.

## Consequences

- Renderer stacks in release point into the minified Vite bundle until source maps are uploaded.
- Sentry may store the sender’s IP address unless the project’s “Prevent storing of IP addresses” setting is on.
- Over-redaction is accepted: a message with a home-folder path loses the rest of its line.
