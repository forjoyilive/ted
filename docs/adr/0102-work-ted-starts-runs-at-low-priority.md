# The work TED starts runs at low priority

Several Tasks working at once fill every core with agents, installs, typechecks and tests. The `lowPriorityWork` machine setting (Settings → Limits, on by default) starts that work at niceness 10. On Linux that lowers its share of the processor. On macOS it does not: measured on Apple silicon, a process at niceness 10 or 20 got the same share as one at 0 (see below), so there the setting changes the niceness and nothing else.

`workCommand` in `packages/daemon/src/priority.ts` puts `/usr/bin/nice -n 10` (or `/bin/nice`) in front of a command. It is used at the three places TED starts Task work:

- the Run host (`runs/run-manager.ts`), so the agent CLI and every command it runs inherit the niceness. Task Leads, sub-agents, Planning, Coordinator and Automation Runs all start through this one host spawn;
- `runWorktreeCommand` (`tasks/worktree.ts`), which runs Checks, worktree `setup` and `teardown`, and the Factory settings Run now;
- the App host (`apps/apps.ts`), but only for an App the human didn’t start.

An App the human starts with ▶, Restart or the sign-off Preview row, the Task shell, the daemon, the Electron app, and the `git` and `gh` calls the daemon makes for itself stay at normal priority.

`nice` sets the niceness and then becomes the command in the same process, so the process ID, the process group and the sandbox wrapper under it are unchanged, and nothing can start before the niceness applies. The path is absolute and chosen by the daemon; a repo’s `worktree.env` can’t change which program runs. `nice -n 10` adds to the daemon’s own niceness, so a daemon that was itself started niced starts its work 10 lower still. If neither path exists, TED logs once and starts the work at normal priority; a start never fails because of this.

The setting is read at each start. A host that is already running keeps its priority, including across `RunManager.restart`, which restarts the agent inside the same host.

## Considered Options

- **`os.setPriority(pid, 10)` right after `spawn`.** Rejected: a shell can fork its first child before the daemon’s call lands, so a descendant could miss it.
- **The host lowers its own priority from a new `launch.json` field.** Rejected: it covers the agent as well as `nice` does but needs a file-format field (ADR 0013) and a second mechanism for Checks, setup and teardown, which have no host.
- **macOS background QoS (`taskpolicy -b`) or a utility QoS clamp (`taskpolicy -c utility`).** Not done here. See below.

## What niceness does on Apple silicon

Measured on an M3 Pro (6 performance and 6 efficiency cores), macOS 27.0.1, with CPU-bound Node processes run for 6 seconds each, while other work was running on the machine (load average 11 to 17 before each run). Numbers are loop iterations per process, in millions.

| Competing processes | Normal | Lowered |
| --- | --- | --- |
| 12 normal, 12 at niceness 10 | 5141 | 5124 |
| 12 normal, 12 at niceness 20 | 4711 | 4851 |
| 24 normal, 24 at niceness 20 | 3333 | 3379 |
| 12 normal, 12 under `taskpolicy -c utility` | 7290 | 505 |
| 12 normal, 12 under `taskpolicy -b` | 8055 | 306 |
| 4 normal, 4 under `taskpolicy -c utility` | 11882 | 1182 |

Niceness did not change the share of CPU a process got against normal-priority processes: `ps` showed `NI 10` but the same scheduler priority (31). A utility clamp dropped the scheduler priority to 20, was inherited by child processes, and left the lowered processes about a tenth of the CPU while normal work was competing. So on macOS niceness does not reduce a process’s share of the processor; the setting has its effect on Linux.

A QoS clamp would give way for real on macOS, at a cost that wasn’t measured on an idle machine: lowered work could run much slower whenever anything else is busy, which could trip Check timeouts and the Task Lead’s no-output clock. Adding it is a change to `workCommand` only.

## Consequences

- Anything new that starts Task work goes through `workCommand` with the setting.
- A test compares against its own niceness plus 10, because TED’s own Runs run tests niced.
