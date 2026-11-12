# Coordinator test daemon ownership before readiness

TED-207 follows [KRI-358](https://linear.app/kriyadesign/issue/KRI-358/diagnose-coordinator-daemon-readiness-and-cleanup-in-the-loaded-suite).
The [suite observations](suite-measurement-results.md) and their
[manifest](suite-measurement-results.json) record two Coordinator cases failing
with both a `daemon.json` readiness timeout and a 10-second cleanup timeout in
loaded observation 2. These observations used frozen `c0594f81851e15c8d68faf96da8d0b1a164d8d7c`.
[KRI-293](https://linear.app/kriyadesign/issue/KRI-293/diagnose-coordinator-relaunch-timeout-and-cleanup-under-load)
remains closed as unreproduced, with no repair claimed. This investigation does
not establish a shared cause.

## What current source establishes

At the starting commit, `84ec6d1c`, both native cases call `daemonAsApp` before
launching Electron. That helper spawns a daemon, discards its child handle and
polls `daemon.json` for 20 seconds. It cannot distinguish a failed spawn, an early
exit or a live child still starting. `stopDaemonIn` discovers its daemon through
the same file. A live child that has not published the file is therefore outside
that cleanup path. If the file appears late instead, cleanup waits up to 10
seconds for the daemon to exit, equal to the hook's entire default budget.

This is a concrete ownership gap at the readiness/cleanup boundary. It is not
proof of why either historical daemon failed to publish readiness on time, or
which historical cleanup operation exceeded its budget.

Comparison with the frozen commit shows that current Coordinator tests already
use `resolveElectron` instead of requiring Electron. Shared helpers also gained
Run-host startup handling and fixture environment isolation. Those later changes
do not retain the child spawned by `daemonAsApp`.

The raw `.suite-measurements/series-2-loaded-2/` folder was absent from this
worktree, the original TED-46 worktree path and the primary repo path when
inspected. The manifest records matching hashes from the original measurement;
this investigation has not independently rechecked those missing bytes.

## Repair and controlled regression conditions

`daemonAsApp` now retains the child through `AppDaemons`. Readiness accepts only
that child's descriptor. A spawn error or early exit is reported at that
boundary. A readiness timeout still uses 20 seconds, but reaps the child before
rejecting, so it cannot later publish readiness into a home being removed.

`stopDaemonIn` first stops its owned child, including one without `daemon.json`,
then performs its existing descriptor-based and Run/App-host cleanup. Owned test
children get one second for SIGTERM, then SIGKILL and one second to confirm exit.
This intentionally forces a stuck test child to end inside the hook budget;
it is not a change to production daemon shutdown or persistence guarantees.
Existing cleanup for daemons launched by the app remains in place.

`packages/daemon/test/app-daemons.test.ts` covers descriptor identity, successful
readiness, timeout with a live child, cleanup before publication, SIGTERM refusal,
early exit and spawn failure. It also exercises the existing `daemonAsApp` and
`stopDaemonIn` boundaries: a Node preload reports its PID and then holds before
the daemon entry point can publish anything. Cleanup must terminate that process
and readiness must reject. The gate uses a child acknowledgment rather than a
sleep to infer that startup is held.

## Verification and limits

No test files or Checks were run in Work. The Factory reserves test execution for
the Task Lead in Validate. The diagnosis skill’s execution loop was deferred to
that Stage under the Factory’s explicit rule; its first result is recorded below.

The first Validate ran `packages/daemon/test/app-daemons.test.ts` and
`packages/app/test/coordinator-ui.test.ts` together with `--retry=0`, outside the
Codex sandbox for native execution, retaining the shared suite locks.
The Coordinator file and all its receipt, reopen, new-Run history and Not sent
assertions are unchanged. No guard or worker cap was raised.

A focused pass will establish only these controlled lifecycle conditions and
the native Coordinator cases on the checked source. It will not establish the
cause of the historical slowdown, reproduce the original loaded suite, or meet
KRI-256's full-suite reliability criteria.

## First Validate result and remaining cleanup investigation

At `a22551ca`, all nine ownership regression cases passed with retries disabled.
The first native Coordinator case passed, but the Not sent case still failed
with `Hook timed out in 10000ms` at the `afterEach` declaration. The invocation
reported 10 passed and 1 failed overall. There was no daemon.json timeout in
that invocation. The output did not identify the individual cleanup operation.
Typecheck, Lint and independent code/security review passed. The native failure
remains a blocker; it is not accepted as a passing result.

A retry-disabled comparison on archived branch base `84ec6d1c` failed earlier,
in `beforeAll` awaiting the renderer build, with the same 10-second hook limit.
Neither native case executed. The archive’s Coordinator test and shared helper
blobs matched the base commit. That comparison is inconclusive about the cleanup
failure and does not establish that it is unrelated to the ownership repair.
The detailed first-visit output is attached to the Task as the Validate round 1
report; neither invocation has been retried on unchanged source.

The next diagnostic slice keeps cleanup order, behavior and deadlines unchanged.
It records each cleanup step in memory and emits the active step plus elapsed
times after eight seconds, before the existing ten-second hook deadline. It
reports completion after a slow cleanup, or the failed step if cleanup rejects.
Fast successful cleanup stays silent. Reporting failures cannot replace the
original cleanup error, and the warning timer is canceled when cleanup ends.
Only static operation names and timings are logged, not test data or secrets.

`cleanup-evidence.test.ts` prepares controlled coverage for a held cleanup step,
preserved errors and warning-timer disposal. Test execution remains reserved for
Validate. These diagnostics do not choose a repair for the remaining native
failure or claim its cause. The next native execution must identify the boundary
before a supported cleanup repair can be selected.
