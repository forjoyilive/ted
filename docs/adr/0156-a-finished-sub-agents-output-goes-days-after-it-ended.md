# A finished sub-agent’s output goes `runOutputDays` days after it ended

This amends ADR 0098.

ADR 0098 kept every Run of an open Task, sub-agents included. Sub-agents and reviewers are most Runs, and a Task can stay open for weeks, so `TED_HOME/runs` grew to 1.9 GB over 1,316 Runs, 97% of it `host.log`. Nothing reads a finished sub-agent’s output for long: a sub-agent is never revived, `ted run wait` reads its last message soon after it ends, and its tokens and cost are saved when it ends (`v1.RunUsageRecorded`, ADR 0126).

`runOutputEnd` in `packages/daemon/src/retention.ts` now starts the clock for a finished Run with a `parentRunId` at that Run’s own end time, even while its Task is open. Deletion still goes only through `pruneRunOutput`. Two cases keep the old rule (kept while the Task is open):

- **A sub-agent with a side chat** (`store.sideChats.get(runId)`), because the side chat was started from its conversation.
- **A reviewer in its own visit**: a Run in `store.reviewers` whose Task is still in the Stage visit the reviewer was chosen in (same Stage, chosen at or after that Stage’s newest entry, Task not archived). `holdsReview` and `reviewed` in `tasks/sub-agents.ts` read the reviewer’s last message from `host.log` to decide whether the visit already has a reviewer. Without it, Ted would allow a second reviewer and skip `movedSinceReview`.

The Task Lead’s Run and every other rule in ADR 0098 stay as they are.

## Considered Options

- **Save the reviewer’s last message in an event and prune every reviewer by its end time.** Saves a little more space, but adds a new event and a second reader path for one visit’s worth of output.
- **Keep reviewers until the Task closes.** Reviewers are a large share of sub-agents, so this keeps much of the space the change exists to free.

## Consequences

- A pruned sub-agent’s chat shows “Output no longer kept”, as a closed Task’s Runs already do.
- `ted run wait` on a sub-agent that ended more than `runOutputDays` days ago returns without its message.
- Once an earlier Validate visit’s reviewer output is gone, `reviewRound` can’t confirm that review finished, so the next reviewer gets a full review instead of a scoped one (ADR 0107). The review takes longer but is never skipped.
