# Plan in chat links a planning chat to its Task, and the Tasks module acts on the Task when the chat ends

**Plan in chat** on a size check (spec §6.10, §13.6) starts a planning chat linked to the Task. `Plans.fromTask` in `packages/daemon/src/plans/plans.ts` creates the plan with `v1.PlanStarted` and `v1.PlanStartedFromTask` in one commit: the Task’s ID, its display ID and title at that moment, and the size check Comment. The chat is named “Plan: <Task title>” and queues like any other plan. The size check is answered with the choice and the plan’s ID, and the Task Lead is told to end its turn and wait.

- **Waiting.** While a plan linked to the Task is open, the Task stays in Clarify with the activity “Planning in chat” (`planningInChat` in `TaskFacts`), and the idle nudge leaves its Task Lead alone. The thread gets “Planning in chat: <title>” from the `v1.PlanStartedFromTask` log entry, with the plan’s ID so the app links to it. A Task has at most one open linked plan.
- **Planner.** The planner’s instructions add the Task’s title, description, the Task Lead’s reason and the points a plan must settle, and say that row 1 is the Task. A proposal from a linked plan carries `firstPiece`, needs at least two rows, and row 1 can’t be blocked, as in Split it.
- **Approval.** The plan creates the other rows and hands row 1 to `Tasks.planApproved`, which narrows the Task with `v1.TaskEdited` and `v1.TaskSplit` (the same thread line as Split it), sets row 1’s Priority, records `v1.TaskPlanEnded` (approved) and tells the Task Lead to carry on with Clarify. The chat gets two TED notes: the created Tasks with the narrowing, then “Told NB-41’s Task Lead; it carries on with Clarify.”
- **Ending without approval.** Stop, failure and Delete call `Tasks.planEnded`, which records `v1.TaskPlanEnded` and tells the Task Lead to ask its size question again.
- **Task archived or deleted.** `Tasks.archive` and `Tasks.delete` call `Plans.taskGone`, which commits `v1.PlanTaskDetached`, posts a TED note in the chat and tells the planner. From then on the plan is standalone: requests are shown without `firstPiece`, so row 1 is an ordinary, unlocked row, and approval creates it as a new Task.

## Considered Options

- **Edit `v1.PlanStarted` to carry the Task.** Rejected: events are never edited, and KRI-152 builds on the same event in parallel.
- **Remove `firstPiece` from stored proposals when the Task goes.** Rejected: it would need a new event per proposal. The plan’s link decides at read time instead, and approval checks the link again.
- **Let the plans module narrow the Task itself.** Rejected: only the Tasks module changes a Task and talks to its Task Lead (ADR 0016, ADR 0063-task-edits-and-description-versions).

## Consequences

- Store events added: `v1.PlanStartedFromTask`, `v1.PlanTaskDetached`, `v1.TaskPlanEnded`. `Plan` gains `fromTask` (the Task with its Stage, status and activity, or `gone`), the answered size check gains `planId`, and `ThreadEvent` gains `planId`.
- If the Task Lead’s Run isn’t live when the chat ends, the message is not held; the narrowed description and a fresh Clarify run cover it.
