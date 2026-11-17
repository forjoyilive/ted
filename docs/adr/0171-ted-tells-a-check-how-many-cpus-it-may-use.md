# Ted tells a Check how many CPUs it may use

Status: accepted. Follows ADR 0166-new-work-waits-while-the-computer-is-busy and ADR 0103-a-machine-limit-on-checks-running-at-once.

On a 12-core Mac, one Task’s Affected tests Check (`pnpm check --affected`, 6 Vitest workers) held 8 queued Tasks for more than 12 minutes with only 2 of 6 working Runs in use. `GET /slots` reported `busy: { loadRatio: 4.94 }`. The hold was right: `top` showed 1 to 3% of the CPU idle and a load average of 52. The Check was the cause. Each Vitest worker starts daemons, Run hosts, stub agents, the CLI and `git`, so a Check with 4 workers was 17 to 29 processes, and with 6 it filled every core.

Two things made it worse than it looks:

- Low priority (ADR 0102) changes who gets the CPU, not how busy the computer reads. The load average counts every thread that wants a core, whatever its priority, so Ted’s own Check holds Ted’s own Runs.
- Nothing told the Check how much to use. This repo’s tooling reads the load once when it starts and takes 6 workers if that moment was quiet. Inside Ted’s sandbox each Task has its own test locks, so two Tasks’ Checks don’t wait for each other either.

Check runs still don’t wait for the busy hold (ADR 0166): a Check holds the Task that asked for it.

## Decision

**Ted gives every Check command `TED_CHECK_CPUS`: the number of logical cores it may use.** `checkCpus` in `packages/daemon/src/tasks/check-slots.ts` works it out when the command starts: a share of the computer’s logical cores (the `checkCpuPercent` machine setting, half by default), divided by the Check runs that hold a `CheckSlots` place at that moment, this one included, rounded down and never less than 1. On 12 cores at the default, a Check alone gets 6, and one that starts beside another gets 3.

The daemon’s one `CheckSlots` answers `cpus()`, because it already knows how many Check runs are running. `runChecks` adds the variable to each command’s environment when its caller passes `cpus`: Task Checks always do, and Scheduled Checks do while the `limitScheduledCheckCpus` machine setting is on. `check-tries.ts` adds it for Run now. It is not part of `checkEnv`, because the hash of that environment is in a Failure case’s tested context and the number changes with what else is running.

The number is a request, not a limit Ted enforces. Ted can’t know a repo’s test runner, so the Check’s command has to pass it on, for example `vitest run --maxWorkers=$TED_CHECK_CPUS`, `jest --maxWorkers=$TED_CHECK_CPUS` or `make -j$TED_CHECK_CPUS`. A Check that ignores it runs as before, and the busy hold still stops new work when it fills the computer.

**This repo’s `pnpm check` keeps to it.** `allowedCpus` and `workersWithin` in `scripts/machine-load.ts` turn the number into Vitest workers at 2 CPUs per worker (`cpusPerWorker`), because a worker here is the test process plus the processes its tests start. The workers of the projects that run at the same time share the number in proportion, never below 1 each: 6 CPUs is `node ×3`, or `electron ×1, node ×2`. The load scaling that was already there applies after that. Outside a Check the variable isn’t set and nothing changes.

The busy hold itself is unchanged: the same reading, the same marks.

## Settings

Both are machine settings in Settings → Limits, each change one `v1.MachineSettingsChanged`:

- `checkCpuPercent`, **CPU a Check may use**: a multiple of 10 from 10 to 100 (`checkCpuLimits`), default 50. `CheckSlots` reads it each time a command starts, so a change applies to the next Check and not to one that is running. At 100 a Check alone is told every core, which is what happened before this ADR.
- `limitScheduledCheckCpus`, **Limit the CPU Scheduled Checks use too**: on by default. Off, a Scheduled Check’s command gets no `TED_CHECK_CPUS` and runs as it did before. It still holds a `CheckSlots` place, so a Task Check that starts beside it gets half of the share.

## Considered Options

- **Raising the load mark, or not counting Ted’s own Checks in the reading.** Rejected: the computer in the report really was full. A reading that looked away from the Check would have started six agents on it.
- **Measuring CPU time in use instead of the load average.** Samples on the same Mac while Checks ran showed the two agree where it matters: a load per core of 1.1 to 1.3 went with 12 to 22% of the CPU idle, and 2.4 to 3 with 1 to 9%. Swapping the measure would move the mark a little and fix nothing while a Check fills every core.
- **Lowering the hold’s resume mark only while a Check Ted capped is running.** Rejected: it is a second set of marks to explain, and it only helps once the Check is lighter, which is the change that matters.
- **Ted limiting the Check’s CPU itself.** Ted has no supported way on macOS to cap the CPU of a command and everything it starts, and a priority lower than utility doesn’t change the load reading. On Linux a cgroup could do it; not built.
- **Making Check runs wait for the busy hold.** Still rejected, as in ADR 0166.
- **Dividing by `maxChecksAtOnce` instead of the Checks running now.** With the default of 2 a Check that runs alone would get a quarter of the cores for nothing.
- **A number of cores as the setting, not a percentage.** A share keeps its meaning when the settings move to a computer with a different core count, and the default needs no reading of the computer.
- **Choosing the number from the queue when the Check starts.** A Check runs for many minutes and Tasks are queued while it runs, as in the report, so the number can’t depend on the queue at its start.

## Consequences

- A Check in this repo that used 6 workers alone now uses 3, so it takes longer. How much longer was not measured; at 6 workers the computer was swapping, so it is less than twice.
- A Scheduled Check gets the same number by default, so the nightly full `pnpm check` runs with fewer workers too and may need a longer timeout. Turning `limitScheduledCheckCpus` off gives it the whole computer back, and new Runs may then wait until it ends.
- Two Checks that start at different times can hold 6 and 3 of 12 cores. The first keeps its number until it ends.
- Other Factories get the variable but nothing uses it until their Check commands do.
- 2 CPUs per worker is an estimate. One worker running `checks.test.ts` on a full computer used 1.0 CPU-seconds per second, not counting the Run hosts and stub agents its tests detach, and a Check with 4 workers ran while 78 to 88% of 12 cores were in use beside a few agents. Measure it on a quiet computer before changing `cpusPerWorker`.
