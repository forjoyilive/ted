# Parent and child Tasks

Every parent and child remains a normal Task, with its own Workflow, Task Lead and pull requests. A parent resumes integration and acceptance work after its children merge; it never becomes a grouping-only Task. This contract supplies the foundation for user controls and later external integrations.

## Relationships and scheduling

`v1.TaskParentChanged` stores a child’s parent ID, or null to unlink it. The `taskParents` table materializes the current links. Links support nesting, one parent per child and same-Factory membership. `Tasks.setParent` rejects self-links, hierarchy cycles and cycles in the combined hierarchy/manual-blocker graph. Manual blocker writes check that same combined graph.

`Task.parentId` and `Task.childIds` expose hierarchy. `Task.blockedBy` continues to mean manually added blockers. Internally, `TedStore.blockers` combines manual links with links marked `kind: 'child'`. An archived child satisfies only its hierarchy dependency; it remains unmerged and any manual blocker still applies. The store derives status and activity from the combined unfinished dependencies.

The existing queue holds parents for direct children, which in turn wait for their children. Children start independently through that same queue. A queued parent leaves the queue to wait when linked to an unfinished child. Queue selection, recovery and Stage advancement also guard against unfinished children. A child merging wakes its parent through the existing blocker wake mechanism. Removing or waiving the last dependency by hand requires an explicit start or resume.

## Read and edit interfaces

| DaemonClient method | HTTP | Result or request |
| --- | --- | --- |
| `taskHierarchy(ref)` | `GET /tasks/:ref/hierarchy` | `{ parentId, childIds, revision }` |
| `taskHierarchyPreview(ref)` | `GET /tasks/:ref/hierarchy/preview` | `{ revision, descendants: [{ id, displayId, title }] }` |
| `setTaskParent(ref, request)` | `PUT /tasks/:ref/parent` | `{ parentId: string \| null, revision }`; returns the child Task |

A revision describes the current Factory Task state, including hierarchy, manual blockers, lifecycle and Runs. Read it again after a conflict. It intentionally refuses stale edits when another Task changes; the client does not retry a decision against new state automatically. The daemon resolves Task references and owns cycle checks, parent safety, waiting and release effects. Integrations use these same daemon-owned operations rather than writing blocker rows themselves.

Both the old and new parent must be in Backlog, Queued, Stopped or waiting for blockers, without a live Run, Checks, start transition or merge underway. Otherwise the operation explains that the user must stop work first. An archived parent must be restored first. Done parents stay closed, with the explicit restoration exception below. Link edits do not stop or restart a Run.

App-authenticated requests can write hierarchy; file tokens and Task Lead Run tokens cannot. A Task Lead may read its own Task’s hierarchy and retains its existing own-Task manual-blocker authority. The Coordinator reads hierarchy in its Factory-scoped Task tools and may use:

```text
ted coordinator parent <child> <parent|none> --operation <id> --version <child-version> --hierarchy-revision <revision>
```

The Coordinator must act on the user’s request. The daemon checks its Factory scope, the child version, the hierarchy revision and the same safety rules as the app. Its durable receipt records the result and supports retrying the same operation ID. Coordinator archive/delete authority is not added.

## Archive, restore and delete

Archiving a parent archives every descendant. First read `taskHierarchyPreview`; pass its revision as `archiveTask(ref, { hierarchyRevision, closePullRequests?, blocked? })`. A parent with descendants refuses an unconfirmed or stale request. The future controls must show the affected Tasks and warn before sending this confirmation. `blocked` continues to affect manual dependents only. Archiving an unmerged child preserves its parent link and merge history while waiving its hierarchy dependency, subject to its parent’s safe-edit rules.

`unarchiveTask(ref)` restores only the selected Task. Restoring an unmerged child while retaining its parent reapplies the hierarchy dependency and requires a safe parent state. Restore an archived parent first, or stop a working parent first. `unarchiveTask(ref, { unlinkParent: true, hierarchyRevision })` explicitly unlinks and restores the child as independent work. It preserves the child’s history and may remove an archived child’s link to a Done parent without reopening that parent. It does not silently unlink a child or interrupt a working parent. A merged child creates no renewed dependency.

A parent with descendants requires a preview revision and an explicit `deleteTask` option: `children: 'delete'` deletes all descendants, while `children: 'unparent'` preserves each direct child and its subtree. Cancel sends no mutation. Deleting a child removes its parent link under the same parent-safety rules. Existing `blocked: 'keep' | 'unblock'` behavior still governs manual dependents. Whole-Factory removal may delete all Tasks without individual hierarchy confirmations. Deletion records unlink events so surviving children never retain dangling parent IDs.

Automatic Linear closure does not cascade hierarchy archives. Linked Tasks use the existing question path and the archive operation’s safety/confirmation rules. Archive Done skips parents with unarchived descendants: those need an explicit confirmed archive through the hierarchy interface. The visible warning and choices are supplied by the following user-controls Task.

## Verification

The three focused files for this change are `packages/daemon/test/blockers.test.ts`, `packages/protocol/test/task-parsers.test.ts` and `packages/protocol/test/request-parsers.test.ts`. They cover public store replay, DaemonClient/HTTP lifecycle operations, nested queue ordering, independent progress, queued-parent holds, combined cycles, cross-Factory and token refusals, Coordinator receipts and stale edits, and all request fields. Existing flat/manual-blocker tests remain in the blocker file. Test execution belongs to Validate in this Factory.
