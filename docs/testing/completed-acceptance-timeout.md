# Completed acceptance timeout (KRI-339)

The completed-acceptance integration case now records each phase and explicitly
exercises queries during and after a delayed background GitHub read. It retains
acceptance/history checks after daemon restart and forces an event-log replay.
This is diagnostic coverage; the original loaded timeout’s cause is not yet
established and no production repair is claimed.

## Preserved failure

The imported issue and committed measurement report record a test-body timeout:

```text
packages/daemon/test/failure-merge.test.ts
completed acceptance survives background reads, explicit queries and daemon restart
Error: Test timed out in 30000ms.
```

Source: [KRI-339](https://linear.app/kriyadesign/issue/KRI-339/diagnose-the-completed-acceptance-integration-test-timing-out-under).
The retained structured record is
[suite-measurement-results.json](suite-measurement-results.json), under
`series-2-loaded-1` → `node` → `failures` (search for the test name);
[suite-measurement-results.md](suite-measurement-results.md) explains its limits.
The frozen revision was `c0594f81851e15c8d68faf96da8d0b1a164d8d7c`.
The measurement used six busy Node worker threads and the normal shared lock
and worker caps. It does not establish that those workers alone caused the
failure or that repaired current source fails.

The raw archive named by the issue,
`/Users/nabhacosley/.ted/worktrees/TED-46/ted/.suite-measurements/series-2-loaded-1/`,
was absent when inspected from TED-204. The retained summary has no phase stack
or step timings. The older incomplete loaded attempt supplies no final diagnostic
and is not pooled with this completed measurement.

## Later repairs reviewed

- `40f9af692fab62374087cbf42057db6f0aee7192` (KRI-294) fixes the separate snapshot
  test’s control of a local-read gate. A background read could consume its global
  count and pause preliminary obligations instead of final verification. It uses
  `ManualClock`, poll rearming and drained verification. It does not change this
  completed-acceptance case or establish a shared cause.
- `6495f617ddcdb4bd5cbb4c6f9e6434b7a3bfbc15` (KRI-290) combines compatible cases
  in failure-merge and controls the CI-stuck wait in merge-gate. This particular
  completed-acceptance path is unchanged. Its measured setup/progression costs
  are documented in [daemon-setup-waits.md](daemon-setup-waits.md).
- `ce89eeb9d19d84dc8e588053d4d53150ff23578f` changes this case’s timeout from
  30 to 90 seconds, reporting 13–15 seconds alone and failures in busy full runs.
  It adds no phase diagnosis. TED-204 does not raise that inherited timeout.

## Focused diagnostic boundary

The test still starts the daemon through `merge-harness.ts`, records and accepts
an actual Finding through HTTP, approves Review and waits for Done. It retains
the second Task’s progress to Review, preserving the original background-work
scenario rather than substituting a store-only test.

`ManualClock` now controls polling. A rearmed poll is the completion signal for
GitHub’s read and `reactToGitHub`; merely starting a stub command is not treated
as completed observation. After draining the poll, the existing stub GraphQL
gate holds one background read. The test queries the completed Task while that
read is held, releases it in `finally`, waits for poll completion and queries
again. Acceptance must remain historical and satisfied, with no invalidations.
There is no sleep or elapsed-time threshold to simulate the delayed read.

The daemon then stops, the temporary home’s state files are removed using the
existing replay-test pattern, and a new daemon must return the same historical
acceptance and exactly the same Failure case history from the event log.

Phase records contain elapsed start/end times for startup, each Task’s progress,
context capture, record/assessment/decision/acceptance, sign-off, merge, gated
reads, history, stop, state removal, restart and replay queries. They print on
success and through `onTestFailed` on failure, including a started phase without
an end time when it did not finish. These values contain fixed phase names and
timings only; they contain no request bodies or credentials.

## Verification and remaining uncertainty

Work prepares this focused command for the Task Lead’s single Validate run:

```sh
pnpm vitest run packages/daemon/test/failure-merge.test.ts
```

No test files were run in Work. Validate must retain the phase output and any
failure, report which phase dominates or remains unfinished, and distinguish
this controlled delayed-read scenario from the original full-suite load.
A passing focused run alone cannot establish that the measured full-suite
symptom is gone. If the source timeout cannot be reproduced, that uncertainty
remains explicit; later user-run full verification is still required.
