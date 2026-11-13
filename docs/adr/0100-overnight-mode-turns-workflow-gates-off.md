# Overnight mode turns Workflow Gates off

**Updated by KRI-362:** Grilling depth no longer forces Clarify sign-off. Clarify follows its effective Workflow or Task sign-off setting at every depth, including overnight mode. Explicit forced Gates and setup Tasks’ Design and Review Gates remain required.

Overnight mode started Backlog Tasks in every Factory and told each Task Lead to stop at its Gates. The human wanted Tasks to run through on their own, and got that only by editing `workflow.yaml` to turn Gates off at night and back on in the morning. Overnight mode now does it: while `overnightMode` is on, a Gate set by the Workflow (TED’s defaults, the Library, the Factory) or by a per-Task override counts as off. Nothing saved changes; the Workflow files and `gateOverrides` stay as they are.

## Where it is decided

`Tasks.taskWorkflow` applies `withoutGates` after the per-Task overrides and before `withForcedGates` and `setupWorkflow`, and lists the Stages it turned off in `ResolvedWorkflow.overnightGates`. Every Gate check reads that Workflow through `gateOn` in `tasks/tasks.ts`: `ted outcome advance` for Intake to Review, and `mergeMode` for the Merge Gate. The Stage prompt reads the same Workflow, so it no longer tells the Task Lead the Stage has a Gate.

The Gate is decided when the Task Lead reports `advance`, not at Stage entry. A Task already in Design when the mode turns on passes without sign-off; a Task in Design when the mode turns off gets its Gate back. Merge is decided when TED starts merging: a Task that enters Merge, or is waiting there with no sign-off posted, while the mode is on starts merging, and stays merging if the mode is turned off before CI passes. The human can still cancel that merge with a Comment.

## What stays on

- Gates TED forces: `forcedGates` on a Task (Review on a Task that changes `.ted/`), and a setup Task’s Design and Review Gates. They are applied after `withoutGates`, so overnight mode cannot reach them. Clarify’s Gate is an ordinary Workflow Gate at every depth, grilling included, so overnight mode turns it off.
- A Gate whose request was already posted in this visit of the Stage, answered or not. An open request stays open and the Task waits; `ted outcome advance` is refused as before. Turning the mode on is not an approval, the same rule ADR 0095 uses for editing a Task’s Gates.
- Everything that is not a Gate: questions and Clarify rounds, permission prompts, the Bypass confirmation, the sandbox, send-back limits, the size check, Validate’s Checks and reviewer, and the merge watcher’s own conditions (CI passed, mergeable, signed-off commit unchanged, required reviews).

Setup Tasks are still never started automatically.

## A Task that changes `.ted/`

Overnight mode must never make a Task that changes `.ted/` less protected than it is with the mode off. A Task Lead that edits `.ted/workflow.yaml`, for example to turn on `permissions: bypass` or drop a Check, would otherwise merge it with nobody looking. So while the mode is on, a Task whose working changes in the Factory’s primary repo touch a path under `.ted/` keeps its Gates exactly as saved (`withoutGates` is not applied), and its Review Gate counts as on, as `forcedGates: ['review']` would make it, even when the saved Workflow has no Review Stage or no Gate.

It is decided where a Gate is decided, not in every `taskWorkflow` call, because reading changes needs git. `gateWorkflow` in `tasks/tasks.ts` wraps `taskWorkflow` for `ted outcome advance`, the approve answer, Validate’s “move on” answer, Merge entry in `move` and the merge watcher’s cycle. It asks `settingsGuard`, which reads the primary repo’s worktree through `git.changedFiles` (`workingChanges`) against the same `origin/<base branch>` the Checks use and applies `touchesSettings` from `tasks/checks.ts`, the one definition the TED settings Check also uses. Committed and uncommitted changes both count. If the changes can’t be read (no worktree, a git error), the Task is treated as changing settings. At Merge the check also reads the files changed by the primary repo’s signed-off commit, the one that merges, when it differs from the worktree’s HEAD. The answer is kept in memory under the Merge visit, the worktree’s HEAD, the signed-off commit and a fingerprint of the worktree’s `.ted/` folder (each entry’s size, modified time and inode, read with `lstat`, never following links). The watcher reads only HEAD and that folder on each poll, and a new commit or an uncommitted `.ted/` edit forces a fresh read. It runs at Merge entry, at the start of each watcher cycle and again before each merge call.

At Merge there is one more check for such a Task, and it is bound to content. When the human approves a Review or Merge Gate, TED records a `v1.GateApprovalBound` event with the primary repo’s commit: for a Review Gate the commit the request was posted for (`v1.GateRequestedFor`, the worktree’s HEAD when the Task Lead ran `ted outcome advance`), and only when the worktree’s HEAD is still that commit and it has no uncommitted changes at approval; for the Merge sign-off the pull request’s signed-off commit. TED starts merging only if an approval made since the Task last entered a Stage before Review is bound to the commit that is signed off now, and, for a Review approval, the worktree’s HEAD is still that commit. Otherwise it posts the Merge sign-off once CI passes, whatever path brought the Task to Merge, and that check comes before the “merge already started overnight” shortcut. So a commit made after the approval, or an approval given while the worktree differed from what was pushed, leads to a new sign-off; what merges is still only the signed-off commit, which the merge watcher already compares with the pull request’s head. After TED adopts its own rebase the signed-off commit changes, so such a Task is asked again.

Whenever the merge watcher finds a Task waiting for the Merge sign-off, it first turns off any GitHub auto-merge TED enabled on its pull requests, and waits while GitHub refuses; auto-merge is enabled only while TED itself would merge. When the check before a merge call finds that sign-off is now needed, the watcher runs another cycle, which posts the request.

A Gate kept this way is one `v1.GateKeptOvernight` event (Task, Stage, reason), shown as “Overnight mode is on, but this Task changes .ted/, so its Review Gate stays on”, or “… but TED couldn’t read this Task’s changes, …”. `GET /tasks/:id/gates` runs the same check: for such a Task no row carries `overnight`, and the Review row is `required` with the reason as its lock. The Factory settings, Library and Board rows are per Factory and still carry `overnight: true`.

Turning the mode off removes the forced Review Gate for later decisions; a Review request already posted stays, like any other.

## What is recorded and shown

Each skipped Gate is one `v1.GateSkippedOvernight` event (Task, Stage), shown in the thread as “Overnight mode is on, so TED skipped the Design Gate”. For Merge the same event is what keeps the merge going after the mode is turned off. `GET /tasks/:id/gates` keeps `inherited` and `override` as saved, sets `effective: false` and adds `overnight: true` on each row the mode turns off. Factory settings, Library and Board Stage rows keep `gate` as saved and add `overnight: true` when the mode is on and the Gate is on.

## Alternatives

Recording the decision at Stage entry was rejected: a Task already in a Stage when the human turns the mode on at bedtime would still stop at that Stage’s Gate. Approving open Gate requests when the mode turns on was rejected because a setting would then act as an answer. Skipping Clarify or turning off its questions was left out: a blocking question still goes to the Inbox, and the Task Lead ends its turn so another Task can use the slot.
