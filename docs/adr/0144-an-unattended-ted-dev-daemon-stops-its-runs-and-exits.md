# An unattended Ted Dev daemon stops its Runs and exits

Daemons started from source with `--exit-when-idle` were found running for a day or more with nobody using them, some on an empty home and some on a demo home with 20 to 40 Run hosts and stub agents. Two things kept them up.

- **The Linear sync timer.** Since KRI-26 the sync runs every 60 seconds through the Tasks module’s `inBackground`, which takes a hold on the idle timer and releases it when the cycle ends. Each release starts the idle exit’s 60 seconds again, and the next cycle is scheduled just before that release, so it always fires first. A daemon with no Task, no Run and no client never exited. Tests didn’t see it because they set `TED_IDLE_EXIT_MS` below 60 seconds.
- **Runs that never end.** The Run manager holds the idle timer while it follows a live Run (ADR 0013), whatever the Run’s state. An idle agent waits for input for ever, and the demo’s stub agents that look like they are working wait on a file for ever. The demo also has an Automation that is on and open pull requests, which hold the idle timer by design (ADR 0070, ADR 0065).

**The Linear sync no longer holds the idle timer**, in every edition. Its cycle still counts as background work, so the daemon waits for a cycle in flight when it closes. This puts back what ADR 0009 says: a daemon nothing holds exits a minute after its last request.

**A Ted Dev daemon that nobody attends stops its Runs and exits.** The idle timer (`packages/daemon/src/idle.ts`) keeps a second time beside the idle exit. It runs while no client is connected and starts again with each of these:

- a request ending (any caller, a Run’s `ted` command included),
- the last open event stream closing,
- output from any Run (`RunManager` calls `idle.heard()` for each batch it reads).

Holds don’t stop it. When it runs out, the daemon does what the app’s Quit does (`POST /shutdown` without `keepRuns`): `Tasks.stoppingForQuit`, then `RunManager.stopAll`, then it exits. The stops are recorded, so they aren’t failures, and a working Task Lead that was stopped is offered for restart the next time the app opens (ADR 0128). The time is one hour; `TED_UNATTENDED_EXIT_MS` shortens it for tests. Only `main.ts` turns it on, with `--exit-when-idle` and `edition === 'dev'`.

The release daemon never gets this time. There an idle Task Lead holds the daemon as before and nothing stops it.

A demo whose Runs were stopped this way is marked incomplete in its `demo.json`, so the next `pnpm app --demo` says to run `ted dev seed --reset` and doesn’t show a demo whose Tasks are all stopped.

## Considered Options

- **An idle Run doesn’t hold the idle timer.** Rejected. In release it would end the daemon of someone who uses only `ted` while their Task Lead waits for an answer, and the idle nudge (ADR 0046) would race the exit. Its hosts would also stay behind, since hosts outlive the daemon. It wouldn’t have ended the demo daemons either: their Automation, pull requests and stub agents that look like they are working hold the timer too.
- **Stop idle Runs at the ordinary idle exit, in Ted Dev.** Rejected for the same reason: the ordinary idle exit never comes for a demo home, and after a minute is too soon for a Task Lead someone started with `pnpm ted task start` and is waiting on.
- **Demos stop their daemon and Runs when they finish.** Not enough alone. The demo app’s Quit keeps the Runs on purpose so the next launch is quick, and the daemons found were started by `ted` commands against a demo home, not by a demo script. The unattended time covers every way a daemon is left behind.
- **A host exits by itself when no daemon has followed it for a while.** Not done. It would also end hosts across a daemon update in release, and the host interprets nothing (ADR 0013). A host whose Run folder is gone already exits.

## Consequences

- In Ted Dev, a Task Lead that waits on the human for more than an hour with no app open and no `ted` command is stopped. An answer resumes it (ADR 0141).
- A demo home left with a daemon and no app loses its Runs after an hour and has to be seeded again. A demo closed with the app’s Quit has no daemon, so its hosts stay until `pnpm ted dev stop` stops them or the home is reset or deleted. Seeding and the demo app’s Quit write `quit-mark` so a stub Run’s `ted` call cannot restart the daemon. After closing the app, `pnpm ted dev stop` stops the daemon, Run hosts, stub agents and Apps while keeping the data, and marks a populated demo incomplete so it needs `pnpm ted dev seed --reset`.
- Apps aren’t stopped by the unattended exit, as they aren’t by Quit.
- New periodic work must not take and release an idle hold on a timer shorter than the idle exit. Hold for as long as there is something to wait for, like the Automations and snooze timers, or not at all.
