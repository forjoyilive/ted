# Task Gates override sign-off without skipping Stage work

KRI-200 needs the human to choose Gates for one Task without editing the Factory’s Workflow. Task details edits a sparse map of Stage-to-boolean overrides; an absent entry follows the Workflow again, while an explicit On or Off keeps that choice across inherited changes. Gate Off keeps the Stage’s work. It never inserts an omitted Stage or bypasses Validate’s reviewer.

`v1.TaskGatesChanged` persists the map. Only the app may write it through `PUT /tasks/:id/gates`; Runs and the file token cannot. `Tasks.taskWorkflow` applies preferences before forced Gates and setup requirements, with grilling Clarify still requiring sign-off. `GET /tasks/:id/gates` explains inherited and effective values and why a row is locked. A revision of the effective rows prevents stale saves, and editing uses the same Task hold as Stage advancement.

Past Stages and finished or archived Tasks are read-only. A requested Gate stays read-only for that visit, even after its answer, so editing never substitutes for answering or withdrawing a request. Merge’s Gate locks at Merge entry because its watcher can already be merging; earlier Stages can change that preference before entry. Gate Off at Merge permits automatic merging only through the existing readiness checks. Stage-off Merge keeps its existing meaning.

Task details exposes On, Off and Use Workflow for each included Stage; resetting removes only editable overrides. The alternative of also skipping whole Stages was left out because that changes agent work rather than just human sign-off. Automatically withdrawing a live Gate on edit was rejected because it would make a settings change act as an approval.
