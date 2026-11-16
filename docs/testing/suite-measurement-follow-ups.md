# Filed tracker updates after the six observations

The user restored Linear write access after the earlier rejected attempts. All
five scopes below are now filed in Kriya Design / Ted as Backlog children of
KRI-256, after fresh duplicate searches:

- [KRI-357](https://linear.app/kriyadesign/issue/KRI-357): archive/setup working slot.
- [KRI-358](https://linear.app/kriyadesign/issue/KRI-358): Coordinator readiness/cleanup.
- [KRI-359](https://linear.app/kriyadesign/issue/KRI-359): empty-app quit retry.
- [KRI-360](https://linear.app/kriyadesign/issue/KRI-360): update/restart preservation.
- [KRI-361](https://linear.app/kriyadesign/issue/KRI-361): Conversation-tab retry.

The final report and recurring history were posted to KRI-256 (comment
`4c84eddf-b3ff-41aa-a3c8-85eacd799215`). Related evidence was added to KRI-286,
KRI-293, KRI-294 and KRI-290. KRI-293’s closure as unreproduced is preserved.
KRI-256 remains In Progress; its speed and reliability criteria remain unmet.
The scopes and publishing checklist below preserve what was filed.

Evidence for every follow-up is in [the final report](suite-measurement-results.md)
and [the evidence manifest](suite-measurement-results.json). Raw archives live
under `.suite-measurements/` in TED-46’s checkout. The measured commit is
`c0594f81851e15c8d68faf96da8d0b1a164d8d7c`, on the same M3 Pro Mac with six
busy CPU workers in each loaded observation. All artifact hashes match.
The frozen source predates later repairs. Each diagnostic Task must inspect
current source before reproducing an already repaired defect.

## Diagnose a working slot left after archiving during setup

Loaded 2: `packages/daemon/test/worktrees.test.ts`, “archiving during setup stops
setup, starts no Task Lead and removes the worktree”, observed `/slots.working`
as 1 instead of 0 at line 324, after removal and no `leadRunId`.
Determine whether slot release is late or incorrectly accounted for; neither is
established by the failure. No exact open diagnostic scope found in the search
for worktree setup, archiving during setup, or slot release.

Acceptance: archive during a running setup releases its working slot, starts no
Task Lead, and removes the worktree. Cover the actual completion boundary without
dropping assertions or adding sleeps. Validate the affected file only; full
suite verification belongs to the user or merge.

## Diagnose Coordinator daemon readiness and cleanup in the loaded suite

Loaded 2: both cases in `packages/app/test/coordinator-ui.test.ts` failed:
“Coordinator opens from the sidebar, sends, shows receipts and keeps its whole
conversation when reopened and after a new Run” and “Stop keeps unstarted messages
visible as Not sent when the Coordinator is reopened”. Each reports an
`afterEach` timeout of 10000 ms plus a `daemon.json` readiness timeout at
`daemonAsApp` lines 49/131. The captured failure files are preserved with hashes.
KRI-293 was closed by the user as unreproduced, with no fix claimed. Link this new
evidence without reopening it or assuming the old and new failures share a cause.

Acceptance: identify the failing readiness or cleanup boundary on current source,
add deterministic regression coverage, and preserve chat receipt, reopen, new-Run
and Not sent assertions. Validate the native file without retry dependence or
wider timeouts. Do not claim a successful focused run meets full-suite reliability.

## Diagnose the empty-app quit test passing only on retry under CPU load

Loaded 2: `packages/app/test/app-task.test.ts`, “quitting with nothing running ends
the app and Ted’s background process”, passed on retry after a 90000 ms test
timeout. The first-attempt capture reports no window and no reported `TED_HOME`;
it does not identify the blocked step. Related KRI-338 covers distinct first-window
and background-readiness symptoms. No exact open quit-test diagnostic found.

Acceptance: locate and fix the delayed launch or quit boundary with focused
coverage preserving app and background-process exit assertions. Do not increase
guards, add sleeps, or depend on retry. Validate the affected file only.

## Diagnose update/restart preservation timing out under CPU load

Loaded 3: `packages/app/test/updates-app.test.ts`, “Restart to update keeps a
working Run going into the next launch with no lost output”, timed out after
90000 ms on both attempts. Two failure captures are preserved; neither locates
the blocked step. No exact open diagnostic scope found in the updates-app search.

Acceptance: identify the actual update handover, restart or readiness failure on
current source and add a deterministic regression. Preserve working-Run continuity
and no-lost-output assertions. Validate the native file without longer deadlines,
fixed sleeps or retry dependence.

## Diagnose the Conversation-tab main path passing only on retry under CPU load

Loaded 3: `packages/app/test/app.test.ts`, “a Run opens in a Conversation tab with
its chat, takes messages, and the tab persists”, passed on retry after a 90000 ms
test timeout. The capture reports no window and no reported `TED_HOME`, without
locating the blocked step. The same case retried in the older incomplete
`loaded-1` attempt, outside the completed rolling history. KRI-333 is a separate
Codex output identity; no common cause is established. No exact open diagnostic
scope found in the Conversation-tab search.

Acceptance: diagnose the delayed lifecycle boundary and preserve chat opening,
message delivery and persisted-tab assertions. Validate the affected native file
with a focused regression; retries, longer guards and missing assertions are not
repairs.

## Append related evidence to existing issues

- KRI-286: loaded 2 repeats the Add Factory duplicate-key error-query failure on
  frozen source that omits its repair. Do not reopen or call it a regression.
- KRI-293: link the new Coordinator evidence and draft diagnostic above; preserve
  the user’s closure as unreproduced.
- KRI-294: loaded 3’s “acceptance rejects superseded local verification:
  unavailable” returned 200 with accepted state instead of 409. Baseline 3’s
  unavailable capture returned 201 instead of 409. The later shared-fixture repair
  is absent from this series. Inspect current code before deciding whether more
  repair is needed; do not weaken rejection assertions.
- KRI-290: the final slowest-file report still has failure-merge at 220.7 s,
  merge-gate at 197.1 s and failure-cases at 178.0 s under load on old source.
  Preserve these measurements without claiming its later repair failed.
- KRI-338/339/340 and KRI-333 already hold scoped diagnostic work for the first
  loaded observation and baseline 1. Keep them open until their own evidence and
  decisions resolve them; later incidental passes are not fixes.

## Parent KRI-256 comment

Post the final report’s measurement tables, full measured commit, machine,
accepted workload adjustment, failure summary and printed recurring-failure
report. Include the evidence manifest and raw archive locations. State that all
six exceeded 180 seconds excluding lock wait, all loaded observations failed and
had retry defects, and the loaded passing streak is zero. Record that quiet-machine
and simultaneous-suite reliability remain unproven. Main-path tests and named
replacements remain in source; failing paths prevent certifying successful native
execution. Keep the lock and 3 Electron / 6 node caps. Link the newly filed scopes
only after creation succeeds. Leave the parent In Progress and its unmet criteria
unchecked. Plan any fresh series after repairs separately with the user.
