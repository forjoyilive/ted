# Work in progress skips the busy hold

Status: accepted (TED-519). Amends ADR 0125-inbox-continuations-wait-for-working-run-slots and ADR 0166-new-work-waits-while-the-computer-is-busy. Amended by ADR 0192-cleanup-skips-the-busy-hold-and-queued-labels-say-only-why: Cleanup skips the hold too, and the reason labels are gone.

Since ADR 0125 an idle Task Lead gets Ted’s next message only through the queue: an answer, a sign-off approval, the Check results and Validate instructions from `tasks/validation.ts`. A Task holds no slot while its Checks run, and Checks push the load past the busy mark of ADR 0166, which went on by default. So a Task whose Checks had just passed, or whose question the user had just answered, waited until nothing else was working.

**A continuation after Checks or an answer skips the busy hold.** A held Task Lead message records why it waits in `after` (`checks-passed`, `checks-done` or `answer`) and when in `heldAt`, inside the JSON `messages` of the existing `v1.TaskLeadMessagesHeld` event, as `waitForSlot` does; a held answer uses its `answerDelivery.queuedAt`. `continuationsReady` in `tasks/tasks.ts` gives such an entry `skipsBusy`, and `startsNow` in `tasks/queue.ts` lets it past the busy hold. The machine limit, Factory caps, the disk hold and agent pauses still apply. Cleanup and Autopilot reminders keep waiting like new work.

**Recent ones go first.** `continuationFlags` marks an entry `recent` for 10 minutes (`recentContinuationMs`) after it was held, and `queueOrder` puts recent entries ahead of others of the same kind, before Priority. Continuations already sort ahead of new Tasks. The pump computes it on each pass; it re-runs every 15 seconds while busy and on every slot change, so the cut-off is read when a slot frees.

**The status says why.** The queued `TaskStatus` carries `after`; `taskStatus` doesn’t report the busy hold for it. The app shows “Queued · Checks passed, waiting for a slot”, “Queued · Checks finished, waiting for a slot” (a Check failed or earlier failures remain) or “Queued · Answered, waiting for a slot”, with the place in the hover title.

## Considered Options

- **Starting these continuations over the limit**, like a permission answer. The user chose to keep the limit.
- **Discounting the load Ted’s own Checks cause.** Ted can’t separate it cleanly, and a heavy Check does slow everything else.
- **Holding the slot while Checks run.** It would keep capacity idle during long Checks, against ADR 0125’s choice to release it.
