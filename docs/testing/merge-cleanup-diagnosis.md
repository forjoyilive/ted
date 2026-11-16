# CI-stuck Merge cleanup diagnosis (KRI-340)

## Result and limits

The historical `Hook timed out in 10000ms` identifies `afterEach`, not its
waiting operation. The supplied capture folder,
`/Users/nabhacosley/.ted/worktrees/TED-46/ted/.suite-measurements/series-2-loaded-1/`,
and its parent worktree were absent when inspected for TED-205. The imported
issue is therefore the available historical evidence; the raw artifacts and
their hashes could not be independently inspected here.

This change adds diagnostics and a deterministic cleanup regression. It does
not claim to reproduce the historical timeout or to repair a demonstrated
production shutdown defect. Six busy worker threads were part of the observed
workload, not an established cause. A later full validation run by the user or
merge remains necessary, including the accepted loaded workload if the user
wants to compare that condition.

## Later repairs inspected before implementation

The starting branch matched `origin/main` at
`84ec6d1cddf34bdf34e1e6c8d7c890ec59c9c6ce`. Compared with frozen
`c0594f81851e15c8d68faf96da8d0b1a164d8d7c`, the relevant changes include:

- `22235557`: bounded host-start cleanup waits in affected tests, handled Runs
  whose hosts never started, and made the Claude stub’s command execution
  asynchronous so it can handle termination during a command.
- `4e6379d7`: ended the optional host-start cleanup wait once no host holds the
  Run lock, after its existing startup floor. The merge harness itself calls
  `killRunHosts` without the optional `waitForStart` flag in both revisions.
- `51e12321`: awaited integration health work before closing the home.
- `07ee011a`: made Run stop grace and input acknowledgement limits configurable
  for tests; the merge harness does not override them.
- `dd2f4456` and `c69ac31d`: extracted the merge watcher and removed repeated
  integration coverage. The old no-check / Keep waiting / Merge anyway case is
  now covered in `merge-watcher.test.ts`. `6495f617` also put the remaining
  CI-stuck send-back integration case on the manual clock.

None of these facts establishes which operation exceeded the historical hook
budget. The frozen branch and the measurement series were not changed.

## Diagnostic boundaries

`merge-harness.ts` emits `[merge-cleanup]` JSON records with the test name, step,
start/end/failed state and elapsed milliseconds. A start without a matching end
identifies the boundary still awaited when the hook times out. A rejection
emits a failed record and is rethrown.

| Step | Work awaited |
| --- | --- |
| `daemon` | Initial daemon stop work, before connection shutdown |
| `daemon.connections` | HTTP server close |
| `daemon.opening` | Any in-flight data opening |
| `daemon.services` | Service shutdown, including Task background work and Run manager close |
| `daemon.store` | Final event persistence and LiveStore shutdown |
| `run-hosts` | The harness’s existing Run host cleanup |
| `home` | Existing process-marker cleanup and temporary-home removal |
| `scratch` | Temporary origin/scratch removal |

The optional synchronous observers on `RunningDaemon.stop` and `Data.close`
report entry to an existing boundary; they do not change its order or await a
replacement implementation. Normal callers supply no observer. Store timings
include both final persistence and LiveStore shutdown; home timings include the
existing process sweep as well as folder removal. A future capture at either
boundary can justify narrower instrumentation without attributing it prematurely.

## Cleanup ownership

Cleanup captures its original daemon, home, scratch folder and removal callback
before its first await. It clears the daemon reference only if that daemon is
still current, and clears fixture environment values only if they still refer
to the original fixture. It leaves the stored paths intact. A late cleanup
therefore cannot switch to a replacement test’s resources or blank its paths.

This matters when a hook times out: its asynchronous cleanup can continue after
Vitest starts the next test. Validation of the first implementation exposed
that overlap. That implementation read mutable context after waiting and added
empty-path resets; those resets were removed. This is a defect found in this
Task’s first implementation, not evidence of the original KRI-340 cause.

## Deterministic verification

`merge-cleanup.test.ts` tests the existing harness cleanup boundary without
starting a full Task and walking its Stages. Its first case holds the daemon
stop contract with a controlled promise and starts a real idle Node child,
recorded as a fixture Run host. While shutdown is held, the child and both
folders must remain, and diagnostics must identify `daemon.services` as pending.
Releasing shutdown must kill the fixture host through the existing
`killRunHosts` helper. A second hold at the home-removal callback must change the
reported waiting boundary to `home` while retaining both folders. Releasing it
must finish normal folder removal. This test controls the stop contract; it
does not simulate or claim to verify LiveStore’s internal persistence timing.

The second case replaces the shared context while old shutdown is held. Old
cleanup must remove its own folders while retaining the newer folders, daemon,
removal callback and environment values. The newer cleanup must then remove its
own folders. This case would catch the ownership defect independently of
machine load or an actual hook timeout.

Holds are released in `finally`; boundary entry uses the existing bounded event
helper, and the owned child is reaped. There are no injected cleanup sleeps,
timeout increases, deletion retries, skipped cleanup, lock changes or worker-cap
changes. The child’s idle interval keeps that fixture alive; it is not a delay
used to order cleanup. The real merge harness still uses its original
`makeTempHome` removal callback and process sweep.

These two focused setups differ from existing Merge behavior cases: one owns a
controlled shutdown boundary and host, and one deliberately replaces the
context during shutdown. Neither needs a daemon or a Task Lead just to test
harness ownership. Existing integration cases exercise the actual daemon/data
close observers; watcher cases preserve no-check / Keep waiting / Merge anyway
behavior.

## Validation history and remaining coverage

The first Validate visit checked cbdf9ec3 after Typecheck and Lint passed. The
new full-Task regression timed out at 30 seconds, with its afterEach exceeding
10 seconds. The completed three-file run finished with 31 failed and 30 passed
tests in 569.01 seconds. Old cleanup records continued during later tests.
Several watcher and data tests also failed, including hook timeouts and final
event persistence timeouts. Do not erase that failure history or treat the
first regression as passed.

The same three files passed all 60 tests on source snapshot 84ec6d1c in 151.80
seconds. The base lacks the new regression. Both completed runs used the normal
shared lock outside the sandbox. They occurred at different times with no
controlled background workload; the comparison does not by itself establish a
cause. An earlier sandbox-limited branch attempt was interrupted, and an
initial base snapshot attempt collected no tests until workspace dependency
links were supplied. Those tooling attempts are not passing evidence.

The first reviewer reported no blocking Findings. Subsequent Task Lead
verification and inspection found the new regression failure and cleanup
ownership defect, and sent the Task back to Work. The report and test changes
now address those Findings but require fresh Validate verification. Work ran no
test files. Logs and Findings are preserved under
`.suite-measurements/ted-205/` and attached to the Task. Temporary snapshot and
fixture artifacts captured by Ted’s checkpoint were removed from the branch.

Next Validate should run the three files covering the riskiest behavior:

```sh
pnpm vitest run packages/daemon/test/merge-cleanup.test.ts packages/daemon/test/merge-gate.test.ts packages/daemon/test/merge-watcher.test.ts
```

These cover the focused lifecycle regressions, real Merge integration cleanup
and CI-stuck decisions. `data.test.ts` remains additional coverage beyond the
Factory’s three-file limit for one visit; its earlier failures remain recorded,
and later full validation by the user or merge remains necessary. Factory
Typecheck and Lint run at handoff. Fresh validation results belong in the Task
brief and thread.
