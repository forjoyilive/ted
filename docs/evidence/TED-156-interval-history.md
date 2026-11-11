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

Recording sessions identify the periods when the daemon can observe volatile state. A clean shutdown records an end. Following an unexpected shutdown, the last meaningful recorded observation is a conservative cutoff: the remainder through the next recording session is unknown. There is no heartbeat and no guessed shutdown timestamp. Old homes have unknown coverage for Run working, GitHub and agent pause observation periods that were not recorded reliably. Durable requests, stopped time, blockers and primary queue durations remain available. Known queue history attributes waiting to explicit queue events, never to a restart itself.

Recovery must catch up the host log and verify the host is still live before reconciling a saved Run state. Saved working state alone does not start another observed working interval. Requests and durable lifecycle relationships can remain established across downtime because their ends are explicit user/workflow actions.

Four new event types fill recording gaps: v1.IntervalObservationStarted, v1.IntervalObservationEnded, v1.TaskWaitObserved (effective queue/hold contributors) and v1.RunStateObserved (one recovery reconciliation). Shipped event schemas are unchanged. Selected durable sources materialize into intervalBoundaries, indexed by subject and sequence; no Run output batch becomes an interval transition.

The asOf argument is a canonical UTC ISO timestamp no later than now. A query before Task creation returns no spans. A query never projects the current state into future time.

Coverage is separate from the intervals: an absent interval means a known absence only where that reason’s coverage is known. A future Flow view must preserve unknown coverage rather than treat it as zero or as another wait reason.

## Validation

Typecheck and lint pass. The public store fixture has 13 passing tests; the daemon recovery integration and all 14 retention tests pass. The required full daemon/protocol run is queued behind other Tasks’ verification. Its final counts and any failures will be recorded before Work is handed off.

The recovery integration uses a real isolated daemon process and a stub Task Lead host, kills the daemon mid-turn, restarts it, and then queries the store through its public interface. It fails with the host reconciliation hook removed and passes with it restored. This setup differs from the existing dev-Run recovery fixture because Task attribution and the Task interval query are under test; it launches one agent host. The existing retention test is extended rather than adding another daemon launch.

Manual security review found no new route, token permission, child command, credential or filesystem authority. The host follower checks its existing lock after catching up; reconciliation only records the Run’s state. Materialized source payloads omit prompts, commands, permission inputs and Comment bodies.
