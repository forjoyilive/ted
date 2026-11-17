# Six suite observations: speed and reliability targets unmet

All six user-run observations are complete on one clean commit. Every Check
exceeded the 180-second target, excluding lock wait. Baselines were FAIL/PASS/FAIL;
added-load observations were FAIL/FAIL/FAIL. The loaded passing streak is zero.
Completing measurements does not meet KRI-256’s speed or reliability criteria.
Keep KRI-256 open and retain the global lock and caps of 3 Electron / 6 node workers.

The user accepted ordinary background work for the three baselines and six busy
Node worker threads for the three added-load observations. These replace the
original quiet-machine and simultaneous-suite experiments. Neither original
criterion is proven. A second full suite would queue behind the global lock,
which stayed enabled. No peer holds or idle window were requested. Unusual
workload, interruption, power or thermal notes were not supplied; this is not
proof that background conditions were identical. Load samples show substantial
variation and cannot attribute a slowdown to the six workers alone.

## Measured source and machine

All six observations started and ended on clean
`c0594f81851e15c8d68faf96da8d0b1a164d8d7c`, on
`Nabhas-MacBook-Pro.local`: Apple M3 Pro, 12 logical CPUs, 36 GiB,
Darwin 27.0.0 arm64, Node v24.7.0, pnpm 10.28.0. Stages 1–4 are present
through base `fba8346c`. Later repairs on main are deliberately absent from the
frozen source. These observations do not establish failures of those repairs.
This reporting commit was made after the series; it is not the measured commit.

Each human command used `TED_HOME="$PWD/node_modules/.cache/ted-home"` and
`node scripts/measure-check.ts quiet|loaded <label>`. The collector launched
one `pnpm check` with `CI=true`. Added load was exactly
`/opt/homebrew/Cellar/node/24.7.0/bin/node`
`/Users/nabhacosley/.ted/worktrees/TED-46/ted/scripts/check-load.ts 6`.
All six workers signaled readiness before each loaded Check, survived until its
completion, and were stopped normally by collector cleanup. No unexpected
workload exit, interruption or Check signal was recorded in the restarted series.
No agent launched a full Check or test during these inspections.

## Results

All durations are seconds. Failures count final failed tests, excluding retry
passes. Each loaded observation also had retry defects.

| Observation | Result | Check total | Lock wait | Check work | Test-process envelope | Failures / retry passes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| baseline-1 | FAIL | 1360.930 | 760.699 | 600.231 | 599.855 | 1 / 0 |
| baseline-2 | PASS | 1526.373 | 921.088 | 605.284 | 604.895 | 0 / 0 |
| baseline-3 | FAIL | 808.569 | 134.240 | 674.328 | 673.951 | 2 / 0 |
| loaded-1 | FAIL | 1763.197 | 0.162 | 1763.035 | 1762.422 | 29 / 2 |
| loaded-2 | FAIL | 874.492 | 0.159 | 874.333 | 873.790 | 4 / 1 |
| loaded-3 | FAIL | 900.028 | 0.158 | 899.870 | 899.346 | 2 / 1 |

Baseline Check-work median: 605.284s (range 600.231–674.328s).
Loaded Check-work median: 899.870s (range 874.333–1763.035s).
These descriptive medians do not replace the requirement that each run meet the
target and do not provide a controlled estimate of CPU-load cost.

Check work is total minus lock acquisition wait, including install, Typecheck,
Lint, test startup/execution/teardown and reporting. The test-process envelope
spans earliest project start to latest project completion. Reported file
execution envelopes are shown separately below. Parallel intervals overlap;
never sum them or call them CPU-only duration. All timing/artifacts are complete;
the collector’s generic “timing incomplete or failed” assessment also fires for
a completed failed Check.

| Observation | Collector UTC start–end | Collector s | Electron process / file s | Node process / file s |
| --- | --- | ---: | ---: | ---: |
| baseline-1 | 2026-11-11T20:59:34.065Z–2026-11-11T21:22:15.526Z | 1361.459 | 324.701 / 320.780 | 599.841 / 596.090 |
| baseline-2 | 2026-11-11T21:31:01.737Z–2026-11-11T21:56:28.645Z | 1526.906 | 308.529 / 304.918 | 604.886 / 601.327 |
| baseline-3 | 2026-11-11T22:21:14.112Z–2026-11-11T22:34:43.230Z | 809.116 | 453.606 / 449.379 | 673.949 / 669.754 |
| loaded-1 | 2026-11-11T22:59:48.875Z–2026-11-11T23:29:14.457Z | 1765.580 | 1762.422 / 1756.750 | 1010.038 / 1004.757 |
| loaded-2 | 2026-11-12T00:46:55.413Z–2026-11-12T01:01:30.978Z | 875.564 | 757.388 / 751.823 | 873.786 / 868.290 |
| loaded-3 | 2026-11-12T01:04:42.132Z–2026-11-12T01:19:43.235Z | 901.102 | 809.452 / 804.312 | 899.343 / 894.520 |

| Observation | Added workers | Load start / min / median / max / end | Samples |
| --- | ---: | --- | ---: |
| baseline-1 | 0 | 18.166 / 9.869 / 17.479 / 94.123 / 14.405 | 1341 |
| baseline-2 | 0 | 13.375 / 4.705 / 10.882 / 99.957 / 13.339 | 1505 |
| baseline-3 | 0 | 6.249 / 5.766 / 80.636 / 150.882 / 16.889 | 791 |
| loaded-1 | 6 | 18.940 / 18.940 / 201.707 / 402.419 / 72.597 | 1341 |
| loaded-2 | 6 | 3.227 / 3.227 / 136.758 / 185.778 / 126.208 | 627 |
| loaded-3 | 6 | 8.372 / 8.372 / 140.370 / 258.096 / 219.050 | 414 |

One-minute load average is scheduler pressure, not instantaneous CPU utilization.
It lags changes and includes lock wait. Sampling callbacks were delayed under load;
these are not exactly one sample per wall second. No cause is established.

## Failures and uncertainty

- Baseline 1: Codex Conversation output was empty instead of hello/world; KRI-333
  remains open. Later passes on unchanged source do not establish a repair.
- Baseline 2: passed without retries, but exceeded the speed target.
- Baseline 3: unavailable-context capture returned 201 instead of 409; GitHub-health
  cleanup raised ENOTEMPTY. Related evidence was posted earlier to KRI-294 and
  KRI-287. Those repairs are on later source, not measured here.
- Loaded 1: 27 Electron tests across 11 files timed out after 60000 ms waiting for a first
  window on both attempts. Completed-acceptance/read/restart timed out after 30000 ms;
  CI-stuck Merge cleanup timed out after 10000 ms. Two cases passed on retry: Automation
  Retry/Duplicate after a window timeout and background launch after daemon-info
  readiness stayed undefined. KRI-338/339/340 carry the diagnostic scopes.
- Loaded 2: both Coordinator cases report a 10000 ms cleanup timeout and daemon.json
  readiness timeout; Add Factory duplicate-key error query failed; archive-during-
  setup observed one working slot instead of zero after removal/no leadRunId.
  Empty-app quit passed on retry after a 90000 ms timeout. The blocked quit step and
  slot-release cause are unknown. KRI-286’s later key-validation repair is absent;
  KRI-293 was closed by the user as unreproduced without a repair claimed.
- Loaded 3: update/restart preserving a working Run timed out after 90000 ms on both
  attempts; unavailable-context acceptance returned 200 instead of 409, recording
  accepted state. Conversation-tab messaging/persistence passed on retry after
  a 90000 ms timeout. Captures do not locate the blocked native step. The acceptance
  case is related to KRI-294; do not infer a production defect or a current-main
  regression without checking the later fixture repair.

The user restored Linear write access after the earlier rejected attempts. The
complete final result and recurring report are now posted in
[KRI-256](https://linear.app/kriyadesign/issue/KRI-256).
Five duplicate-checked Backlog diagnostics were filed under KRI-256:
KRI-357 (archive/setup slot), KRI-358 (Coordinator readiness/cleanup), KRI-359
(empty-app quit retry), KRI-360 (update/restart preservation) and KRI-361
(Conversation-tab retry). The [follow-up record](suite-measurement-follow-ups.md)
retains their scopes. Related evidence was added to KRI-286, KRI-293, KRI-294 and
KRI-290 without changing their closure decisions. KRI-256 remains In Progress,
with its speed and reliability criteria unmet.

## Recurring-failure report

The final console report below covers 9 history entries, including 1 incomplete
entry and earlier source commits. It is not nine restarted observations and
cannot supply a loaded passing streak. Raw history is preserved in the
[machine-readable evidence](suite-measurement-results.json), which also lists
all final failed test names/messages, retry identities, manifests and hashes.
The old incomplete loaded attempt’s Conversation retry is visible only in its
partial console, not in this completed history; preserve it separately.

```text
== Most frequently observed test failures (last 9 runs; 1 incomplete)
  2 runs  packages/app/test/banners-component.test.tsx > Add Factory repo-access and key errors prevent submission
  2 runs  packages/app/test/coordinator-ui.test.ts > Stop keeps unstarted messages visible as Not sent when the Coordinator is reopened
  2 runs  packages/daemon/test/integrations.test.ts > GitHub health signing out raises an app-wide banner whose Fix opens gh auth login, and signing in clears it
  1 run  packages/app/test/app-background.test.ts > running in the background closing the window keeps Ted running, and the window still gets updates
  1 run  packages/app/test/app-background.test.ts > running in the background the app menu shows what’s waiting and running, and its items open the right place
  1 run  packages/app/test/app-background.test.ts > running in the background when macOS asks for approval, the row says so and opens Login Items
  1 run  packages/app/test/app-background.test.ts > running in the background with Keep running remembered, Quit leaves the Run going; with Stop it, Quit ends it all
  1 run  packages/app/test/app-board.test.ts > Board a Comment on a Done Task offers Comment only and Follow up, which opens the linked Task
  1 run  packages/app/test/app-board.test.ts > Board dragging up a column changes rank, and across Priority groups the Priority
  1 run  packages/app/test/app-crashes.test.ts > daemon crashes killing the daemon shows the Reconnecting bar and turns actions off while the Run keeps going; the restarted daemon picks the Run back up
  Incomplete runs may have unreported failures.
== Tests that failed, then passed on retry (last 9 runs)
  1 run  packages/app/test/app-background.test.ts > running in the background started with --background, Ted runs with no window
  1 run  packages/app/test/app-background.test.ts > running in the background the app menu shows what’s waiting and running, and its items open the right place
  1 run  packages/app/test/app-task.test.ts > Ted app quitting with nothing running ends the app and Ted’s background process
  1 run  packages/app/test/app.test.ts > Ted app a Run opens in a Conversation tab with its chat, takes messages, and the tab persists
  1 run  packages/app/test/automations-ui.test.ts > Automations in the app a failed Run shows Retry on the newest failed row only, and Duplicate makes an off copy
  1 run  packages/app/test/linear.test.ts > New Task dialog with a Linear URL a late inline key save preserves newer draft edits after dismissing the source
  1 run  packages/app/test/new-task-submission.test.ts > a pending key save respects the draft lifecycle during Create more
  1 run  packages/app/test/notifications-app.test.ts > notifications and badges a Task notification opens its selected request in the Inbox from All Tasks
  1 run  packages/app/test/plans-ui.test.ts > Planning chats the Plans list groups chats, Retry clears the red dot, Plan more from here builds on a past chat, and Delete removes one
  1 run  packages/app/test/task-content-isolation.test.ts > a late Task load cannot put its text and screenshots into another Task’s thread
```

## Coverage and evidence

All six collected the same 40 Electron and 200 node files, with 114 Electron and
2088 node tests. Every run has one expected Linux-only pipe/socket isolation skip
on this Mac and no node skips. Typecheck and Lint passed in all six. File manifests
and all 36 expected artifact hashes were checked against the archives. Stage 5
removes no tests. The named-replacement source audit remains valid on the unchanged
measured source:

- [Daemon decisions](daemon-decision-coverage.md): all 4 removed cases name
  replacements; Linear lifecycle, queue slot release, permissions, merge-to-Done
  and Automation firing/finish retain integration coverage.
- [Renderer components](renderer-component-coverage.md): 98 baseline-case rows
  name replacements or consolidation destinations; 312 named source links were
  checked. Native launch, Inbox answer, Validate/sign-off, settings/reload, OS
  integration, transport, persistence and security paths remain. The suite still
  exceeds the original roughly 30-native-test target, an explicit coverage tradeoff.
- [Timer control](timer-control-coverage.md): no feature test was removed. Controlled
  clocks and completion barriers supplement retained feature paths.

No missing named replacement or removed main-path test was found in source.
Collection is not successful execution: failing startup/update/Conversation
paths prevent certifying that every feature main path passed in the loaded
series. The acceptance result remains unmet.

Raw archives stay ignored under `.suite-measurements/<label>/`; old attempts
are retained. Each contains run metadata, console, timing, project results,
retries, per-file times, failure history and assessment. Loaded reports have
`inspection.json`, `inspection-hashes.json` and copied `failure.txt` captures
with original/saved hashes. Loaded1/2/3 preserve 30/3/3 captures respectively;
`redactSecrets` changed none, and no Run environments or credentials were copied.
The committed evidence manifest identifies original files by SHA-256; it is a
portable summary, not a claim that the large raw archives are in git.

Earlier installation failure and the old incomplete loaded attempt remain in
[the procedure and preserved first series](suite-measurements.md). Never pool
commits, borrow cached reports, replace a failure with its retry, or average away
a slow run. No additional full runs, lock bypass or cap changes are authorized.

## Next work

The final tracker updates are complete. Diagnose on current source before
reproducing already repaired frozen-source failures. Focused passes are repair
evidence, not full-series
acceptance. A fresh series after repairs needs its own clean commit and human
agreement; keep this failed series intact.
