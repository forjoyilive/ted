# Overnight mode turns Workflow Gates off

Overnight mode started Backlog Tasks in every Factory and told each Task Lead to stop at its Gates. The human wanted Tasks to run through on their own, and got that only by editing `workflow.yaml` to turn Gates off at night and back on in the morning. Overnight mode now does it: while `overnightMode` is on, a Gate set by the Workflow (TED’s defaults, the Library, the Factory) or by a per-Task override counts as off. Nothing saved changes; the Workflow files and `gateOverrides` stay as they are.

## Where it is decided

`Tasks.taskWorkflow` applies `withoutGates` after the per-Task overrides and before `withForcedGates` and `setupWorkflow`, and lists the Stages it turned off in `ResolvedWorkflow.overnightGates`. Every Gate check reads that Workflow through `gateOn` in `tasks/tasks.ts`: `ted outcome advance` for Intake to Review, and `mergeMode` for the Merge Gate. The Stage prompt reads the same Workflow, so it no longer tells the Task Lead the Stage has a Gate.

The Gate is decided when the Task Lead reports `advance`, not at Stage entry. A Task already in Design when the mode turns on passes without sign-off; a Task in Design when the mode turns off gets its Gate back. Merge is decided when TED starts merging: a Task that enters Merge, or is waiting there with no sign-off posted, while the mode is on starts merging, and stays merging if the mode is turned off before CI passes. The human can still cancel that merge with a Comment.

## What stays on

- Gates TED forces: `forcedGates` on a Task (Review on a Task that changes `.ted/`), a setup Task’s Design and Review Gates, and the Clarify sign-off at grilling depth. They are applied after `withoutGates`, or checked outside the Workflow, so overnight mode cannot reach them.
- A Gate whose request was already posted in this visit of the Stage, answered or not. An open request stays open and the Task waits; `ted outcome advance` is refused as before. Turning the mode on is not an approval, the same rule ADR 0095 uses for editing a Task’s Gates.
- Everything that is not a Gate: questions and Clarify rounds, permission prompts, the Bypass confirmation, the sandbox, send-back limits, the size check, Validate’s Checks and reviewer, and the merge watcher’s own conditions (CI passed, mergeable, signed-off commit unchanged, required reviews).

Setup Tasks are still never started automatically.

## What is recorded and shown

Each skipped Gate is one `v1.GateSkippedOvernight` event (Task, Stage), shown in the thread as “Overnight mode is on, so TED skipped the Design Gate”. For Merge the same event is what keeps the merge going after the mode is turned off. `GET /tasks/:id/gates` keeps `inherited` and `override` as saved, sets `effective: false` and adds `overnight: true` on each row the mode turns off. Factory settings, Library and Board Stage rows keep `gate` as saved and add `overnight: true` when the mode is on and the Gate is on.

## Alternatives

Recording the decision at Stage entry was rejected: a Task already in a Stage when the human turns the mode on at bedtime would still stop at that Stage’s Gate. Approving open Gate requests when the mode turns on was rejected because a setting would then act as an answer. Skipping Clarify or turning off its questions was left out: a blocking question still goes to the Inbox, and the Task Lead ends its turn so another Task can use the slot.
