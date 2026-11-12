# Empty-app quit diagnosis (KRI-359)

The historical cause is unresolved. The user approved adding diagnostics to the
existing quit test, then executing only `packages/app/test/app-task.test.ts` in
Validate with retries disabled and six ready CPU workers. A focused pass is a
negative reproduction result, not proof of a repair or full-suite reliability.

## Evidence and current source

The [measurement report](suite-measurement-results.md) and
[manifest](suite-measurement-results.json) record one 90-second timeout followed
by a retry pass on frozen `c0594f81851e15c8d68faf96da8d0b1a164d8d7c`.
The first-attempt capture reported no window and no reported `TED_HOME`; this
does not identify a launch or quit boundary. The referenced raw directory
`.suite-measurements/series-2-loaded-2/` is absent here and at its recorded
TED-46 location. It has not been re-examined or hash-verified.

Later commit `6035789f` bounds the shutdown request and forces Electron to exit
if quitting stalls. It is already on this branch’s base. There is no evidence
that establishes whether it addresses the historical test failure.
[KRI-338’s diagnostics](electron-startup-diagnosis.md) also already register
startup observations through the common app harness after `electron.launch`
resolves. Their focused success does not establish the quit test’s cause.
TED-207 confirmed it plans no edits to those app launch/capture helpers.

## What the added observations establish

Only the existing empty-app quit test changes. Before each awaited boundary it
prints a fixed phase label, elapsed milliseconds, its temporary home and the
liveness of known app/background process PIDs. It also saves the accumulated
observations and PIDs in `logs/empty-app-quit.json` in that home. Diagnostic write
failure prints a warning without replacing the test’s original failure.

The labels distinguish launch start/loaded, reading the background PID, Electron
close start/resolution, background exit start/completion and completed exit
assertions. The existing failure capture can copy the log once an app is
registered. Console output covers earlier launch failures and survives normal
temporary-home cleanup. An exception adds `failed` and is rethrown; a Vitest
timeout need not unwind the awaited operation, so use the last printed phase.

`launch-start` alone cannot distinguish Electron launch/attachment from window
or renderer readiness. Correlate it with the existing startup milestones and
snapshot. Likewise, `close-start` without `close-resolved` identifies an awaited
close that has not returned, but does not prove a production shutdown defect.
PID liveness is an observation at that instant, not a guarantee against PID reuse.
Diagnostic writes add a small amount of test-only I/O.

Both original exit requirements remain: wait for the background process to exit
and assert that Electron is no longer alive. The test also rejects a missing
Electron PID instead of falling back to PID zero. No timeout, sleep, retry policy,
test lock, worker cap, shared helper or production code changes.

## Validation and remaining work

Tests have not run in Work. In Validate, start six workers with the existing
`startLoad(6)` in `scripts/check-load.ts`, await their readiness, then run
`pnpm vitest run packages/app/test/app-task.test.ts --retry 0` outside the Electron
sandbox. Keep the workload alive through the invocation and cleanup, fail if a
worker exits unexpectedly, and terminate only those owned workers in a `finally`
block. Preserve the standard suite locks and worker caps. Retain the console
containing the phase observations before interpreting the result.

If it fails, return to Work with the last reached boundary and retained evidence.
If it passes, report the historical cause as unresolved. This single-file run
does not reproduce the original concurrent mixed suite. Locate and hash-check
the original capture before making a stronger historical claim; further full
suite measurements belong to the user or merge.
