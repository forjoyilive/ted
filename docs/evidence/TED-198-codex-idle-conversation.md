# Codex Conversation before the first turn

## Result and limits

The main-path integration test treated any idle state as completion of its first turn. The stub reports idle when it opens the thread, before that turn starts. The test now holds turn start with the stub’s existing file gate, observes that earlier idle state with no assistant messages, and requires a `turn/completed` event in the Conversation as well as idle before checking the result.

This is a source-supported synchronization defect with deterministic integration coverage prepared in Work. Runtime verification is reserved for Validate by this Factory. No test was run in Work, and this report does not claim a passing regression or a proven cause of the historical full-Check failure. Validate’s results belong in the Task’s thread and brief.

Source: [KRI-333 and discussion](https://linear.app/kriyadesign/issue/KRI-333/diagnose-an-empty-codex-conversation-after-the-run-becomes-idle). The imported report records an empty assistant-text list on clean commit `c0594f81851e15c8d68faf96da8d0b1a164d8d7c`, followed by an unchanged passing full Check. The supplied archive path, `/Users/nabhacosley/.ted/worktrees/TED-46/ted/.suite-measurements/series-2-baseline-1/`, was absent when inspected. Its underlying Run log and state sequence have not been examined, so the historical failure remains unattributed. TED-46’s branch was not changed.

## Boundaries inspected

- `test/fixtures/stub-codex.ts`: `openThread` replies with the thread ID, emits `thread/started`, then emits `thread/status/changed` with `idle`. The existing `turnStartWaitFor` setting holds the later `turn/start` request before emitting any turn or assistant events. The normal turn sends its messages before `turn/completed` and idle.
- `src/agents/codex-driver.ts`: the driver awaits the thread response before sending the first `turn/start`. Thread creation and turn completion are separate protocol boundaries.
- `src/agents/codex.ts`: `stateFrom` maps both a thread’s idle status and `turn/completed` to idle. An idle state alone cannot identify completion of the requested turn. This matches ADR 0018.
- `src/runs/run-manager.ts`: `commitBatch` derives state from each batch and passes its byte offset to `store.recordRunOutput` with the state.
- `src/store/index.ts`: a changed state and the read offset commit together. Batches with no derived changes hold the newer offset in memory, as ADR 0120 describes.
- `src/routes/runs.ts` and `src/runs/run-output.ts`: the GET returns the Run and its Conversation synchronously; output is read through the store’s current read offset, as ADR 0097 describes.

Paths above are relative to `packages/daemon/`. These reads identify the earlier idle state without establishing that the other failure modes are impossible.

## Predictions for focused verification

The candidate explanations, ranked by the inspected code, are:

1. **The test observes thread-opening idle.** Holding the first `turn/start` must let the original idle-only predicate return an empty assistant-text list. The repaired completion predicate must reject that same response. Releasing the gate must allow completion and the exact ordered messages on the same thread.
2. **Output visibility lags completed-turn idle.** After a completion event is visible through the Conversation boundary, preceding assistant items could still be absent. The repaired test asserts their exact values on that response; it does not keep polling for the expected text to appear.
3. **Output is lost.** Missing or reordered assistant items at completion must fail the original exact output assertion. If that happens, inspect the corresponding host log and read offset before selecting a product repair.

## Regression and repair

The existing main-path test in `packages/daemon/test/codex.test.ts` is extended rather than adding another daemon/Run setup. It uses `turnStartWaitFor`, already supported by the stub, to make the thread-opening idle state observable independently of scheduling. It asserts that this response has no assistant texts, already has the thread/session ID, and is rejected by the same completion predicate used by its final wait. Replacing that predicate with the old idle-only condition makes this rejection assertion fail.

After releasing the file gate, the test waits for idle plus a raw `turn/completed` event in the Conversation. It then immediately asserts exactly `['hello', 'world']`, the original thread-ID format and the unchanged session ID. The original restart, isolated Codex home and continued-thread assertions remain. No expected-output condition was added to the final polling predicate, so lost or reordered output at completion still fails rather than being hidden by a later read.

Only the test and this report change. No production state mapping, host format, output storage, timeout, retry, worker cap or stub implementation changes. The existing stub’s gate polling is an explicit release barrier, not an added fixed delay.

## Verification handoff

Validate should run `pnpm vitest run packages/daemon/test/codex.test.ts` once for the visit and record its result. This exercises the early idle response, completed-turn output, session ID, restart and the rest of the existing Codex integration file. Typecheck and Lint are the Factory’s hand-off Checks. No manual Checks ran in Work.

A later user-run full Check is still needed to establish behavior under the original shared-machine workload. A focused pass cannot prove that the unavailable historical trace had this cause or exclude a separate output-loss defect. If the final exact-output assertion fails, retain that failure and investigate the completed-turn trace rather than weakening the barrier or output assertions.
