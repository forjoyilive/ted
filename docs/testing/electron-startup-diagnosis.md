# Electron startup diagnosis (KRI-338)

The historical loaded-run startup cause remains unresolved. This change adds
bounded evidence at the native launch boundary and a focused unattended workload
reproduction. It does not claim that current main reproduces the archived failures
or that the six CPU workers caused them. Current-branch native execution belongs
to Validate; no test files were run in Work.

## Historical evidence and coordination

[KRI-338](https://linear.app/kriyadesign/issue/KRI-338/diagnose-electron-startup-timeouts-under-the-accepted-cpu-workload)
records 27 final first-window failures across 11 files, with both attempts reaching
the existing 60-second deadline. An Automation case passed on retry after the same
window symptom. Explicit `--background` startup instead missed its 20-second
daemon-info poll and passed on retry. Those symptoms remain separate.

The [measurement report](suite-measurement-results.md) and
[manifest](suite-measurement-results.json) retain the case inventory, timings and
hashes from frozen `c0594f81851e15c8d68faf96da8d0b1a164d8d7c`. The original
`/Users/nabhacosley/.ted/worktrees/TED-46/ted/.suite-measurements/series-2-loaded-1/`
directory is absent in this environment. The 30 preserved captures cannot be
re-examined here; a summary or matching timeout text cannot replace them. TED-204
independently reported the same missing archive and was told of this evidence gap.

[KRI-295](https://linear.app/kriyadesign/issue/KRI-295/remove-create-more-and-plans-list-native-retry-defects)
was read with its discussion on 2026-11-12 UTC. It remains In Progress for Create
more and Plans-list completion ordering. Its discussion explicitly separates the
KRI-338 startup evidence and does not establish a shared cause. Its old TED-145
Lead is no longer a Factory peer, so direct peer coordination was unavailable.
The local KRI-295 branch contains no later diagnostic commits than its base. This
Task changes neither those feature assertions nor their repair scope. Recheck
that investigation before overlapping a later repair.

## What the code establishes

`first-window.ts` waits for Playwright’s window event for 60 seconds, then for the
renderer’s `data-loaded="true"` marker. In `main.ts`, window creation follows
`app.whenReady()`, daemon supervision/connection, initial state loading and update
setup. Consequently, a missing Playwright window does not identify which earlier
boundary stalled, whether a native window exists, or whether Electron exited.
This is a description of ordering, not a causal attribution.

Test launches now write up to 48 fixed milestone records per process to
`TED_HOME/logs/app-startup.log`. Each has wall time, pid and elapsed milliseconds.
They distinguish main-module evaluation, Electron ready, window/background mode,
daemon connection, initial state, update setup, native window creation, renderer
load and background completion. Renderer load failure, renderer process exit,
unresponsiveness, startup rejection and single-instance refusal have labels too.
The small synchronous writes are test-only and can perturb timing; they do not
change startup ordering or deadlines.

The common app launch helper and explicit background case also register parent
observations. On a readiness failure, `test-startup.json` records:

- Electron pid, exit code and signal, and at most 32 transport/window events;
- daemon-info presence and a bounded daemon data-status request;
- native window count/loading state, Playwright window count and renderer marker;
- numeric `ps` state/CPU-time columns for only the app and daemon pids;
- logical CPU count, load averages and free/total memory;
- at most 16 KiB each of milestone and redacted stderr tails.

Independent probes run together with 1.5-second bounds; daemon-info reading has
its own bound. A failed probe says `unavailable`. No environment, command line,
daemon credential or app key is written. Diagnostic failure preserves the original
readiness error. Failure captures use the registered home even when evaluation
through Electron is dead, and copy these logs using the existing capture limits.
Only the first snapshot per launch is kept, preserving the failure boundary.

Interpret evidence conservatively: an exit signal demonstrates exit, while a live
pid with `unavailable` evaluation only demonstrates an unresponsive transport at
the probe deadline. A native window with no Playwright window narrows the boundary;
it does not prove a transport defect. Load averages and process CPU time describe
observations, not scheduler causality. Probe deadlines can themselves expire on a
busy machine.

## Focused verification

At Validate, run these three files once, outside Codex’s Electron sandbox, retaining
the normal suite locks and project worker caps:

```sh
ELECTRON_STARTUP_LOAD=6 pnpm vitest run packages/app/test/uncaught.test.ts packages/app/test/app-startup.test.ts packages/app/test/app-background.test.ts --retry 0
```

The test-runner-only `ELECTRON_STARTUP_LOAD=6` flag opts into the three stress
cases; they are skipped in ordinary suite runs so a routine Check does not acquire
an extra competing workload. It is not an app or daemon runtime setting.
`app-startup.test.ts` starts a separate Node process running the existing
`scripts/check-load.ts 6`. All six busy workers report ready before app launch,
unexpected workload exit fails the observations, and the workload stays alive
through the native cases and their cleanup. It stops only its own workload.
It preserves the existing 60-second window and 20-second daemon-info deadlines.
The normal case requires a loaded renderer and Sidebar; the background case
requires a working menu, daemon readiness and zero native/Playwright windows.
Successful readiness snapshots are printed as JSON so they survive temporary
test-home removal. Failures use the normal retained capture directory.

A third case kills its own already-started Electron process and checks that the
exit signal, milestone history and transport unavailability are saved without
evaluating its home. This is an observability check with a different setup, not a
regression test for the historical startup cause. `uncaught.test.ts` checks that
milestone logging is disabled outside test launches, bounded and nonthrowing.
The existing background file retains its feature assertions.

The focused run has six competing workers but does not reproduce the full Check’s
three Electron and six node workers running concurrently across 240 files. A pass
therefore cannot establish full-suite reliability or three consecutive loaded
passes. No timeout, fixed sleep, retry policy, feature assertion, worker cap or
lock was changed as a repair.

## Unresolved boundaries and next steps

1. Obtain the retained raw archive from the user or its current custodian. Verify
   it against the committed manifest before comparing exact failure identities.
2. Inspect the focused current-branch snapshots in Validate. If they fail, use the
   last reached milestone and independent process/window/daemon states to choose
   the next probe. Do not choose a fix from timeout text alone.
3. If focused launches pass, retain that bounded negative result. A later
   user-run full Check can capture these diagnostics under the original mixed
   workload. A fresh full measurement series needs its own user agreement.
4. If failures precede `electron.launch()` returning, parent observations are not
   yet registered. Main milestones may still exist, but module-import stalls
   before `main-evaluated` and launch/attachment failures require an earlier
   process-launch probe. This change does not claim that boundary is covered.
5. Split repairs when evidence distinguishes unrelated causes, coordinate any
   overlap with KRI-295, and retain every main-path native feature assertion.

No historical cause, causal CPU-load attribution or repaired full-suite passing
streak has been established by this change.
