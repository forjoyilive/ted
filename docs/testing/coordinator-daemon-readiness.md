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

The first diagnostic slice kept cleanup order, behavior and deadlines unchanged.
It recorded each cleanup step in memory and emitted the active step plus elapsed
times after eight seconds, before the existing ten-second hook deadline. It
reported completion after a slow cleanup, or the failed step if cleanup rejected.
Fast successful cleanup stayed silent. Reporting failures could not replace the
original cleanup error, and the warning timer was canceled when cleanup ended.
Only static operation names and timings were logged, not test data or secrets.

`cleanup-evidence.test.ts` prepares controlled coverage for a held cleanup step,
preserved errors and warning-timer disposal. Test execution remains reserved for
Validate. These diagnostics do not choose a repair for the remaining native
failure or claim its cause. The next native execution must identify the boundary
before a supported cleanup repair can be selected.

## Diagnostic-first Validate result

The user approved a diagnostic-first Validate pass before selecting the remaining
repair. At `be2f2a6a`, the three diagnostic cases and both native cases passed
with `--retry=0`, with no skipped cases or cleanup warning. Duration was 43.15
seconds. Cleanup behavior was unchanged. The clean invocation therefore did not
identify the earlier stalled operation or repair the observed intermittent
failure. The round-1 Finding remains open; this pass was not failure acceptance.
Scoped code/security review found no new blocker in the diagnostic change and
confirmed that the repair part was absent. Detailed round-2 evidence and console
are attached to the Task.

The next diagnostic revision includes the fixed test name on every cleanup line
and reports completed step timings even when cleanup finishes before the warning.
This avoids losing useful measurements on a passing run or confusing a late
completion line with the next case. The eight-second warning, cleanup operations
and ten-second hook deadline remain unchanged.

The next experiment continues the user-approved diagnostic-first approach: one focused invocation of
the diagnostic and native files with retries disabled and six ready CPU workers,
matching the added workload of the original observation. Prepare the renderer
once under the normal shared test lock before starting that workload, using the
existing per-run build marker so the native hook does not repeat the build. This
targets native readiness and cleanup rather than the already-observed renderer
build timeout, without extending any guard. Record the preflight and workload
conditions, retain the worker caps, detect unexpected workload exit, and stop
only the experiment’s own workers in finally. This remains a focused loaded
diagnosis, not a replay or reliability certificate for the mixed full suite.

## Loaded diagnostic result and retained output repair

At `ad3850b9`, both native cases and all three diagnostic cases passed under six
ready CPU workers, with `--retry=0`, in 25.93 seconds. Renderer preparation
completed under the shared lock before that workload began. The workload stopped
normally after the test command completed. This was a focused experiment and did
not reproduce the mixed full suite or the original cleanup stall.

The captured console had no cleanup records even though the completion callback
was unconditional. Installed Vitest selected its minimal reporter in the agent
environment; that reporter suppresses successful test console records by default.
The first attempt to retain successful timings was therefore ineffective in
this invocation. Round-3 evidence, output and installed source pointers are
attached to the Task. The user chose Try again after TED’s loop check, resetting
the send-back count without accepting the native failure or declaring a repair.

The output repair writes the same fixed test identity, operation names, states
and timings directly to stderr instead of through `console.warn`. This keeps the
records outside the reporter’s console filtering. It changes no cleanup call,
order, error handling, assertion or deadline. Validate must confirm that the
actual native records appear in its retained log; a callback-spy assertion alone
cannot establish that. The native file changed and should run again; unchanged
ownership and diagnostic-helper cases retain their earlier passing results.

The remaining intermittent cleanup timeout is still unresolved. Retained phase
measurements must guide any further repair. Neither the output fix nor a clean
loaded invocation supplies a cause for the original failure.

## Verified retained records and remaining scope

At `ea8a06a1`, both native cases passed with `--retry=0` under six ready CPU
workers. The runner verified actual retained cleanup records for both distinct
cases, confirming the stderr output repair. Cleanup phases in milliseconds:

| Case | closeApp | stopDaemonIn | killRunHosts | removeHome | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Receipts, reopen, new-Run history | 985 | 162 | 1 | 161 | 1309 |
| Not sent after reopening | 913 | 223 | 1 | 202 | 1339 |

Vitest reported 21.66 seconds overall. Renderer preparation happened once under
the normal one-file test lock before added load. Both native cases executed,
no retry was used, the workload stopped normally, and the lock was released.
The detailed report and console are attached to the Task as Validate round 4.
Code/security review found no new defect in reporting but kept the original
cleanup obligation open. No product behavior or deadline changed.

These successful measurements resolve the evidence-output defect. They do not
explain or repair the earlier ten-second cleanup stall. Another identical
focused pass is not a distinct next experiment. The remaining choice must be
explicit: collect evidence under the original mixed-suite concurrency with a
human-run full Check, or narrow this Task to the verified ownership repair and
retained diagnostics while recording the cleanup cause as unreproduced.
Neither narrowing nor failure acceptance has been authorized yet.

For the original-scope route, the existing human-only collector can run one
loaded Check from a normal terminal in this clean Task worktree:

```sh
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/measure-check.ts loaded ted207-cleanup-mixed-1
```

The collector refuses agent execution, records the commit and machine/workload,
keeps the full-suite lock and worker caps, captures output under
`.suite-measurements/ted207-cleanup-mixed-1/`, and stops its owned CPU workload.
On this 12-CPU machine it adds six busy workers. This is a new observation on
the checked branch, not a reproduction on the frozen historical commit. Any
Coordinator failure or retry remains evidence of a defect, not a passing repair.
Agents must not launch this command. No full Check has been run for this route.


## User-run mixed-suite observation and supported cleanup repair

The user ran `scripts/measure-check.ts loaded ted207-cleanup-mixed-1` at clean
`a0985dedba88ac5b7ab9413a070ab05fa30d1d1a`, UTC 2026-11-12 16:36:25–17:14:35.
The six-worker workload remained alive. The full Check failed (Electron 8 failed,
125 passed, 4 skipped; node 23 failed, 3467 passed, 2 skipped). This is a new
observation; unrelated failures are outside this Task.

Both Coordinator cases failed their initial 10,000ms cleanup hook. The retained
records now identify the boundary:

| Case | closeApp running warning | closeApp completed | All cleanup completed |
| --- | ---: | ---: | ---: |
| Receipts and history | 8002ms | 10004ms | 10517ms |
| Not sent | 8001ms | 10007ms | 10542ms |

The shared `closeApp` helper waits up to 10,000ms before force-killing the app,
which exhausts the entire hook deadline before daemon/Run/home cleanup. The
Coordinator teardown now passes its existing timeout argument as 1000ms, leaving
room for those remaining operations. Shared helper defaults, the hook deadline,
behavior assertions and worker caps stay unchanged. This repairs the observed
cleanup budget collision; it does not identify why graceful app close stalled
or prove the unavailable historical failure had the same cause.

The failed hooks continued into subsequent attempts. Those retries failed
readiness with SIGKILL before daemon.json. The old cleanup read the shared home
between awaits, so a delayed cleanup could reach a replacement attempt. The
records lack home/PID identity to attribute these SIGKILLs conclusively. The new
Coordinator cleanup helper captures app/home when called, and the hook clears
its outer app reference before awaiting it.

`coordinator-cleanup.test.ts` holds the real `closeApp` call unresolved and checks
its force-kill and remaining cleanup path under a 5000ms test guard; the old
10,000ms argument cannot finish that regression in time. It also checks that an
already exited app is not killed and a daemon cleanup error remains an error
without deleting its home. No tests ran in Work. Validate must run it together
with `cleanup-evidence.test.ts` and `coordinator-ui.test.ts`, with retries disabled.

Evidence is in `.suite-measurements/ted207-cleanup-mixed-1/`: console, JSON test
reports, retries, run metadata, timing and collector assessment. All six artifact
hashes in check-measurement.json were independently checked and matched. The
attached `ted-207-mixed-suite-evidence.md` retains the exact Coordinator records
and hashes, including the console and run metadata. Original captures, all
previous passing and failed results, and the inconclusive base comparison remain
part of the evidence. No full-suite reliability or historical causal repair is
claimed; post-repair native validation is still required.
