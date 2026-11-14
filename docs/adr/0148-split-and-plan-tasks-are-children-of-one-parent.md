# Split and plan Tasks are children of one parent, which finishes when they merge

Split it narrowed the original Task to row 1 and created the other rows as unrelated Tasks; a plan’s Create Tasks created its rows with no link between them. Nothing in All Tasks showed that a set of Tasks came from one split or one plan (TED-323). Tasks already have parent and child links, and the List already nests children, so the pieces now become children of one parent.

**Split it.** On approval, `answerProposal` (`tasks/request-answers.ts`) first stops the original’s Task Lead through `stopLeadForChildren` in `tasks/tasks.ts` (`RunManager.stop`), so a failed stop creates nothing. It then creates every checked row, row 1 included, through `createProposalTasks` with `parentId` set to the original, and `waitForChildren` records `v1.ChildTasksCreated { taskId, childIds, from: 'split' }` and makes the Task wait for its blockers in its Stage. The original keeps its title and description and is no longer narrowed (`v1.TaskSplit` is no longer written, and its thread line stays for old events). Row 1 is an ordinary row: it can be unchecked and blocked. The proposal’s stored `firstPiece` field keeps its name and now names the Task that becomes the parent.

**Plans.** `approve` in `plans/plans.ts` uses the Task the chat started from as the parent: it stops that Task’s Lead before creating the rows, and `Tasks.planApproved` then calls the same `waitForChildren` with `from: 'plan-task'`, so the Task keeps its own Created by. A chat with no linked Task first creates a parent with `store.createTask`: the plan’s title, the proposal’s summary as its description, the highest Priority among the rows, and Start requested, so it waits for its children. It records `v1.ChildTasksCreated` with `from: 'plan'`, which also makes it count as created by planning.

**Finishing.** `wakeTask` runs when a waiting Task’s last blocker merges, and `releaseParent` calls it instead of stopping such a parent when its last unfinished child is archived or detached. For a Task with a `v1.ChildTasksCreated` record and at least one merged child, it first calls `finishParent`: when every worktree has no commits beyond its base and no changes, read with `workingChanges`, or there is no worktree, TED checks open failure obligations, records `v1.ParentFinishedWithChildren`, changes the Stage to Done and runs the normal Done cleanup. Otherwise, or when a read fails, the Task carries on as before and its Task Lead starts again from the brief. A Done Task with no pull requests already counts as merged (`taskIsMerged`), so a grandparent waiting on it carries on too.

**All Tasks.** With Nest child Tasks on, `nestedRows` in `renderer/list-view.ts` takes every Task in scope besides a group’s own. A child whose parent sits in another group gets that parent, and any of its ancestors also outside the group, as a `context` row above it. `TaskList.tsx` draws those rows faded: they open the Task but can’t be selected or dragged, and they don’t count in the group’s number. Nest child Tasks stays off by default, because nesting turns off drag-to-reorder in the Manual sort.

## Considered Options

- **A series marker without a parent.** Rejected by the user: parent and child links already exist and the List already nests them.
- **Make the original the parent and keep row 1’s work in it.** Rejected: rows blocked by row 1 would block the parent that waits for them, which `setParent` refuses as a cycle.
- **Start the parent’s Task Lead when the children merge and let it decide.** Rejected as the default: it costs a Run for every series, and the user asked for the parent to complete when its children are done. It still happens when the parent has work of its own.
- **Finish every parent with no work of its own.** Rejected: a parent the user linked by hand may be meant to do joining-up work, so only parents with a `v1.ChildTasksCreated` record finish by themselves.

## Consequences

Tasks created by earlier splits and plans keep their old shape; nothing is backfilled. Archive, delete and unarchive act on the parent and every Task under it, as for any parent. Only Tasks created after this change get a parent.
