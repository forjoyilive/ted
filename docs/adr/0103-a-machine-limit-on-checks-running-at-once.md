# The machine limits how many Check runs run at once

A Check run never took a working-Run slot (ADR 0044), so six Tasks reaching Validate together ran six typechecks at once. The `maxChecksAtOnce` machine setting (Settings → Limits, default 2, 1 to 16) limits how many run at the same time. One Check run, a Task’s whole sequence of Checks, counts as one. So does a Check tried with Run now in Factory settings, from its scratch worktree’s setup to the end of its command.

`createCheckSlots` in `packages/daemon/src/tasks/check-slots.ts` holds the places and a first-come line. The daemon makes one and gives it to the Tasks module and to `check-tries.ts`. `beginChecks` in `tasks/tasks.ts`, which every Task Check run goes through (Validate entry, `ted checks`, the Merge rebase rerun), records the Check run, then takes a place before it calls `runChecks` and gives it back when the runner returns. The limit is read each time a place is taken or freed, and again on every `v1.MachineSettingsChanged`: raising it starts waiting Check runs at once, and lowering it stops nothing.

Waiting holds no working-Run slot. A Check run that is waiting already exists in the store with every Check `waiting`; nothing new is recorded in the event log. What is waiting lives in memory: the store carries each waiting Task’s place (`setChecksWaiting`), which adds `waiting` to its unfinished Check run and `checksWaiting` to `TaskFacts`. The Task shows its “Waiting for checks” chip and no Working status, since it holds no slot (changed by TED-516; it used to stay Working), and its activity line reads “Waiting to run Checks · 2nd”; the thread reads “Waiting to run Checks” instead of “Running Checks”; a waiting try reads “Waiting for other Checks to finish”.

## Leaving the line

A waiting Check run leaves the line and ends `interrupted`, without running, when:

- the human stops the Task (`stopByHand`);
- the Task is archived, deleted, moved back to Backlog for planning, or its Factory is removed (all through `clearAway`);
- the daemon shuts down. As with a running Check run, it is then left unfinished, and the next start marks it interrupted and runs Validate’s Checks again.

A waiting try leaves on Stop, on removing the Factory and on shutdown, through the abort signal it already had.

Before this change only a daemon shutdown interrupted a running Check run; stopping or archiving a Task let its running Checks finish. That is unchanged. A stopped Task that is resumed in Validate starts a fresh Task Lead from the brief, as it did when its Checks were running at the stop.

## Counts

`Activity.checksRunning` counts Tasks whose Checks are actually running. `Activity.checksWaiting` counts Tasks in the line. Both hold Stay Awake and count as work running at Quit. `GET /update/work` reports their sum as `checks`, because an update has to wait for a waiting Check run as much as for a running one. Tries are in neither count, as before.

## Considered Options

- **Check runs take a working-Run slot.** Rejected: a Task at Validate usually has an idle Task Lead that gave its slot back, and Checks waiting behind agents would stall every Task at Validate while the machine’s agents are busy.
- **A new event for “waiting”.** Rejected: the line doesn’t outlive the daemon, and every unfinished Check run is interrupted at the next start anyway.
- **Limit single Checks, not Check runs.** Rejected: a Task’s Checks would interleave with other Tasks’ and each Task would take longer to hear about its first failure.

## Consequences

- Anything new that runs Checks takes a place from the daemon’s `CheckSlots` first.
- A Check’s timeout starts when its command starts, so waiting never times a Check out. `ted checks` polls for longer while its Check run waits.
