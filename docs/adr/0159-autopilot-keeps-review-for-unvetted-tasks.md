# 0159: Autopilot keeps the Review Gate for Tasks the user hasn’t vetted

## Decision

Add the machine setting `reviewUnvettedTasks`, on by default, shown under Autopilot in Settings → General as “Review Tasks from Automations and public issues”. While it is on and Autopilot is in effect for a Task, two kinds of Task keep their Gates the way a Task that changes `.ted/` does (ADR 0100, ADR 0127):

- a Task an Automation created, from any source, Follow-ups included: one with a `v1.AutomationTaskCreated` link (`store.createdByAutomation`), not one whose `createdBy` reads `automation`, because `createdBy` shows a single origin and an Automation’s Follow-up reads `follow-up`;
- a Task whose imported GitHub issue has text from an outsider (`TaskSource.github.outsiderText`, ADR 0158).

`unvettedReason` in `packages/daemon/src/tasks/autopilot.ts` decides it from the Task and the setting. `gateWorkflow` and `gatesFor` in `tasks/tasks.ts` check it before the `.ted/` check and pass the result as the `OvernightGuard` reasons `automation` and `outsider`. Everything after that is the existing kept-Gate path: saved Gates stay on, Review is forced on, `v1.GateKeptOvernight` records the reason, Autopilot refuses to approve the sign-off, and at Merge the merge waits for an approval bound to the signed-off commit, so code added after the user’s Review approval doesn’t merge unseen. The reason texts live once in `overnightGuardTexts` in `workflow/resolve.ts`, for the thread line and the Task’s Gates rows.

The setting changes through `PATCH /settings`, which sets neither `runToken` nor `fileToken`, so only the app can turn it off.

## Why

Under Autopilot Ted counts ordinary Gates as off and can merge a Task without the user. An Automation writes a Task from outside input the user hasn’t read, and an outsider’s issue text is written by someone with no say over the repo; both reach the Task Lead as context. A Review the user signs off is the one point where a person sees the result before it merges.

## Consequences

Only these two kinds count. Split, plan and Coordinator Tasks don’t: the user approves a split or plan even under Autopilot, and the Coordinator acts within ADR 0094. A Follow-up the user made of an Automation’s Task doesn’t either. A user-created Task from an issue written only by maintainers, or with no source, goes through Autopilot as before. With Autopilot off, or the setting off, nothing changes. The check reads only the store and the settings, so it costs no git read, and the reason is decided each time the Gate is, so turning the setting off lets later Gates through.
