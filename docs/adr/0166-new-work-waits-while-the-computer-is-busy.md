# New work waits while the computer is busy

Status: accepted (KRI-404). Replaces ADR 0101-new-work-waits-while-the-machine-is-busy.

TED measured memory for Settings → Developer but never acted on it. On a Mac that ran out, TED kept starting agents, simulators and Scheduled Checks, and macOS swapped and killed processes. A killed agent went through recovery; a killed Check looked like a real failure. ADR 0101 already held new starts for CPU load, but only behind a setting that was off by default, and it held them by a different rule from what Scheduled Checks used. This ADR makes one rule for both resources.

## The rule

One machine setting, `waitWhenBusy` (**Wait to start new work when this computer is busy** in Settings → Limits), on by default. It replaces `adjustRunsToLoad`; the old stored value is ignored, so everyone starts with the new setting on.

The computer is busy when either resource is past its mark. `nextBusy` in `packages/daemon/src/busy.ts` decides it from one reading, with the marks in `busyMarks` (`packages/protocol/src/slots.ts`):

- **CPU load:** the 1-minute load average per logical core (`machineLoadRatio`). Hold at 1, resume below 0.75, as in ADR 0101.
- **Memory:** the share of total memory available, from `kern.memorystatus_level` on macOS and `MemAvailable` on Linux (`availableMemory`, which Settings → Developer also reads). Hold below 10%, resume above 20%. macOS lowers the level as memory pressure rises, well before it starts killing processes.

Each resource keeps its own hysteresis: between its marks the last answer stands. A figure that isn’t a finite number never holds. The hold carries only the resources that are holding, with their figures rounded to two decimals (`BusyHold`).

The daemon makes one `createBusyHold` and hands it to everything that waits, so the queue, Scheduled Checks and device slots can’t disagree. It reads memory at most every 5 seconds outside tests.

## What waits

- **Task Lead Runs and sub-agents** in the queue: while held, `startsNow` skips every entry unless nothing holds a slot or it is a slot handoff, as in ADR 0101. A Task Lead continuing after Checks or an answer doesn’t wait (ADR 0183-work-in-progress-skips-the-busy-hold).
- **Simulator and emulator boots** an agent asks for (`apps/device-slots.ts`): with a slot free but the computer busy and at least one device of that kind live, the boot waits in the first-come line instead of asking the human to shut a device down; the line boots it when the hold ends. A boot the human starts with ▶ ignores the hold, like other actions signed with the app’s key. The first device of a kind always boots.
- **Scheduled Checks** wait as before, until `check.runBy` or 4 hours (ADR 0147).

What doesn’t wait: chats (ADR 0137), Automation Runs and drafts, Check runs (hand-off, Validate, `ted checks`, Merge) and Apps. Nothing already working is stopped. The disk-full hold, agent pauses and Factory caps still apply first.

While held, the pump runs again every 15 seconds, so work starts once both resources recover with no other event.

## Showing it

`GET /slots` carries `busy` while held; `slots-changed` goes out when it starts, ends or its figures change. A queued Task’s status is `{ kind: 'queued', hold: 'this computer is busy', busy }`. The app shows one line for both resources, “this computer is busy”, and the hover title on the Task’s status, the Board card and the Limits line (`busyDetail` in `packages/app/src/renderer/slots.ts`) says which resource holds, with its figure and marks, for example “Memory available: 7% · waits below 10%, starts again above 20%”. There is no banner or notification: this is normal operation.

## Default working Runs

With no stored `maxWorkingRuns`, the store uses `defaultWorkingRuns` of the computer’s total memory: one per 4 GB, between 2 and 8 (8 GB → 2, 16 GB → 4, 24 GB → 6, 32 GB or more → 8). A value the human set stays. `defaultMachineSettings` keeps 6, because the renderer can’t read total memory and tests compare against it.

## Tests

Tests never read the real machine. `TED_LOAD_FILE` names a file holding the load ratio and `TED_MEMORY_FILE` a JSON file with `totalBytes` and `availableBytes`; `vitest.config.ts` points every test at fixtures with load 0 and 24 GB total and available, so nothing holds and the default limit stays 6. `startDaemon`’s `load` option (`ratio`, `memoryAvailable` as a share, `checkEveryMs`) overrides both.

## Considered Options

- **A second setting for memory.** Two switches that hold the same work for two reasons read as two features. The human cares whether the computer has room, not which resource ran out.
- **Naming the resource in the queued line.** One line keeps the list short; the hover title names it for whoever wants to know.
- **Holding Check runs too.** A Check holds the Task that asked for it; holding it would stall hand-offs and Merge.
- **Retrying a Check or Run killed while memory was low.** Telling a memory kill from a real failure needs its own design (exit signals, macOS’s memory-kill reports), so it is left to a later change.

## Consequences

- The CPU hold is now on for everyone, including those who had turned the old setting off.
- Programs other than TED that use the CPU or memory hold TED’s new work too, down to one working Run.
