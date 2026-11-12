# Planning chats are their own store records, queue as `planning`, and work in throwaway detached worktrees

A planning chat (spec §13) is a Run in a Factory, outside any Task. `packages/daemon/src/plans/plans.ts` owns it end to end:

- **Record.** `v1.PlanStarted` stores the Factory, the title (first line of the first message, cut at 60 characters), the first message and the planner’s agent, model and effort, resolved from `planner` (`resolveAgentChoices`) unless the human changed them in the new chat. The plan’s ID is its Run’s ID, so `store.plans.get(runId)` says whether a Run is a Planning Run. Its rounds, proposals and TED’s notes are `planRequests` rows, not Task Comments, and the Tasks it creates are `planTasks` rows, which make the Task’s `createdBy` `planning` and give it `fromPlan`.
- **Queue.** The first message queues the plan as a `planning` entry through `Tasks.addQueueSource`, after sub-agents and before Automations (ADR 0030). It holds a slot only while its Run is working with nothing open; waiting on a round or proposal, or idle, it holds none and has no time limit.
- **Checkout.** At launch each Factory repo gets a detached worktree (`git worktree add --detach`) at the freshly fetched `origin/<base_branch>` under `~/.ted/plans/<id>/<repo name>`. A one-repo Factory runs the agent inside its worktree; a multi-repo one runs it in the plan folder. The worktrees get the `copy` files and the primary repo’s `env`, never `setup`, and nothing is pushed. The worktrees and folder are removed when the plan ends (finished, stopped or failed), and again at daemon start for any ended plan whose folder is still there.
- **Requests.** The planner posts with the same commands as a Task Lead, `ted ask --round <file>` and `ted task propose --file <file>`; inside a Planning Run (`TED_PLAN` set, no `TED_TASK`) the CLI sends them to `POST /plan-runs/requests`, which only that Run’s token can use. A new proposal replaces an open one. Answers come only from the app: a round answer and Request changes go into the Run as a message; **Create N Tasks** creates the checked rows in Backlog in blocker order with `planProposal`, posts “Created N Tasks in Backlog: …”, ends the plan as Finished and stops the Run. Blocked Tasks are created with Start requested; unblocked ones start only with `startUnblocked`.
- **Ending.** Stop withdraws open requests and ends the plan as Stopped with no Tasks. A Run that dies is resumed once, then the plan is Failed. Rename, Stop and Delete are app-only.

## Considered Options

- **Store rounds and proposals as Task Comments with an empty `taskId`.** Rejected: every Comment path (Inbox, thread lines, Gates, search, unread counts) assumes a Task, and a planning chat has none. The app reuses the card parts (`RoundQuestions`, `ProposalAnswer`, `ProposalRows`) with `PlanRequest`s instead.
- **Plan in the user’s clone or a Task-style worktree with a branch.** Rejected by the spec: the user’s clone is never touched, and a planning checkout must not leave branches behind.
- **Run `setup` in planning worktrees.** Rejected by the spec: the planner only reads.

## Consequences

- Store events added: `v1.PlanStarted`, `v1.PlanRenamed`, `v1.PlanDeleted`, `v1.PlanRunBegan`, `v1.PlanRunResumeQueued`, `v1.PlanRunRevived`, `v1.PlanEnded`, `v1.PlanRequestPosted`, `v1.PlanRequestAnswered`, `v1.PlanTaskCreated`. Live updates are `plan-updated` and `plan-deleted`.
- `TaskDefaults` gains `planner`, which the new chat’s selects start from.
- Research sub-agents are the planner’s own; TED does not start sub-agent Runs for a plan yet, so the header and right pane show only the planner.
- Plan in chat from a Task (KRI-153) and the Plans list (KRI-152) build on this module.
- **Retry** (KRI-152, app-only `POST /plans/:id/retry`) is for a Failed plan only. With a Run that has a session, TED checks the repos out again at once and records `v1.PlanRetried`, which queues a resume of the same Run; with no Run, the plan goes back to queued and starts fresh. A Run with no session can’t be retried.
- **Plan more from here** (KRI-152) is `POST /plans` with `from`, allowed from a Finished or Stopped plan in the same Factory. TED writes the old chat’s first message, rounds and answers, latest proposal and created Tasks as text into `v1.PlanContinued`, next to `v1.PlanStarted`, and puts it in the planner’s instructions. Keeping the text in the event means deleting the old chat later doesn’t change the new one.
- `TED_HOME/plans/` counts as Worktrees in Settings → Storage and is kept out of Time Machine.
