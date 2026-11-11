# Incremental execution validation

Run selected scenarios from the repository root with Node 24, pnpm and Git installed:

```sh
node scripts/validate-execution.ts \
  --report-dir "$HOME/.cache/ted/execution-validation" \
  --scenario fixture-controls --scenario ownership --scenario reporting
```

The report directory is required. Use an absolute, persistent directory outside the
checkout, fixture scratch folders and personal `.ted` / `.ted-dev` homes, with no
symlink components. Reports survive removal of the Task’s worktree. There is no
automatic report deletion. The runner prints the unique run directory’s `summary.md`;
`report.json` beside it is the versioned machine-readable result. Attach the summary
with `ted comment --attach <absolute-summary-path> "<result and limitations>"`.
The runner itself never posts to a Task or accesses configured machines.

Each selected scenario invokes only its manifest-listed files with `pnpm vitest run`.
Vitest uses the existing suite slots and process cleanup. There is no second lock,
full-suite command or GitHub workflow. Allow up to 30 minutes to acquire existing
suite slots, plus the scenario timeout. Normal test runs also remain local:

```sh
pnpm vitest run packages/daemon/test/execution-fixture.test.ts \
  packages/daemon/test/execution-validation.test.ts scripts/validate-execution.test.ts
```

On systems where the agent sandbox blocks process inspection or child launches,
run that selected command with the agent’s command approval mechanism. Do not
disable cleanup or suite locks. This permission supplies no native-sandbox evidence.

## Scenarios and evidence boundaries

The versioned manifest is `packages/daemon/test/support/execution-manifest.ts`.
Selections are explicit; empty and unknown selections fail.

| Scenario | What it proves | Evidence label |
| --- | --- | --- |
| `fixture-controls` | Independent homes, daemons and loopback ports; sibling-preserving cleanup; process kill/restart; held/dropped acknowledgments; readiness, disk, load and Run capacity controls | isolated loopback integration; fixture controls |
| `ownership` | Row 1’s real assignment persistence before start, immutable retry receipt, stable machine identity, process restart and full event-log replay; conflict/stale-reference rejection and refusal of local execution on another machine’s assignment | isolated loopback integration; production behavior |
| `reporting` | Selection, source identity, durable publication, failed/incomplete subprocess results, redaction, bounded evidence, replay instructions and scratch cleanup | isolated loopback integration; fixture controls |
| `production-transport` | Skipped until an owning implementation Task adds its adapter | isolated loopback integration |
| `two-mac` | Skipped until lab access and a real-machine adapter exist | actual two-Mac execution |
| `native-sandbox` | Skipped; no qualifying scenario supplied | native-sandbox evidence |
| `gui` | Skipped; no GUI scenario supplied | GUI evidence |

Loopback success never counts as two-Mac, native-sandbox or GUI evidence. The
acknowledgment exchange echoes fixture messages only: it is not a transport backend,
remote Task execution, scheduling, failover or reconciliation implementation.
Synthetic capability tests may use the store driver before the full remote lifecycle
exists; no feature flag or route advertises this as support for ordinary user Tasks.

The separate lab entry point requires explicit opt-in:

```sh
node scripts/validate-execution-lab.ts --opt-in \
  --report-dir "$HOME/.cache/ted/execution-validation" --scenario two-mac
```

It currently reports skipped and reads no machine inventory. Add production service
and transport adapters in their owning Tasks, together with qualifying scenarios;
the normal runner must never discover or contact real Macs.

## Fixtures and extension points

`createExecutionFixture()` owns a scratch root. Each `machine('controller' | 'executor')`
has a synthetic source repo and bare remote, separate home, sanitized explicit
environment, stub agents and Gh, a child daemon and a fixture-only socket bound to
`127.0.0.1:0`. `machine(..., 'store')` exposes real `TedStore.execution` and
`createTaskExecution` over test-only IPC. There are no new product routes.

Use `start`, `kill`, `close`, `control`, `exchange`, `barrier`, `agentStarts` and
`client` for bounded observations. Settings such as `maxWorkingRuns` and
`maxChecksAtOnce` go through the existing app-authorized client on the synthetic
home. Gh state/call counters reuse `createGhFixture`, also used by the merge harness.
Agent prompts use the existing JSON `steps`, including `waitFor` release files.
Fault counters distinguish fixture execution from acknowledged, held and dropped
replies. Agent and Gh counters are separate actual start/call records.

Wait for IPC readiness, process exits, socket events, Task/slot state or exact
counters. Use bounded `eventWait` / `waitUntil` checks rather than fixed sleeps to
claim progress or absence. Closing a fixture disconnects its links, settles pending
requests, stops/reaps its child, kills only processes marked with its unique home,
verifies their exit, then removes only its owned scratch directory. Sibling homes
and processes stay intact. Startup failures follow the same cleanup path.

## Reports and replay

Reports identify the candidate commit and content tree, plus a dirty-content digest
when tracked or untracked content differs from HEAD. Git’s isolated-index
`workingChanges` path disables hooks, external diff and text conversion; raw patches
are not saved. Metadata includes prerequisite versions, manifest version, exact
command argv, host identity/platform/architecture, durations, evidence labels,
expected/observed invariants, results and relative evidence paths.

A pass requires a zero subprocess exit, a complete passing Vitest JSON result and
all declared invariant observations. Missing observations, crashes, timeouts,
publication failures and cleanup errors fail closed. Exit codes are 0 for passing
evidence, 1 for failure and 2 for skipped-only runs (no passing evidence).
On macOS and Linux, a timed-out command’s owned process group receives termination
and then forced cleanup, so descendants cannot keep the scenario’s pipes open.

On failure, reports retain redacted stdout/stderr, failure details and selected
fixture diagnostics, capped at 256 KiB per artifact (four artifacts, below 2 MiB per
scenario), with truncation markers. Stream collectors also bound retained memory
and omit oversized lines. Reports use `redactSecrets`; no raw homes, environment
dumps, credential databases or personal integration data are copied. JSON and
summary publication each use temporary-file rename. Successful and failed runs
clean scratch after collecting evidence; a cleanup failure is reported as failure.

Replay instructions include exact argv and the required candidate identity. Restore
that commit and matching dirty content, install the recorded prerequisites and run
the argv from the checkout root. Replay creates fresh synthetic resources; it needs
no saved home, personal Task, billing account, Linear/Sentry or real GitHub access.
