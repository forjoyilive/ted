# Task interval history

`TedStore.taskIntervalHistory(taskId, asOf?)` is the store boundary for later Flow aggregation. It reports half-open wall-clock intervals, their contributing entities and boundary sources, coverage for each reason, and explicit Task lifecycle boundaries. Different reasons may overlap. Contributors within one reason are unioned, so concurrent Runs or unanswered requests do not multiply wall time. `run-working` means observed agent state, not productive effort.

The query reads indexed materialized state and Task history. It never reads Run output or Conversations. New materialization of shipped events preserves the event definitions and supports replay after old output events have been compacted.

## Boundary map

- Requests use the durable Comment creation and answer/withdrawal timestamps. An unanswered request ends at a Task stop, archive or Done boundary, even if the Task later resumes. A query boundary means the request is still open as of that time.
- Stopped time uses TaskStopped through TaskResumed, TaskRetried, TaskUnarchived or an archive/Done boundary.
- Blockers use the durable blocker relationship and the blocking Task’s completion history. Completion shares the current status predicate: Done and every numbered pull request merged. Archiving a blocker does not establish that its work merged.
- Run working uses RunStarted, RunStateChanged, RunRevived, RunRestarted and RunProblemFound. Only periods with observation coverage count as observed working.
- Run-slot queues use durable Task queue/dequeue and sub-agent request/start/drop boundaries. Their primary queued duration remains known where these events establish it; old hold detail may be absent. Effective queue contributors and load/disk holds come from TaskFacts and are recorded only when they change. Queue positions are not interval transitions.
- GitHub waits reuse PullRequestWaitChanged and merge/close/removal boundaries. Agent pauses reuse AgentPaused/AgentResumed, Run lifetimes, held Run and queue attribution. These selectors share TaskFacts, pause attribution and completion predicates with current status. Separate contributors preserve overlapping pauses of the Task Lead, sub-agents and pending sub-agents.
- Report reads select request metadata rather than Comment bodies or attachments. Request creation event order resolves lifecycle events with equal timestamps.

## Recording and recovery

Recording sessions identify the periods when the daemon can observe volatile state. A clean shutdown records an end. Following an unexpected shutdown, the last recorded interval observation is a conservative cutoff: the remainder through the next recording session is unknown. There is no heartbeat and no guessed shutdown timestamp. Old homes have unknown coverage for Run working, GitHub and agent pause observation periods that were not recorded reliably. Durable requests, stopped time, blockers and primary queue durations remain available. Known queue history attributes waiting to explicit queue events, never to a restart itself.

Recovery must catch up the host log and verify the host is still live before reconciling a saved Run state. Saved working state alone does not start another observed working interval. Requests and durable lifecycle relationships can remain established across downtime because their ends are explicit user/workflow actions.

Four new event types fill recording gaps: v1.IntervalObservationStarted, v1.IntervalObservationEnded, v1.TaskWaitObserved (effective queue/hold contributors) and v1.RunStateObserved (one recovery reconciliation). Shipped event schemas are unchanged. Selected durable sources materialize into intervalBoundaries, indexed by subject and sequence; no Run output batch becomes an interval transition.

The asOf argument is a canonical UTC ISO timestamp no later than now. A query before Task creation returns no spans. A query never projects the current state into future time.

Coverage is separate from the intervals: an absent interval means a known absence only where that reason’s coverage is known. A future Flow view must preserve unknown coverage rather than treat it as zero or as another wait reason.

## Validation

Typecheck and lint pass. The public store fixture has 13 passing tests; the daemon recovery integration and all 14 retention tests pass. The required `pnpm vitest run packages/daemon/test packages/protocol/test` completed with 167/169 files and 1935/1938 tests passing. Its only three failures were assertions in the existing data/compaction fixtures described below. New interval, recovery and retention tests passed in that run. The focused `pnpm vitest run packages/daemon/test/data.test.ts packages/daemon/test/compact.test.ts` rerun passed both files and all 17 tests on b499cb89. Production code was unchanged between that broad run and the focused storage-fixture repair; later main integration is recorded below. Together these results cover the required daemon/protocol scope; no test failure was accepted or waived.

The recovery integration uses a real isolated daemon process and a stub Task Lead host, kills the daemon mid-turn, restarts it, and then queries the store through its public interface. It fails with the host reconciliation hook removed and passes with it restored. This setup differs from the existing dev-Run recovery fixture because Task attribution and the Task interval query are under test; it launches one agent host. The existing retention test is extended rather than adding another daemon launch.

Manual security review found no new route, token permission, child command, credential or filesystem authority. The host follower checks its existing lock after catching up; reconciliation only records the Run’s state. Materialized source payloads omit prompts, commands, permission inputs and Comment bodies.

## Broad verification findings

The first required run found three test assumptions invalidated by appending recording events: the failed-rebuild fixture corrupted whichever event happened to be last but expected a TaskRanked error, and two compaction fixtures expected the entire SQLite file/log to remain identical after a daemon restart. The migration fixture now targets TaskRanked explicitly. Compaction assertions compare every column of all pre-existing events and allow only the new recording events after that prefix; the compaction byte count is captured before store startup appends its events. This preserves the checks that shipped events are unchanged. No production change was needed. Original run log: /tmp/ted156-daemon-protocol.log; repair run log: /tmp/ted156-data-compaction-repair.log. All 17 tests in those two files passed after the fixture repairs. The original failures remain recorded here; they were repaired and verified, rather than accepted or waived.

## Required main integration

Ted’s Work advancement required merging main at 0c4d214386fa5980432042675b79e5fd895abf81. The only textual conflict was Task mapping in store/index.ts: preserve main’s preparation field and this Task’s observation callback and optional observe parameter. Other original handler writes, including Check timing materialization, remain intact under withIntervalBoundaries.

Main introduced v1.TaskResumedOvernight. The interval reducer now recognizes it as an explicit stopped-time end, lifecycle resume and durable queue entry. A public-store fixture covers a preparation stop released overnight. Typecheck and lint pass after integration. The merged Factory rules now say “Don’t run test files in Work” (.ted/stages/work.md); the new fixture and merged source must be tested in Validate. The recommended three-file command covers task-intervals-store.test.ts, task-interval-recovery.test.ts and retention.test.ts. Remaining affected files include status.test.ts, store.test.ts, runs.test.ts, run-output.test.ts, preparation.test.ts, data.test.ts and compact.test.ts; pre-merge verification is preserved above.

## First Validate and pause repair

The first Validate visit reviewed commit 5cf53319. Its one permitted batch passed all 29 tests across task-intervals-store.test.ts, task-interval-recovery.test.ts and retention.test.ts. Independent reviewer aed1e751-ca00-488a-8d36-051d4417d44f identified two blocking P2 cases absent from those fixtures: observation-window clipping discarded pauses reconstructible from durable queue/hold history in older homes, and recovered Run-dependent pauses were labelled known before host catch-up. Validate returned the Task to Work; those Findings remain part of the failure history, not accepted failures. The manual public-store trial and manual security review passed, with no new authority introduced.

The repair retains an internal attribution basis for pause contributors. Queue, held-launch and pending sub-agent attribution remains durable independently of observation sessions. Run attribution requires observation coverage and excludes that specific Run’s unreconciled recovery prefix. A reconciliation or state transition supplies the new start provenance. A contributor changing from pending to live splits at that transition even if its pause reason is unchanged. Per-reason coverage marks durable positive pause spans known; other unverified Run-dependent periods remain unknown. Shared TaskFacts pause selection still owns the reason decision. No protocol or shipped event changes were needed.

Three public-store fixtures now cover old-home queue-to-hold pause history and replay, a paused Run that ended during downtime, and a surviving paused Run confirmed after recovery. These fixtures have not run in Work under the current Stage rules. The next Validate batch should run the same three riskiest files; the earlier 29-test result does not establish the repair’s correctness.

## Second main integration

PR #153 reported another base conflict while the Task was already in Work. Commit 37b71b89 merges main f19ef0a8 and preserves both interval imports and the new test-invocation reporting store imports. Reporting owner-end writes remain inside the original schema handlers under withIntervalBoundaries. No reporting behavior was changed to resolve the conflict.

Main added renderer dependencies that were absent locally. The initial post-merge typecheck reported missing react-markdown and remark-gfm modules. A noninteractive `CI=1 pnpm install --frozen-lockfile` restored the locked dependencies, after which Typecheck and Lint passed on the merge. This was a dependency refresh, with no lockfile change. Repair verification is recorded in the Task brief and next Validate result.
