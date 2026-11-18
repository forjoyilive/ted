# Ted tells a device App build how many CPUs it may use

Status: accepted. Follows ADR 0171-ted-tells-a-check-how-many-cpus-it-may-use and ADR 0191-simulators-and-emulators-share-one-limit-and-build-one-at-a-time.

On 2026-11-17 an Android emulator App and an iOS simulator App each ran a native build sized to all 12 cores, and the Mac swapped (KRI-422). ADR 0191 made them share one device limit and take turns building by default. Nothing told a build how much of the computer to use, so a build that runs alone, or beside another with the turn off, still sized itself to every core.

## Decision

**Ted gives every iOS simulator and Android emulator App’s `run` command `TED_APP_CPUS`: the number of logical cores its build may use.** It is the share set by **CPU a Check may use** (`checkCpuPercent`, half by default), divided by the device App builds running at that moment, this one included, rounded down and never less than 1: `checkCpus` in `tasks/check-slots.ts`, the same arithmetic as `TED_CHECK_CPUS`. Web and command Apps get nothing.

**A build counts from its `run` starting until the build turn would end.** That is when the App’s log shows a `TED_APP_READY` line, the App ends or is stopped, its device shuts down, or 15 minutes pass. `createDevicePool` in `apps/device-pool.ts` keeps the count: `launch` in `apps/apps.ts` calls `beginBuild` and `endTurn` removes the build at each of those points, whether **Build one simulator or emulator App at a time** is on or off. With it on only one build runs, so a build gets the whole share. With it off, Ted now also watches for `TED_APP_READY` so a ready App stops counting.

Checks running at the same time don’t count, and a build doesn’t count toward a Check’s `TED_CHECK_CPUS`. The busy hold (ADR 0166) still stops new work while the computer is full.

The number is a request, as in ADR 0171. A Factory’s script passes it on: `xcodebuild -jobs "$TED_APP_CPUS"` or `./gradlew --max-workers="$TED_APP_CPUS"`. The setup guide says so.

## Considered Options

- **A separate setting for builds.** Rejected by the user: one share is easier to explain.
- **Dividing by Checks and builds together.** Rejected by the user; the busy hold covers a full computer.
- **Counting device Apps by their saved state.** A device App has no URL and shows as running as soon as its `run` starts, so the state can’t tell a build from a running app.
- **Reusing `TED_CHECK_CPUS`.** An App isn’t a Check, and a script reading one name for both would hide which setting applies.

## Consequences

- A build alone on 12 cores at the default is told 6, so it may take longer than one that used every core.
- Factories get the variable but nothing changes until their App scripts pass it on.
- An agent that runs a device App’s script itself, outside `ted run-app`, gets no number.
