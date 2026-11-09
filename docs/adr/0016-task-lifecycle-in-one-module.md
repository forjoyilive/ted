# A Task’s Stage changes go through one Tasks module, which orders their side effects

`packages/daemon/src/tasks/tasks.ts` is the only code that starts a Task or moves it between Stages. Routes call it; they don’t commit Task events or run git themselves. It owns the order of the side effects around each commit:

- **Start:** fetch the clone, pick the branch, add the worktree from `origin/<default branch>`, commit `v1.TaskStarted`, then start the Task Lead Run. A git failure leaves the Task in Backlog.
- **Done:** commit `v1.TaskStageChanged` to `done` and answer the request, then stop the Task Lead’s Run, then remove the worktree. The request usually comes from inside that Run, so the answer goes back before the Run is stopped.

A Run belongs to a Task through `taskId` on `v2.RunStarted`; `v1.RunStarted` keeps its materializer with no Task (ADR 0010). The Task Lead is the latest Run on the Task, shown as `leadRunId`. A route open to Runs (ADR 0015) asks the module for the Run’s own Task and gets 403 for any other. Reporting an outcome also checks that the Run is the Task Lead (spec 7.1).

`TED_TASK` holds the Task’s display ID, such as `NB-1`, because that is what a human types after `--task`. Routes take either the display ID or the internal ID.

Until KRI-124, Tasks created without `--factory` still go to the `dev` placeholder Factory (ADR 0010). They have no repo and can’t be started.

## Considered Options

- **Each route runs its own git commands and commits.** Rejected: queueing, Stop, Resume and Merge all add steps to the same sequences, and the order has to live in one place.
- **Stop the Run before answering `ted outcome advance`.** Rejected: the `ted` process inside the Run may die with it, so the agent sees a failed command for an outcome that was recorded.

## Consequences

- A daemon that dies between committing Done and removing the worktree leaves the worktree on disk. Restart cleanup is later work.
- A daemon that dies between `v1.TaskStarted` and starting the Run leaves the Task in Work with no Run. Failed Runs (spec 7.6) will cover this.
- `runs.stop` sends SIGTERM to the host, which passes it to the agent, and sends SIGKILL to both after 10 seconds.
