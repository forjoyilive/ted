# A Task Lead can create Tasks

ADR 0070 let only an Automation Run use `ted task create` with a Run token. A Task Lead that found follow-up work, such as a bug it noticed or a piece outside its Task’s scope, had to hand the user a title and description to paste into the app (TED-419).

**The current Task Lead of an open Task may now create Tasks.** `leadCreator` in `tasks/tasks.ts` accepts a Run caller that is not an Automation firing only when it is its Task’s current Task Lead Run (`taskLead`) and the Task is neither archived nor Done. Sub-agents, other Tasks’ Runs, Coordinator, planning and side-chat Runs keep the old refusal.

- **Narrow by default.** The Task lands in Backlog in the Task Lead’s own Factory. `--start`, a `--factory` naming another Factory and blockers are refused. A `--follow-up` stays in Backlog instead of starting on its own. An Asana URL as `--source` makes one Task with a link: no subtree import and no Asana Task Sync, because the Task keeps only the URL. A GitHub issue source imports no sub-issues. Files must be ones the Run uploaded for its Task or that its Task already has (`checkOwnFiles`), the same rule as its Comments.
- **Never started by TED.** `backlogEligible` leaves `createdBy: 'task-lead'` Tasks out of a Factory’s Start Backlog Tasks automatically, so the user starts each one. Otherwise, with Autopilot on, every new Task’s Lead could create more Tasks with no person involved.
- **Checked again before the save.** `requireSameCreator` repeats the caller check right before `store.createTask`, in `createTask` and `createFollowUp`, so a Task archived, finished or given a new Task Lead while TED fetched a source creates nothing.
- **3 suggested, 10 at most per Task** (`suggestedTasksPerLead`, `maxTasksPerLead`). From the 4th Task, `ted task create` still creates it and prints a reminder with the count and the advice to suggest a planning chat or Split it to the user. The 11th is refused with the same advice. A hard refusal at 3 made the user create the Task by hand for work the Task Lead had already written up (TED-526); the cap of 10 still stops a looping Task Lead from filling the Backlog.
- **Recorded on both Tasks.** `v1.TaskCreatedByTaskLead` (on the new Task) and `v1.TaskLeadCreatedTask` (on the creating Task) are committed in the new Task’s own `store.createTask` commit. They set `createdByTask` and `createdByRun` on the new Task’s row, which gives `createdBy: 'task-lead'` and the count for the limit, and each writes a thread line.
- **`--child`.** The new Task becomes a child of the creating Task at any Stage. `safeParent` still refuses to add children to a Task with a live Run from the app; this path skips it because the parent is the caller’s own Task. A child link doesn’t normally stop a Task Lead, so `shouldStopForBlockers` also counts an unmerged child that the Run created. When the turn ends, TED stops the Run and the Task waits for blockers, as with `ted task block --by`. When the child merges, a fresh Task Lead starts from the brief. The child waits in Backlog until the user starts it.
- **Autopilot** treats these Tasks like the user’s own: `unvettedReason` keeps Gates only for Automation-created Tasks and outsider GitHub text, as before.
- The preamble tells the Task Lead when to use `ted task create` and to post a note naming the new Task.

## Considered Options

- Reusing the app’s `parent` field for `--child`: `safeParent` refuses a parent with a live Run, and loosening it would change the app’s rule too.
- Reusing `v1.TaskCreatedByCoordinator` or `v1.AutomationTaskCreated`: both would misreport who acted.
- No limit: the user expects one or two Tasks per Task, and more than that is a sign the work needs planning. A looping Task Lead could also fill the Backlog.
- A hard limit of 3 (the first version): it cost the user a manual round trip whenever a Task really needed a 4th Task.
