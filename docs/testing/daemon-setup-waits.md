# Daemon test setup and waits (KRI-290)

The three affected files keep their daemon HTTP, git and stub-agent integration
coverage. Compatible variants share their existing setup. The CI-stuck question
uses the existing controllable clock and waits for the real question before
answering. Production code, suite locks, worker caps and timeout guards are
unchanged.

## Measurement method

The starting revision is `ee596b69ddd23a4a139b568c93fc5aa03f657cbe`, which already
contains earlier failure-case test consolidation. The older KRI-290 figures
(191.4s, 165.6s and 159.9s) are reference observations from a different revision,
not this change’s before measurement.

Both affected-file runs use Node v24.7.0, pnpm 10.28.0, Vitest 5.1.0 on Darwin
27.0.0 arm64, Apple M3 Pro / 12 logical CPUs / 36 GiB. They use the same command,
with `before` or `after` substituted for `<run>`:

```sh
pnpm vitest run packages/daemon/test/failure-cases.test.ts packages/daemon/test/merge-gate.test.ts packages/daemon/test/failure-merge.test.ts --reporter=default --reporter=json --outputFile.json=node_modules/.cache/ted-135-measurements/<run>.json
```

The existing configuration selects 3 workers for these 3 files and acquires one
normal shared test slot. Temporary observations around `lockRun` report elapsed
acquisition time and whether a slot was obtained. Temporary observations in
`merge-harness.ts` report fixture setup, Workflow fixture commit, daemon/Factory
startup, progression to sign-off and cleanup, plus the number of GitHub stub
calls. The same observers are used for both runs and removed from the final
change. They do not change scheduling or release a slot early. The tests run
outside the Codex sandbox because process inspection and filesystem watchers
are required. An earlier sandboxed attempt was stopped while queued, before
executing any tests, and supplies no timing result.

Per-file durations come from the JSON report’s file start/end times; their
combined execution envelope is the latest file end minus the earliest file
start. These times exclude slot acquisition. Vitest’s reported total duration
includes the slot wait. File execution overlaps; never add the file durations
to claim suite wall time. Other Tasks were active on the machine; neither run
is a controlled quiet or loaded measurement.

## Results

The before run passed all 34 tests. Slot acquisition took 2145.322s (35.8 minutes),
separately from a 137.854s file execution envelope. Its reported total duration
was 2285.29s. It acquired its slot at 2026-11-11 07:05:57.294 UTC.

The after run passed all 30 tests, retaining the original scenarios within the
combined cases below. Its slot acquisition took 221.588s, separately from a
110.697s file execution envelope. Its reported total duration was 333.66s. It
acquired its slot at 2026-11-11 07:13:04.204 UTC. The observed file envelope was
27.157s (19.7%) shorter. This is an affected-file observation under contention,
not a controlled estimate of the change’s speedup.

| File | Before execution | After execution |
| --- | ---: | ---: |
| `failure-cases.test.ts` | 73.714s | 57.346s |
| `merge-gate.test.ts` | 112.424s | 90.765s |
| `failure-merge.test.ts` | 137.854s | 110.697s |

## What the profile justified

| File | Before fixture / Workflow / daemon startup / cleanup totals | Before progression to sign-off |
| --- | --- | --- |
| `failure-cases.test.ts` | 2.304s / 1.950s / 6.302s / 2.261s across 12 setups | Not used by this file |
| `merge-gate.test.ts` | 1.516s / 1.059s / 3.366s / 3.450s across 10 setups | 55.360s across 9 calls |
| `failure-merge.test.ts` | 2.151s / 1.531s / 4.832s / 3.805s across 12 setups | 78.467s across 13 calls |

These are cumulative observed phase times within each file, not parallel-run
wall time. Sign-off progression excludes harness startup and cleanup. Remaining
scenario time includes actual HTTP actions, snapshots, git/agent work and
restart paths; it is not labeled idle waiting. GitHub stub calls numbered 2,
391 and 448 respectively in the table’s file order.

Creating a mutable git origin took only about 0.15–0.19s per fixture. Sharing
an origin or daemon across unrelated tests would sacrifice isolation for a
small saving, so the change leaves the shared harness alone. The three held
GitHub context-check variants each repeated roughly 6 seconds of progression
to the same sign-off; they now share that setup and explicitly restore scenario
state. Direct/Comment delivery shares one setup; historical-Finding checks use
the fresh Lead already created by the restart test. Four fixture/daemon starts,
two walks to sign-off and one extra stop/resume are removed.

The Merge Gate change targets a timing dependency: it computes the CI-stuck
deadline from the later of the recorded Merge entry and push, waits for the
GitHub timer to be armed, advances the existing manual clock, and waits for the
question. It does not shorten the configured durations or assume that a clock
advance completes asynchronous work.

## After profile and attribution limits

| File | After fixture / Workflow / daemon startup / cleanup totals | After progression to sign-off |
| --- | --- | --- |
| `failure-cases.test.ts` | 1.657s / 1.149s / 3.754s / 1.841s across 10 setups | Not used by this file |
| `merge-gate.test.ts` | 1.345s / 1.033s / 2.958s / 3.418s across 10 setups | 50.310s across 9 calls |
| `failure-merge.test.ts` | 1.343s / 1.014s / 3.027s / 2.364s across 10 setups | 58.262s across 11 calls |

After GitHub stub call counts were 2, 367 and 424 respectively. The deterministic
reduction is four fixture/daemon starts and two sign-off progressions, with no
shared mutable fixture across unrelated tests.

| Consolidated scenarios | Before, sequential cases in that file | After, combined case |
| --- | ---: | ---: |
| Direct and Comment resolution delivery | 9.370s | 5.373s |
| Restart plus historical Findings | 11.724s | 6.877s |
| Acceptance, obligations and Gate checks during a held GitHub read | 27.798s | 17.876s |

The CI-stuck test took 6.272s before and 6.111s after; the change removes its
reliance on real time reaching the deadline, rather than proving a substantial
speedup for that test. Unchanged tests varied too: the re-sign-off case in
`merge-gate.test.ts` took 25.195s before and 14.325s after. Therefore the whole
file or envelope difference cannot be attributed solely to these edits.

Local raw logs, JSON reports, per-case/phase summaries, observer script and
machine/load observations are under
`node_modules/.cache/ted-135-measurements/`. The raw before/after reports and logs
are attached to TED-135’s Work result so they remain available beyond this
worktree. Test assertions passed on their first attempts; neither run requested
retries. No production source or shared test helper remains changed.

## Preserved coverage

No scenario moves to a lower-level test. Replacements remain daemon HTTP / real git / stub-agent integration tests.

| Original test case | Integration replacement |
| --- | --- |
| `failure-cases.test.ts`: direct failure resolution delivers attached line comments to the live Task Lead | First variant of `direct and Comment failure resolutions deliver attached line comments to the live Task Lead`; retains actual delivery, patch text, redaction and duplicate-resolution assertions. |
| `failure-cases.test.ts`: comment failure resolution delivers attached line comments to the live Task Lead | Second variant of the same integration test, using a new failure request and draft on the same Task. |
| `failure-cases.test.ts`: outstanding cases and Inbox requests survive daemon restart and a fresh Task Lead | Combined restart/historical-Finding integration test; retains persisted blockers, Inbox linkage, new Lead and stale-token rejection. |
| `failure-cases.test.ts`: historical Findings remain recordable but cannot borrow a capture after their Run ended | Appended after the same real daemon restart and new Lead; retains rejection of the borrowed context, unknown provenance, inability to accept and explicit fixed resolution. |
| `failure-merge.test.ts`: acceptance / obligations / gate verifies worktree edits made while GitHub is pending | Three variants in one integration test, each with its own failure case and held GitHub read. Retains response status, current-case disposition/resolutions, blockers, unanswered sign-off, Review stage and absence of merge. Removes the edit, closes the completed case, confirms no blockers and restores GitHub state before the next variant. |
| `merge-gate.test.ts`: Send to Task Lead sends the Task back to Work without counting against Merge’s limit | Same integration test, advancing the existing manual clock from the recorded Merge entry / push deadline and awaiting the real question. |

All other integration scenarios remain unchanged. Main-path failure acceptance, Gate approval and actual merging remain integrated. No production interface, lock, worker cap, timeout or feature coverage change is proposed.

## Verification and remaining measurement

The measured after run passed all 3 files / 30 tests. After restoring both
shared observer files to their clean originals, `ted checks` passed Typecheck
and Lint. `git diff --check` passed. The final diff contains only the three
scoped test files and this report; no README or agent-guide update is needed.
The default 30-second guard stays in place for the consolidated cases; the
longest new combined case took 17.876s in the measured run.

The human or merge must still run full Checks under quiet and loaded conditions.
This Task alone does not establish the parent’s ≤180s target, and the overlapping
file durations cannot establish an overall suite improvement.
