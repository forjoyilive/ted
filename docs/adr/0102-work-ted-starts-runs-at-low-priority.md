# The work TED starts runs at low priority

Several Tasks working at once fill every core with agents, installs, typechecks and tests, and the rest of the computer gets slow. The `lowPriorityWork` machine setting (Settings → Limits, on by default) starts that work at a priority below the human’s own apps.

`workCommand` in `packages/daemon/src/priority.ts` puts one program in front of a command:

- on macOS, `/usr/sbin/taskpolicy -c utility`, a utility QoS clamp;
- elsewhere, `/usr/bin/nice -n 10` (or `/bin/nice`).

macOS gets the clamp instead of `nice`, not as well as it, because niceness doesn’t change how macOS shares out the processor (measured below) and a second program would add a step for nothing.

It is used at the three places TED starts Task work:

- the Run host (`runs/run-manager.ts`), so the agent CLI and every command it runs inherit the priority. Task Leads, sub-agents, Planning, Coordinator and Automation Runs all start through this one host spawn;
- `runWorktreeCommand` (`tasks/worktree.ts`), which runs Checks, worktree `setup` and `teardown`, and the Factory settings Run now;
- the App host (`apps/apps.ts`), but only for an App the human didn’t start.

An App the human starts with ▶, Restart or the sign-off Preview row, the Task shell, the daemon, the Electron app, and the `git` and `gh` calls the daemon makes for itself stay at normal priority.

Both programs set the priority and then become the command in the same process, so the process ID, the process group and the sandbox wrapper under it are unchanged, and nothing can start before the priority applies. Every child process inherits it. The path is absolute and chosen by the daemon; a repo’s `worktree.env` can’t change which program runs. If the program isn’t there, TED logs once and starts the work at normal priority; a start never fails because of this.

A daemon that is itself already lowered still works: a second utility clamp leaves the work at utility, and `nice -n 10` adds 10 to the daemon’s own niceness. One oddity: under a daemon clamped to background, `taskpolicy -c utility` puts the work at utility, which is above the daemon.

The setting is read at each start. A host that is already running keeps its priority, including across `RunManager.restart`, which restarts the agent inside the same host.

## Considered Options

- **`os.setPriority(pid, 10)` right after `spawn`.** Rejected: a shell can fork its first child before the daemon’s call lands, and niceness does nothing on macOS.
- **The host lowers its own priority from a new `launch.json` field.** Rejected: it needs a file-format field (ADR 0013) and a second mechanism for Checks, setup and teardown, which have no host.
- **Niceness on macOS too.** Rejected after measuring: it changes nothing there.
- **macOS background QoS (`taskpolicy -b`).** Rejected: it keeps work on the efficiency cores and throttles its disk access even when the machine is idle.

## Measurements

All on an M3 Pro (6 performance and 6 efficiency cores), macOS 27.0.1. Other test runs were going on the machine throughout; the load average before each run is given.

Against competing normal-priority work (CPU-bound Node loops, 6 seconds each, loop iterations per process in millions, load 11 to 40):

| Competing processes | Normal | Lowered |
| --- | --- | --- |
| 12 normal, 12 at niceness 10 | 5141 | 5124 |
| 12 normal, 12 at niceness 20 | 4711 | 4851 |
| 24 normal, 24 at niceness 20 | 3333 | 3379 |
| 12 normal, 12 under `taskpolicy -c utility` | 7290 | 505 |
| 4 normal, 4 under `taskpolicy -c utility` | 11882 | 1182 |
| 12 normal, 12 under `taskpolicy -b` | 8055 | 306 |

Niceness left the shares equal; `ps` showed `NI 10` but scheduler priority 31. The utility clamp dropped the scheduler priority to 20 and left lowered work about a tenth of the processor while normal work wanted it.

With cores free (load 3 to 8), normal against utility:

| Work | Normal | Utility | Slowdown |
| --- | --- | --- | --- |
| One Node loop, 6 s, iterations (two runs each) | 25.5 and 26.5 billion | 24.2 and 26.7 billion | 1.0× |
| 12 Node loops at once, 6 s, iterations per process | 16.1 billion | 16.4 billion | 1.0× |
| `pnpm typecheck` (three runs each) | 2.0 s, 2.1 s, 2.3 s | 2.0 s, 2.3 s, 2.0 s | 1.0× |
| `tsc --noEmit -p tsconfig.json --incremental false` (three each) | 1.0 s each | 1.0 s each | 1.0× |
| `vitest run packages/daemon/test/queue.test.ts` (two each) | 1.1 s, 1.1 s | 1.1 s, 1.1 s | 1.0× |
| `vitest run packages/daemon/test/checks.test.ts` (two each) | 40.0 s, 40.2 s | 40.4 s, 39.8 s | 1.0× |

So utility work is not kept on the efficiency cores: with cores free it runs as fast as normal work, and it slows down only while something else wants the processor. In the worst case measured, with as many normal busy processes as cores, it ran about ten times slower.

## Timeouts the lowered work is under

None is changed. With cores free nothing is slower. Under heavy competing load from outside TED (the ten-times case), these could be reached:

- a Check’s `timeout`, default 10 minutes: a Check that normally takes more than about a minute;
- worktree `setup` and `teardown`, default 15 minutes: an install that normally takes more than about 90 seconds;
- a Run now try, default 10 minutes, plus its scratch `setup`;
- the Task Lead’s no-output clock, `stallAfterMs`, 30 minutes: an agent whose one command normally runs for more than about 3 minutes with no output in between;
- App readiness, 5 minutes, for an App an agent starts.

These are short enough to matter only if the hosts themselves were starved: the Run and App hosts wait 2 seconds for their lock, and the Run manager waits 10 seconds for a revived or replaced host’s start record.

TED’s own lowered work doesn’t compete with itself this way; it all sits in the same class. The ten-times case needs normal-priority work from outside TED on every core.

## Consequences

- Anything new that starts Task work goes through `workCommand` with the setting.
- Tests read a process’s scheduler priority (`ps -o pri=`, 20 under the clamp, 31 normally) on macOS and its niceness on Linux, and compare with their own, because TED’s own Runs run tests lowered.
