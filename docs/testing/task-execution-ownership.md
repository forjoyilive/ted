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

Manual code and security review checked assignment atomicity, idempotency, persistence before local starts, legacy pinning and deletion. Identifiers are not credentials, no assignment mutation route was added, and no remote paths, listeners or authentication changes were introduced. The assignment receipt is stored once, in the immutable assignment record. See ADR 0104 for the future disconnect and revocation contract and its explicit implementation limits. The Workflow’s Validate review remains separate from this Work-stage review.
