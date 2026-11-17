# A process’s memory is its footprint, read in one place

Status: accepted (TED-413).

The sidebar footer, Settings → Developer and `ted dev memory` each showed a different memory figure, and none matched Activity Monitor. The sidebar added up `ps` resident sizes and left out the app. Settings → Developer added the app, measured with Electron’s working set size. Resident size counts shared memory again in every process and leaves out compressed memory, so its sum is usually too high and sometimes too low.

## Decision

- `processMemory` in `packages/daemon/src/process-memory.ts` is the only code that measures a process’s memory. On macOS it reads each process’s footprint, the figure in Activity Monitor’s Memory column, with `/usr/bin/footprint`. A process it doesn’t report, and every process on Linux, gets its resident size from `ps`.
- The daemon’s process reading (`ownedProcesses` in `diagnostics.ts`), the daemon’s own figure in `memoryUse`, and the app’s processes in the main process (`appUsage` in `packages/app/src/main.ts`) all go through it. So the sidebar, Settings → Developer, the Diagnostics table, Copy report and `ted dev memory` count memory the same way.
- The sidebar footer gets its figures from the main process (`resourceUsage`), which adds the app’s CPU and memory to the daemon’s. Every memory size is shown with `memorySize`.

## Considered

- `top -l 1`: reports the same footprint, but costs about a second of CPU on every read, even when limited to a few processes. `footprint` reads 20 processes in about 0.2 s.
- A native addon calling `proc_pid_rusage`: cheapest, but it adds a native build.

## Consequences

Each read costs a fraction of a second of CPU, so the sidebar and Settings → Developer read processes every 5 seconds, not every 2. `ted dev memory` can’t see the app’s processes; it says so, and its total is lower than the sidebar’s by the app’s share.

## Grouping by kind (TED-487)

A total across many processes can’t be checked against Activity Monitor, which lists each one separately, mostly as `node`, `claude` or `TED`. So `classifyProcesses` in `diagnostics.ts` gives every process a kind from the nearest thing above it: a Run host (the host, its agent, and the agent’s tools and MCP servers below that), a Check or App root, or the daemon (anything else it started is “other”). Check and App processes are found through `process-roots.ts`, where `runTaskCommand` records a Check’s first process and the Apps module records each App host it follows; an App host left running across a daemon restart is counted too, though it no longer has the daemon as parent. `memoryParts` turns the groups into the sidebar’s hover card, the Developer page’s summary and `ted dev memory`, and `processName` names each row of the Processes table.
