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

## Deterministic verification

The new case in `merge-gate.test.ts` uses the real daemon and existing
`beforeMerge` seam with a promise controlled by the test. It starts harness
cleanup while the merge is held, verifies the last boundary is
`daemon.services`, verifies no Run host cleanup has started and verifies both
folders remain. Releasing the merge permits normal shutdown and store close.

The same case then holds the home-cleanup callback. The reported boundary must
change to `home`, with store close and Run host cleanup completed and scratch
still present. Releasing that hold must finish the original cleanup, remove
both folders and leave no process marked with that home. Holds are released in
`finally`; waits for boundary entry use the existing bounded event helper.
There are no injected sleeps, timeout increases, deletion retries, skipped
cleanup, lock changes or worker-cap changes. Existing removal helpers retain
their existing behavior.

The regression has a different setup from existing Merge behavior cases: it
deliberately keeps a real merge in flight across daemon shutdown. No additional
daemon is started to repeat CI/Gate assertions already covered by the watcher.

Work did not run test files, in accordance with this Factory’s Stage rules.
Validate should run these three affected files in one command:

```sh
pnpm vitest run packages/daemon/test/merge-gate.test.ts packages/daemon/test/merge-watcher.test.ts packages/daemon/test/data.test.ts
```

These cover the new lifecycle regression, existing Merge sign-offs and CI-stuck
behavior, and the data lifecycle changed by the optional observer. Factory
Typecheck and Lint run at handoff. Validation results belong in the Task brief
and thread; this report describes the implementation and its evidence limits.
