# The daemon chooses a Task’s status and sends it with the Task

A Task shows one status, chosen by the precedence in spec 6.6. `taskStatus` in `packages/daemon/src/tasks/status.ts` makes that choice from a `TaskFacts` object, and `taskMarkers` and `taskActivity` derive the outline chips and the activity line from the same facts. The store builds the facts for each Task and puts `status`, `markers`, `activity`, `track` and the Task’s live `runs` on the `Task` it returns, so the app, the CLI and every `task-updated` event see the same answer. The app only draws them.

Today the facts are the Task’s Stage and its Runs’ states: a working Run makes the Task Working, and a Run waiting on a permission prompt makes it Waiting on you. Failed, Partly merged, Paused, Stopped, Blocked, Queued and the GitHub waits are already in the function and its tests. The tickets that add those inputs fill a new `TaskFacts` field; they don’t add another place that decides a status. A change of Run state on a Task emits `task-updated`.

The activity line is the agent’s text from `ted status "<text>"` (`v1.TaskActivitySet`), shown only while the Task stays in the Stage it was set in. Otherwise TED fills it in (“Not started” in Backlog, “Starts when NB-46 merges” for a blocked Task). The daemon flattens the text to one line of at most 200 characters.

Each Stage entry now records the Workflow’s order of agent Stages (`v2.TaskStageEntered`). The Stage track takes the order from the Task’s latest entry and marks each Stage past, current, skipped (before the current Stage but never entered) or future. A Task with no entries shows TED’s default order.

## Considered Options

- **Choose the status in the app from raw facts.** Rejected: the app is a thin client (ADR 0011), and the CLI, notifications and the Inbox need the same status.
- **Store the status as its own event.** Rejected: it would be a copy of facts that are already in the store and could drift from them.
- **Resolve the Workflow to draw the track.** Rejected: resolving reads git and the Library, and the Workflow may have changed since the Task last moved; the order recorded at the last Stage entry is what the Task is actually following.

## Consequences

- Every new input to a status is a new field on `TaskFacts` and a test in `packages/daemon/test/status.test.ts`.
- Older entries written as `v1.TaskStageEntered` have no order; a Task whose entries are all old shows the default order.
- The activity line clears when the Task changes Stage, so an agent sets it again in each Stage.
