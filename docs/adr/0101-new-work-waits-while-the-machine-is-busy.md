# New work waits while the machine is busy

Status: replaced by ADR 0166-new-work-waits-while-the-computer-is-busy.

A fixed `maxWorkingRuns` doesn’t fit every hour. Each working Run’s agent runs installs, typechecks and tests on this machine, and how much those cost changes from minute to minute. With six Tasks working, a 12-core Mac reached a load average of 53. A lower fixed limit would waste the machine when the Runs are only thinking.

The machine setting `adjustRunsToLoad` (off by default; **Start fewer Runs when this computer is busy** in Settings → Limits) makes the pump hold new starts while the machine is busy. `maxWorkingRuns` and every Factory cap stay as they are and are still the most TED runs.

## The rule

The measure is the 1-minute load average divided by the number of logical cores: `os.loadavg()[0] / os.availableParallelism()`, read by `machineLoadRatio` in `packages/daemon/src/load.ts`. `heldForLoad` in `packages/daemon/src/tasks/queue.ts` turns it into held or not held with two marks in `loadMarks`:

- **Hold at 1.0.** At 1.0 there is, on average, one process that wants a core for every core. Above that, processes wait for a core and everything on the machine slows, the human’s own work included.
- **Resume below 0.75.** The 1-minute average moves slowly and a Run that has just started raises it. With one mark, a load near it would stop and start work on every reading. The gap also leaves about a quarter of the cores free for what the next Run will start.

Between the marks the last answer stands. A ratio that isn’t a finite number never holds. Windows reports a load average of zero, so the setting does nothing there.

The pump reads the load once per pass, in `fill`, and only when the setting is on and something waits to start. While held, `SlotUse.heldForLoad` is set and `startsNow` skips every entry unless one of these is true:

- **Nothing holds a slot.** The first entry in queue order starts whatever the load is, so a machine that is busy for reasons other than TED still gets one Run at a time. Factory caps still apply to it.
- **It is a slot handoff** (ADR 0049). A waiting Task Lead’s first sub-agent starts for the reason it starts over the limit: its Task already held that slot, so it adds no working Run the machine wasn’t already carrying. Under a hold, a Task Lead that waits on several sub-agents gets them one at a time.

Everything else that goes through `startsNow` waits: queued Tasks, sub-agent requests, Planning Runs, Coordinator turns, Automation drafts and Runs, Backlog Tasks that would start on their own, a held Task Lead being started again and a Task Lead being resumed after it ended. Nothing that is already working is stopped, paused or slowed, and a Run that goes from waiting back to working is never held, as before. The disk-full hold, agent pauses and Factory caps are unchanged and are checked first.

While held, a timer runs the pump again every 15 seconds, so starting resumes when the load falls without waiting for another event. The timer exists only while held, is `unref`’d, and holds no idle timer and adds nothing to `TedStore.activity()`.

## Showing it

`GET /slots` adds `heldForLoad: true` and `loadRatio` (two decimals) while held, and leaves both out otherwise; `slots-changed` goes out when the hold starts or ends, and when the rounded ratio changes while it lasts. The store keeps the flag in memory (`TedStore.holdForLoad`, like `holdNewWork`), and a queued Task gets `TaskFacts.heldForLoad`, so its status is `{ kind: 'queued', hold: 'this computer is busy' }` and reads “Queued · this computer is busy”. The disk-full hold wins when both apply. The footer and the Limits line add “· this computer is busy”. There is no banner: this is normal operation.

## Tests

Tests never read the real load. `TED_LOAD_FILE` names a file holding the ratio TED should see; `vitest.config.ts` points every test at `packages/daemon/test/fixtures/load.txt`, which holds 0. `startDaemon`’s `load` option (`ratio`, `checkEveryMs`) overrides it.

## Considered Options

- **Lowering the limit as load rises** (for example one slot fewer per 0.25 of load). It needs a formula nobody can check by looking at the machine, and it still starts work while the machine is over its cores. Holding all new starts is one rule with one number.
- **CPU use instead of load average.** It needs sampling over time and misses processes waiting on a core, which is what the human feels. Load average is one call.
- **The marks as settings.** Two more numbers to explain, for a rule the human turns on to stop thinking about it. They are constants until someone needs another value.
- **Stopping or pausing working Runs.** A paused agent mid-install or mid-test leaves broken state, and its work is lost time. Only new starts wait.
- **A banner.** Banners are for problems. A busy machine with the setting on is doing what the human asked.

## Consequences

- With the setting on, the number of working Runs settles where the machine’s load sits near the marks, up to `maxWorkingRuns`.
- Load from other programs holds TED’s new work too, down to one working Run.
- Process priority for Runs and Checks, and a limit on Checks running at once, are not part of this.
