# Queued Runs outside a Task share one module

Planning chats (ADR 0083), Automation Runs and Automation drafts (ADR 0070), Coordinators (ADR 0094) and Side chats all start Runs that wait in the queue (ADR 0030) without belonging to a Task. Each had its own copy of the same rules: the set of items starting, a `begin` that starts each once and pumps the queue after, a hand-built `QueueSource`, a set of Runs that hit a usage limit or failed to sign in (ADR 0057), and “the process ended: resume once, then fail” (ADR 0051). The copies of the usage-limit tracking had drifted: drafts kept marking Runs after they closed, and cleared a Run only when the Provider that became ready was the Run’s own.

**The rules live in `packages/daemon/src/tasks/queued-runs.ts`**, as four pieces an owner uses as it needs:

- `startGuard` starts an item once per key, logs or hands on a failure, and calls the owner’s `done` when it ends. Its key is whatever the owner queues by, so the queue ID need not be a Run ID. All five owners use it.
- `queuedRuns` builds and registers the `QueueSource` from what the owner lists as waiting, how it launches one, which items hold a slot and how a slot is shown. Registering pumps the queue at once, so an owner whose `waiting` reads its start guard (Automations) creates the guard first and passes it in. Plans, Automations and drafts use it. Coordinators and Side chats keep their own `QueueSource`, pause checks, launch and settle code.
- `runLimits` keeps the Runs that hit a usage limit or failed to sign in, clears one when it works again, and, when any Provider becomes ready, clears every Run whose own Provider is no longer paused. It marks nothing once its owner has closed. Plans, Automations and drafts use it.
- `afterProcessEnded` decides between stopped, resume once (the Run has a session and wasn’t resumed before) and fail, with the shared fallback sentence. `queuedRunStatus` gives the status lines Plans and Automations share. Drafts don’t resume.

`RunQueue` replaces the identical `PlanQueue` and `AutomationQueue`.

## Considered Options

- **One module that also owns the Run’s end and its status.** Rejected: Automations’ Scheduled Check agent phase, drafts’ settle on idle and Coordinators’ own keys would each need an override, and the interface would grow to the size of what it hides.
- **Keep each difference between the usage-limit copies as an option.** Rejected: nobody chose them on purpose. Drafts now behave as Plans and Automations did.

## Consequences

A queue rule is changed once and tested once, in `packages/daemon/test/queued-runs.test.ts`, with a fake queue, store and Run manager. A new chat kind uses these pieces instead of copying them. The queue and pump in `tasks/queue.ts` and `tasks/tasks.ts` don’t change. Moving the queue-source builder and usage-limit tracking into Coordinators and Side chats is left for later, because they decide “paused” differently today.
