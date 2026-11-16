# Chats start at once, outside the slot limit

A chat is a Run the human talks to and waits on: the Coordinator, a side chat or a planning chat. Until now each one went through the working-Run queue like a Task (ADR 0030, ADR 0083). With every slot held by Task Leads, a message to a chat sat as “Queued” until some Task ended or waited, so the human could not get an answer while Ted was busiest. A chat mostly waits for the human, so the slot it held also kept a Task from starting.

## The rule

`chatKinds` in `packages/protocol/src/slots.ts` lists the chat kinds: `coordinator`, `side-chat` and `planning`. `isChat` checks one.

- **They start at once.** `startsNow` in `packages/daemon/src/tasks/queue.ts` starts a chat entry without checking `maxWorkingRuns`, a Factory cap or the busy hold (ADR 0101).
- **They hold no slot.** `startsNow` doesn’t add a chat to `working` or to its Factory’s count, and `slotUse` in `tasks/tasks.ts` leaves chat holders out of both. A running chat never makes a Task, sub-agent or Automation wait.
- **They still go through the pump.** Chats keep their queue sources and are started by the pump, so the disk-full hold (`newWorkHold`, ADR 0039) and each source’s `runnable` check (a paused agent kind, ADR 0033) still hold them back. That keeps one start path instead of three. A chat that waits for one of these shows as queued, as before.
- **Only the chat Run.** Tasks a planning chat creates and Tasks the Coordinator starts or resumes still go through the queue. Helpers an agent runs inside its own Run (Claude Code’s Task tool, for example) are part of the chat Run already.

## Showing it

`GET /slots` still lists running chats in `holders`, so the app can show what is running, but `working` and each Factory’s `working` leave them out. The Working Runs popover draws them in a Chats group between Working and Queued, each marked “No slot”.

## Tests

`queue.test.ts` covers `startsNow` with a full machine, a Factory at its cap and the busy hold, and checks that a chat leaves the next slot to the work after it. `plans.test.ts` and `side-chats.test.ts` start a chat while the limit is full. Coordinator tests that need a message to stay unsent sign the stub agent out instead of filling the slots.
