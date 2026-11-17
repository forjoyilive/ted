# Inbox continuations wait for working-Run slots

Answering many Inbox Tasks used to bypass working-Run limits because ADR 0030 gated only new starts. Questions, Clarify rounds and sign-offs now save the answer immediately and queue the Task Lead’s continuation when it is no longer working. Permission answers still continue immediately, as the user chose; that exception can still take the working count over the limit.

The Tasks module adds continuations to its existing queue, ahead of new Tasks and ordered by Task Priority and manual order. Other queue classes keep their existing precedence. Each continuation uses the machine limit, Factory cap, load hold and disk hold. A Task releases capacity while waiting for every Clarify round; it reserves no slot for a future answer.

A pending Task Lead message carries `waitForSlot` inside the existing `v1.TaskLeadMessagesHeld` event’s JSON messages. The queue holds a slot while the lifecycle applies the selected agent settings and dispatches that saved message. The lifecycle checks admission before dispatch, and clears the message only after the host acknowledges it. Pending continuations survive a daemon restart. Queue positions, Task status and the Run count use the same ordered entries.

Reserving capacity between rounds would avoid repeated queue waits but leave less capacity for other Tasks. The user chose to release it instead. Existing working Runs continue; this change does not stop them to enforce a lower limit.

A continuation after Checks or an answer skips the load hold and recent ones go first: ADR 0184-work-in-progress-skips-the-busy-hold.
