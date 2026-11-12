# 0125: Autopilot can be set for one Task or a selection

## Decision

Rename Overnight mode to Autopilot in the app. Keep `overnightMode` as the persisted machine-setting key. Each Task inherits the global switch by default or explicitly chooses on or off, stored through `v1.TaskAutopilotChanged`. Explicit choices take precedence. Per-Task setting changes do not Start or Resume work. The global switch retains its eligible automatic starts; an explicit off excludes a Task from those starts without disabling the Factory’s own automatic-start setting.

Effective Autopilot lets the Task Lead make routine decisions and continue through Merge. Ordinary Clarify, including grilling, does not need a round or sign-off. Recommended answers in existing rounds that are not being talked through and ordinary sign-offs are applied automatically through the existing request-answer transitions. Only the current Task Lead can answer a waiting ordinary question on its own automatic Task, through `ted autopilot answer`. That command requires an explanation. The daemon rechecks mode, ownership and request eligibility while holding the Task before committing the answer.

This is a bounded exception to ADR 0032’s human-only ordinary approvals and ADR 0015’s ordinary question-answer authority. It does not open the general human answer route to Runs. The Task setting remains app-only. A Run cannot enable Autopilot for itself or another Task.

A request still closes once through `v1.CommentAnswered`. Its commit includes the companion `v1.CommentAnsweredByAutopilot` event, which records attribution durably without rewriting historical events. Thread cards and replacement-Lead context identify these as Autopilot’s decisions. They are never answers posted as the user.

Setup questions, rounds and sign-offs, talked-through rounds awaiting a summary close, permissions, failed Checks requiring a user decision and Workflow-change safeguards, missing information or access, size checks and split proposals remain manual. Ordinary questions are eligible only when they are Task Lead questions, rather than TED’s failure, permission, simulator, model, integration or other operational requests. Workflow-change inspection fails closed. Validation obligations still apply to automatic approvals.

## Consequences

The Tasks module owns effective mode and eligible request handling. The renderer uses the normal DaemonClient forwarding seam to change one Task; the selection toolbar applies the same change to multiple Tasks and reports individual failures. Inherited Tasks show no label. Explicit choices show “Autopilot on” or “Autopilot off”.

Mode changes affect subsequent decisions. An automatic answer already committed is not undone when the mode is turned off, and started work continues. Enabling also processes existing ordinary requests. Recovery processes unanswered eligible requests again, with the existing Task lock and answered-request checks preventing duplicate answers. A manually stopped Task stays stopped until resumed.
