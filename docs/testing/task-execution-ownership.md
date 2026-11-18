# Task execution ownership baseline

TED-97 is the first piece of the approved cross-machine plan. It establishes local ownership and replay guarantees; it does not establish remote execution or real-Mac acceptance. TED-109 can incorporate these commands and cases into the shared harness. The Task’s Work completion Comment identifies the committed revision for the results below.

Run from the repository root on Node 24 with dependencies installed:

```sh
pnpm vitest run packages/daemon/test/execution-store.test.ts packages/daemon/test/execution.test.ts packages/daemon/test/store.test.ts packages/daemon/test/tasks.test.ts
ted checks
```

The configured Checks are `pnpm typecheck` and `pnpm lint`. Agents run only the targeted test files, never `pnpm test` or `pnpm check`. The shared test-slot lock can delay the command before tests start. In Codex’s sandbox, the runner’s process cleanup needs an escalated invocation because `ps` is blocked; that restriction does not justify skipping cleanup or bypassing the test lock.

## Coverage

| Public seam | Cases |
| --- | --- |
| `openStore` / `TedStore.execution` | Old v1/v2 Task events, generation-0 local fallback, stable machine identity, durable assignment, full state rebuild from the event log, idempotent retry after replay |
| Assignment writes | Conflicting attempts, concurrent attempts, operation/reservation/assignment ID reuse, legacy started Tasks pinned locally, invalid initial generations, unknown Tasks |
| Assignment reference validation | Wrong Task, machine, assignment or reservation; stale, future and invalid generations; deleted Tasks reject late traffic |
| `createTaskExecution.local` | Concurrent retries share ownership, ownership is on disk before return, persistence failure prevents permission to start, another machine’s assignment refuses local execution |
| Execution handles | Structured ownership references, path-shaped IDs rejected, generation 0 cannot create an execution handle |
| Daemon HTTP API with stub agent and local bare origin | Ordinary Task starts after assignment is saved, stays in Intake, and retains a single assignment across daemon restart |
| Existing store and Tasks tests | Regression coverage for local persistence, Task lifecycle and normal local execution |

## Results

- Initial test-first run: six ownership tests failed because the execution interface did not exist. Sandbox process cleanup also failed with `spawn EPERM`; this result is not a passing baseline.
- Initial implemented store checkpoint: `pnpm vitest run packages/daemon/test/execution-store.test.ts` passed, 6/6 tests, with escalated process access.
- Final targeted regression command: passed, 4/4 files and 44/44 tests. Reported duration was 912.94 seconds including the shared-lock wait; do not treat that as isolated test execution time.
- `ted checks`: passed, Typecheck and Lint.

## Review

Manual code and security review checked assignment atomicity, idempotency, persistence before local starts, legacy pinning and deletion. Identifiers are not credentials, no assignment mutation route was added, and no remote paths, listeners or authentication changes were introduced. The assignment receipt is stored once, in the immutable assignment record. The Workflow’s Validate review remains separate from this Work-stage review.

## Merge and review checkpoint

Fetched base: `20b46312b54313550f6f71af219aab607eb69e21`. The merge retains Task history, side chats, command-launch consent and Stage effort selection.

The independent reviewer found that sub-agents of an already-live legacy Task Lead could start before an explicit assignment was persisted. The fix adds the same Tasks-owned persistence barrier before sub-agent worktree preparation and launch, with cancellation checks after the await. `sub-agent-execution.test.ts` exercises a legacy Task through TedStore and SubAgents, observes the assignment on disk before both side effects, and prevents both when persistence fails.

Post-merge commands and results:

- `pnpm typecheck`: passed.
- `ted checks`: passed Typecheck and Lint after the merge and again after the sub-agent fix.
- `pnpm vitest run packages/daemon/test/execution-store.test.ts packages/daemon/test/execution.test.ts packages/daemon/test/store.test.ts packages/daemon/test/tasks.test.ts packages/daemon/test/task-lead.test.ts packages/daemon/test/side-chats.test.ts`: 75 passed, 3 failed; 5 files passed and the Tasks file failed.
- Untouched base snapshot, `pnpm vitest run packages/daemon/test/tasks.test.ts`: 15 passed, 2 failed. The same primary case, “a Task with no .ted/ runs every default Stage in order to Done”, failed in its `afterEach` with `Hook timed out in 10000ms`. The following Library-edit case also failed after its temporary repo/store folders were removed. The branch’s following Library-edit and Factory Workflow cases had missing-folder errors. Keep this baseline cleanup failure visible; it is not a pass.
- `pnpm vitest run packages/daemon/test/sub-agent-execution.test.ts packages/daemon/test/sub-agents.test.ts packages/daemon/test/execution-store.test.ts packages/daemon/test/execution.test.ts`: passed, 4 files / 31 tests, including both legacy sub-agent barrier cases.
- `pnpm vitest run packages/daemon/test/tasks.test.ts -t 'a Library edit changes|the Factory’s .ted/'`: passed, 2 tests / 15 skipped. The two downstream cases pass without the preceding baseline cleanup timeout.

The base snapshot is an untouched archive in `dist/ted-97-base`, with snapshot-local `@ted` workspace links; dependencies are reused, but source imports resolve to that base snapshot.

Isolated manual verification used `node_modules/.cache/ted-home`, stub agents/GitHub/keyring and offline status. CLI output:

```text
Created DEV-1  Ownership validation
DEV-1  Backlog  Ownership validation
```

Direct Tasks execution interface output, on that same isolated Task:

```text
Local assignment generation: 1
Identity and assignment survive reopen: true
Conflicting assignment: rejected (409)
```

No agent Run or App was started. The isolated daemon and its hosts were stopped. An initial CLI start with a 1000 ms idle override stopped during startup; the 60000 ms retry listed the persisted Task successfully.

The same configured reviewer confirmed the original Finding is resolved and reported no remaining blocking Finding. Its follow-up typecheck and focused lint passed; its own test attempt hit sandbox cleanup restrictions and its escalated rerun was canceled while waiting for a lock, so those attempts are not counted as regression passes. The Lead’s escalated four-file run completed all 31 tests successfully.

## Latest-base merge checkpoint

Commit `29eef47040008de338fcce0babfe25099bfdb787` merges fetched base `eab2dc9a8ac209d96426e654d3aca739e9103117` into `30718370`. The latest base merged cleanly; it adds typed app daemon request forwarding. The ownership implementation and regression tests are unchanged. The diff against the new base remains the same 14 ownership, documentation and test files, without app or `.ted/` changes.

After TED-46 explicitly released its quiet-window hold:

- `pnpm vitest run packages/daemon/test/sub-agent-execution.test.ts packages/daemon/test/sub-agents.test.ts packages/daemon/test/execution-store.test.ts packages/daemon/test/execution.test.ts`: passed, 4 files / 31 tests, reported duration 79.35 seconds including the initial shared-slot wait. No lock was bypassed.
- `ted checks`: passed Typecheck and Lint.
- The same configured reviewer checked only the earlier Finding and merge regressions: no blocking Findings. It confirmed the persistence barrier, subsequent cancellation/lifecycle checks and regression tests remain intact. It ran no additional tests or Checks.

The earlier broad-run baseline failure and manual CLI startup note remain historical notes, not new failures in this rerun. No network execution, real-Mac validation or new UI behavior is claimed.
