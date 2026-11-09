# Sub-agents are Runs with a parent, started through the Tasks module’s queue

A Task Lead starts a sub-agent with `ted run start`, waits for it with `ted run wait`, sends it follow-ups with `ted run send` and stops it with `ted run stop`. The CLI reads the prompt file and sends its text, so the daemon never opens a path an agent names. The routes are `POST /tasks/:id/sub-agents`, `GET /sub-agents/:id/wait`, `POST /sub-agents/:id/messages` and `POST /sub-agents/:id/stop`. They are open to Run tokens, and only the Task’s current Task Lead Run may use them, on sub-agents it started itself.

**A sub-agent is a Run with a parent.** `v4.RunStarted` adds `parentRunId` and `name` to a Run. A Task’s Task Lead Run is its newest Run with no parent, so starting a sub-agent never changes which Run gets the human’s Comments, Gate answers or outcome checks. The name is `--name`, else the prompt file’s first heading, else “Sub-agent”. Agent, model and effort left out come from the Task’s Task Lead field; model and effort are copied only when the agent is the same kind.

**Requests go through the queue.** `v1.SubAgentRequested` records the request with the Run ID it will have, so `ted run start` can print the ID before the Run exists, and `ted run wait` works on a request still waiting for a slot. The request is a `sub-agent` entry in the pump’s queue (ADR 0030), second in order after the setup Task, and `v4.RunStarted` for that ID removes it. `v1.SubAgentRequestDropped` removes a request whose Task Lead Run ended, whose Task finished or was archived, or that the Task Lead stopped. A sub-agent being started holds a slot like a starting Task. The code is in `packages/daemon/src/tasks/sub-agents.ts`; `tasks.ts` wires it to the pump and the slot count.

**A Task Lead waiting on its sub-agents holds no slot.** While a `ted run wait` request is open, the store marks the Task Lead Run `onSubAgents` (in memory, not an event). The slot count leaves it out, its Run icon has a grey ring, and its row reads “on sub-agents”; the Task still shows Working because the Run’s state is still working. The mark lasts one second after a wait returns, so the CLI’s next poll (each wait returns after at most 25 s) doesn’t flicker the count.

**Ending.** `ted run wait` returns when the sub-agent finishes a turn (idle), or its Run ends. After `ted run send`, it waits for a turn end in output read after the send. A sub-agent Run that ends without anyone stopping it gets `v1.RunFailed` with the host’s last error lines; `ted run wait` prints the last message, says it failed and exits 1, and a Task Lead not waiting at that moment gets a message saying so. No Inbox item is posted. A sub-agent stopped by the human, the Task Lead or TED ends as stopped.

**Sub-agents post only notes.** `ted comment` from a sub-agent may not carry choices or supersede a request; outcomes and the brief were already the Task Lead’s alone. A Task Lead may supersede only requests posted by itself or an earlier Task Lead Run on its Task, never a sub-agent’s.

**Worktrees.** A sub-agent shares the Task’s primary worktree. With `--own-worktree` it gets `worktrees/<Task ID>/sub-agents/<branch>` on a new branch `<Task branch>-<name slug>` made from the Task worktree’s `HEAD`. Finishing a Task stops all its Runs and removes those worktrees.

## Considered Options

- **Blocking `ted run start` until a slot is free.** The Task Lead’s tool call would hang with no ID, and the Task Lead would hold its slot while it waited.
- **Keeping requests in memory.** A daemon restart would lose them while the Task Lead’s `ted run wait` was still polling for them.
- **One long wait request.** Long polls of 25 s keep each request well under the client’s idle timeout and let `ted` ride out a daemon restart.

## Consequences

- The Runs section and Run icons read `role`, `name`, `parentRunId` and `onSubAgents` from `TaskRun` and `RunSummary`.
- Planning and Automation Runs can reuse the queue entry pattern.
- A failed sub-agent shows red in the Runs section only after the daemon saw it end; a Run that ended while the daemon was down shows as stopped.
