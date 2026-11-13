# Blocked Tasks wait and wake in the Tasks module

A blocker link is a row in `taskBlockers`. `v2.TaskBlockerAdded` adds or replaces one and records which Run set it (null for the human); `v1.TaskBlockerRemoved` deletes one. The old `v1.TaskBlockerAdded` keeps its materializer. A blocker counts as merged when its Task is in Done and every pull request it opened has merged (ADR 0056-ted-merges-pull-requests-at-the-merge-stage).

**Adding a blocker** (`POST /tasks/:id/blockers`, `ted task block`) is refused when it would make a cycle; the error names the cycle, `NB-1 → NB-3 → NB-2 → NB-1`, where each Task waits for the next. Then, by the Task’s state:

- In Backlog it stays there.
- Queued with no worktree, it goes back to Backlog and is marked as meant to start (`v1.TaskStartRequestChanged`), in the same commit as the link.
- Running, the human’s new blocker is sent into the Task Lead’s Run as a message. The Task Lead either runs `ted task block --by <id>` itself, writes the Task brief and ends its turn, or posts a Comment saying why it carries on.

**Stopping mid-flow.** When the Task Lead’s Run goes idle and one of the Task’s unmerged blockers was set by that Run, TED stops the Run and records `v1.TaskWaitingForBlockers`. The Task keeps its Stage and worktree and shows Blocked (no live Run and an unmerged blocker). Stopping is keyed to the link the Run set itself, not to the message TED sent, so a message queued behind a turn that is ending can’t stop a Run before the agent has read it.

**Waking.** Each time a Task reaches Done, and once when the daemon starts, the Tasks module looks at every Task whose blockers have all merged. A Backlog Task meant to start is started through the queue. A Task waiting mid-flow is put back in the queue with `v1.TaskRequeuedAfterBlockers`; when the pump picks it, it gets a fresh Task Lead Run in its existing worktree. That Run’s prompt is the Stage prompt plus a “Picking up after a blocker” section with the latest Task brief and the Comments since it.

**Start requests.** `startRequested` (set by Start now, `--start`, or by moving a queued Task back to Backlog) decides whether a Backlog Task starts when unblocked. Starting a blocked Backlog Task by hand sets it rather than starting. Removing the last unmerged blocker by hand clears it, so the Task stays in Backlog. Starting the Task also clears it, so a Task moved back to Backlog afterwards stays there (ADR 0129).

## Considered Options

- **Stopping any idle Task Lead that has an unanswered blocker.** Needs no extra step from the agent, but races with the message TED just sent, and a Task Lead that answers in a tool call rather than a Comment would be stopped.
- **Waking from `reportOutcome` only.** Simpler, but misses Tasks reaching Done any other way, and misses wake-ups lost to a daemon restart.

## Consequences

- Removing the last blocker by hand from a Task waiting mid-flow queues a fresh Run for it, because Resume (KRI-101) doesn’t exist yet. KRI-101 may change this to leave it for the human.
- Archiving or deleting a Task that blocks others comes with the Archive ticket.
