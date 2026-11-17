# Conversation-tab retry diagnosis (KRI-361)

`packages/app/test/app.test.ts`, “a Run opens in a Conversation tab with its chat,
takes messages, and the tab persists”, hit its 90-second limit once in the loaded-3
measurement run and passed on retry.

The most likely stalled step is the app quit in the middle of the test. At the
measured commit that quit had no time limit. Current `main` already limits it.
This is a conclusion from reading the source and the capture’s description. It is
not proven, because the raw capture is gone and no test ran in Work.

## Evidence

The [measurement report](suite-measurement-results.md) and
[manifest](suite-measurement-results.json) record the timeout and the retry pass
on frozen `c0594f81851e15c8d68faf96da8d0b1a164d8d7c`. The capture is described as
“no window and no reported `TED_HOME`”. The raw folder
`.suite-measurements/series-2-loaded-3/` is not in this worktree, the main clone or
the TED-46 folder, so the capture itself was not read.

## What the capture’s description rules in

The capture is written by `closeApp(ctx.app)` after a failed test. It exists only
when `ctx.app` is set. It reports no window when the app has none, and no
`TED_HOME` when the app’s main process does not answer within 5 seconds. In this
test that state is possible at three points:

1. The first launch, after Electron starts and before its window opens.
2. The quit in the middle of the test (`await ctx.app?.close()`). `ctx.app` is
   cleared only after the quit finishes, so a quit that never finishes leaves a
   closing app with no window that no longer answers.
3. The second launch, before its window opens.

Points 1 and 3 have their own 60-second limit in `firstWindow`, which fails with
its own message. They give a bare “timed out in 90000 ms” only if more than 30
seconds had already gone. A starting app’s main process normally answers, so “no
reported `TED_HOME`” fits them less well. Point 2 had no limit of its own.

## The quit at the measured commit

At `c0594f81`, `quitCompletely` in `packages/app/src/main.ts` was:

```ts
quitting = true
supervisor?.close()
await client?.shutdown().catch((error: unknown) => console.error(error))
app.quit()
```

The app waited for the daemon’s answer to `POST /shutdown` with the client’s
5-minute timeout. The daemon answers only after `runs.stopAll()`, which stops this
test’s idle Task Lead Run and waits for its host. Nothing forced the app to exit
if Electron’s own quit did not finish. Playwright’s `close()` waits for the app
process to exit. So the test’s quit waited, without a limit, on the app, the
daemon and the Run host, all competing with six busy CPU workers.

Only three app tests quit the app this way in the middle of a test. Another is
the empty-app quit test (KRI-359), which retried in loaded-2 with the same capture
description.

## Current source

Commit `6035789f` (“Make Quit Ted completely always exit the app”) is on `main`
and was not in the measured commit. The app now waits at most 10 seconds for the
shutdown answer and exits 5 seconds after asking Electron to quit. The daemon
shuts down when the response closes, or at once if the app has already gone. The
quit is therefore limited to about 15 seconds in the product. This Task changes
no product code.

One gap remained in the test. It launched the app again as soon as the first app
had exited, while the old daemon could still be closing its store. `stop` in
`packages/daemon/src/daemon.ts` removes `daemon.json`, closes connections, closes
the store and only then releases the lock. A second app that starts in that gap
starts a daemon that exits because the lock is held, and repeats until the old
one is gone (`withDaemon` in `packages/daemon/src/launch.ts`). Each try is a full
process start, which is slow on a busy machine and adds to the same 90 seconds.

## What changed

Only the test changed:

- Before the second launch it waits for the old daemon’s process to exit
  (`waitForExit`, the helper the empty-app quit test uses, with its own
  10-second limit and message). The second launch then starts one daemon.
- It prints each step it reaches with the elapsed time
  (`Conversation tab: <step> at <n> ms`): `run-idle`, `first-launch-loaded`,
  `message-delivered`, `quit-start`, `quit-finished`, `old-daemon-exited`,
  `second-launch-loaded`. A Vitest timeout names no line; the last printed step
  now does.

No timeout, retry setting, lock, worker cap or assertion changed. The chat
opening, message delivery and persisted-tab assertions are as they were.

## Validation and limits

In Validate, run `pnpm vitest run packages/app/test/app.test.ts --retry 0` and
keep the console output. A pass shows the test works without a retry on current
source. It does not reproduce the full loaded suite, so it does not prove that
the 90-second timeout cannot recur there. If the test fails, the last
`Conversation tab:` line and the failure capture’s `logs/test-startup.json` and
`logs/app-startup.log` name the step.

If a later full loaded run shows this retry again, compare the printed steps:
a gap between `quit-start` and `quit-finished` points at the quit, one between
`quit-finished` and `old-daemon-exited` at the daemon’s stop, and one before
either `…-launch-loaded` at startup (see
[the startup diagnosis](electron-startup-diagnosis.md)).
