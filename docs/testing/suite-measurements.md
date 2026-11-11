# Suite measurements (KRI-256, stage 5)

The restarted series is pending. Earlier observations failed the speed and
reliability criteria; this procedure is not evidence that those targets passed.
Agents must never run these full-suite commands. The human runs them in a normal terminal outside an agent
Run or TED Task shell. No GitHub workflow is needed.

## Accepted experiment

The human accepted three normal-background baseline Checks, then three Checks
alongside a separate CPU workload on the same Mac. This replaces the earlier
quiet-machine plan: ordinary work may continue, without peer holds or an idle
window. The CLI argument `quiet` means no added CPU workload; it does not claim
the machine was quiet. Original quiet-machine reliability remains unproven.
The workload runs `ceil(logical CPUs / 2)` busy Node worker threads. Every worker
signals readiness before the Check starts, and the workload stays running until
the Check finishes. Its exact command, worker count, machine and one-second
load-average samples are recorded. Load average describes recent scheduler
pressure, not instantaneous CPU utilization; it can lag workload start/stop.

This demonstrates busy-machine reliability, **not simultaneous-suite reliability**.
KRI-256 originally asked for another full suite running concurrently. The global
lock serializes full suites, including across checkouts; a queued second suite
is not a competing test workload. The human explicitly accepted the CPU workload
instead. The lock and caps (3 Electron, 6 node) stay unchanged. These measurements
do not authorize raising them.

## Before running

Use one clean commit containing stages 1–4 and this collector, on the same Mac
for every attempt. The branch starts from `fba8346c` (stage 4 merged), which also
contains stage 1 (`da699a07`), stage 2 (`7599ff4e`) and stage 3 (`da21600e`). Record
the actual full tested commit from `run.json`; the starting commit is not the
measurement commit. Do not switch branches or update code/dependencies between
attempts. A code change needs a fresh six-run series.

Record ordinary background work and any unusual workload, interruption, power
source or thermal change alongside each result. Do not stop another Task’s
processes or remove its locks. Keep conditions as consistent as practical;
background variation prevents precise causal comparisons between baseline and
added-load results. The first baseline Check is included, even if installation
or caches make it slower. Keep all failures, interruptions and retries; do not
select only fast passing runs.

Do not set lock-owner variables, change worker counts, or run a second collector
at the same time. Install runs before the suite lock, so concurrent collectors
could otherwise compete during dependency installation. The collector refuses
a dirty tree, existing run label, or agent Run environment. Do not clear agent
context variables to defeat that refusal; use your own normal terminal.

## Six human-run commands

From this repo’s root, run each command separately and wait for it to finish:

```sh
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/measure-check.ts quiet series-2-baseline-1
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/measure-check.ts quiet series-2-baseline-2
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/measure-check.ts quiet series-2-baseline-3
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/measure-check.ts loaded series-2-loaded-1
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/measure-check.ts loaded series-2-loaded-2
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/measure-check.ts loaded series-2-loaded-3
```

Each invocation starts exactly one `pnpm check` with `CI=true` so pnpm’s installation step can run without an interactive terminal. This environment override is recorded in `run.json`. Loaded mode starts its own
separate `node scripts/check-load.ts <worker-count>` process, waits for readiness,
and stops that workload on completion or interruption. It never stops another
Task’s App. Ctrl-C terminates the collector’s own Check process group and CPU
workload; an interrupted attempt is incomplete evidence, not a pass. SIGKILL or
machine failure cannot guarantee cleanup or complete artifacts; report that
attempt and inspect any surviving owned processes before continuing.

Every run has a new directory under
`.suite-measurements/<label>/`. A used label is refused to
preserve the previous evidence. If a run fails, preserve it and report why. A
fresh loaded passing streak requires additional human-run commands with new
labels; the initial six attempts must remain in the report.

## Evidence and timing

- `run.json`: actual start/end commits and cleanliness, machine hostname/OS/CPU/
  memory, Node/pnpm versions, exact Check/workload commands, worker count, load
  samples, collector wall time, exit status, interruption and workload failure.
  `unexpectedWorkloadExit` records `{ code, signal }` when the workload exits
  before collector cleanup (including an exit during interruption); it is absent
  when the workload survives until cleanup. `checkSignal` is the Check’s
  terminating signal, or null when none was recorded (including when the Check
  never started). Neither field identifies who sent a signal. A missing field in an older archive means it was not recorded.
- `console.log`: complete Check output, including the recurring-failure report.
- `check-measurement.json`: monotonic phase boundaries in milliseconds from the
  Check’s start, total duration, lock wait, work duration and combined test-process
  envelope; artifact hashes identify the fresh files copied under the suite lock.
- `ted-test-report-{electron,node}.json`, `ted-test-retries-{electron,node}.json`,
  `ted-test-times.json`, `ted-test-failures.json`: per-project results/retries,
  per-file durations and rolling last-20-run failure history. The collector does
  not reset history; distinguish earlier runs from the six measured attempts.
- `assessment.json`: preliminary completeness/reliability and speed assessment.
  A pass on retry makes `reliablePass` false even if `pnpm check` exited zero.
  Read the raw artifacts before making the final acceptance claim.

`totalMs` measures installation through Check reporting, before evidence copying
and lock release. `lockWaitMs` covers acquisition of both the full-suite lock and
all slots. `workMs = totalMs - lockWaitMs` includes installation, typecheck, lint,
test startup/execution/teardown and reporting. Use `workMs <= 180000` for the
agreed full-Check speed target; also publish the raw total and lock wait. Never
present lock wait as test execution time. Collector wall time additionally
includes metadata collection, CPU-workload startup/shutdown and evidence export.

`phases['Test electron']` and `phases['Test node']` give separate child-process
start/end boundaries. `testProcessEnvelopeMs` spans the earliest project start
to the latest project completion; both projects overlap. These intervals include
Vitest startup, collection and teardown. The project JSON reports also record
per-file start/end timestamps; report their envelope separately if
reported test-file execution is needed. Summing per-file times overstates wall
time with parallel workers. No instrumentation claims an exact CPU-only duration.

Missing/incomplete timing or artifacts are a finding. Unchanged old timing or
failure-history files are not copied as fresh evidence. Retry/project files
are cleared by the existing Check runner under the lock before test execution;
new identical empty retry reports are still preserved. Artifact copying also
happens under the lock, before another suite can overwrite them. Installation
failure or interruption before tests cannot borrow another run’s cached reports.

## Initial failed attempt

The human’s `quiet-1` on `76601d748dfad217b32cd497caa907c4f484c37c`
stopped before tests: pnpm reported
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. The collector captured output
without telling pnpm to run noninteractively. The corrected collector explicitly
sets `CI=true`; a stub regression models this refusal even when the parent sets
`CI=false`. Evidence now lives outside `node_modules`, which installation may
refresh. The original attempt was preserved and copied to
`.suite-measurements/quiet-1/`. Its reserved label must not be reused.

This was an installation failure, not a test failure or a completed measurement.
The recorded Mac was an Apple M3 Pro with 12 logical CPUs and 36 GiB memory,
Darwin 27.0.0 arm64, Node v24.7.0 and pnpm 10.28.0. Collector wall time was
754.6 ms and installation ran for 234.8 ms. Lock wait and test execution are
absent. The sampled 1-minute load was 58.44, so it also provides no quiet-machine
baseline. That installation attempt did not count toward the subsequent series.

## Preserved first series and restart decision

The first series on `9a06f4754dcd916b858d6ffff16388ff10aeefa4` used the same
Apple M3 Pro Mac (12 logical CPUs, 36 GiB, Darwin 27 arm64, Node 24.7.0,
pnpm 10.28.0, `CI=true`). Its three normal-background baselines were
FAIL/FAIL/PASS, with Check work durations 651.938, 639.381 and 617.040 seconds.
All exceeded 180 seconds. Preserve raw archives `quiet-1-retry`, `baseline-2`
and `baseline-3`, including their failure and retry reports.

`loaded-1` ended before completion after 497.242 seconds of collector wall time,
with `workloadFailed: true`, Check exit code null and no final Check timing or
reports. That wall time is not completed Check work or test time. The user
confirmed the attempt ended on its own; its cause remains unknown because exit
code/signal details were not recorded. Partial output contains a failure in
`failure-merge.test.ts` (“completed acceptance survives background reads, explicit
queries and daemon restart”) and a retry in `app.test.ts` (“a Run opens in a
Conversation tab with its chat, takes messages, and the tab persists”). Neither
is resolved by the incomplete attempt. Do not borrow stale cache reports.

The user authorized collector exit diagnostics and a fresh six-run series.
Use the new clean commit and `series-2-*` labels above, keeping all earlier
archives. Do not pool observations from different commits into a passing series.
The loaded passing streak is zero. The three-minute, original quiet-machine
and original simultaneous-suite criteria remain unmet or unproven. Existing
scoped repairs are tracked in KRI-286–290 and KRI-293–295; these diagnostics
supply evidence and do not claim to repair the unexpected workload exit.

## Results to post in KRI-256

Include the acceptance adjustment, full commit, machine identity/configuration,
Node/pnpm versions, exact workload and worker count, baseline/background conditions,
and links to all attempt artifacts. Preserve `console.log` and the full rolling
failure-history file to support the top-10 recurring-failure report, including
passes on retry. Unexpected skips or missing Electron execution require an
explanation; a zero exit alone does not prove full coverage ran.

| Attempt | Commit / Mac | Total s | Lock wait s | Check work s | Test-process envelope s | Exit / failures / retries | CPU load observations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| series-2-baseline-1 | Pending | — | — | — | — | Pending | Pending |
| series-2-baseline-2 | Pending | — | — | — | — | Pending | Pending |
| series-2-baseline-3 | Pending | — | — | — | — | Pending | Pending |
| series-2-loaded-1 | Pending | — | — | — | — | Pending | Pending |
| series-2-loaded-2 | Pending | — | — | — | — | Pending | Pending |
| series-2-loaded-3 | Pending | — | — | — | — | Pending | Pending |

Report every attempt against 180 seconds, without averaging away a slow run.
Require three consecutive loaded passes with complete evidence, no retry defects
and a live workload throughout. If a criterion fails, record the failure and
create a scoped TED-project Linear follow-up after checking for duplicates.
The follow-up names the failing tests/phase and evidence, desired result and
focused validation. Keep KRI-256 open while agreed criteria are unproven or
unmet; measurements alone are not completion.

## Coverage audit

The audit is of source coverage responsibilities; execution of all native paths
remains pending the human’s full runs. No tests are removed by stage 5.

- [Daemon migration](daemon-decision-coverage.md): all four removed cases name
  exact unit replacements. Source confirms both Linear decision cases, queue
  Priority ordering and Claude permission fields are covered at their production
  seams. Retained `linear-sync.test.ts` lifecycle, `queue-limits.test.ts` slot
  release, and `permissions.test.ts` approval/delivery cases still exercise their
  complete integration paths. Status, merge and schedule main paths were not
  removed; merge-to-Done and Automation firing/finish remain integration tests.
- [Renderer migration](renderer-component-coverage.md): the 98 baseline-case
  rows retain named replacements or consolidation destinations. All 312 named
  local source links were checked for the named title in their current test
  file. One stale Coordinator title was updated to the retained, expanded
  reopen/new-Run case. The baseline diff’s changed List default title belongs
  to the separately merged Stage-grouping change, not a removed native feature.
  The inventory explicitly retains native launch, Inbox answer, Validate/sign-off,
  settings/reload, OS integration, transport, persistence and security paths;
  component tests claim only their DOM/bridge responsibilities. Native coverage
  remains above the original roughly-30-test target; this is already documented
  as a deliberate boundary-coverage tradeoff, not a fulfilled count target.
- [Timer changes](timer-control-coverage.md): no feature test was deleted. Source
  changes replace synchronization with controlled clock advancement and actual
  completion barriers. Existing GitHub, nudge, recovery, steering, merge,
  Automation and Linear main paths remain; focused clock tests supplement them.

The named-replacement and retained-main-path source audit found no missing
replacement or removed feature main path. This does not certify passing native
execution, nor prove the 180-second target. Confirm the actual tested commit
still includes these paths when reviewing the supplied run artifacts.
