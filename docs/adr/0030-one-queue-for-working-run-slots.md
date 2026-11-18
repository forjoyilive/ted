# One queue in the Tasks module hands out working-Run slots

Amended by ADR 0195-stage-queue-priority-and-busy-hold-skip-are-workflow-settings: among Tasks, Stage priority sorts first, then continuations before new starts, recent continuations before older ones, Task Priority and rank.

Starting a Task now only queues it. `Tasks.start` (and so `ted task start`, Start now and `S`) records `v1.TaskQueued`: the Task moves to its first Stage with a row in the `taskQueue` table and no Run or worktree. A pump in `packages/daemon/src/tasks/tasks.ts` then decides what starts. It runs after every `task-created`, `task-updated`, `run-updated` and `settings-changed` event and whenever a slot hold is released, one pass at a time. Each pass orders the queue with `queueOrder` and picks what fits with `startsNow`, both pure functions in `packages/daemon/src/tasks/queue.ts`. When a queued Task starts, `v1.TaskDequeued` is committed together with `v1.TaskStarted`. If the start fails, the Task goes back to Backlog (`v1.TaskMovedToBacklog`) with “Couldn’t start: …” as its activity line. If a slot is free when `start` is called, the request waits for the start and returns the started Task, as it did before the queue existed.

**What holds a slot.** Each working Run on a Task holds one slot. A Task whose worktree `setup` is running holds one. A Task the pump is starting holds one while its worktree is made. The pump is the only place that adds holds, so two passes can’t both give away the last slot. Waiting, idle and finished Runs don’t count. Runs with no Task (`ted dev run`) don’t count either, because they are a developer tool and have no Factory. Originally only new starts were gated: a Run that went from waiting back to working was never held back. ADR 0125 queues continuations from questions, Clarify rounds and sign-offs; permission answers retain the exception and can still take the count over the limit. One new start is let through over both limits: the first queued sub-agent of a Task whose Task Lead is waiting on its sub-agents and which holds no slot (the slot handoff, ADR 0049).

**Limits.** The machine limit is the machine setting `maxWorkingRuns`, from 1 to 99 with a default of 6. A Factory’s cap is `max_working_runs` from its resolved Workflow. The Tasks module caches the cap each time it resolves that Factory’s Workflow, so a changed cap applies from the next Task start, Stage entry or slots read that resolves it. An entry whose Factory is at its cap is skipped, and the next entry in the queue can start.

**Order.** `queueOrder` sorts by class (setup Task, sub-agent request, new Planning Run, Automation Run, Task), then by Priority for Tasks, then by rank. A new Task’s rank is one more than the highest rank in the queue, so it joins the bottom of its Priority group. Only Tasks are queued today; the other classes are in the order so that their tickets only add entries.

**Showing it.** `GET /slots` returns `RunSlots` (limit, working count, holders, the numbered queue and every Factory with a cap). The Tasks module emits `slots-changed` when that answer changes; `data.ts` forwards it with the store’s events. A queued Task’s place comes from the same order through `TaskFacts.queue`, so its status reads “Queued · 2nd”. `POST /tasks/:id/backlog` (Move to Backlog) works only on a queued Task that has never had a Run. Both routes are closed to Run tokens.

## Considered Options

- **Computing slots in the store.** The store has the Runs and the queue, but not the Factory caps (they come from Workflow resolution) or the Tasks that are partway through starting. Those live in the Tasks module, which already owns starting Tasks (ADR 0016).
- **A `queued` flag on the `tasks` row.** A separate table keeps the queue’s own fields (rank, when queued) in one place, and leaves the shipped Task events alone.
- **Counting `ted dev run` Runs.** They have no Factory, and nothing reports when they finish to the pump. Counting them could leave the queue stuck until another event.

## Consequences

- A new kind of queued work (sub-agent requests, Planning or Automation Runs) adds entries of its class to the pump’s queue and holders to the slot count; the order is already in place.
- Paused Runs and Paused Queued Tasks aren’t shown yet: agent pauses don’t exist, so the popover has no Paused group.
- Reordering the queue by hand (rank) waits for the List (KRI-98) and the Board (KRI-97). Until then, rank is the order Tasks were started.

Task Lead recovery decisions live in `tasks/lead-lifecycle.ts`; slot allocation stays in Tasks. The lifecycle offers pending revival candidates, which the pump filters for agent pauses and Task holds and selects ahead of queued Tasks. Only that selection calls `beginRevive`. Held-session and worktree setup preparation use the same lifecycle entry point while their execution and slot holds remain with Tasks. The lifecycle wakes the pump after a failure decision or health recovery; it never allocates a slot itself.
