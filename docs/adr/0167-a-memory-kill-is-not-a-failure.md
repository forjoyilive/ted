# A Check or Run killed for lack of memory is not a failure

Status: accepted (KRI-406). Follows ADR 0166-new-work-waits-while-the-computer-is-busy.

When macOS (or Linux) runs out of memory it kills processes. A killed Check was recorded as a failed Check, so a Task could be sent back for a failure its code didn’t cause, and a killed Task Lead went through recovery and counted toward “stopped twice in 30 minutes”. The busy hold makes this rarer but doesn’t change how a kill is counted once it happens.

## How TED tells a memory kill

`memoryKill` in `packages/daemon/src/memory-kills.ts` is the one rule: the process ended by SIGKILL (its own signal, or exit 137 from the shell that ran it), TED didn’t send it, and the lowest memory reading TED took while it ran was under the busy hold’s mark (`busyMarks.memory.holdBelow`, 10%). TED’s own timeout and stop return `timed-out` or `interrupted` before the rule is asked, and a Run TED stopped has `ended.how === 'stopped'`, so neither can count.

Memory recovers as soon as something is killed, so the reading has to be taken while the process runs. `createMemoryWatch` in the same file reads the busy hold’s cached memory share (`Busy.memory`, not gated by `waitWhenBusy`) once when a watch opens and then every 5 seconds while any watch is open, and keeps only the lowest value per watch, in memory. The daemon makes one watch and hands it to the Tasks module, Scheduled Checks and `RunManager`.

TED doesn’t read macOS’s JetsamEvent reports: they are macOS only, can appear late or be unreadable, and can’t be driven from a test. A test runner that catches its own worker’s death and exits with a normal code (Vitest’s “Worker exited unexpectedly”, exit 1) stays a failure; TED can’t tell it from a real one.

## Task Checks

Every Task Check (hand-off, Validate entry, `ted checks`, the Merge rerun) runs through the executor in `tasks/validation.ts`. `runChecks` returns the outcome `memory` for a memory kill instead of `failed`. The executor then:

- records `v1.CheckKilledForMemory`, whose materializer sets the Check’s row to `out-of-memory` (“Stopped: out of memory” in the app), drops the Check’s start boundary so the rerun can record its own, and adds a Task thread line;
- waits until the memory share is back above `busyMarks.memory.resumeAbove` (`MemoryWatch.freed`), whatever `waitWhenBusy` says, and runs the same Check run again from that Check. It keeps its Check slot while it waits, because the slot’s queue boundaries are recorded once per Check run;
- on the second memory kill in the same Stage visit (`store.memoryKills` since `visitStart`), posts a question with `memoryKill` on the Comment (`v1.CommentMemoryKillAsked`, purpose `memory-kill`): **Try again** waits for memory and reruns, **Count it as failed** finishes the Check as `failed` and the normal failure path follows. Only the user answers it: Autopilot answers only `question` purposes and `coordinatorNeverAnswers` leaves it out. If the Task is stopped, archived or deleted first, or the daemon restarts, the question is withdrawn and the Check run ends as interrupted.

Callers see one Check run that ends passed, failed or interrupted, so the hand-off, Validate, Merge and `ted checks` paths don’t change.

## Scheduled Checks

A memory kill ends the firing through the stopped path with a message saying memory ran out. It creates no Backlog Task, starts no check agent and isn’t run again.

## Runs

`RunManager` opens a watch while it follows a Run. When the host’s recorded ending meets the rule, `recordRunOutput` commits `v1.RunKilledForMemory` with the ending. In `recover` (`tasks/lead-lifecycle.ts`) such a Task Lead gets the reason “was stopped because this computer ran out of memory”, is never marked Failed for it, and its resume waits for `freed`; `failureHistory` leaves the failure out, so it doesn’t count toward a later Failed either. Other Runs on the Task (sub-agents) get a thread line saying memory ran out; their handling doesn’t change.

A daemon restart while a Run is live loses that Run’s readings, and a kill after the restart is counted as before.
